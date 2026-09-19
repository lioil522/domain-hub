/**
 * DNS 解析记录
 *
 * NOTE: `DnsRecord` 的定义最初在 `App.tsx`，抽组件时移到 `components/types.ts`。
 * 本文件是它在 `types/` 层下的**同一份定义**——`components/types.ts` 现在从这里
 * 再导出（re-export），全项目仍只有一处 interface 声明。
 */

/** 单条解析记录（DNSHE 与 Cloudflare 共用：CF 的 id 是字符串、TTL 1 表示自动） */
export interface DnsRecord {
  id: number | string;
  record_id?: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  priority: number | null;
  line: string | null;
  proxied?: boolean;
  /** Cloudflare 专用：AAAA 100:: proxied 占位记录对应的 Worker 名（来自 /workers/routes） */
  workerName?: string;
}
