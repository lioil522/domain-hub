/**
 * 域名的展示用格式化
 *
 * WHY 单独成文件：`displayDomainSmart` 原本定义在 `App.tsx` 内部（闭包依赖
 * punycode 的 `toUnicode`），抽组件后 `DnsRecordPanel` / `AccountsPage` 都要用它。
 * 从 App.tsx 导出会造成循环依赖，所以连同它的两个私有 helper 一起挪到中立模块。
 *
 * 这一组函数只做**渲染层**的字符替换，不改变域名的实际值 —— 复制、搜索、
 * 与上游匹配一律使用原始字符串。改动这里不会影响任何数据流。
 */

import { toUnicode } from "../punycode";

/**
 * 域名显示用的零宽字符占位
 *
 * NOTE: 有用户注册了以零宽字符（U+200B 等）为前缀的域名，直接显示时看起来像
 * 「.ddns.ge」，容易被当成显示异常或空空前缀。仅在渲染时替换为可见的 ◌ 占位符，
 * 复制、搜索、Cloudflare 匹配仍使用原始完整域名，不受影响。
 */
const INVISIBLE_CHAR_RE = /[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]/g;

export const displayDomain = (value: string): string =>
  String(value || "").replace(INVISIBLE_CHAR_RE, "◌");

/**
 * 判定字符是否为「可见可打印」字符（排除 C0/C1 控制字符、DEL、空白）
 *
 * 用于智能解码：xn-- 标签解码后若全是控制字符（如 U+0080），说明它并非
 * 有意义的 IDN，应保留 xn-- 原文展示，而不是渲染成一片空白。
 */
const isPrintableVisible = (ch: string): boolean => {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x20 || cp === 0x7f) return false; // C0 控制字符 + DEL
  if (cp >= 0x80 && cp <= 0x9f) return false; // C1 控制字符（U+0080 等）
  if (/\s/.test(ch)) return false; // 各类空白
  return true;
};

/**
 * 智能显示域名：逐标签处理，替代「displayDomain(toUnicode(...))」的盲目解码。
 *
 * - 非 xn-- 标签：原样保留
 * - xn-- 标签解码后含可见字符（如中文、ª 等）→ 用 Unicode（零宽字符替换为 ◌）
 * - xn-- 标签解码后全是零宽字符（U+200B 等）→ 替换为 ◌ 占位（零宽前缀域名）
 * - xn-- 标签解码后含其他不可见控制字符（U+0080 等，非零宽）→ 保留 xn-- 原文
 *
 * 典型：xn--zug（→ U+200B 零宽）显示「◌」，xn--aa（→ U+0080 控制字符）显示
 * 完整「xn--aa」而非不可见的空白前缀。
 */
export const displayDomainSmart = (value: string): string => {
  return String(value || "")
    .split(".")
    .map((label) => {
      if (!/^xn--/i.test(label)) return label;
      let decoded = label;
      try {
        decoded = toUnicode(label);
      } catch {
        return label;
      }
      const chars = [...decoded];
      // 含可见字符 → 用 Unicode（含零宽时一并替换成 ◌）
      if (chars.some((ch) => isPrintableVisible(ch))) {
        return displayDomain(decoded);
      }
      // 全是零宽字符 → ◌ 占位
      if (chars.length > 0 && chars.every((ch) => INVISIBLE_CHAR_RE.test(ch))) {
        return displayDomain(decoded);
      }
      // 其余（控制字符等不可见、且非零宽）→ 保留 xn-- 原文
      return label;
    })
    .join(".");
};

/**
 * 统一日期展示（注册时间 / 到期时间 / 绑定时间共用）
 *
 * WHY 需要 isExpiration 这个开关：空值 / 0000 占位 / 无法解析的字符串，在
 * 「到期时间」语境下应显示为「永久」，在「注册时间」语境下应显示为「未记录」。
 * 用同一个函数加开关，避免两处各写一份分支（早先就是分开写的，行为已出现分叉）。
 */
export const formatDate = (dateStr?: string | null, isExpiration = false): string => {
  if (!dateStr || dateStr.startsWith("0000")) {
    return isExpiration ? "永久" : "未记录";
  }
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    return isExpiration ? "永久" : dateStr;
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
};
