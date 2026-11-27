// Only local in-memory databases. No remote bindings, account data or API clients.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = fileURLToPath(new URL("../", import.meta.url));
const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
const config = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
const compatibilityDate = config.match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1];
assert.ok(compatibilityDate);
const code = await build({ stdin: { contents: `export {measureSnapshotWrites} from "./tests/helpers/snapshot-write-fixture";
  export {createD1FromSqlite} from "./server/d1-sqlite";`, resolveDir: root }, bundle: true, format: "esm", write: false });
const { measureSnapshotWrites, createD1FromSqlite } = await import(`data:text/javascript;base64,${Buffer.from(code.outputFiles[0].contents).toString("base64")}`);
const statements = schema.replace(/^\s*--[^\r\n]*/gm, "").split(";").map(s => s.trim()).filter(Boolean);
for (const n of [100, 1000, 10000]) for (const optimized of [false, true]) {
  const mf = new Miniflare(convertV4MiniflareOptions({ name: "snapshot-cost", modules: true, compatibilityDate,
    script: "export default { fetch(){return new Response(null,{status:404})} };", d1Databases: ["DB"] }));
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(schema);
    const d1 = await mf.getD1Database("DB");
    for (let i = 0; i < statements.length; i += 40) await d1.batch(statements.slice(i, i+40).map(s => d1.prepare(s)));
    for (const [runtime, db] of [["Node", createD1FromSqlite(sqlite)], ["Miniflare D1", d1]]) {
      const samples = await measureSnapshotWrites(db, n, optimized);
      console.log(JSON.stringify({ runtime, n, optimized, samples }));
    }
  } finally { sqlite.close(); await mf.dispose(); }
}
