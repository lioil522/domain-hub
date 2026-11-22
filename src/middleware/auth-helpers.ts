/**
 * 鉴权相关工具函数
 */

import type { Context } from "hono";
import type { Bindings, Variables } from "../routes/types";

/**
 * 提取客户端 IP（供登录限流分维度计数）
 *
 * 运行时适配器提供可信上下文：Worker 只取边缘头，Node 默认取 socket。
 * 此处绝不从客户端可伪造的 HTTP 代理头补取 IP。
 */
export function getClientIp(c: Context<{ Bindings: Bindings; Variables: Variables }>): string {
  return c.env.REQUEST_SECURITY?.clientIp || "unknown";
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
