/**
 * 登录失败限流常量
 */

/** 同一「用户名@IP」或「IP」维度在窗口期内允许的连续失败次数，超限即锁定 */
export const LOGIN_MAX_FAILURES = 5;

/** 限流窗口 / 锁定持续时长：15 分钟 */
export const LOGIN_LOCK_WINDOW_SECONDS = 15 * 60;

export const LOGIN_LOCKED_MESSAGE = "登录失败次数过多，账号已临时锁定，请 15 分钟后再试";
