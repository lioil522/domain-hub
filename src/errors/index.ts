/**
 * 统一业务错误体系
 */

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(message: string, statusCode = 500, code = "internal_error", details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "资源不存在", details?: unknown) {
    super(message, 404, "not_found", details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "请先登录或登录态已失效", details?: unknown) {
    super(message, 401, "unauthorized", details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "无权访问此资源", details?: unknown) {
    super(message, 403, "forbidden", details);
  }
}

export class ValidationError extends AppError {
  constructor(message = "参数校验失败", details?: unknown) {
    super(message, 400, "bad_request", details);
  }
}

export class UpstreamError extends AppError {
  constructor(message = "上游服务请求失败", details?: unknown) {
    super(message, 502, "upstream_error", details);
  }
}
