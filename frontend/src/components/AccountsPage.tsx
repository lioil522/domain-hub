/**
 * 账号管理页（Tab "accounts"）
 *
 * 结构（「账号中心」式，不再按服务商切大分区）：
 *   ① 标题栏：页面标题 + 「添加账号」
 *   ② 工具行：搜索框 + 服务商筛选 chips（全部 / 各家，带账号数）
 *   ③ 扁平账号列表：一行一账号卡片（品牌图标 + 别名 + 掩码凭据 + 绑定日期 + 编辑/解绑）
 *
 * WHY 从「按服务商分组的巨块分区」改为「顶部分类筛选 + 扁平列表」：
 * 服务商多达 7 家、且多数为空时，旧结构要为每个服务商渲染「大标题 + 巨型空状态卡片」，
 * 页面被撑得极长（空状态卡片本身约 150px）。而本页的核心任务是
 * 「找账号 / 看状态 / 编辑 / 删除 / 添加」，不是「浏览有哪些服务商」——
 * 服务商退化为筛选维度后，空服务商不再占高度，新增服务商也不会让页面变臃肿。
 *
 * 绑定入口仍是回调（弹窗在 App.tsx，被多页复用），本组件不感知弹窗形态。
 *
 * 关于密钥掩码：DNSHE 沿用历史上的「前8***后4」，其余统一「••••尾4」。
 */

import { useMemo, useState } from "react";
import type { Account } from "./types";
import { formatDate } from "../lib/display-domain";
import { Button } from "./Button";
import { BrandLogo } from "./BrandLogo";
import { ProviderBadge } from "./patterns/ProviderBadge";
import { Pencil, Plus, RefreshCw, Search, Trash2 } from "lucide-react";

/** 四个新接入托管商的 key（与 MULTI_PROVIDER_META 的键一致） */
export type MultiProviderKey = "dnspod" | "alidns" | "huaweicloud" | "vercel";

/** 账号页里出现的全部服务商 key（DNSHE 排最后，与改造前的分组顺序一致） */
type ProviderKey = "dnshe" | "cloudflare" | "digitalplat" | MultiProviderKey;

/** 新托管商的展示配置（只取本页需要的字段） */
export interface AccountsProviderMeta {
  /** 侧栏与页面标题显示名 */
  label: string;
  /** 凭据字段名，用于账号卡片上的掩码前缀 */
  primaryLabel: string;
  /** 单凭据型（Vercel）时 primaryLabel 为空，回退到 secondaryLabel */
  secondaryLabel: string;
}

export interface AccountsPageProps {
  // ===== 账号数据（已按 provider 分好组） =====
  dnsheAccounts: Account[];
  cfAccountList: Account[];
  dpAccountList: Account[];
  /** 四个新托管商的账号列表，按 provider key 索引 */
  multiProviderAccountLists: Record<MultiProviderKey, Account[]>;
  loadingAccounts: boolean;
  /** 当前 actionLoading 的键（形如 "delete-account-3"），用于按钮禁用判断 */
  actionLoading: string | null;

  // ===== 四个新托管商：循环渲染所需的顺序与配置 =====
  multiProviderOrder: MultiProviderKey[];
  multiProviderMeta: Record<MultiProviderKey, AccountsProviderMeta>;

  // ===== 绑定入口 =====
  /**
   * 打开绑定弹窗（不预选托管商，由弹窗内的 ProviderPicker 决定）。
   *
   * WHY 不再逐家传参：顶部是单个「添加账号」按钮，选择动作整体移入弹窗 ——
   * 本组件不需要再知道有哪些服务商，职责更干净。
   */
  onAddAccount: () => void;

  // ===== 编辑账号（各服务商各有一套弹窗，这里只负责触发） =====
  onEditDnshe: (acc: Account) => void;
  onEditCf: (acc: Account) => void;
  onEditDp: (acc: Account) => void;
  onEditMulti: (key: MultiProviderKey, acc: Account) => void;

  // ===== 解绑 =====
  onDeleteDnshe: (acc: Account) => void;
  onDeleteCf: (acc: Account) => void;
  onDeleteDp: (acc: Account) => void;
  onDeleteMulti: (key: MultiProviderKey, acc: Account) => void;
}

export function AccountsPage(props: AccountsPageProps) {
  const {
    dnsheAccounts,
    cfAccountList,
    dpAccountList,
    multiProviderAccountLists,
    loadingAccounts,
    actionLoading,
    multiProviderOrder,
    multiProviderMeta,
    onAddAccount,
    onEditDnshe,
    onEditCf,
    onEditDp,
    onEditMulti,
    onDeleteDnshe,
    onDeleteCf,
    onDeleteDp,
    onDeleteMulti,
  } = props;

  const [filter, setFilter] = useState<ProviderKey | "all">("all");
  const [query, setQuery] = useState("");

  /** 服务商展示顺序：DNSHE 最后（与改造前的分组顺序一致） */
  const providerOrder = useMemo<ProviderKey[]>(
    () => ["digitalplat", "cloudflare", ...multiProviderOrder, "dnshe"],
    [multiProviderOrder]
  );

  const listOf = (key: ProviderKey): Account[] =>
    key === "dnshe"
      ? dnsheAccounts
      : key === "cloudflare"
        ? cfAccountList
        : key === "digitalplat"
          ? dpAccountList
          : multiProviderAccountLists[key];

  const metaOf = (key: ProviderKey): AccountsProviderMeta =>
    key === "dnshe"
      ? { label: "DNSHE", primaryLabel: "Key", secondaryLabel: "" }
      : key === "cloudflare"
        ? { label: "Cloudflare", primaryLabel: "Token", secondaryLabel: "" }
        : key === "digitalplat"
          ? { label: "DigitalPlat", primaryLabel: "Key", secondaryLabel: "" }
          : multiProviderMeta[key];

  /** 扁平化：一行一账号，附带其 provider key */
  const flat = useMemo(
    () => providerOrder.flatMap((key) => listOf(key).map((acc) => ({ key, acc }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [providerOrder, dnsheAccounts, cfAccountList, dpAccountList, multiProviderAccountLists]
  );

  const counts = useMemo(() => {
    const m = {} as Record<ProviderKey, number>;
    for (const key of providerOrder) m[key] = listOf(key).length;
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerOrder, dnsheAccounts, cfAccountList, dpAccountList, multiProviderAccountLists]);

  const total = flat.length;

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      flat.filter(
        ({ key, acc }) =>
          (filter === "all" || key === filter) && (!q || String(acc.alias).toLowerCase().includes(q))
      ),
    [flat, filter, q]
  );

  /** 筛选 chips：有账号的服务商；另保留当前选中项（即便被删空），避免 UI 跳变 */
  const chipKeys = providerOrder.filter((k) => counts[k] > 0 || k === filter);

  const dispatchEdit = (key: ProviderKey, acc: Account) => {
    if (key === "dnshe") onEditDnshe(acc);
    else if (key === "cloudflare") onEditCf(acc);
    else if (key === "digitalplat") onEditDp(acc);
    else onEditMulti(key, acc);
  };

  const dispatchDelete = (key: ProviderKey, acc: Account) => {
    if (key === "dnshe") onDeleteDnshe(acc);
    else if (key === "cloudflare") onDeleteCf(acc);
    else if (key === "digitalplat") onDeleteDp(acc);
    else onDeleteMulti(key, acc);
  };

  /** 各家的「删除中」loading key（与 App.tsx 既有约定保持一致） */
  const deleteLoadingKey = (key: ProviderKey, acc: Account): string =>
    key === "dnshe"
      ? `delete-account-${acc.id}`
      : key === "cloudflare"
        ? `cf-delete-account-${acc.id}`
        : key === "digitalplat"
          ? `dp-delete-account-${acc.id}`
          : `multi-delete-${acc.id}`;

  /** 凭据掩码：DNSHE 保留「前8***后4」，其余统一「••••尾4」 */
  const maskOf = (key: ProviderKey, acc: Account): string => {
    const raw = String(acc.api_key || "");
    if (key === "dnshe") {
      return raw.length > 12 ? `${raw.slice(0, 8)}***${raw.slice(-4)}` : raw;
    }
    const meta = metaOf(key);
    return `${meta.primaryLabel || meta.secondaryLabel}: ••••${raw.slice(-4)}`;
  };

  return (
    <div className="space-y-4 pt-5 md:pt-6">
      {/* ===== ① 标题栏 ===== */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-content-primary">账号管理</h1>
        <button
          type="button"
          onClick={onAddAccount}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-accent-gradient px-4 py-2.5 text-sm font-semibold shadow-lg shadow-accent transition-all hover:opacity-95"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          添加账号
        </button>
      </div>

      {/* ===== ② 工具行：搜索 + 服务商筛选 ===== */}
      <div className="space-y-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-content-muted"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索账号别名…"
            aria-label="搜索账号别名"
            className="form-input w-full rounded-xl py-2.5 pl-9 pr-3 text-sm"
          />
        </div>

        <div className="flex flex-wrap gap-2" role="group" aria-label="按服务商筛选">
          <FilterChip
            active={filter === "all"}
            onClick={() => setFilter("all")}
            label="全部"
            count={total}
          />
          {chipKeys.map((key) => (
            <FilterChip
              key={key}
              active={filter === key}
              onClick={() => setFilter(key)}
              label={metaOf(key).label}
              count={counts[key]}
              brand={key}
            />
          ))}
        </div>
      </div>

      {/* ===== ③ 账号列表 ===== */}
      {loadingAccounts ? (
        <div className="flex justify-center py-10">
          <RefreshCw className="h-6 w-6 animate-spin text-accent" />
        </div>
      ) : total === 0 ? (
        <div className="rounded-xl border border-dashed border-border-base bg-surface py-12 text-center">
          <p className="text-sm text-content-muted">尚未绑定任何账号，点击右上角「添加账号」开始</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border-base bg-surface py-10 text-center">
          <p className="text-sm text-content-muted">
            {q ? `没有匹配「${query.trim()}」的账号` : "该服务商暂无账号"}
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map(({ key, acc }) => {
            const meta = metaOf(key);
            const deleting = actionLoading === deleteLoadingKey(key, acc);
            return (
              <li
                key={`${key}-${acc.id}`}
                className="flex items-center justify-between gap-2 rounded-xl border border-border-base bg-surface p-4"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-bold text-content-primary">
                    <ProviderBadge provider={key} compact />
                    <span className="truncate" title={acc.alias}>
                      {acc.alias}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-xs text-content-muted">
                    {maskOf(key, acc)}
                  </div>
                  <div className="mt-0.5 text-[11px] text-content-muted">
                    绑定于 {formatDate(acc.created_at, false)}
                  </div>
                </div>
                <div className="flex flex-shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    icon={<Pencil className="h-4 w-4" />}
                    aria-label={`编辑 ${meta.label} 账号 ${acc.alias}`}
                    title="编辑账号"
                    onClick={() => dispatchEdit(key, acc)}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    icon={<Trash2 className="h-4 w-4" />}
                    aria-label={`解绑 ${meta.label} 账号 ${acc.alias}`}
                    title="解绑账号"
                    loading={deleting}
                    onClick={() => dispatchDelete(key, acc)}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const PROVIDER_TEXT_COLOR: Record<ProviderKey, string> = {
  dnshe: "text-source-dnshe-fg",
  cloudflare: "text-source-cf-fg",
  digitalplat: "text-source-dp-fg",
  dnspod: "text-source-dnspod-fg",
  alidns: "text-source-alidns-fg",
  huaweicloud: "text-source-huawei-fg",
  vercel: "text-source-vercel-fg",
};

/** 服务商筛选 chip（按钮 + aria-pressed；带品牌图标与账号数，供应商名称跟随主题来源色） */
function FilterChip({
  active,
  onClick,
  label,
  count,
  brand,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  brand?: ProviderKey;
}) {
  const brandTextColor = brand ? PROVIDER_TEXT_COLOR[brand] : "text-content-primary";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        "filter-chip inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-all duration-200",
        active
          ? "border-accent bg-accent text-accent-contrast shadow-sm shadow-accent/20"
          : "border-border-base bg-surface/60 text-content-secondary hover:border-accent hover:bg-hovered/80",
      ].join(" ")}
    >
      {brand && <BrandLogo brand={brand} size={13} className="flex-shrink-0" />}
      <span className={active ? "text-accent-contrast" : brandTextColor}>{label}</span>
      <span
        className={[
          "rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums transition-colors",
          active ? "bg-black/20 text-accent-contrast" : "bg-elevated/80 text-content-muted",
        ].join(" ")}
      >
        {count}
      </span>
    </button>
  );
}
