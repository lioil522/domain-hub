import assert from "node:assert/strict";
import test from "node:test";
import { apiJson, ApiRequestError } from "../../frontend/src/api/request";

const response = (status: number, body: unknown, ok = status >= 200 && status < 300) =>
  ({ ok, status, json: async () => body } as Response);

test("apiJson parses successful JSON", async () => {
  const data = await apiJson<{ success: boolean; value: number }>(async () => response(200, { success: true, value: 7 }));
  assert.deepEqual(data, { success: true, value: 7 });
});

test("apiJson converts HTTP failures into ApiRequestError", async () => {
  await assert.rejects(
    () => apiJson(async () => response(502, { success: false, message: "upstream unavailable" })),
    (error: unknown) => error instanceof ApiRequestError && error.status === 502 && error.message === "upstream unavailable",
  );
});

test("apiJson converts network failures into ApiRequestError", async () => {
  await assert.rejects(
    () => apiJson(async () => { throw new Error("network unavailable"); }),
    (error: unknown) => error instanceof ApiRequestError && error.status === null && error.message === "network unavailable",
  );
});
