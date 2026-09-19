/**
 * Cron 辅助工具函数：分批并发控制与 Worker 子请求限制判断
 */

/**
 * 分批并发执行 —— 控制同时发出的 fetch() 数量以避免触发 Worker 子请求限制
 */
export async function batchedPromiseAll<T>(
  items: T[],
  fn: (item: T) => Promise<T>,
  batchSize: number = 5
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

/**
 * 判断错误是否为 Worker 子请求配额耗尽
 */
export function isSubrequestLimitError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes("Too many subrequests");
  }
  return false;
}
