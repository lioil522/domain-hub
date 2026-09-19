import assert from "node:assert/strict";
import { test } from "node:test";
import { rankSearchResults, scoreSearchResult } from "../../src/search/ranking";

test("search ranking prefers exact and prefix matches", () => {
  assert.equal(scoreSearchResult({ type: "domain", id: "1", title: "example.com", route: "domains" }, "example.com"), 1000);
  assert.equal(scoreSearchResult({ type: "domain", id: "2", title: "example.com.cn", route: "domains" }, "example"), 800);
  const results = rankSearchResults([
    { type: "domain", id: "1", title: "zzz.example.com", route: "domains" },
    { type: "domain", id: "2", title: "example.com", route: "domains" },
  ], "example.com");
  assert.equal(results[0].id, "2");
});
