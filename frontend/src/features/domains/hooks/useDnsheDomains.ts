import { useMemo, useState } from "react";
import { toASCII, toUnicode } from "../../../punycode";
import { DNSHE_PROVIDERS } from "../../../constants/providers";
import type { Account } from "../../../types/account";
import type { Domain } from "../../../types/domain";

/** `groupedDomains` 的元素：一个账号分组（含账号序号与组内域名） */
export interface DnsheDomainGroup {
  alias: string;
  accountId: number;
  seq: number;
  domains: Domain[];
}

/** 账号分组收起状态的本地存储键 */
const COLLAPSED_LS_KEY = "DNSHE_COLLAPSED_ACCOUNTS";

/**
 * DNSHE 域名页的分组 / 搜索 / 折叠状态
 *
 * 从 `App.tsx` 抽出（Phase 4-H）。**纯搬运**：每个 `useMemo` 的依赖数组、
 * 排序规则、本地存储键名与全部字符串字面量都逐字保留，行为与原内联实现一致。
 *
 * 为什么是「一个 hook」而不是拆成 `useDomainGroups` / `useDomainSync` /
 * `useDomainActions` 三个：这三块目前共享同一批上游状态（`domains` /
 * `accounts` / `globalSearch`），且分组结果 `groupedDomains` 同时被
 * 「全部收起」与列表渲染消费 —— 拆开只会制造三处 prop 透传，收益为零。
 * 等 Phase 5+ 真正需要独立复用时再拆。
 *
 * NOTE: `domainSearchIndex` / `accountSeqMap` 只服务于本 hook 内部的
 * `groupedDomains` 计算，属私有派生量，不对外返回。
 */
export function useDnsheDomains(domains: Domain[], accounts: Account[], globalSearch: string) {
  // 域名列表中被收起的账号分组集合（存 accountId，持久化于本地，刷新后保持上次布局）
  const [collapsedAccounts, setCollapsedAccounts] = useState<Set<number>>(() => {
    try {
      const raw = localStorage.getItem(COLLAPSED_LS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch {
      return new Set();
    }
  });

  // 折叠状态落盘
  const persistCollapsed = (next: Set<number>) => {
    setCollapsedAccounts(next);
    localStorage.setItem(COLLAPSED_LS_KEY, JSON.stringify([...next]));
  };

  // 域名搜索索引：full_domain 在库中一律以 Punycode(xn--) 存储，
  // 而列表展示的是解码后的中文，直接拿中文关键词匹配 ASCII 串永远搜不到。
  // 这里为每个域名预计算「Punycode 原文 + 中文解码」两种形态供匹配。
  const domainSearchIndex = useMemo(() => {
    const map = new Map<number, string>();
    domains.forEach((d) => {
      const ascii = (d.full_domain || "").toLowerCase();
      const unicode = toUnicode(d.full_domain || "").toLowerCase();
      map.set(d.id, ascii === unicode ? ascii : `${ascii} ${unicode}`);
    });
    return map;
  }, [domains]);

  // 通用域名关键词匹配：大小写不敏感，兼容 Punycode（用户可输入中文域名或 xn-- 形态）。
  // 对单个域名返回其「Punycode 原文 + 中文解码」两种形态，任一包含关键词即命中。
  const domainMatchesKeyword = (fullDomain: string, kw: string): boolean => {
    const ascii = (fullDomain || "").toLowerCase();
    const unicode = toUnicode(fullDomain || "").toLowerCase();
    const hay = ascii === unicode ? ascii : `${ascii} ${unicode}`;
    const kwAscii = toASCII(kw).toLowerCase();
    return hay.includes(kw) || (kwAscii !== kw && hay.includes(kwAscii));
  };

  // DNSHE 账号列表（Cloudflare / DigitalPlat 账号在独立标签页展示，自定义服务商分组
  // 无上游 API 也单独处理；DNSHE 的账号选择/注册/查重等场景都应排除它们）
  const dnsheAccounts = useMemo(
    () => accounts.filter((a) => DNSHE_PROVIDERS.includes(a.provider ?? "dnshe")),
    [accounts]
  );

  // 账号序号：以 accounts 列表的顺序为准，而不是分组数组的下标。
  //
  // 分组数组会被搜索/账号筛选裁剪，用它的下标当序号会导致「只看某个账号时永远显示账号 1」。
  // 锚定到 accounts 后，序号在任何筛选下都保持不变，删除账号后又会自然重排。
  const accountSeqMap = useMemo(() => {
    const map = new Map<number, number>();
    dnsheAccounts.forEach((a, i) => map.set(a.id, i + 1));
    return map;
  }, [dnsheAccounts]);

  // 按账号分组处理域名列表
  const groupedDomains = useMemo<DnsheDomainGroup[]>(() => {
    const kw = globalSearch.trim().toLowerCase();
    // 关键词本身也转一次 Punycode：用户粘贴完整中文域名时可直接命中 ASCII 形态。
    // 注意中文「部分匹配」依赖上面的解码形态，因为半个标签的 Punycode 编码
    // 并不是整标签编码的子串。
    const kwAscii = kw ? toASCII(kw).toLowerCase() : "";
    const source = kw
      ? domains.filter((d) => {
          const hay = domainSearchIndex.get(d.id) || "";
          return hay.includes(kw) || (kwAscii !== kw && hay.includes(kwAscii));
        })
      : domains;
    const map = new Map<string, { alias: string; accountId: number; seq: number; domains: Domain[] }>();
    source.forEach((dom) => {
      const key = String(dom.account_id || 0);
      if (!map.has(key)) {
        map.set(key, {
          alias: dom.account_alias || `账号 ${dom.account_id}`,
          accountId: dom.account_id,
          // 已解绑账号的历史域名拿不到序号，用 0 表示（渲染处退化为只显示别名）
          seq: accountSeqMap.get(dom.account_id) ?? 0,
          domains: []
        });
      }
      map.get(key)!.domains.push(dom);
    });
    // 按账号序号排序，让卡片顺序与「账号管理」一致且不随筛选变化；
    // 无序号的（已解绑账号遗留）排在最后
    return Array.from(map.values()).sort((a, b) => {
      if (a.seq === 0) return 1;
      if (b.seq === 0) return -1;
      return a.seq - b.seq;
    });
  }, [domains, globalSearch, domainSearchIndex, accountSeqMap]);

  // 当前搜索命中的域名总数 —— 供筛选栏提示使用。
  //
  // NOTE: 表头的「托管域名: N 个」读的是 domains.length（总数），搜索过滤发生在渲染层，
  //       两个数字不一致时很容易被误读成「账号和域名凭空少了一大半」。
  //       把命中数显式摆出来，让过滤状态不再是隐形的。
  const searchHitCount = useMemo(
    () => groupedDomains.reduce((n, g) => n + g.domains.length, 0),
    [groupedDomains]
  );

  // 切换单个账号分组展开/收起
  const toggleAccountCollapse = (accountId: number) => {
    const next = new Set(collapsedAccounts);
    if (next.has(accountId)) {
      next.delete(accountId);
    } else {
      next.add(accountId);
    }
    persistCollapsed(next);
  };

  // 展开/收起全部账号分组
  const toggleAllAccounts = () => {
    if (collapsedAccounts.size > 0) {
      persistCollapsed(new Set()); // 存在收起的 → 全部展开
    } else {
      persistCollapsed(new Set(groupedDomains.map(g => g.accountId))); // 全部收起
    }
  };

  return {
    collapsedAccounts,
    persistCollapsed,
    domainMatchesKeyword,
    dnsheAccounts,
    groupedDomains,
    searchHitCount,
    toggleAccountCollapse,
    toggleAllAccounts,
  };
}
