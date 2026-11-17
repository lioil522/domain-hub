import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = new URL("../", import.meta.url);
const output = await build({
  entryPoints: [fileURLToPath(new URL("src/db/schema-definition.ts", root))],
  bundle: true, platform: "node", format: "esm", write: false,
});
const { freshSchemaSql } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
const expected = freshSchemaSql();
const file = new URL("schema.sql", root);
if (process.argv.includes("--check")) {
  const actual = (await readFile(file, "utf8")).replace(/\r\n/g, "\n");
  if (actual !== expected) throw new Error("schema.sql is stale; run npm run schema:generate and commit the updated snapshot");
  console.log("[schema] generated snapshot matches the runtime definition");
} else {
  await writeFile(file, expected);
  console.log("[schema] regenerated schema.sql (fresh database only)");
}
