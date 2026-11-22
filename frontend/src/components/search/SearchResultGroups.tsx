import type { CrossSourceResult, SearchDomainHit } from "../../types/search";
import type { MultiProviderKey } from "../../types/provider";
import { MULTI_PROVIDER_META, MULTI_PROVIDER_ORDER, MULTI_PROVIDER_SEARCH_COLORS } from "../../features/providers/providerMeta";
import { displayDomainSmart } from "../../lib/display-domain";

/**
 * 搜索框下方的跨来源聚合结果面板：按来源分组列出命中域名，点击跳转到对应标签页。
 */
export function SearchResultGroups(props: {
  result: CrossSourceResult;
  onJump: (source: "dnshe" | "cf" | "dp" | "custom" | MultiProviderKey, fullDomain: string, id?: number, accountId?: number) => void;
}) {
  const { result, onJump } = props;
  const groups: Array<{
    key: "dnshe" | "cf" | "dp" | "custom" | MultiProviderKey;
    label: string;
    color: string;
    items: SearchDomainHit[];
  }> = [
    {
      key: "dnshe",
      label: "DNSHE",
      color: "text-indigo-600 dark:text-indigo-400",
      items: result.dnsheHits
    },
    {
      key: "cf",
      label: "Cloudflare",
      color: "text-orange-500 dark:text-orange-400",
      items: result.cfHits
    },
    {
      key: "dp",
      label: "DigitalPlat",
      color: "text-emerald-600 dark:text-emerald-400",
      items: result.dpHits
    },
    // 四个新托管商：由 MULTI_PROVIDER_META 驱动，避免每家的标签与配色各写一遍
    ...MULTI_PROVIDER_ORDER.map((key) => ({
      key,
      label: MULTI_PROVIDER_META[key].label,
      color: MULTI_PROVIDER_SEARCH_COLORS[key],
      items: result.multiHits[key]
    })),
    {
      key: "custom",
      label: "自定义服务商",
      color: "text-amber-600 dark:text-amber-400",
      items: result.customHits
    }
  ];
  const total = groups.reduce((n, g) => n + (result.totals?.[g.key] ?? g.items.length), 0);

  if (total === 0) {
    return (
      <div className="px-4 py-6 text-center text-sm text-content-muted">
        未找到匹配「{result.kw}」的域名
        {result.dns_scope && <p className="mt-2 text-xs">DNS 只检索有效已缓存记录，未缓存不代表不存在。</p>}
      </div>
    );
  }

  return (
    <div className="py-1">
      {result.dns_scope && <p className="px-4 py-2 text-xs text-content-muted">包含有效 DNS 缓存；不是实时全量 DNS 查询。</p>}
      {groups.map((g) => {
        if (g.items.length === 0) return null;
        return (
          <div key={g.key}>
            <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-content-muted flex items-center gap-1.5">
              <span className={`font-bold ${g.color}`}>{g.label}</span>
               <span className="text-content-muted">({result.totals?.[g.key] ?? g.items.length})</span>
            </div>
            {g.items.slice(0, 8).map((item) => (
              <button
                key={`${g.key}-${item.id}`}
                onClick={() => onJump(g.key, item.full_domain, item.id, item.account_id)}
                className="w-full text-left px-4 py-1.5 text-sm text-content-secondary hover:text-content-primary hover:bg-hovered transition-colors flex items-center gap-2"
              >
                <span className="min-w-0">
                  <span className="block font-mono truncate">{displayDomainSmart(item.full_domain)}</span>
                  {item.dns_match && <span className="block truncate text-xs text-content-muted"
                    title={`${item.dns_match.type} ${item.dns_match.name || "@"} → ${item.dns_match.preview}`}>
                    DNS 缓存 · {item.dns_match.type} · {item.dns_match.name || "@"} → {item.dns_match.preview}
                  </span>}
                </span>
              </button>
            ))}
             {(result.totals?.[g.key] ?? g.items.length) > 8 && (
              <div className="px-4 pb-1 text-[11px] text-content-muted">
                 还有 {(result.totals?.[g.key] ?? g.items.length) - 8} 个，请输入更精确关键词
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
