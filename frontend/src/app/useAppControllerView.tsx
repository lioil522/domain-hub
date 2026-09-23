import { useState, useEffect, useMemo, Suspense } from "react";
import {
  RefreshCw,
  Settings,
  Pencil,
} from "lucide-react";
import { type BadgeTone } from "../components/Badge";
import { DnsRecordPanel } from "../components/DnsRecordPanel";
// DNSHE 解析记录弹窗（Phase 4-D 从 App.tsx 抽出；与 DnsRecordPanel 的差异见组件头注释）
import { DnsheDnsModal } from "../features/dns/components/DnsheDnsModal/index";
import { useCfDnsPanel } from "../features/dns/hooks/useCfDnsPanel";
// 词库解析：设置页「线路解析支持名单」粘贴多个后缀时用于拆分（Phase 9 后仅此处使用）

// ── 已抽出的类型 / 常量 / 工具 / 纯组件（Phase 1 迁移） ──
import type { Domain } from "../types/domain";
import type { Account } from "../types/account";
import type { MultiProviderKey } from "../types/provider";
import type { CustomAccount, CustomDomain } from "../types/custom";
import {
  MULTI_PROVIDER_META,
  MULTI_PROVIDER_ORDER
} from "../features/providers/providerMeta";
import { useMultiProviders } from "../features/providers/hooks/useMultiProviders";
import { useCustomProviders } from "../features/custom/hooks/useCustomProviders";
import { CustomDomainCard, isCfManaged } from "../features/custom/components/CustomDomainCard";
import {
  CustomGroupModal,
  CustomDomainModal,
  CustomAccountModal,
  CustomDeleteAccountModal,
  CustomDeleteGroupModal,
  CustomDeleteDomainModal,
} from "../features/custom/components/CustomModals";
import { useScanner } from "../features/scanner/hooks/useScanner";
import { WordBankModal } from "../features/scanner/components/WordBankModal";
import { useDashboardStats } from "../features/dashboard/hooks/useDashboardStats";
import { AppShell } from "./AppShell";
import {
  AccountsPage,
  MultiProviderPage,
  CustomProvidersPage,
  RegisterPage,
  DashboardPage,
  SettingsPage,
  DomainsPage,
  LineSettingsPage,
  QuotaPage,
  LogsPage,
  CfZonesPage,
  DpZonesPage,
} from "./pages";
import {
  buildProviderNavItems,
  buildVisibleNavItems,
  tabFromHash,
  type TabKey,
} from "./navigation";
import { useAppControllerNavigation } from "./controller/useAppControllerNavigation";
import { useAppControllerDataActions } from "./controller/useAppControllerDataActions";
import { useAppControllerDataEffects } from "./controller/useAppControllerDataEffects";
import { useSettings } from "../features/settings/hooks/useSettings";
import { useDataTransfer } from "../features/data/hooks/useDataTransfer";
import { DataOpModal } from "../features/data/components/DataOpModal";
import { LoginPage, useAuthSession } from "../features/auth";
import { sleep } from "../lib/utils";
// ── Phase 2：API 客户端 / Toast ──
// NOTE: readSessionToken 原先在此引入；鉴权整体下沉到 useAuthSession 后，
//       App 内已无直接调用点（登出时读旧 token 撤销会话的逻辑在该 hook 内）。
import { ToastView } from "../components/feedback/ToastView";
// ── Phase 2.5：全局数据上下文（账号域 + 横切基础设施） ──
import { useAppData } from "../state/AppDataContext";
import { BindAccountModal } from "../features/accounts/components/BindAccountModal";
import { EditAccountModal } from "../features/accounts/components/EditAccountModal";
import { DeleteDomainModal } from "../features/domains/components/DeleteDomainModal";
import { CreateDomainModal } from "../features/domains/components/CreateDomainModal";
import { NameserverModal } from "../features/domains/components/NameserverModal";
import { checkHasDns, getDnsProviderLabel } from "../lib/dns-status";
import { DpNameserverModal } from "../features/domains/components/DpNameserverModal";
import { DpDomainCard } from "../features/domains/components/DpDomainCard";
import { DomainCard } from "../features/domains/components/DomainCard";
import { MultiProviderDomainCard } from "../features/providers/components/MultiProviderDomainCard";
import { useDnsheDomains } from "../features/domains/hooks/useDnsheDomains";
import { useDomainActions } from "../features/domains/hooks/useDomainActions";
import { useDomainSync } from "../features/domains/hooks/useDomainSync";
import { useNameservers } from "../features/domains/hooks/useNameservers";
import { domainKeyCandidates } from "../lib/domain-keys";
import { useCfExpiry } from "../features/cloudflare/hooks/useCfExpiry";
import { useCfZones } from "../features/cloudflare/hooks/useCfZones";
import { CfZoneCard } from "../features/cloudflare/components/CfZoneCard";
import { useCfZoneHighlight } from "../features/cloudflare/hooks/useCfZoneHighlight";
import { CfEditModal } from "../features/cloudflare/components/CfEditModal";
import { useDpDomains } from "../features/digitalplat/hooks/useDpDomains";
import { useDpZoneHighlight } from "../features/digitalplat/hooks/useDpZoneHighlight";
import { useAppUiState } from "./controller/useAppUiState";
import { useAppDataState } from "./controller/useAppDataState";
import { useAppAlerts } from "./controller/useAppAlerts";
import { useLineDnsSettings } from "../features/dns/hooks/useLineDnsSettings";
export function useAppControllerView() {
  const [activeTab, setActiveTab] = useState<TabKey>(tabFromHash);

  // 当前处于的选项卡(通过 URL hash 持久化,刷新/前进后退保持所在页面)
  const {
    theme, setTheme, colorTheme, setColorTheme, globalSearch, setGlobalSearch,
    notifOpen, setNotifOpen, notifRef, searchFocused, setSearchFocused,
    dnsheMenuOpen, setDnsheMenuOpen, logCategory, setLogCategory,
  } = useAppUiState();

  // ===== 全局数据上下文（Phase 2.5：账号域 + 横切基础设施） =====
  // NOTE: 这些量原先定义在本组件内；上移到 AppDataProvider 后，本组件仍以同名局部常量
  //       消费，因此内部引用（apiFetch / showToast / toast / sessionToken / backendUrl /
  //       accounts / loadingAccounts / fetchAccounts）全部无需改动。
  const {
    sessionToken,
    setSessionToken,
    backendUrl,
    apiFetch,
    accounts,
    loadingAccounts,
    fetchAccounts,
    toast,
    showToast,
} = useAppData();

  // 侧栏 / 抽屉 / 断点状态已随外壳(useAppLayout)下沉到 app/AppShell,
  // App 不再持有这些量 —— 它们在外壳之外没有任何消费点。

  const {
    domains, setDomains, quotas, setQuotas, logs, setLogs,
    loadingDomains, setLoadingDomains, loadingQuotas, setLoadingQuotas,
    loadingLogs, setLoadingLogs, actionLoading, setActionLoading,
    selectedAccountFilter, setSelectedAccountFilter, openActionMenuId, setOpenActionMenuId,
    bindModalOpen, setBindModalOpen, editingAccount, setEditingAccount,
  } = useAppDataState();

  // DNSHE 域名页的分组 / 搜索 / 折叠状态（实现见 features/domains/hooks/useDnsheDomains）
  // NOTE: 必须在 domains 声明之后调用；accounts 已在 AppDataProvider 解构、globalSearch 在其上方，均可见。
  const {
    collapsedAccounts,
    persistCollapsed,
    domainMatchesKeyword,
    dnsheAccounts,
    groupedDomains,
    searchHitCount,
    toggleAccountCollapse,
    toggleAllAccounts,
  } = useDnsheDomains(domains, accounts, globalSearch);

  // Toast 提示状态已在 AppDataProvider 内通过 useToast 挂载（Phase 2.5）


  // 选中的域名与 DNS 记录管理模态框状态
  const [selectedDomain, setSelectedDomain] = useState<Domain | null>(null);
  const [dnsModalOpen, setDnsModalOpen] = useState(false);
  // NS 弹窗路径删除解析记录后，用它通知 DNSHE 弹窗重拉列表（弹窗本体见 DnsheDnsModal）
  const [dnsRefreshToken, setDnsRefreshToken] = useState(0);

  // 在线添加域名弹窗状态（支持 DNSPod / Cloudflare / 阿里云 / 华为云 / Vercel）
  const [createDomainModalOpen, setCreateDomainModalOpen] = useState(false);
  const [createDomainDefaultAccountId, setCreateDomainDefaultAccountId] = useState<number | undefined>(undefined);

  // NS 修改弹窗状态（DNSHE + DigitalPlat）（实现见 features/domains/hooks/useNameservers）
  const {
    nsModalOpen,
    setNsModalOpen,
    nsModalDomain,
    openNsModal,
    dpNsModalOpen,
    setDpNsModalOpen,
    dpNsModalDomain,
    openDpNsModal,
  } = useNameservers();

  // ===== 四个新托管商标签页的通用状态（实现见 features/providers/hooks/useMultiProviders） =====
  //
  // NOTE: 四家的 state / 派生 / 动作全在该 hook 内，调用点见下方 useDomainSync 之后
  // （multiSyncOneAccount 依赖 handleSyncAccount，故必须晚于 useDomainSync）。

  // 从 Cloudflare zone 卡片「注册来源 = DNSHE」跳转过来时待定位的 DNSHE 域名卡片 id
  const [dnsheHighlightDomainId, setDnsheHighlightDomainId] = useState<number | null>(null);

  // ===== 自定义服务商（无 API，三层结构：分组 → 账号 → 域名） =====
  // NOTE: state / 派生 / 动作全部抽出到 features/custom/hooks/useCustomProviders，
  //       调用点见下方（依赖 isPermanentExpiry，故晚于该 helper 的声明）。

  // ===== 共用「DNS 解析记录面板」状态 / 派生 / 处理函数 =====
  // 七家共用（DNSHE / Cloudflare / DigitalPlat / DNSPod / 阿里云 / 华为云 / Vercel），
  // 后端按 zone.account_provider 分发；实现见 features/dns/hooks/useCfDnsPanel。
  // NOTE: dnsPanelProps 整包下发给 <DnsRecordPanel {...dnsPanelProps} />；
  //       handleCfOpenDnsModal 供 CF / DP / 四家托管商的「打开 DNS 面板」入口复用。
  const { dnsPanelProps, handleCfOpenDnsModal, handleDpOpenDnsModal } = useCfDnsPanel({ actionLoading, setActionLoading });
  // CF zone 注册信息编辑弹窗触发器（字段状态内聚在 CfEditModal，挂载时预填手动值）
  const [cfEditOpen, setCfEditOpen] = useState(false);
  const [cfEditZone, setCfEditZone] = useState<Domain | null>(null);

  // ===== 注册查重（Scanner）状态 =====
  // NOTE: 根域名 / WHOIS 查重 / 注册 / 批量扫描 / 顺序检测 / 断点续查 / 保留前缀 /
  //       可编辑词库等状态全部抽出到 features/scanner/hooks/useScanner，调用点见上方。
  // 后端 Worker 地址 / 会话 Token 已上移到 AppDataProvider（Phase 2.5），此处由 useAppData 取得。

  // ===== 鉴权 / 登录 / 账户安全（实现见 features/auth） =====
  // NOTE: 鉴权状态、登录与首次初始化表单、账户安全信息原先平铺在这里（约 190 行）。
  //       登录页 JSX 已随 Phase 3 迁入 features/auth/components/LoginPage，
  //       它需要的 18 个值（表单受控态 + setter + 两个提交动作）整体由 `auth` 对象传入，
  //       本组件不再逐个解构 —— 只留下「登录之后」仍要用的三项。
  //       数据导入/导出弹窗的自身状态（dataOp*）与此无关，留在本组件内。
  const auth = useAuthSession({ sessionToken, setSessionToken, apiFetch, showToast, backendUrl });
  const { accountInfo, handleLogout, fetchAccountInfo } = auth;

  // NOTE: 数据导入/导出（弹窗开关状态 + 导出/导入 handler）已下沉到
  //       features/data/hooks/useDataTransfer，调用点在下方 fetchDomains 声明之后。

  // 设置页状态与动作（实现见 features/settings/hooks/useSettings）
  // NOTE: 必须在 fetchAccountInfo / handleLogout / actionLoading / accountInfo 声明之后调用。
  const settingsPage = useSettings({
    apiFetch,
    showToast,
    actionLoading,
    setActionLoading,
    accountInfo,
    fetchAccountInfo,
    handleLogout,
  });
  const { fetchSettings } = settingsPage;

  // 自动淡出 Toast 提示 / showToast 均已在 hooks/useToast.ts 内实现（Phase 2-E）

  // 点击外部关闭三点弹出菜单
  useEffect(() => {
    const handleClickOutside = () => setOpenActionMenuId(null);
    window.addEventListener("click", handleClickOutside);
    return () => window.removeEventListener("click", handleClickOutside);
  }, []);

  // 日期格式化辅助函数：转换为 YYYY/MM/DD（到期时间支持“永久”）
  // NOTE: formatDate 已移至 lib/display-domain.ts（两个抽出的组件也要用）。
  // 原先此处是组件内的一个闭包，改为模块级 import 后不再随组件重建。

  // 到期时间是否为「永久」：空 / 0000 占位 / 无法解析都视为永久（自定义域名以 0000 占位落库）
  const isPermanentExpiry = (v?: string | null): boolean => {
    const s = String(v || "").trim();
    if (!s || s.startsWith("0000")) return true;
    return Number.isNaN(new Date(s).getTime());
  };

  /**
   * 到期剩余天数 → 徽章语义与文案。
   *
   * WHY 抽成 helper：这段「永久 / 已过期 / 30 天内告警 / 正常」四分支判断
   * 原先在自定义域名面板里被复制了两份（未归属账号域名、账号下域名），
   * 两份各带一套硬编码明暗配色 —— 改阈值或改配色时必须同步两处，必然改漏。
   * 现在文案与 tone 一起产出，配色交给 Badge 的令牌层。
   */
  const expiryBadge = (expiresAt?: string | null, daysLeftRaw?: number) => {
    const daysLeft = typeof daysLeftRaw === "number" && Number.isFinite(daysLeftRaw) ? daysLeftRaw : 0;
    const permanent = isPermanentExpiry(expiresAt);
    const expired = !permanent && daysLeft < 0;
    // 阈值 30 天与后端 renew_threshold_days / 概览页 EXPIRY_WARN_DAYS 同档
    const warning = !permanent && !expired && daysLeft <= 30;
    // 永久域名用 info（蓝）而非 ok（绿）：它没有到期日，
    // 不该被读成「刚续过的健康状态」。
    const tone: BadgeTone = permanent
      ? "info"
      : expired
        ? "danger"
        : warning
          ? "warn"
          : "ok";
    const text = permanent
      ? "永久"
      : expired
        ? `已过期 ${Math.ceil(-daysLeft)} 天`
        : `剩 ${Math.ceil(daysLeft)} 天`;
    return { tone, text, permanent, expired, warning };
  };

  // DNSHE 域名卡片（渲染本体见 features/domains/components/DomainCard，Phase 4-E 抽出）
  //
  // 这里只做「App 闭包 → props」的适配：卡片自身只认 props，跨卡片共享的高亮态、
  // 三点菜单开关、CF 交叉提示判据都在此算好传入，两个调用点（默认/外部域名分组）保持不变。
  const renderDomainCard = (dom: Domain) => (
    <DomainCard
      key={dom.id}
      dom={dom}
      highlighted={dnsheHighlightDomainId === dom.id}
      cfManaged={
        !checkHasDns(dom) &&
        domainKeyCandidates(dom.full_domain).some((k) => cfZoneFullDomainSet.has(k))
      }
      menuOpen={openActionMenuId === dom.id}
      onToggleMenu={() => setOpenActionMenuId(openActionMenuId === dom.id ? null : dom.id)}
      onCloseMenu={() => setOpenActionMenuId(null)}
      onGotoCf={() => gotoCfZone(dom.full_domain)}
      onOpenDns={() => openDnsModal(dom)}
      onOpenNs={() => openNsModal(dom)}
      onRenew={() => handleRenewDomain(dom)}
      onDelete={() => handleOpenDeleteModal(dom)}
      actionLoading={actionLoading}
    />
  );

  // 1. 获取所有域名列表（支持按账号筛选）
  const fetchDomains = async (accountIdFilter?: string) => {
    setLoadingDomains(true);
    try {
      const targetAcc = accountIdFilter ?? selectedAccountFilter;
      const accParam = targetAcc && targetAcc !== "all" ? `&account_id=${targetAcc}` : "";
      const res = await apiFetch(`/api/domains?${accParam}`);
      const data = await res.json();
      if (data.success) {
        const list: Domain[] = data.domains || [];
        setDomains(list);
        // 没有 DNSHE 账号时不做根域 NS 查询：
        // 该结论只用于 DNSHE 线路支持判定，提前对公共根域做 DoH 查询没有业务价值，
        // 反而会在大陆网络环境下产生大量预期内的 Cloudflare/Google DoH 超时日志。
        if (dnsheAccounts.length > 0) {
          const roots = Array.from(
            new Set([
              ...list.map((d) => String(d.rootdomain ?? "").trim().toLowerCase()),
              ...scanner.allRootDomains.map((r) => String(r || "").trim().toLowerCase())
            ])
          ).filter(Boolean);
          void fetchRootNs(roots);
        }
      } else {
        showToast("error", data.message || "拉取域名列表失败");
      }
    } catch (e) {
      showToast("error", "网络连接异常，无法获取域名列表");
    } finally {
      setLoadingDomains(false);
    }
  };

  // ===== 数据导入 / 导出（实现见 features/data/hooks/useDataTransfer） =====
  // NOTE: 调用点必须在本处。导入成功后要调 fetchDomains() / fetchAccountInfo() 刷新列表，
  //       而二者都是本组件里的 `const`（存在 TDZ），在更早的位置传参会在求值参数时抛
  //       ReferenceError。故本 hook 只能挂在两个声明都出现之后。
  const {
    dataOpOpen,
    setDataOpOpen,
    dataOpMode,
    setDataOpMode,
    dataOpToken,
    setDataOpToken,
    importSnapshot,
    setImportSnapshot,
    handleExportData,
    handlePickSnapshotFile,
    handleImportData,
  } = useDataTransfer({ apiFetch, showToast, accountInfo, setActionLoading, fetchDomains, fetchAccountInfo });

  // 2. 获取账号列表 —— 已上移到 AppDataProvider（Phase 2.5），由 useAppData 取得 fetchAccounts。

  /**
   * 刷新某个 provider 的域名列表
   *
   * WHY 需要它：同步完成后的「刷新对应标签页」原先是一串 if/else if，每接入一个
   * 托管商就要往里加一个分支，散落在 4 处调用点（单账号同步 / 批量同步 / 全量同步 /
   * 会话初始化）。收敛到这里后新增托管商只需改这一个函数。
   *
   * NOTE: 四家新托管商的分支转发到 `useMultiProviders` 的 fetchMultiProviderDomains
   * （本函数定义处早于该 hook，但只在事件/回调里调用，运行时已就绪）。
   */
  const refreshProviderDomains = (provider?: string, accountIdFilter?: string) => {
    if (provider && (MULTI_PROVIDER_ORDER as readonly string[]).includes(provider)) {
      return fetchMultiProviderDomains(provider as MultiProviderKey, accountIdFilter);
    }
    if (provider === "cloudflare") return fetchCfZones(accountIdFilter);
    if (provider === "digitalplat") return fetchDpDomains(accountIdFilter);
    return fetchDomains();
  };

  /** 刷新全部托管商的域名列表（会话初始化 / 全量同步后用） */
  const refreshAllProviderDomains = () => {
    fetchCfZones();
    fetchDpDomains();
    MULTI_PROVIDER_ORDER.forEach((key) => fetchMultiProviderDomains(key));
  };

  // 2.5 读取某账号域名缓存的「指纹」：域名条数 + 最新的 updated_at
  //
  // NOTE: 后端每个账号的域名是在一次 db.batch 里整批写入的，所以指纹一变
  //       就说明该账号这一轮后台同步已经落库。新绑定账号从「0 条」变为有域名，
  //       换 Key 重新同步则是 updated_at 被刷新，两种场景都能用同一个信号判断。
  const readAccountDomainFingerprint = async (accountId: number, provider?: string): Promise<string | null> => {
    try {
      // 非 DNSHE 托管商的域名默认被 /api/domains 排除（它们在独立标签页展示），
      // 指纹查询必须显式带上 provider，否则永远返回「0 条」，同步等待逻辑会失效
      const isNonDnshe =
        provider === "cloudflare" ||
        provider === "digitalplat" ||
        provider === "dnspod" ||
        provider === "alidns" ||
        provider === "huaweicloud" ||
        provider === "vercel";
      const providerParam = isNonDnshe ? `&provider=${provider}` : "";
      const res = await apiFetch(`/api/domains?account_id=${accountId}${providerParam}`);
      const data = await res.json();
      if (!data.success) return null;
      const list: Array<Record<string, unknown>> = data.domains || [];
      const newest = list.reduce((max, d) => {
        const v = String(d.updated_at || "");
        return v > max ? v : max;
      }, "");
      return `${list.length}:${newest}`;
    } catch (e) {
      return null;
    }
  };

  // 2.6 等待账号的域名在后端落库后再刷新列表
  //
  // NOTE: 绑定 / 换 Key 接口里的域名同步是 waitUntil 后台任务（逐个域名拉解析记录
  //       判定三态），接口返回「成功」时库里通常还没写完。原先紧接着调 fetchDomains()
  //       只会拿到空列表或旧数据，看起来像「账号绑上了却没有域名」，只能手动刷新页面。
  const waitForAccountDomainSync = async (
    accountIds: number[],
    label: string,
    baseline?: Map<number, string>,
    providerLookup?: (id: number) => string | undefined
  ) => {
    const pending = new Set(accountIds.filter((id) => Number.isFinite(id) && id > 0));
    if (pending.size === 0) {
      fetchDomains();
      return;
    }

    showToast("info", `${label}，正在后台同步域名，完成后自动刷新…`);

    // 后端逐个账号同步，账号之间还有 1.2s 间隔，等待预算随账号数增长
    const deadline = Date.now() + 15_000 + pending.size * 8_000;

    while (pending.size > 0 && Date.now() < deadline) {
      await sleep(1500);

      // 轮询期间会话失效（登出 / 过期）就不再空转
      if (!sessionStorage.getItem("DOMAIN_HUB_SESSION") && !localStorage.getItem("DOMAIN_HUB_SESSION")) return;

      // 逐个账号单独查询，不受域名页当前账号筛选影响
      for (const id of [...pending]) {
        const fingerprint = await readAccountDomainFingerprint(id, providerLookup?.(id));
        // 查询失败（null）不终止等待，下一轮继续
        if (fingerprint !== null && fingerprint !== (baseline?.get(id) ?? "0:")) {
          pending.delete(id);
        }
      }
    }

    // 无论是否等齐都刷新一次列表，让已完成的账号立即可见
    fetchDomains();
    refreshAllProviderDomains();
    // 后端在同步域名之前已经刷过这些账号的配额缓存，这里顺带把配额也拉新
    invalidateQuotaTabCache();
    fetchQuotas();

    if (pending.size === 0) {
      showToast("success", "域名同步完成，列表已刷新");
    } else {
      showToast(
        "warning",
        `${pending.size} 个账号暂未同步到域名（可能仍在后台进行，也可能该账号名下确实没有域名），可稍后点击各页右上角「同步域名」`
      );
    }
  };

  // ===== Cloudflare 标签页状态（与 DNSHE 的状态相互独立，复用同一套后端路由） =====
  // zones 列表 / 账号筛选 / 折叠 / 分组 / 同步动作（实现见 features/cloudflare/hooks/useCfZones）
  // NOTE: 必须在 accounts(Provider) 与 waitForAccountDomainSync 之后调用；
  //       调用点刻意前置于所有 cfZones 只读消费点（跨来源搜索 / 分组 / 卡片渲染）。
  const {
    cfZones,
    loadingCfZones,
    cfAccountFilter,
    setCfAccountFilter,
    cfCollapsedAccounts,
    persistCfCollapsed,
    cfAccountList,
    groupedCfZones,
    cfEditingAccount,
    setCfEditingAccount,
    fetchCfZones,
    handleCfDeleteAccount,
    handleCfSyncZones,
    handleCfUpdateAccount,
    cfToggleAccountCollapse,
    cfToggleAllAccounts,
  } = useCfZones({ setActionLoading, waitForAccountDomainSync });
  // CF「跨来源跳转 + 跳转后定位高亮」（实现见 features/cloudflare/hooks/useCfZoneHighlight）
  const { cfHighlightZoneId, gotoCfZone } = useCfZoneHighlight({
    activeTab,
    cfZones,
    cfCollapsedAccounts,
    persistCfCollapsed,
    setActiveTab,
  });

  // ===== DigitalPlat 标签页状态（域名列表 / 筛选 / 折叠 / 分组 / 同步）=====
  // 实现见 features/digitalplat/hooks/useDpDomains。调用点前置于所有 dpDomains
  // 只读消费点（跨来源搜索 / 分组 / 卡片渲染 / Dashboard 统计）。
  const {
    dpDomains,
    loadingDpDomains,
    dpAccountFilter,
    setDpAccountFilter,
    dpCollapsedAccounts,
    persistDpCollapsed,
    dpAccountList,
    groupedDpDomains,
    fetchDpDomains,
    handleDpSyncDomains,
    dpToggleAccountCollapse,
    dpToggleAllAccounts,
    dpEditingAccount,
    setDpEditingAccount,
    handleDpDeleteAccount,
    handleDpUpdateAccount,
  } = useDpDomains({ setActionLoading, readAccountDomainFingerprint, waitForAccountDomainSync });

  // DP「跨来源跳转 + 跳转后定位高亮」（实现见 features/digitalplat/hooks/useDpZoneHighlight）
  const { dpHighlightDomainId, gotoDpDomain } = useDpZoneHighlight({
    activeTab,
    dpDomains,
    dpAccountFilter,
    setDpAccountFilter,
    dpCollapsedAccounts,
    persistDpCollapsed,
    setActiveTab,
  });

  const { fetchQuotas, fetchLogs, handleClearLogs } = useAppControllerDataActions({
    apiFetch,
    showToast,
    setLoadingQuotas,
    setQuotas,
    setLoadingLogs,
    setLogs,
    setActionLoading,
  });

  // 跨来源聚合搜索：顶部搜索框同时覆盖**所有**服务商（DNSHE / Cloudflare / DigitalPlat /
  // DNSPod / 阿里云 / 华为云 / Vercel / 自定义）。
  // 返回按来源分组的命中列表，供搜索框下方的聚合下拉展示与跳转。
  // NOTE: 消费 multiProviderData，故必须晚于下方 useMultiProviders 的调用点。

  // 域名同步动作（全量 / DNSHE / 单账号）（实现见 features/domains/hooks/useDomainSync）
  // NOTE: 依赖 setActionLoading 与三个 refresh 回调，均在本文上方已声明。
  const { handleSyncDomains, handleSyncDnsheDomains, handleSyncAccount } = useDomainSync({
    setActionLoading,
    refreshDomains: fetchDomains,
    refreshAllProviderDomains,
    refreshProviderDomains,
  });

  // ===== 四个新托管商：状态 / 派生 / 动作（实现见 features/providers/hooks/useMultiProviders） =====
  // NOTE: 必须在此处调用 —— multiSyncOneAccount 依赖上面的 handleSyncAccount，
  //       故晚于 useDomainSync；调用点又需前置于所有只读消费点（跨来源搜索 /
  //       导航 badge / 页面渲染），因此紧接着 useDomainSync 声明。
  const {
    multiProviderData,
    multiProviderLoading,
    multiProviderFilter,
    setMultiProviderFilter,
    multiProviderCollapsed,
    multiProviderAccountLists,
    groupedMultiProviderDomains,
    multiEditingAccount,
    setMultiEditingAccount,
    fetchMultiProviderDomains,
    handleMultiProviderSync,
    multiSyncOneAccount,
    multiToggleAllAccounts,
    multiToggleAccountCollapse,
    handleMultiUpdateAccount,
    handleMultiDeleteAccount,
  } = useMultiProviders({ setActionLoading, waitForAccountDomainSync, handleSyncAccount });

  // 跨来源聚合搜索：见下方 useCustomProviders 之后（消费 multiProviderData / customDomains）。

  // 解绑账号
  const handleDeleteAccount = async (id: number) => {
    if (!confirm("确定要解绑该账号吗？这会同步清除该账号缓存的域名及解析日志！")) return;
    setActionLoading(`delete-account-${id}`);
    try {
      const res = await apiFetch(`/api/accounts/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        showToast("success", "账户解绑成功");
        fetchAccounts();
        fetchDomains();
        // 后端已从配额缓存中摘掉该账号，同步刷新配额列表，避免配额页还列着它
        invalidateQuotaTabCache();
        fetchQuotas();
      } else {
        showToast("error", data.message || "账户解绑失败");
      }
    } catch (e) {
      showToast("error", "解绑请求发送失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 打开修改账号弹窗
  const openEditAccount = (acc: Account) => {
    setEditingAccount(acc);
  };

  // 打开添加域名弹窗
  const handleOpenCreateDomain = (defaultAccountId?: number) => {
    setCreateDomainDefaultAccountId(defaultAccountId);
    setCreateDomainModalOpen(true);
  };

  // 添加域名成功后的全量列表刷新
  const handleCreateDomainSuccess = async (_createdDomain?: Domain) => {
    void fetchDomains();
    void fetchCfZones();
    MULTI_PROVIDER_ORDER.forEach((key) => void fetchMultiProviderDomains(key));
  };

  // 点击添加成功后的「立即配置解析」
  const handleCreateDomainOpenDns = (createdDomain: Domain) => {
    setCreateDomainModalOpen(false);
    handleCfOpenDnsModal(createdDomain);
  };


  // DNSHE 域名行的续期 / 删除动作 + 删除确认弹窗状态（实现见 features/domains/hooks/useDomainActions）
  // NOTE: 必须在此处调用 —— 依赖 setActionLoading（328）与 fetchDomains（1415）/ fetchDpDomains（1467），
  //       三者均已在上方声明；返回的动作只在渲染期（renderDomainCard / JSX）被调用，不存在 TDZ。
  const {
    deleteModalDomain,
    setDeleteModalDomain,
    handleRenewDomain,
    handleOpenDeleteModal,
    handleDeleteDomain,
  } = useDomainActions({ setActionLoading, refreshDomains: fetchDomains, refreshDpDomains: fetchDpDomains });


  // 打开 DNS 解析弹窗（弹窗本体见 features/dns/components/DnsheDnsModal）
  const openDnsModal = (domain: Domain) => {
    setSelectedDomain(domain);
    setDnsModalOpen(true);
  };


  // 删除 DNS 记录
  // NOTE: domain 显式传入 —— NS 弹窗里删除 NS 记录时打开的是 nsModalDomain，
  // 与 DNS 弹窗的 selectedDomain 不一定是同一个域名（甚至可能为 null）。
  const handleDeleteDnsRecord = async (recordId: string | number, domain: Domain | null = selectedDomain) => {
    if (!domain) return;
    if (!confirm("确定要删除这条 DNS 解析记录吗？这会立即影响该域名的解析！")) return;

    setActionLoading(`delete-dns-${recordId}`);
    try {
      const res = await apiFetch(`/api/domains/${domain.id}/dns/${recordId}`, {
        method: "DELETE"
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", "DNS 解析记录删除成功！");
        // 弹窗正显示该域名时递增 refreshToken 触发列表重拉（等价于原 reloadDnsRecords(domain)）
        if (dnsModalOpen && selectedDomain?.id === domain.id) {
          setDnsRefreshToken((n) => n + 1);
        }
        fetchDomains();
      } else {
        showToast("error", data.message || "删除解析记录失败");
      }
    } catch (e) {
      showToast("error", "删除解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };


  // ===== Cloudflare：数据派生与处理函数 =====
  //
  // NOTE: 与 DNSHE 的 DNS 面板保持同样的交互形态（单条添加 / 行内修改 / 批量添加 /
  //       批量修改 / 批量删除），复用同一批后端路由与 dnsrecords.ts 纯逻辑；
  //       差异点只有两个 —— 没有解析线路，多了橙色云代理开关，TTL 1 表示「自动」。

  // ===== 自定义服务商（无 API，三层结构：分组 → 账号 → 域名） =====
  // NOTE: state / 派生 / 动作全部抽出到 features/custom/hooks/useCustomProviders。
  //       调用点落在这里 —— 晚于 isPermanentExpiry（1014，handleSaveCustomDomain / openCustomDomainModal 要用）
  //       与 accounts（AppDataProvider），早于所有只读消费点（跨来源搜索 / 导航 badge / 页面渲染）。
  const {
    customGroupFilter,
    setCustomGroupFilter,
    customGroupList,
    customAccounts,
    customDomains,
    loadingCustomDomains,
    groupedCustomDomains,
    customCollapsedGroups,
    fetchCustomDomains,
    customToggleGroupCollapse,
    customToggleAllGroups,
    customNewGroupOpen,
    setCustomNewGroupOpen,
    customNewGroupAlias,
    setCustomNewGroupAlias,
    customNewGroupWebsite,
    setCustomNewGroupWebsite,
    customNewGroupSaving,
    customNewGroupMode,
    setCustomNewGroupMode,
    customBatchRows,
    setCustomBatchRows,
    customBatchResults,
    setCustomBatchResults,
    handleCreateCustomGroup,
    handleBatchCreateCustomGroups,
    customAccountModalOpen,
    setCustomAccountModalOpen,
    customAccountModalGroup,
    customAccountName,
    setCustomAccountName,
    customAccountSaving,
    openCustomAccountModal,
    handleSaveCustomAccount,
    customDomainModalOpen,
    setCustomDomainModalOpen,
    customDomainModalGroup,
    customDomainModalAccount,
    customDomainModalEditing,
    customDomainFull,
    setCustomDomainFull,
    customDomainRegistered,
    setCustomDomainRegistered,
    customDomainExpiry,
    setCustomDomainExpiry,
    customDomainRemark,
    setCustomDomainRemark,
    customDomainSaving,
    openCustomDomainModal,
    handleSaveCustomDomain,
    customDeleteGroup,
    setCustomDeleteGroup,
    customDeleteAccount,
    setCustomDeleteAccount,
    customDeleteDomain,
    setCustomDeleteDomain,
    handleDeleteCustomAccount,
    handleDeleteCustomDomain,
    handleDeleteCustomGroup,
  } = useCustomProviders({ isPermanentExpiry });

  const { invalidateQuotaTabCache } = useAppControllerDataEffects({
    sessionToken,
    activeTab,
    fetchAccounts,
    fetchDomains,
    refreshAllProviderDomains,
    fetchCustomDomains,
    fetchLogs,
    fetchQuotas: () => { void fetchQuotas(); },
    fetchSettings: () => { void fetchSettings(); },
    fetchAccountInfo: () => { void fetchAccountInfo(); },
  });

  // ===== 注册查重（Scanner）状态 / 派生 / 动作 =====
  // NOTE: 依赖 dnsheAccounts（useDnsheDomains 产出）与 fetchDomains / setActiveTab /
  //       actionLoading，故调用点必须晚于这些声明。
  const scanner = useScanner({
    fetchDomains,
    setActiveTab,
    dnsheAccounts,
    actionLoading,
    setActionLoading,
  });

  // 跨来源聚合搜索：顶部搜索框同时覆盖**所有**服务商（DNSHE / Cloudflare / DigitalPlat /
  // DNSPod / 阿里云 / 华为云 / Vercel / 自定义）。返回按来源分组的命中列表，供搜索框
  // 下方的聚合下拉展示与跳转。
  // NOTE: 消费 multiProviderData 与 customDomains，故必须晚于 useMultiProviders /
  //       useCustomProviders 的调用点。
  const crossSourceSearch = useMemo(() => {
    const kw = globalSearch.trim().toLowerCase();
    if (!kw) return null;
    const dnsheHits = domains.filter((d) => domainMatchesKeyword(d.full_domain, kw));
    const cfHits = cfZones.filter((z) => domainMatchesKeyword(z.full_domain, kw));
    const dpHits = dpDomains.filter((d) => domainMatchesKeyword(d.full_domain, kw));
    const multiHits = {} as Record<MultiProviderKey, Domain[]>;
    MULTI_PROVIDER_ORDER.forEach((key) => {
      multiHits[key] = multiProviderData[key].filter((d) => domainMatchesKeyword(d.full_domain, kw));
    });
    const customHits = customDomains.filter((d) => domainMatchesKeyword(d.full_domain, kw));
    return { kw, dnsheHits, cfHits, dpHits, multiHits, customHits };
  }, [globalSearch, domains, cfZones, dpDomains, multiProviderData, customDomains]);

  const cfZoneFullDomainSet = useMemo(
    () => new Set(cfZones.flatMap((z) => domainKeyCandidates(String(z.full_domain || "")))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cfZones]
  );

  // DNSHE 注册域名集合，供 CF zone 卡片显示「DNSHE 注册」标识
  const dnsheFullDomainSet = useMemo(
    () => new Set(domains.flatMap((d) => domainKeyCandidates(String(d.full_domain || "")))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [domains]
  );

  // DigitalPlat 账号域名集合，供 CF zone 卡片显示「DigitalPlat 注册」跳转提示
  const dpDomainFullDomainSet = useMemo(
    () => new Set(dpDomains.flatMap((d) => domainKeyCandidates(String(d.full_domain || "")))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dpDomains]
  );

  // Cloudflare zone 注册/到期时间：缓存 + 手动覆盖 + RDAP 自动查询（实现见 features/cloudflare/hooks/useCfExpiry）
  // NOTE: 必须在 cfZones / dpDomains / dnsheFullDomainSet / dpDomainFullDomainSet 之后调用；
  //       内部 effect 依赖 activeTab/cfZones，返回的 cfZoneDateInfo 供卡片与编辑弹窗共用。
  const { cfExpiryMap, persistCfExpiryMap, cfZoneDateInfo } = useCfExpiry({
    activeTab,
    cfZones,
    domains,
    dpDomains,
    dnsheFullDomainSet,
    dpDomainFullDomainSet,
  });

  // 打开 CF zone 注册信息编辑弹窗（手动值由弹窗挂载时自行预填，见 features/cloudflare/components/CfEditModal）
  const openCfEditZone = (zone: Domain) => {
    setCfEditZone(zone);
    setCfEditOpen(true);
  };


  // 交叉提示跳转（CF zone 卡片「注册来源 = DNSHE」→ DNSHE 域名列表页）：切页、清搜索、展开账号并定位
  const gotoDnsheDomain = (fullDomain: string) => {
    const keys = domainKeyCandidates(String(fullDomain || ""));
    const dom = domains.find((d) =>
      domainKeyCandidates(String(d.full_domain || "")).some((k) => keys.includes(k))
    );
    // 搜索过滤若收窄到其它关键词会让目标卡片不可见，跳转时一律清空搜索
    if (globalSearch) setGlobalSearch("");
    setActiveTab("domains");
    if (!dom) return;
    if (collapsedAccounts.has(dom.account_id)) {
      persistCollapsed(new Set([...collapsedAccounts].filter((id) => id !== dom.account_id)));
    }
    setDnsheHighlightDomainId(dom.id);
  };

  // 定位高亮（DNSHE）：与 dpHighlightDomainId 的 effect 一致
  useEffect(() => {
    if (dnsheHighlightDomainId === null || activeTab !== "domains") return;
    const scrollTimer = window.setTimeout(() => {
      document.getElementById(`dnshe-domain-card-${dnsheHighlightDomainId}`)?.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
    }, 150);
    const clearTimer = window.setTimeout(() => setDnsheHighlightDomainId(null), 4000);
    return () => {
      window.clearTimeout(scrollTimer);
      window.clearTimeout(clearTimer);
    };
  }, [dnsheHighlightDomainId, activeTab]);

  const { toJumpSource, handleCrossSourceJump } = useAppControllerNavigation({
    activeTab,
    setActiveTab,
    setGlobalSearch,
    setDnsheMenuOpen,
    setMultiProviderFilter,
    gotoDnsheDomain,
    gotoCfZone,
    gotoDpDomain,
  });

  // 渲染单个 Cloudflare zone 卡片（渲染本体见 features/cloudflare/components/CfZoneCard，Phase 5-4b 抽出）
  //
  // 这里只做「App 闭包 → props」的适配：跨卡片共享的高亮态、编辑/解析/跳转回调都在此传入，
  // 调用点 {group.zones.map(renderCfZoneCard)} 保持不变。
  const renderCfZoneCard = (zone: Domain) => (
    <CfZoneCard
      key={zone.id}
      zone={zone}
      highlighted={zone.id === cfHighlightZoneId}
      cfZoneDateInfo={cfZoneDateInfo}
      onOpenEdit={() => openCfEditZone(zone)}
      onOpenDns={() => handleCfOpenDnsModal(zone)}
      onGotoDnshe={() => gotoDnsheDomain(zone.full_domain)}
      onGotoDp={() => gotoDpDomain(zone.full_domain)}
    />
  );

  // ===== 四个新托管商：账号绑定 / 批量绑定 / 编辑 / 解绑（共用一套 handler） =====
  //
  // NOTE: 表驱动 —— 三个双凭据型（DNSPod 的 SecretId/SecretKey、阿里云
  // AccessKeyId/Secret、华为云 AK/SK）走 api_key + api_secret；Vercel 是单
  // Token 型，只填 secondary，前端按 meta.singleCredential 决定渲染几个输入框。



  const handleUpdateAccount = async (fields: { alias: string; primary: string; secondary: string }) => {
    const { alias: editAlias, primary: editApiKey, secondary: editApiSecret } = fields;
    if (!editingAccount) return;
    if (!editAlias.trim()) {
      showToast("error", "账户别名不能为空");
      return;
    }
    if (Boolean(editApiKey.trim()) !== Boolean(editApiSecret.trim())) {
      showToast("error", "更换 API 密钥时，API Key 与 API Secret 需同时填写（留空则保持不变）");
      return;
    }
    setActionLoading(`update-account-${editingAccount.id}`);
    const accountId = editingAccount.id;
    try {
      const body: Record<string, string> = { alias: editAlias.trim() };
      const keyChanged = Boolean(editApiKey.trim() && editApiSecret.trim());
      if (keyChanged) {
        body.api_key = editApiKey.trim();
        body.api_secret = editApiSecret.trim();
      }

      // 换 Key 会触发后台重新深度同步，先记下当前指纹作为「同步已生效」的对照基线
      const baseline = new Map<number, string>();
      if (keyChanged) {
        const current = await readAccountDomainFingerprint(accountId);
        if (current !== null) baseline.set(accountId, current);
      }

      const res = await apiFetch(`/api/accounts/${accountId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", data.message || "账号信息已更新");
        setEditingAccount(null);
        fetchAccounts();
        if (keyChanged) {
          // 只改别名时后端不会重新同步域名，没必要轮询
          waitForAccountDomainSync([accountId], "API 密钥已更换", baseline);
        } else {
          fetchDomains();
          // 后端已就地改掉配额缓存里的别名，刷新一次让配额页的标题跟上
          invalidateQuotaTabCache();
          fetchQuotas();
        }
      } else {
        // 密钥框非空却失败，多半是被密码管理器预填的登录凭据当成了新密钥送去校验
        const hint = keyChanged ? "（若 API Key/Secret 是浏览器自动填充的，请清空这两个框后重试）" : "";
        showToast("error", `${data.message || "更新账号失败"}${hint}`);
      }
    } catch (e) {
      showToast("error", "更新账号请求失败");
    } finally {
      setActionLoading(null);
    }
  };


  // DigitalPlat 域名卡片（渲染本体见 features/domains/components/DpDomainCard，Phase 4-F 抽出）
  //
  // 与 DomainCard 同样的「App 闭包 → props」适配层；域名分组里的调用点保持不变。
  const renderDpDomainCard = (dom: Domain) => (
    <DpDomainCard
      key={dom.id}
      dom={dom}
      highlighted={dpHighlightDomainId === dom.id}
      cfManaged={
        !checkHasDns(dom) &&
        domainKeyCandidates(dom.full_domain).some((k) => cfZoneFullDomainSet.has(k))
      }
      menuOpen={openActionMenuId === dom.id}
      onToggleMenu={() => setOpenActionMenuId(openActionMenuId === dom.id ? null : dom.id)}
      onCloseMenu={() => setOpenActionMenuId(null)}
      onGotoCf={() => gotoCfZone(dom.full_domain)}
      onOpenDns={() => handleDpOpenDnsModal(dom)}
      onOpenNs={() => openDpNsModal(dom)}
      onDelete={() => handleOpenDeleteModal(dom)}
    />
  );

  // 四个新托管商的域名单卡（渲染本体见 features/providers/components/MultiProviderDomainCard）
  //
  // 与 DpDomainCard 同样的「App 闭包 → props」适配层；四家的卡片结构一致，
  // 差异由 providerKey 驱动，故仍是一份适配器而不是四份。
  const renderMultiProviderDomainCard = (key: MultiProviderKey, dom: Domain) => (
    <MultiProviderDomainCard
      key={dom.id}
      providerKey={key}
      dom={dom}
      onOpenDns={() => handleCfOpenDnsModal(dom)}
    />
  );

  // 四个新托管商的标签页渲染已抽出为 features/providers/components/MultiProviderPage
  // （Phase 7-1，表驱动共用一份 JSX，调用点见下方 activeTab 分发）。

  // 自定义服务商的单张域名单卡（渲染本体见 features/custom/components/CustomDomainCard）
  //
  // 与 DpDomainCard 同样的「App 闭包 → props」适配层：注入 expiryBadge 的产物、
  // 「是否已在 Cloudflare 托管」的判定（依赖 cfZoneFullDomainSet），以及编辑 /
  // 删除 / 跳 CF 三个动作。groupId / groupAlias / account 由页面在遍历时透传。
  const renderCustomDomainCard = (
    groupId: number,
    groupAlias: string,
    account: CustomAccount | null,
    dom: CustomDomain & { daysLeft: number }
  ) => (
    <CustomDomainCard
      key={dom.id}
      dom={dom}
      badge={expiryBadge(dom.expires_at, dom.daysLeft)}
      cfManaged={isCfManaged(dom.full_domain, cfZoneFullDomainSet)}
      onGotoCf={() => gotoCfZone(dom.full_domain)}
      onEdit={() =>
        openCustomDomainModal(
          { id: groupId, alias: groupAlias, api_key: "", created_at: "" } as Account,
          account,
          dom
        )
      }
      onDelete={() => setCustomDeleteDomain(dom)}
    />
  );

  // 日志清理动作由 useAppControllerDataActions 统一提供。

  // ===== 注册查重（Scanner）派生与处理函数 =====
  // NOTE: handleCheckWhois / handleRegisterSubdomain / 根域名增删 / rulePreview / 顺序模式生成器 /
  //       断点续查 / 保留前缀 / 词库增删改 / handleStartBatchScan / handleExportAvailableTxt
  //       全部抽出到 features/scanner/hooks/useScanner（App 通过 scanner.* 调用）。
  const {
    lineNsSuffixes,
    newLineNsInput,
    setNewLineNsInput,
    rootNs,
    learnedLineRoots,
    nsHostMatchesSuffix,
    domainSupportsLine,
    fetchRootNs,
    learnLineRootFrom,
    handleAddLineNsSuffix,
    handleRemoveLineNsSuffix,
    handleRestoreLineNsSuffixes,
    handleClearLearnedLineRoots,
    handleRefreshRootNs,
    knownRootDomains,
  } = useLineDnsSettings({
    domains,
    scannerRootDomains: scanner.allRootDomains,
    dnsheAccountCount: dnsheAccounts.length,
    apiFetch,
    showToast,
    setActionLoading,
  });

  // 动态服务商菜单项：按该服务商账号的「最早添加时间」动态排序
  // 只有真正绑定了账号的服务商才会显示，且不再受 loadingAccounts 影响，杜绝刷新时一闪而过的闪烁。
  const providerNavItems = useMemo(
    () =>
      buildProviderNavItems(accounts, {
        dnshe: domains.length,
        cloudflare: cfZones.length,
        digitalplat: dpDomains.length,
        dnspod: multiProviderData.dnspod.length,
        alidns: multiProviderData.alidns.length,
        huaweicloud: multiProviderData.huaweicloud.length,
        vercel: multiProviderData.vercel.length,
      }),
    [
      accounts,
      domains.length,
      cfZones.length,
      dpDomains.length,
      multiProviderData.dnspod.length,
      multiProviderData.alidns.length,
      multiProviderData.huaweicloud.length,
      multiProviderData.vercel.length
    ]
  );

  /** 实际渲染的侧栏菜单项:概览 + 动态排序的服务商 + 自定义 + 管理项 */
  const visibleNavItems = useMemo(
    () => buildVisibleNavItems(providerNavItems, customDomains.length, accounts.length),
    [providerNavItems, customDomains.length, accounts.length]
  );

  const { alertLogs, unreadAlert, markAlertsRead, filteredLogs } = useAppAlerts(logs, logCategory);

  // Dashboard 概览统计（实现见 features/dashboard/hooks/useDashboardStats）
  const dashboardStats = useDashboardStats({
    domains,
    cfZones,
    dpDomains,
    customDomains,
    dnsheAccounts,
    cfAccountList,
    dpAccountList,
    customGroupList,
    cfExpiryMap,
  });

  // 顶部搜索提交：跳转到域名页并带入搜索词
  const handleGlobalSearchSubmit = () => {
    if (activeTab !== "domains") setActiveTab("domains");
  };

  // ===== 未登录：展示登录 / 首次初始化页面 =====
  // NOTE: 登录页 / 首次初始化页的 JSX（含「鉴权状态未加载完成」的加载态）已随
  //       Phase 3 迁入 features/auth/components/LoginPage —— 那约 135 行是 auth 域
  //       唯一的视图，留在这里会让 App 同时承担「应用装配」与「登录界面细节」。
  //       它需要的 18 个受控值全部来自同一个 useAuthSession() 返回对象，
  //       故整体传 `auth`，不摊平成 18 个 props（理由见 LoginPage 头注释）。
  if (!sessionToken) {
    return <LoginPage auth={auth} toast={toast} />;
  }

  return (
    <>
    <AppShell
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      visibleNavItems={visibleNavItems}
      dnsheMenuOpen={dnsheMenuOpen}
      setDnsheMenuOpen={setDnsheMenuOpen}
      globalSearch={globalSearch}
      setGlobalSearch={setGlobalSearch}
      searchFocused={searchFocused}
      setSearchFocused={setSearchFocused}
      crossSourceSearch={crossSourceSearch}
      onGlobalSearchSubmit={handleGlobalSearchSubmit}
      onCrossSourceJump={handleCrossSourceJump}
      notifOpen={notifOpen}
      setNotifOpen={setNotifOpen}
      notifRef={notifRef}
      alertLogs={alertLogs}
      unreadAlert={unreadAlert}
      markAlertsRead={markAlertsRead}
      theme={theme}
      setTheme={setTheme}
      onLogout={handleLogout}
      apiFetch={apiFetch}
    >
      {/* 标签页均为 React.lazy 按需加载的独立 chunk，切换时展示统一骨架 */}
      <Suspense
        fallback={
          <div className="flex justify-center py-24">
            <RefreshCw className="w-6 h-6 animate-spin text-accent" />
          </div>
        }
      >
        {/* Tab 0: Dashboard 概览 */}
        {activeTab === "dashboard" && (
          <DashboardPage
            stats={dashboardStats}
            syncing={actionLoading === "sync-all"}
            onSyncAll={handleSyncDomains}
            onGotoTab={setActiveTab}
            onJump={handleCrossSourceJump}
            toJumpSource={toJumpSource}
          />
        )}

        {/* Tab 5: 域名注册与查重 */}
        {activeTab === "register" && (
          <RegisterPage scanner={scanner} dnsheAccounts={dnsheAccounts} actionLoading={actionLoading} />
        )}

        {/* Tab 1: 域名列表 */}
        {activeTab === "domains" && (
          <DomainsPage
            selectedAccountFilter={selectedAccountFilter}
            onSelectAccountFilter={setSelectedAccountFilter}
            dnsheAccounts={dnsheAccounts}
            fetchDomains={fetchDomains}
            globalSearch={globalSearch}
            onClearSearch={() => setGlobalSearch("")}
            searchHitCount={searchHitCount}
            domainsCount={domains.length}
            actionLoading={actionLoading}
            onSyncDnsheDomains={handleSyncDnsheDomains}
            collapsedAccounts={collapsedAccounts}
            onToggleAllAccounts={toggleAllAccounts}
            loadingDomains={loadingDomains}
            groupedDomains={groupedDomains}
            checkHasDns={checkHasDns}
            onToggleAccountCollapse={toggleAccountCollapse}
            onSyncAccount={handleSyncAccount}
            renderDomainCard={renderDomainCard}
          />
        )}

        {/* Tab 1.5: Cloudflare 独立标签页 */}
        {activeTab === "cloudflare" && (
          <CfZonesPage
            cfAccountFilter={cfAccountFilter}
            setCfAccountFilter={setCfAccountFilter}
            cfAccountList={cfAccountList}
            cfZones={cfZones}
            loadingCfZones={loadingCfZones}
            actionLoading={actionLoading}
            onAddDomain={() => {
              const preselected = cfAccountFilter !== "all" ? Number(cfAccountFilter) : cfAccountList[0]?.id;
              handleOpenCreateDomain(preselected);
            }}
            handleCfSyncZones={handleCfSyncZones}
            cfToggleAllAccounts={cfToggleAllAccounts}
            cfCollapsedAccounts={cfCollapsedAccounts}
            groupedCfZones={groupedCfZones}
            cfToggleAccountCollapse={cfToggleAccountCollapse}
            handleSyncAccount={handleSyncAccount}
            fetchCfZones={fetchCfZones}
            renderCfZoneCard={renderCfZoneCard}
            onGotoAccounts={() => setActiveTab("accounts")}
          />
        )}

        {/* DigitalPlat 标签页（结构与 Cloudflare 标签页同构：账号分组 → 域名卡片 → DNS 面板） */}
        {activeTab === "digitalplat" && (
          <DpZonesPage
            dpAccountFilter={dpAccountFilter}
            setDpAccountFilter={setDpAccountFilter}
            dpAccountList={dpAccountList}
            dpDomains={dpDomains}
            loadingDpDomains={loadingDpDomains}
            actionLoading={actionLoading}
            handleDpSyncDomains={handleDpSyncDomains}
            dpToggleAllAccounts={dpToggleAllAccounts}
            dpCollapsedAccounts={dpCollapsedAccounts}
            groupedDpDomains={groupedDpDomains}
            dpToggleAccountCollapse={dpToggleAccountCollapse}
            handleSyncAccount={handleSyncAccount}
            fetchDpDomains={fetchDpDomains}
            renderDpDomainCard={renderDpDomainCard}
            onGotoAccounts={() => setActiveTab("accounts")}
          />
        )}

        {/* 四个新托管商（DNSPod / 阿里云 DNS / 华为云 DNS / Vercel）
            共用同一段渲染，靠 key 切换到各自的数据槽位 */}
        {MULTI_PROVIDER_ORDER.map(
          (key) =>
            activeTab === key && (
              <MultiProviderPage
                providerKey={key}
                accountFilter={multiProviderFilter[key]}
                setAccountFilter={(v) =>
                  setMultiProviderFilter((prev) => ({ ...prev, [key]: v }))
                }
                accountList={multiProviderAccountLists[key]}
                domains={multiProviderData[key]}
                loading={multiProviderLoading[key]}
                actionLoading={actionLoading}
                onAddDomain={() => {
                  const filterVal = multiProviderFilter[key];
                  const list = multiProviderAccountLists[key];
                  const preselected = filterVal !== "all" ? Number(filterVal) : list[0]?.id;
                  handleOpenCreateDomain(preselected);
                }}
                onSyncAll={() => handleMultiProviderSync(key)}
                onToggleAllAccounts={() => multiToggleAllAccounts(key)}
                collapsedAccounts={multiProviderCollapsed[key]}
                groupedDomains={groupedMultiProviderDomains[key]}
                onToggleAccountCollapse={(accountId) => multiToggleAccountCollapse(key, accountId)}
                onSyncAccount={(accountId) => multiSyncOneAccount(key, accountId)}
                onFetchDomains={(f) => fetchMultiProviderDomains(key, f)}
                renderDomainCard={(dom) => renderMultiProviderDomainCard(key, dom)}
                onGotoAccounts={() => setActiveTab("accounts")}
              />
            )
        )}

        {/* 自定义服务商（无 API 的社区公益域名，三层：分组 → 账号 → 域名） */}
        {activeTab === "custom" && (
          <CustomProvidersPage
            customGroupFilter={customGroupFilter}
            setCustomGroupFilter={setCustomGroupFilter}
            customGroupList={customGroupList}
            customAccountCount={customAccounts.length}
            customDomainCount={customDomains.length}
            loadingCustomDomains={loadingCustomDomains}
            groupedCustomDomains={groupedCustomDomains}
            customCollapsedGroups={customCollapsedGroups}
            onRefresh={() => fetchCustomDomains()}
            onToggleAllGroups={customToggleAllGroups}
            onToggleGroupCollapse={customToggleGroupCollapse}
            onOpenNewGroup={() => setCustomNewGroupOpen(true)}
            onAddAccount={openCustomAccountModal}
            onAddDomain={(group, account, editing) =>
              openCustomDomainModal(group, account, editing as CustomDomain | undefined)
            }
            onRequestDeleteGroup={setCustomDeleteGroup}
            onRequestDeleteAccount={(acc) => setCustomDeleteAccount(acc as CustomAccount)}
            renderDomainCard={renderCustomDomainCard}
          />
        )}

        {/* 新建自定义服务商分组弹窗（单个 / 批量，Phase 8 抽出） */}
        <CustomGroupModal
          open={customNewGroupOpen}
          onClose={() => setCustomNewGroupOpen(false)}
          saving={customNewGroupSaving}
          mode={customNewGroupMode}
          setMode={setCustomNewGroupMode}
          alias={customNewGroupAlias}
          setAlias={setCustomNewGroupAlias}
          website={customNewGroupWebsite}
          setWebsite={setCustomNewGroupWebsite}
          batchRows={customBatchRows}
          setBatchRows={setCustomBatchRows}
          batchResults={customBatchResults}
          setBatchResults={setCustomBatchResults}
          onCreate={handleCreateCustomGroup}
          onBatchCreate={handleBatchCreateCustomGroups}
        />

        {/* 添加/编辑手动域名弹窗（Phase 8 抽出） */}
        <CustomDomainModal
          open={customDomainModalOpen}
          onClose={() => setCustomDomainModalOpen(false)}
          saving={customDomainSaving}
          group={customDomainModalGroup}
          account={customDomainModalAccount}
          editing={customDomainModalEditing}
          full={customDomainFull}
          setFull={setCustomDomainFull}
          registered={customDomainRegistered}
          setRegistered={setCustomDomainRegistered}
          expiry={customDomainExpiry}
          setExpiry={setCustomDomainExpiry}
          remark={customDomainRemark}
          setRemark={setCustomDomainRemark}
          onSave={handleSaveCustomDomain}
        />

        {/* 添加账号弹窗（Phase 8 抽出） */}
        <CustomAccountModal
          open={customAccountModalOpen}
          onClose={() => setCustomAccountModalOpen(false)}
          saving={customAccountSaving}
          group={customAccountModalGroup}
          name={customAccountName}
          setName={setCustomAccountName}
          onSave={handleSaveCustomAccount}
        />

        {/* 三个删除确认弹窗（Phase 8 抽出） */}
        <CustomDeleteAccountModal
          account={customDeleteAccount}
          onCancel={() => setCustomDeleteAccount(null)}
          onConfirm={handleDeleteCustomAccount}
        />
        <CustomDeleteGroupModal
          group={customDeleteGroup}
          onCancel={() => setCustomDeleteGroup(null)}
          onConfirm={handleDeleteCustomGroup}
        />
        <CustomDeleteDomainModal
          domain={customDeleteDomain}
          onCancel={() => setCustomDeleteDomain(null)}
          onConfirm={handleDeleteCustomDomain}
        />



        {/* DNS 解析记录面板（DNSHE / Cloudflare / DigitalPlat / DNSPod /
            阿里云 / 华为云 / Vercel 七家共用，后端按 account_provider 分发） */}
        <DnsRecordPanel {...dnsPanelProps} />


        {/* Tab 2: 账号管理 */}
        {/* Tab 2: 账号管理（按服务商分组的账号列表，绑定入口由回调触发弹窗） */}
        {activeTab === "accounts" && (
          <AccountsPage
            dnsheAccounts={dnsheAccounts}
            cfAccountList={cfAccountList}
            dpAccountList={dpAccountList}
            multiProviderAccountLists={multiProviderAccountLists}
            loadingAccounts={loadingAccounts}
            actionLoading={actionLoading}
            multiProviderOrder={MULTI_PROVIDER_ORDER}
            multiProviderMeta={MULTI_PROVIDER_META}
            onAddAccount={() => {
              setBindModalOpen(true);
            }}
            onEditDnshe={(acc) => openEditAccount(acc)}
            onEditCf={(acc) => setCfEditingAccount(acc)}
            onEditDp={(acc) => setDpEditingAccount(acc)}
            onEditMulti={(_key, acc) => setMultiEditingAccount(acc)}
            onDeleteDnshe={(acc) => { void handleDeleteAccount(acc.id); }}
            onDeleteCf={(acc) => { void handleCfDeleteAccount(acc); }}
            onDeleteDp={(acc) => { void handleDpDeleteAccount(acc); }}
            onDeleteMulti={(key, acc) => { void handleMultiDeleteAccount(key, acc); }}
          />
        )}

        {editingAccount && (
          <EditAccountModal
            account={editingAccount}
            onClose={() => setEditingAccount(null)}
            title="修改账号"
            icon={<Settings className="w-5 h-5 text-accent" />}
            actionKeyPrefix="update-account"
            actionLoading={actionLoading}
            onSave={handleUpdateAccount}
            aliasName="dnshe-account-alias"
            primary={{
              label: "API Key（留空保持不变）",
              name: "dnshe-edit-api-key",
              placeholder: `当前: ${editingAccount.api_key.substring(0, 8)}***${editingAccount.api_key.substring(editingAccount.api_key.length - 4)}`,
              className: "w-full form-input px-3 py-2.5 rounded-lg text-sm text-content-secondary font-mono",
            }}
            secondary={{
              label: "API Secret（留空保持不变）",
              name: "dnshe-edit-api-secret",
              placeholder: "如需更换密钥则填写新的 API Secret",
              secret: true,
              className: "w-full form-input px-3 py-2.5 rounded-lg text-sm text-content-secondary",
            }}
            note="仅修改别名时无需填写密钥；更换 API Key/Secret 会校验新密钥有效性，并自动重新同步该账号的域名缓存。"
          />
        )}

        {/* Cloudflare 编辑账号弹窗 */}
        {cfEditingAccount && (
          <EditAccountModal
            account={cfEditingAccount}
            onClose={() => setCfEditingAccount(null)}
            title="编辑 Cloudflare 账号"
            icon={<Pencil className="w-5 h-5 text-accent" />}
            actionKeyPrefix="cf-update-account"
            actionLoading={actionLoading}
            onSave={handleCfUpdateAccount}
            aliasName="cf-edit-alias"
            secondary={{
              label: "API Token（留空保持不变）",
              name: "cf-edit-token",
              placeholder: "如需更换凭据则填写新的 API Token",
              secret: true,
              className: "w-full form-input px-3 py-2.5 rounded-lg text-sm text-content-secondary font-mono",
            }}
            note="仅修改别名时无需填写 Token；更换 Token 会校验新 Token 有效性，并自动重新同步该账号的 zones。"
          />
        )}

        {/* DigitalPlat 编辑账号弹窗 */}
        {dpEditingAccount && (
          <EditAccountModal
            account={dpEditingAccount}
            onClose={() => setDpEditingAccount(null)}
            title="编辑 DigitalPlat 账号"
            icon={<Pencil className="w-5 h-5 text-accent" />}
            actionKeyPrefix="dp-update-account"
            actionLoading={actionLoading}
            onSave={handleDpUpdateAccount}
            aliasName="dp-edit-alias"
            secondary={{
              label: "API Key（留空保持不变）",
              name: "dp-edit-key",
              placeholder: "如需更换凭据则填写新的 API Key",
              secret: true,
              className: "w-full form-input px-3 py-2.5 rounded-lg text-sm text-content-secondary font-mono",
            }}
            note="仅修改别名时无需填写 Key；更换 Key 会校验新 Key 有效性，并自动重新同步该账号的域名。"
          />
        )}

        {/* 四个新托管商的账号编辑弹窗（表驱动共用一份） */}
        {multiEditingAccount &&
          (() => {
            const key = multiEditingAccount.provider as MultiProviderKey;
            const meta = MULTI_PROVIDER_META[key];
            if (!meta) return null;
            return (
              <EditAccountModal
                account={multiEditingAccount}
                onClose={() => setMultiEditingAccount(null)}
                title={`编辑 ${meta.label} 账号`}
                icon={<Pencil className="w-5 h-5 text-accent" />}
                actionKeyPrefix="multi-update"
                actionLoading={actionLoading}
                onSave={(f) => handleMultiUpdateAccount(key, f)}
                aliasName={`${key}-edit-alias`}
                primary={meta.singleCredential ? undefined : {
                  label: `${meta.primaryLabel}（留空保持不变）`,
                  name: `${key}-edit-primary`,
                  spellCheck: false,
                  placeholder: `如需更换凭据则填写新的 ${meta.primaryLabel}`,
                  className: "w-full form-input px-3 py-2.5 rounded-lg text-sm text-content-secondary font-mono",
                }}
                secondary={{
                  label: `${meta.secondaryLabel}（留空保持不变）`,
                  name: `${key}-edit-secondary`,
                  placeholder: `如需更换凭据则填写新的 ${meta.secondaryLabel}`,
                  secret: true,
                  className: "w-full form-input px-3 py-2.5 rounded-lg text-sm text-content-secondary font-mono",
                }}
                note="仅修改别名时无需填写凭据；更换凭据会校验其有效性，并自动重新同步该账号的域名。"
              />
            );
          })()}

        {/* 绑定账号弹窗（统一承载全部托管商与 单个 / 批量） */}
        {/* 绑定账号弹窗（Phase 3-A 已抽出为 BindAccountModal） */}
        {bindModalOpen && (
          <BindAccountModal
            open={bindModalOpen}
            onClose={() => setBindModalOpen(false)}
            actionLoading={actionLoading}
            setActionLoading={setActionLoading}
            waitForAccountDomainSync={waitForAccountDomainSync}
            fetchCfZones={fetchCfZones}
            fetchDpDomains={fetchDpDomains}
            fetchMultiProviderDomains={fetchMultiProviderDomains}
          />
        )}
        <WordBankModal
          open={scanner.bankModalOpen}
          editingBank={scanner.editingBank}
          formKind={scanner.bankFormKind}
          formName={scanner.bankFormName}
          formWords={scanner.bankFormWords}
          onClose={() => scanner.setBankModalOpen(false)}
          onKindChange={scanner.setBankFormKind}
          onNameChange={scanner.setBankFormName}
          onWordsChange={scanner.setBankFormWords}
          onSave={scanner.handleSaveBank}
        />

        {/* Tab 3: 账户配额（DNSHE 专属，已归入侧栏 DNSHE 子菜单） */}
        {activeTab === "quota" && (
          <QuotaPage quotas={quotas} loadingQuotas={loadingQuotas} fetchQuotas={fetchQuotas} />
        )}

        {/* Tab 4: 解析线路（DNSHE 专属 —— 线路是 DNSHE 的解析特性，已从设置页移出） */}
        {/* Tab 4: 解析线路（DNSHE 专属 —— 线路是 DNSHE 的解析特性，已从设置页移出） */}
        {activeTab === "line-settings" && (
          <LineSettingsPage
            lineNsSuffixes={lineNsSuffixes}
            onRemoveSuffix={handleRemoveLineNsSuffix}
            newLineNsInput={newLineNsInput}
            setNewLineNsInput={setNewLineNsInput}
            onAddSuffix={handleAddLineNsSuffix}
            onRestoreSuffixes={handleRestoreLineNsSuffixes}
            knownRootDomains={knownRootDomains}
            rootNs={rootNs}
            hasDnsheAccount={dnsheAccounts.length > 0}
            learnedLineRoots={learnedLineRoots}
            onClearLearnedLineRoots={handleClearLearnedLineRoots}
            onRefreshRootNs={handleRefreshRootNs}
            nsHostMatchesSuffix={nsHostMatchesSuffix}
            actionLoading={actionLoading}
          />
        )}

        {/* Tab 4: 运行日志 */}
        {activeTab === "logs" && (
          <LogsPage
            logs={filteredLogs}
            loadingLogs={loadingLogs}
            logCategory={logCategory}
            setLogCategory={setLogCategory}
            actionLoading={actionLoading}
            onClearLogs={handleClearLogs}
          />
        )}

        {/* Tab 7: 设置 */}
        {activeTab === "settings" && (
          <SettingsPage
            s={settingsPage}
            theme={theme}
            setTheme={setTheme}
            colorTheme={colorTheme}
            setColorTheme={setColorTheme}
            backendUrl={backendUrl}
            onOpenDataOp={(mode) => { setDataOpToken(""); setDataOpMode(mode); setDataOpOpen(true); }}
          />
        )}
      </Suspense>

    </AppShell>
    {/* 全局模态框 / Toast：与外壳平级，均为 fixed 覆盖层 */}

      {/* DNS 解析管理模态框 (Modal) */}
      {dnsModalOpen && selectedDomain && (
        <DnsheDnsModal
          open={dnsModalOpen}
          domain={selectedDomain}
          onClose={() => setDnsModalOpen(false)}
          actionLoading={actionLoading}
          setActionLoading={setActionLoading}
          domainSupportsLine={domainSupportsLine}
          learnLineRootFrom={learnLineRootFrom}
          onDomainsChanged={fetchDomains}
          onDeleteRecord={handleDeleteDnsRecord}
          refreshToken={dnsRefreshToken}
        />
      )}

      {/* NS 域名服务器修改与重置模态框 (NS Modal) */}
      {/* 删除域名确认弹窗 —— 不可逆操作，需输入完整域名二次确认（Phase 4-A 已抽出） */}
      {deleteModalDomain && (
        <DeleteDomainModal
          domain={deleteModalDomain}
          onClose={() => setDeleteModalDomain(null)}
          actionLoading={actionLoading}
          onConfirm={handleDeleteDomain}
        />
      )}

      {/* 数据导入 / 导出二次验证弹窗 —— 导出必须通过 2FA；导入在已开启 2FA 时同样需要 */}
      <DataOpModal
        open={dataOpOpen}
        mode={dataOpMode}
        onClose={() => { setDataOpOpen(false); setDataOpToken(""); setImportSnapshot(null); }}
        token={dataOpToken}
        onTokenChange={setDataOpToken}
        importSnapshot={importSnapshot}
        onPickFile={handlePickSnapshotFile}
        twoFaEnabled={accountInfo.two_fa_enabled}
        busy={actionLoading === "data-export" || actionLoading === "data-import"}
        onExport={handleExportData}
        onImport={handleImportData}
      />

      {/* DigitalPlat 域名「修改 NS 记录」弹窗 —— 结构对齐 DNSHE NS 弹窗：草稿列表 + 批量添加 + 一键恢复默认，
          注册局级整组替换，点「保存替换」才真正 PATCH */}
      {/* CF zone 注册信息手动编辑：注册/到期时间 + 注册来源（RDAP 查不到的域名可自行录入） */}
      {cfEditOpen && cfEditZone && (
        <CfEditModal
          open={cfEditOpen}
          zone={cfEditZone}
          onClose={() => setCfEditOpen(false)}
          cfExpiryMap={cfExpiryMap}
          persistCfExpiryMap={persistCfExpiryMap}
          cfZoneDateInfo={cfZoneDateInfo}
        />
      )}

      {dpNsModalOpen && dpNsModalDomain && (
        <DpNameserverModal
          open={dpNsModalOpen}
          domain={dpNsModalDomain}
          onClose={() => setDpNsModalOpen(false)}
          onSaved={() => fetchDpDomains(dpAccountFilter)}
        />
      )}

      {nsModalOpen && nsModalDomain && (
        <NameserverModal
          open={nsModalOpen}
          domain={nsModalDomain}
          onClose={() => setNsModalOpen(false)}
          actionLoading={actionLoading}
          setActionLoading={setActionLoading}
          checkHasDns={checkHasDns}
          getDnsProviderLabel={getDnsProviderLabel}
          onDeleteDnsRecord={handleDeleteDnsRecord}
          onSynced={handleSyncDnsheDomains}
        />
      )}

      {/* 在线添加域名托管弹窗（支持 DNSPod / Cloudflare / 阿里云 DNS / 华为云 DNS / Vercel） */}
      <CreateDomainModal
        open={createDomainModalOpen}
        onClose={() => setCreateDomainModalOpen(false)}
        accounts={accounts}
        defaultAccountId={createDomainDefaultAccountId}
        onSuccess={handleCreateDomainSuccess}
        onOpenDns={handleCreateDomainOpenDns}
      />

      {/* 全局 Toast 通知 */}
      <ToastView toast={toast} animated />

    </>
  );
}
