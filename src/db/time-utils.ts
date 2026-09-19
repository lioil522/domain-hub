/**
 * 北京时间（UTC+8）格式化工具
 *
 * NOTE: Cloudflare Workers / D1 的 CURRENT_TIMESTAMP 默认为 UTC，
 * 为了让日志时间与用户所在时区一致，手动构造北京时间。
 */

/**
 * 把任意时刻格式化成定宽的北京时间字符串
 *
 * 格式：YYYY-MM-DD HH:mm:ss.sss（字符串比较等价于时间先后比较）
 */
export function toBeijingString(date: Date): string {
  const beijingOffset = 8 * 60 * 60 * 1000;
  const beijingTime = new Date(date.getTime() + beijingOffset);
  return beijingTime.toISOString().replace("T", " ").replace("Z", "");
}

/**
 * 获取当前北京时间的 ISO 格式字符串
 */
export function getBeijingNow(): string {
  return toBeijingString(new Date());
}
