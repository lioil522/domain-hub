/**
 * 域名相关的数据形状
 *
 * NOTE: `Domain` 的定义最初在 `App.tsx`，抽组件时移到 `components/types.ts`。
 * 本文件是它在 `types/` 层下的**同一份定义**——`components/types.ts` 现在从这里
 * 再导出（re-export），因此全项目仍只有一处 interface 声明。
 * 新增字段时三处要同步：后端 SQL SELECT、这里、消费点。
 */

/** 域名行（`domains_cache` 表 + 后端 JOIN 出的 account_alias / account_provider） */
export interface Domain {
  id: number;
  account_id: number;
  account_alias: string;
  subdomain: string;
  rootdomain: string;
  full_domain: string;
  status: string;
  created_at?: string;
  expires_at: string;
  last_renewed_at: string | null;
  has_dns?: number | boolean;
  ns1?: string;
  ns2?: string;
  dns_provider?: string | null;
  provider_account_id?: string | number | null;
  disable_ns_management?: boolean;
  /** 上游对象 ID：Cloudflare 行存 zone id；DNSHE 行为空 */
  remote_id?: string | null;
  /** 所属账号的提供商（后端 JOIN accounts 返回） */
  account_provider?: string | null;
  /** 当前域名是否支持线路解析 */
  supports_line?: boolean;
}

/**
 * CF zone 注册/到期时间缓存条目。
 *
 * found 表示 RDAP 是否查得；manual=true 表示用户对 RDAP 查不到的域名自行录入
 * （手动覆盖），保存后优先于自动查询并阻止 RDAP 回写。
 */
export interface CfExpiryEntry {
  found: boolean;
  expires_at?: string;
  registered_at?: string;
  /** RDAP 自动查到的注册商（registrar）名称 */
  registrar?: string;
  /** 手动覆盖：用户编辑过注册/到期时间或来源 */
  manual?: boolean;
  /** 注册来源文本（如 Namecheap / GoDaddy / 赠送）；仅手动录入时展示 */
  source?: string;
  /**
   * 后端回源失败时的错误信息（如 "RDAP HTTP 403"）。
   * 有此字段 = 没查成，而不是注册局明确答「查无此域名」；两者要区别对待：
   * 前者值得换条路再试，后者再试多少次也是同一个答案。
   */
  error?: string;
}
