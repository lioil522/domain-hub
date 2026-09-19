/**
 * 鉴权相关工具函数
 */

import type { Context } from "hono";
import type { Bindings, Variables } from "../routes/types";

/**
 * 提取客户端 IP（供登录限流分维度计数）
 *
 * Cloudflare 上优先取 cf-connecting-ip（由 CF 注入、不可伪造）；
 * 自建版 / 反代场景回退到 x-real-ip / x-forwarded-for 的首个值。
 */
export function getClientIp(c: Context<{ Bindings: Bindings; Variables: Variables }>): string {
  const ip = (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-real-ip") ||
    (c.req.header("x-forwarded-for") || "").split(",")[0] ||
    "unknown"
  ).trim();
  return ip.slice(0, 64) || "unknown";
}

/**
 * 把用户可控字符串截断到固定上限
 *
 * NOTE: 登录接口的 username 来自请求体、无长度约束，写日志与拼限流 key 前
 * 必须截断，否则攻击者可用超长用户名刷爆 logs 表或撑大 cache 表。
 */
export function capText(s: unknown, max = 64): string {
  const v = String(s ?? "");
  return v.length > max ? v.slice(0, max) : v;
}
