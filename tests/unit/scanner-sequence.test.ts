import assert from "node:assert/strict";
import { test } from "node:test";
import { generateSeqPrefixes, getSeqCharset, nextSeqCandidate } from "../../frontend/src/features/scanner/utils/scanner-sequence";

test("scanner sequence advances with carry", () => {
  const charset = getSeqCharset("字母");
  assert.equal(nextSeqCandidate("qwe", charset), "qwf");
  assert.equal(nextSeqCandidate("qwz", charset), "qxa");
  assert.equal(nextSeqCandidate("zzz", charset), null);
});

test("scanner sequence lazily generates bounded candidates", () => {
  assert.deepEqual(generateSeqPrefixes("数字", 2, "08", 4), ["08", "09", "10", "11"]);
  assert.deepEqual(generateSeqPrefixes("字母", 2, "", 3), ["aa", "ab", "ac"]);
});

test("scanner sequence falls back when start is invalid", () => {
  assert.deepEqual(generateSeqPrefixes("数字", 2, "a1", 2), ["00", "01"]);
});
