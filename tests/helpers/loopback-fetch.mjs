import { request } from "node:http";

/** Test-only HTTP: PORT=0 may select a Fetch-standard blocked port. No external hosts. */
export async function loopbackFetch(input, init = {}) {
  const url = new URL(input);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Test HTTP client permits plain HTTP loopback only");
  }
  if (init.body !== undefined && typeof init.body !== "string") throw new Error("Test HTTP client requires a string body");
  return new Promise((resolve, reject) => {
    const req = request(url, { method: init.method || "GET", headers: Object.fromEntries(new Headers(init.headers)),
      agent: false, signal: init.signal || AbortSignal.timeout(15000) }, res => {
      let bytes = 0;
      const chunks = [];
      res.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { req.destroy(new Error("Test HTTP response exceeds the byte limit")); return; }
        chunks.push(chunk);
      });
      res.once("error", reject);
      res.once("end", () => {
        try {
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (value !== undefined) for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
          }
          const status = res.statusCode;
          if (!Number.isInteger(status)) throw new Error("Test HTTP response has no valid status");
          const body = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks).toString("utf8");
          resolve(new Response(body, { status, headers }));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.once("error", reject);
    req.end(init.body);
  });
}
