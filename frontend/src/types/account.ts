/**
 * 已绑定服务商账号的数据形状
 *
 * NOTE: `Account` / `AccountProvider` 的定义最初在 `App.tsx`，抽组件时移到
 * `components/types.ts`。本文件是它在 `types/` 层下的**同一份定义**——
 * `components/types.ts` 现在从这里再导出（re-export），全项目仍只有一处声明。
 */

/**
 * 服务商标识
 *
 * NOTE: 与后端 `AccountProvider`（src/db.ts）取值严格一致。这里是前端侧的
 * 同名类型，两处必须同步 —— 后端新增一家时这里也要加，否则
 * `Account.provider` 赋值处会报不可比。
 */
export type AccountProvider =
  | "dnshe"
  | "cloudflare"
  | "digitalplat"
  | "dnspod"
  | "alidns"
  | "huaweicloud"
  | "vercel"
  | "custom";

/** 已绑定的服务商账号（`accounts` 表，不含密钥明文） */
export interface Account {
  id: number;
  alias: string;
  api_key: string;
  provider?: AccountProvider;
  created_at: string;
  website?: string | null;
}
