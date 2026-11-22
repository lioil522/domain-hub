import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../routes/types";
import { ServiceUnavailableError } from "../errors";
import { errorRes } from "../routes/response";
import { parseOrigin } from "./request-security";

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const HEADERS = ["content-type", "authorization"];
const VARY = ["Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"];

export const apiCors: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Always vary, including rejections/no-Origin responses, and preserve any
  // downstream Vary dimensions rather than replacing them.
  const vary = () => c.header("Vary", [...new Set([
    ...(c.res.headers.get("Vary") || "").split(",").map(value => value.trim()).filter(Boolean), ...VARY,
  ])].join(", "));
  vary();
  if ((c.env.ALLOWED_ORIGIN || "").length > 16384) throw new ServiceUnavailableError("ALLOWED_ORIGIN 超过配置长度上限");
  const entries = (c.env.ALLOWED_ORIGIN || "").split(",").map(value => value.trim()).filter(Boolean);
  const allowed = entries.map(parseOrigin);
  if (entries.length > 64 || allowed.some(origin => !origin)) throw new ServiceUnavailableError("ALLOWED_ORIGIN 必须为明确的 HTTP(S) 来源，不支持通配符或路径");
  const raw = c.req.header("Origin");
  const origin = raw ? parseOrigin(raw) : null;
  const sameOrigin = c.env.REQUEST_SECURITY?.origin;
  if ((raw !== undefined && (!origin || (origin !== sameOrigin && !allowed.includes(origin)))) ||
    (raw === undefined && c.req.header("Sec-Fetch-Site") === "cross-site")) {
    vary();
    return c.json(errorRes("请求来源不在允许列表中", "origin_forbidden"), 403);
  }
  if (c.req.method === "OPTIONS") {
    const method = c.req.header("Access-Control-Request-Method");
    const requested = (c.req.header("Access-Control-Request-Headers") || "")
      .split(",").map(header => header.trim().toLowerCase()).filter(Boolean);
    if (!origin || !method || !METHODS.includes(method) || requested.some(header => !HEADERS.includes(header))) {
      vary();
      return c.json(errorRes("不支持的跨域预检请求", "preflight_forbidden"), 403);
    }
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Methods", METHODS.join(", "));
    c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    c.header("Access-Control-Max-Age", "600");
    vary();
    return c.body(null, 204);
  }
  await next();
  if (origin) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Expose-Headers", "X-Catalog-Summary-Cache");
  }
  vary();
};
