// No user-supplied database/URL: fresh in-memory fixtures only.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = fileURLToPath(new URL("../", import.meta.url));
const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
const statements = schema.replace(/^\s*--[^\r\n]*/gm, "").split(";").map(sql => sql.trim()).filter(Boolean);
const bundled = async contents => (await build({ stdin: { contents, resolveDir: root }, bundle: true, write: false,
  platform: "neutral", format: "esm", target: "es2022" })).outputFiles[0].text;
const entry = `import {measureCapture} from "./tests/prototypes/catalog-write-capture";`;
const nodeEntry = await bundled(`${entry}
  import {createD1FromSqlite} from "./server/d1-sqlite";
  export function run(sqlite,n,enabled){return measureCapture(createD1FromSqlite(sqlite),n,enabled);}`);
const { run } = await import(`data:text/javascript;base64,${Buffer.from(nodeEntry).toString("base64")}`);
const script = await bundled(`${entry}
  export default {async fetch(request,env){
    const query=new URL(request.url).searchParams;
    return Response.json(await measureCapture(env.DB,Number(query.get("n")),query.get("capture")==="true"));
  }};`);
const config = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
const compatibilityDate = config.match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1];
assert.ok(compatibilityDate);
for (const n of [100, 1000, 10000]) for (const captured of [false, true]) {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(schema);
    const result = await run(sqlite, n, captured);
    console.log(JSON.stringify({ runtime: "node", ...result }));
  } finally { sqlite.close(); }
  const mf = new Miniflare(convertV4MiniflareOptions({ name: "local-capture-cost", modules: true, script,
    compatibilityDate, d1Databases: ["DB"], outboundService() { throw new Error("Fixture forbids upstream requests"); } }));
  try {
    const db = await mf.getD1Database("DB");
    for (let i = 0; i < statements.length; i += 40) await db.batch(statements.slice(i, i + 40).map(sql => db.prepare(sql)));
    const response = await mf.dispatchFetch(`http://localhost/?n=${n}&capture=${captured}`);
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json();
    assert.equal(result.syncReplay.events, captured ? n * 0.3 : 0);
    assert.equal(result.repeatReplay.events, 0);
    assert.equal(result.dateReplay.events, captured ? 1 : 0);
    assert.equal(result.cascadeReplay.events, captured ? n + 2 : 0);
    console.log(JSON.stringify({ runtime: "workerd", ...result }));
  } finally { await mf.dispose(); }
}
