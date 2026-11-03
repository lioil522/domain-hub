import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";

test("route layer has no direct concrete provider imports", () => {
  const routeDir = path.resolve(process.cwd(), "src/routes");
  const forbidden = /(cloudflare|dnspod|alidns|dnshe|huaweicloud|digitalplat|vercel)/i;
  for (const file of fs.readdirSync(routeDir).filter((name) => name.endsWith(".ts"))) {
    const source = fs.readFileSync(path.join(routeDir, file), "utf8");
    const imports = source.split("\n").filter((line) => line.trim().startsWith("import "));
    assert.equal(imports.some((line) => forbidden.test(line)), false, `${file} imports concrete provider client`);
  }
});
