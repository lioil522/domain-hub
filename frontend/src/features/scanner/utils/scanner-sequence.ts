/** Pure helpers for sequential scanner candidate generation. */

export type SeqCharsetName = "字母" | "数字" | "字母数字";

export function getSeqCharset(name: string): string[] {
  const letters = "abcdefghijklmnopqrstuvwxyz".split("");
  const digits = "0123456789".split("");
  if (name === "数字") return digits;
  if (name === "字母数字") return [...letters, ...digits];
  return letters;
}

export function nextSeqCandidate(current: string, charset: string[]): string | null {
  const idxMap = new Map(charset.map((c, i) => [c, i]));
  const chars = current.split("");
  let pos = chars.length - 1;
  while (pos >= 0) {
    const cur = idxMap.get(chars[pos]);
    if (cur === undefined) return null;
    if (cur < charset.length - 1) {
      chars[pos] = charset[cur + 1];
      return chars.join("");
    }
    chars[pos] = charset[0];
    pos--;
  }
  return null;
}

export function generateSeqPrefixes(
  charsetName: string,
  length: number,
  start: string,
  limit: number
): string[] {
  const charset = getSeqCharset(charsetName);
  const min = charset[0].repeat(length);
  let cur = start && start.length === length ? start.toLowerCase() : min;
  if (cur.split("").some(c => !charset.includes(c))) cur = min;

  const out: string[] = [];
  while (out.length < limit) {
    out.push(cur);
    const next = nextSeqCandidate(cur, charset);
    if (next === null) break;
    cur = next;
  }
  return out;
}
