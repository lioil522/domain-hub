/** 简易异步等待工具（用于轮询后台同步进度） */
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
