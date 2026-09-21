/**
 * 绑定账号 schema 聚合入口。
 * Provider 细节位于 bind-schema/，这里仅保留公共契约与 provider 注册表，避免 schema 大文件继续增长。
 */
import type { BindProvider } from "../../../types/provider";
import type { BindProviderSchema } from "./bind-schema/types";
import { DNSHE_SCHEMA } from "./bind-schema/dnshe";
import { CF_SCHEMA } from "./bind-schema/cloudflare";
import { DP_SCHEMA } from "./bind-schema/digitalplat";
import { multiSchema } from "./bind-schema/multi";
export * from "./bind-schema/types";

export const BIND_FORM_SCHEMA: Record<BindProvider, BindProviderSchema> = {
  dnshe: DNSHE_SCHEMA,
  cloudflare: CF_SCHEMA,
  digitalplat: DP_SCHEMA,
  dnspod: multiSchema("dnspod"),
  alidns: multiSchema("alidns"),
  huaweicloud: multiSchema("huaweicloud"),
  vercel: multiSchema("vercel"),
};

