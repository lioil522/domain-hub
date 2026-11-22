import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { loopbackFetch } from "../helpers/loopback-fetch.mjs";

test("test-only HTTP performs real loopback requests and preserves response/body semantics", async t => {
  const server = createServer((req, res) => {
    if (req.url === "/empty") { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { "Content-Type": "application/json", "X-Test": "loopback" });
    res.end(JSON.stringify({ method: req.method, message: "测试响应" }));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const response = await loopbackFetch(url, { method: "POST", body: "{}" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Test"), "loopback");
  assert.deepEqual(await response.json(), { method: "POST", message: "测试响应" });
  assert.equal((await loopbackFetch(`${url}/empty`)).status, 204);
});
test("test HTTP cannot accidentally reach a production/non-loopback endpoint", async () => {
  for (const url of ["https://domain.licacv.com", "http://example.invalid", "http://192.0.2.1", "file:///etc/passwd"]) {
    await assert.rejects(() => loopbackFetch(url), /loopback only/);
  }
});
