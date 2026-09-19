/** 周一为一周之首（与国内日历习惯一致） */
export const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

/** Date → "YYYY-MM-DD"（本地时区，不经 UTC，避免跨日偏移） */
export const toLocalDateValue = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** "YYYY-MM-DD" → 所在月 1 号的 Date；空值/格式不符时落到当前月 */
export const monthStartOf = (value: string): Date => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  const now = new Date();
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, 1) : new Date(now.getFullYear(), now.getMonth(), 1);
};

/** "YYYY-MM-DD" → 年 / 月 / 日三段字符串；空值或格式不符时三段都给空串 */
export const splitDateValue = (value: string): { y: string; m: string; d: string } => {
  const hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  return hit ? { y: hit[1], m: hit[2], d: hit[3] } : { y: "", m: "", d: "" };
};

/**
 * 年 / 月 / 日三段 → "YYYY-MM-DD"；凑不齐完整日期时给空串。
 * 月夹到 1-12，日夹到当月天数，两位补零。commit 与失焦补齐共用这套规则。
 */
export const buildDateValue = (s: { y: string; m: string; d: string }): string => {
  if (s.y.length !== 4 || !s.m || !s.d) return "";
  const monthNum = Math.min(12, Math.max(1, Number(s.m)));
  const maxDay = new Date(Number(s.y), monthNum, 0).getDate();
  const dayNum = Math.min(maxDay, Math.max(1, Number(s.d)));
  return `${s.y}-${String(monthNum).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
};
