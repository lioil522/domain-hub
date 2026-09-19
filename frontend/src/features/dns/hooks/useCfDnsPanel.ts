import { useMemo, useRef, useState } from "react";
import { useAppData } from "../../../state/AppDataContext";
import {
  CF_DNS_TYPE_SET,
  needsDnsPriority,
  dnsRecordKey,
  toRelativeRecordName,
  parseDnsBatchInput,
  buildDnsEditTargets,
  providerSupportsLine,
  type ParsedDnsLine,
} from "../../../dnsrecords";
import { MULTI_PROVIDER_META, MULTI_PROVIDER_ORDER } from "../../providers/providerMeta";
import { dpStatusBadge } from "../../domains/dpStatusBadge";
import type { Domain } from "../../../types/domain";
import type { DnsRecord } from "../../../types/dns";
import type { MultiProviderKey } from "../../../types/provider";
import type { DnsRecordPanelProps } from "../../../components/DnsRecordPanel";

/** `useCfDnsPanel` 的外部依赖 —— 由 `App.tsx` 注入 */
export interface UseCfDnsPanelOptions {
  /** 通用 loading 键（面板按钮的禁用 / 旋转状态） */
  actionLoading: string | null;
  /** 动作级 loading 标记的 setter（App 的 `setActionLoading`） */
  setActionLoading: (v: string | null) => void;
}

/** 可直接展开给 `<DnsRecordPanel />` 的整包 props（含 zone） */
export type DnsPanelProps = DnsRecordPanelProps;

/**
 * 共用「DNS 解析记录面板」的状态 / 派生 / 处理函数
 *
 * 从 `App.tsx` 抽出（Phase 5-3）。**纯搬运**：请求路径、loading 键、字段语义与
 * 全部注释逐字保留。
 *
 * ⚠️ 这是 **七家共用** 的面板（DNSHE / Cloudflare / DigitalPlat / DNSPod / 阿里云 /
 * 华为云 / Vercel）：后端按 `zone.account_provider` 分发，前端只有 `dnsPanelMeta`
 * 一处按托管商切换文案与字段语义。因此它属于 `features/dns/`（共用层），
 * **不是** Cloudflare 专属实现 —— 绝不为 CF 单独复制一份面板（铁律 3）。
 *
 * 对外只暴露 `dnsPanelProps`（整包 props）。调用方（App.tsx）仅需：
 *   ```tsx
 *   const { dnsPanelProps } = useCfDnsPanel({ actionLoading, setActionLoading });
 *   <DnsRecordPanel {...dnsPanelProps} />
 *   ```
 *
 * 由 App 侧负责的「打开面板」入口（保持原样、不迁入本 hook）：
 *   - Cloudflare zone 卡片：`handleCfOpenDnsModal(zone)`
 *   - DigitalPlat 卡片：`handleDpOpenDnsModal`（先调 handleCfOpenDnsModal，再把 TTL 改成 300）
 *   - 四家新托管商卡片：`onOpenDns={() => handleCfOpenDnsModal(d)}`
 * 这些入口通过解构 `handleCfOpenDnsModal` 取得（本 hook 有返回）。
 */
export function useCfDnsPanel({ actionLoading, setActionLoading }: UseCfDnsPanelOptions) {
  const { apiFetch, showToast } = useAppData();


  // CF DNS 记录面板（模态框结构同 DNSHE 的 DNS 面板，但没有「解析线路」概念、多了「代理」开关）
  const [cfDnsModalOpen, setCfDnsModalOpen] = useState(false);
  const [cfSelectedZone, setCfSelectedZone] = useState<Domain | null>(null);
  const [cfRecords, setCfRecords] = useState<DnsRecord[]>([]);
  const [loadingCfRecords, setLoadingCfRecords] = useState(false);
  // 记录列表加载失败的原因（区别于「确实没有记录」的空态，避免误导用户去添加）
  const [cfRecordsError, setCfRecordsError] = useState<string | null>(null);
  // CF 新建记录表单（TTL 取值 1 表示 Cloudflare 的「自动」）
  const [cfFormOpen, setCfFormOpen] = useState(false);
  const [cfNewType, setCfNewType] = useState("A");
  const [cfNewLine, setCfNewLine] = useState("default");
  const [cfNewName, setCfNewName] = useState("");
  const [cfNewContent, setCfNewContent] = useState("");
  const [cfNewTtl, setCfNewTtl] = useState(1);
  const [cfNewPriority, setCfNewPriority] = useState<number>(10);
  const [cfNewProxied, setCfNewProxied] = useState(false);
  // CF 行内修改
  const [cfEditingKey, setCfEditingKey] = useState<string | null>(null);
  const [cfEditType, setCfEditType] = useState("A");
  const [cfEditLine, setCfEditLine] = useState("default");
  const [cfEditName, setCfEditName] = useState("");
  const [cfEditContent, setCfEditContent] = useState("");
  const [cfEditTtl, setCfEditTtl] = useState(1);
  const [cfEditPriority, setCfEditPriority] = useState<number>(10);
  const [cfEditProxied, setCfEditProxied] = useState(false);
  // CF 批量添加
  const [cfBatchOpen, setCfBatchOpen] = useState(false);
  const [cfBatchInput, setCfBatchInput] = useState("");
  const [cfBatchType, setCfBatchType] = useState("A");
  const [cfBatchLine, setCfBatchLine] = useState("default");
  const [cfBatchName, setCfBatchName] = useState("@");
  const [cfBatchTtl, setCfBatchTtl] = useState(1);
  const [cfBatchPriority, setCfBatchPriority] = useState<number>(10);
  const [cfBatchProxied, setCfBatchProxied] = useState(false);
  const [cfBatchResults, setCfBatchResults] = useState<Array<{ label: string; success: boolean; message: string }> | null>(null);
  // CF 批量添加输入框引用（自绘拖拽调整高度用）
  const cfBatchTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  // CF 批量修改面板（字段：记录值 / TTL / 代理）
  const [cfSelectedKeys, setCfSelectedKeys] = useState<Set<string>>(new Set());
  const [cfEditPanelOpen, setCfEditPanelOpen] = useState(false);
  const [cfEditFields, setCfEditFields] = useState({
    content: false,
    ttl: true,
    proxied: false
  });
  const [cfBatchEditTtl, setCfBatchEditTtl] = useState(1);
  const [cfBatchEditProxied, setCfBatchEditProxied] = useState(false);
  const [cfBatchEditContents, setCfBatchEditContents] = useState<Record<string, string>>({});
  const [cfEditResults, setCfEditResults] = useState<Array<{ label: string; success: boolean; message: string }> | null>(null);

  // DNS 面板当前打开的域名属于哪家托管商（复用 CF 的解析记录面板：
  // 差异仅在无代理开关、无「自动」TTL 语义，记录路由本身按提供商在后端分发）
  //
  // WHY 收敛成一个描述对象：面板头部文案、刷新按钮 title、编辑态的字段语义
  // 都要按托管商切换。原先只有一个 dnsPanelIsDp 布尔量，接入四家新托管商后
  // 会退化成 6 个并列布尔量（isCf/isDp/isDnspod/...），每个消费点都要写一串
  // 三元表达式。改成「一次判定 → 取字段」后，新增托管商只需在这里加一行。
  const dnsPanelMeta = useMemo(() => {
    const provider = cfSelectedZone?.account_provider || "cloudflare";
    const supportsLine = providerSupportsLine(provider, Boolean(cfSelectedZone?.supports_line));
    if (provider === "digitalplat") {
      return {
        isDp: true,
        isCloudflare: false,
        provider,
        supportsLine,
        // DigitalPlat 的记录类型/主机名由 API 决定，不允许在编辑态改动
        lockedIdentity: true,
        label: "DigitalPlat",
        subtitle: `DigitalPlat 托管域名 · ${dpStatusBadge(String(cfSelectedZone?.status || "")).text}`,
        refreshTitle: "强制刷新（忽略缓存，重新从 DigitalPlat 拉取）",
      };
    }
    if ((MULTI_PROVIDER_ORDER as readonly string[]).includes(provider)) {
      const key = provider as MultiProviderKey;
      return {
        isDp: false,
        isCloudflare: false,
        provider,
        supportsLine,
        // DNSPod / 阿里云 / 华为云 / Vercel 的记录类型与主机名同样由各自 API 固定
        lockedIdentity: true,
        label: MULTI_PROVIDER_META[key].label,
        subtitle: `${MULTI_PROVIDER_META[key].label} 托管域名 · 状态: ${String(cfSelectedZone?.status || "正常")}`,
        refreshTitle: `强制刷新（忽略缓存，重新从 ${MULTI_PROVIDER_META[key].label} 拉取）`,
      };
    }
    return {
      isDp: false,
      isCloudflare: true,
      provider,
      supportsLine,
      // 只有 Cloudflare 允许在编辑态切换记录类型与主机名
      lockedIdentity: false,
      label: "Cloudflare",
      subtitle: `Cloudflare 托管 zone · ${
        String(cfSelectedZone?.status || "").toLowerCase() === "active" ? "已激活" : "待激活"
      }`,
      refreshTitle: "强制刷新（忽略缓存，重新从 Cloudflare 拉取）",
    };
  }, [cfSelectedZone]);

  /** 兼容旧引用点：面板当前是否为 DigitalPlat 域名 */
  const dnsPanelIsDp = dnsPanelMeta.isDp;

  // 打开 CF 解析记录面板并加载记录
  const reloadCfRecords = async (zone: Domain, forceRefresh = false) => {
    setLoadingCfRecords(true);
    try {
      const res = await apiFetch(`/api/domains/${zone.id}/dns${forceRefresh ? "?refresh=1" : ""}`);
      const data = await res.json();
      if (data.success) {
        setCfRecords(data.records || []);
        setCfRecordsError(null);
      } else {
        setCfRecordsError(data.message || "获取解析记录失败");
        showToast("error", data.message || "获取解析记录失败");
      }
    } catch (e) {
      setCfRecordsError("网络连接异常，无法获取解析记录");
      showToast("error", "网络连接异常，无法获取解析记录");
    } finally {
      setLoadingCfRecords(false);
    }
  };

  const handleCfOpenDnsModal = (zone: Domain) => {
    setCfSelectedZone(zone);
    setCfDnsModalOpen(true);
    setCfRecords([]);
    setCfRecordsError(null);
    setCfSelectedKeys(new Set());
    setCfEditingKey(null);
    setCfFormOpen(false);
    setCfBatchOpen(false);
    setCfEditPanelOpen(false);
    setCfBatchResults(null);
    setCfEditResults(null);
    setCfNewType("A");
    setCfNewLine("default");
    setCfNewName("");
    setCfNewContent("");
    setCfNewTtl(1);
    setCfNewPriority(10);
    setCfNewProxied(false);
    setCfBatchLine("default");
    setCfEditLine("default");
    void reloadCfRecords(zone);
  };

  // 新建 CF 解析记录
  const handleCfCreateRecord = async () => {
    if (!cfSelectedZone) return;
    if (!cfNewContent.trim()) {
      showToast("error", "记录值不能为空");
      return;
    }
    setActionLoading("cf-create-dns");
    try {
      const isCf = dnsPanelMeta.isCloudflare;
      const isDp = dnsPanelIsDp;
      const payload: Record<string, unknown> = {
        type: cfNewType,
        name: cfNewName.trim() || "@",
        content: cfNewContent.trim(),
        ttl: isCf && cfNewProxied ? 1 : cfNewTtl,
      };
      if (dnsPanelMeta.supportsLine) {
        payload.line = cfNewLine || "default";
      }
      if (isCf) {
        payload.proxied = cfNewProxied;
      }
      if (!isDp && needsDnsPriority(cfNewType)) {
        payload.priority = cfNewPriority;
      }
      const res = await apiFetch(`/api/domains/${cfSelectedZone.id}/dns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", "创建解析记录成功");
        setCfNewName("");
        setCfNewContent("");
        setCfNewProxied(false);
        void reloadCfRecords(cfSelectedZone, true);
      } else {
        showToast("error", data.message || "创建解析记录失败");
      }
    } catch (e) {
      showToast("error", "创建解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 行内修改：进入编辑态
  const handleCfStartEditRecord = (rec: DnsRecord) => {
    setCfEditingKey(dnsRecordKey(rec));
    setCfEditType(rec.type);
    setCfEditLine(rec.line || "default");
    setCfEditName(toRelativeRecordName(rec.name, cfSelectedZone?.full_domain || ""));
    setCfEditContent(rec.content);
    setCfEditTtl(rec.ttl > 0 ? rec.ttl : 1);
    setCfEditPriority(rec.priority !== null && rec.priority !== undefined ? rec.priority : 10);
    setCfEditProxied(Boolean(rec.proxied));
  };

  // 行内修改：保存
  const handleCfUpdateRecord = async () => {
    if (!cfSelectedZone || !cfEditingKey) return;
    const target = cfRecords.find((r) => dnsRecordKey(r) === cfEditingKey);
    if (!target) return;
    if (!cfEditContent.trim()) {
      showToast("error", "记录值不能为空");
      return;
    }
    setActionLoading(`cf-update-dns-${cfEditingKey}`);
    try {
      const isCf = dnsPanelMeta.isCloudflare;
      const isDp = dnsPanelIsDp;
      const payload: Record<string, unknown> = isDp
        ? { content: cfEditContent.trim(), ttl: cfEditTtl }
        : {
            type: cfEditType,
            name: cfEditName.trim() || "@",
            content: cfEditContent.trim(),
            ttl: isCf && cfEditProxied ? 1 : cfEditTtl,
            priority: needsDnsPriority(cfEditType) ? cfEditPriority : undefined,
            ...(isCf ? { proxied: cfEditProxied } : {})
          };
      if (dnsPanelMeta.supportsLine) {
        payload.line = cfEditLine || "default";
      }
      const res = await apiFetch(`/api/domains/${cfSelectedZone.id}/dns/${encodeURIComponent(cfEditingKey)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", "解析记录已更新");
        setCfEditingKey(null);
        void reloadCfRecords(cfSelectedZone, true);
      } else {
        showToast("error", data.message || "更新解析记录失败");
      }
    } catch (e) {
      showToast("error", "更新解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 删除单条 CF 解析记录
  const handleCfDeleteRecord = async (rec: DnsRecord) => {
    if (!cfSelectedZone) return;
    if (!confirm(`确定要删除记录 ${rec.type} ${rec.name} → ${rec.content} 吗？这会立即影响该域名的解析！`)) {
      return;
    }
    const key = dnsRecordKey(rec);
    setActionLoading(`cf-delete-dns-${key}`);
    try {
      const res = await apiFetch(`/api/domains/${cfSelectedZone.id}/dns/${encodeURIComponent(key)}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        showToast("success", "解析记录已删除");
        void reloadCfRecords(cfSelectedZone, true);
      } else {
        showToast("error", data.message || "删除解析记录失败");
      }
    } catch (e) {
      showToast("error", "删除解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // CF 批量添加输入框的实时解析（主机记录提前转相对名，预览与提交一致）
  // NOTE: 行首类型令牌按 Cloudflare 全量类型识别，否则 PTR 这类行首会被误认成主机记录
  const cfParsedBatchLines = useMemo(
    () =>
      parseDnsBatchInput(cfBatchInput, {
        type: cfBatchType,
        name: cfBatchName,
        ttl: cfBatchProxied ? 1 : cfBatchTtl,
        priority: cfBatchPriority
      }, CF_DNS_TYPE_SET).map((r) =>
        r ? { ...r, name: toRelativeRecordName(r.name, cfSelectedZone?.full_domain || "") } : null
      ),
    [cfBatchInput, cfBatchType, cfBatchName, cfBatchTtl, cfBatchPriority, cfBatchProxied, cfSelectedZone]
  );

  const cfValidBatchLines = useMemo(
    () => cfParsedBatchLines.filter((r): r is ParsedDnsLine => r !== null),
    [cfParsedBatchLines]
  );

  // CF 批量添加（面板上的「代理」开关只对 A/AAAA/CNAME 行生效）
  const handleCfBatchCreate = async () => {
    if (!cfSelectedZone) return;
    if (cfValidBatchLines.length === 0) {
      showToast("error", "未能解析出任何有效的解析记录，请检查输入格式");
      return;
    }
    if (cfValidBatchLines.length > 50) {
      showToast("error", "单次最多批量添加 50 条解析记录");
      return;
    }

    const isCf = dnsPanelMeta.isCloudflare;
    const records = cfValidBatchLines.map((r) => ({
      ...r,
      line: dnsPanelMeta.supportsLine ? (cfBatchLine || "default") : undefined,
      ttl: isCf && cfBatchProxied ? 1 : r.ttl,
      proxied: isCf && cfBatchProxied && ["A", "AAAA", "CNAME"].includes(r.type) ? true : undefined
    }));

    setActionLoading("cf-batch-create-dns");
    setCfBatchResults(null);
    try {
      const res = await apiFetch(`/api/domains/${cfSelectedZone.id}/dns/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records })
      });
      const data = await res.json();
      if (data.success) {
        setCfBatchResults(data.results || []);
        if (data.fail_count === 0) {
          showToast("success", `已添加 ${data.success_count} 条解析记录`);
          setCfBatchInput("");
        } else {
          showToast("warning", `批量添加完成：成功 ${data.success_count} 条，失败 ${data.fail_count} 条（详见下方明细）`);
        }
        void reloadCfRecords(cfSelectedZone, true);
      } else {
        showToast("error", data.message || "批量添加解析记录失败");
      }
    } catch (e) {
      showToast("error", "批量添加解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // CF 勾选的记录（批量修改 / 批量删除共用）
  const cfSelectedRecords = useMemo(
    () => cfRecords.filter((rec) => cfSelectedKeys.has(dnsRecordKey(rec))),
    [cfRecords, cfSelectedKeys]
  );

  const cfToggleAllSelection = () => {
    if (cfSelectedKeys.size === cfRecords.length) {
      setCfSelectedKeys(new Set());
    } else {
      setCfSelectedKeys(new Set(cfRecords.map(dnsRecordKey)));
    }
  };

  // CF 批量修改目标（复用 buildDnsEditTargets：内容 / TTL / 代理 三个字段可覆盖）
  const cfBatchEditTargets = useMemo(
    () =>
      buildDnsEditTargets(
        cfSelectedRecords,
        {
          type: false,
          name: false,
          content: cfEditFields.content,
          ttl: cfEditFields.ttl,
          line: false,
          priority: false,
          proxied: cfEditFields.proxied
        },
        {
          type: "A",
          name: "@",
          content: "",
          ttl: cfBatchEditTtl,
          line: "",
          priority: 10,
          proxied: cfBatchEditProxied
        },
        cfSelectedZone?.full_domain || "",
        cfBatchEditContents
      ),
    [cfSelectedRecords, cfSelectedZone, cfEditFields, cfBatchEditTtl, cfBatchEditProxied, cfBatchEditContents]
  );

  const cfBatchEditChanged = useMemo(
    () => cfBatchEditTargets.filter((t) => !t.unchanged),
    [cfBatchEditTargets]
  );

  const handleCfOpenEditPanel = () => {
    setCfBatchEditContents(
      Object.fromEntries(cfSelectedRecords.map((rec) => [dnsRecordKey(rec), rec.content || ""]))
    );
    setCfEditResults(null);
    setCfEditPanelOpen(true);
  };

  // CF 批量修改已勾选的解析记录
  const handleCfBatchUpdateRecords = async () => {
    if (!cfSelectedZone || cfBatchEditTargets.length === 0) return;
    if (!cfEditFields.content && !cfEditFields.ttl && !cfEditFields.proxied) {
      showToast("error", "请至少勾选一个要修改的字段");
      return;
    }
    if (cfBatchEditChanged.length === 0) {
      showToast("info", "选中的记录与当前值一致，没有需要提交的修改");
      return;
    }
    if (cfBatchEditChanged.length > 50) {
      showToast("error", "单次最多批量修改 50 条解析记录");
      return;
    }

    if (!confirm(`确定要修改选中的 ${cfBatchEditChanged.length} 条解析记录吗？`)) {
      return;
    }

    const isCf = dnsPanelMeta.isCloudflare;
    const records = cfBatchEditChanged.map((t) => ({
      record_id: t.record_id,
      label: t.label,
      type: t.type,
      name: t.name,
      content: t.content,
      // 仅 Cloudflare 支持代理：其余托管商绝不把 TTL 强制写成 1（自动）或把代理位传上去
      ttl: isCf && cfEditFields.proxied && cfBatchEditProxied ? 1 : t.ttl,
      proxied: isCf && cfEditFields.proxied ? cfBatchEditProxied : undefined
    }));

    setActionLoading("cf-batch-update-dns");
    try {
      const res = await apiFetch(`/api/domains/${cfSelectedZone.id}/dns/batch-update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records })
      });
      const data = await res.json();
      if (data.success) {
        setCfEditResults(data.results || []);
        const failed = (data.results || []).filter((r: { success: boolean }) => !r.success);
        if (failed.length === 0) {
          showToast("success", `已修改 ${data.success_count} 条解析记录`);
        } else {
          showToast("warning", `批量修改完成：成功 ${data.success_count} 条，失败 ${data.fail_count} 条（详见下方明细）`);
        }
        void reloadCfRecords(cfSelectedZone, true);
      } else {
        showToast("error", data.message || "批量修改解析记录失败");
      }
    } catch (e) {
      showToast("error", "批量修改解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // CF 批量删除已勾选的解析记录
  const handleCfBatchDeleteRecords = async () => {
    if (!cfSelectedZone || cfSelectedKeys.size === 0) return;

    const targets = cfSelectedRecords.map((rec) => ({
      record_id: dnsRecordKey(rec),
      label: `${rec.type} ${rec.name} → ${rec.content}`
    }));

    if (
      !confirm(
        `确定要删除选中的 ${targets.length} 条解析记录吗？这会立即影响该域名的解析！\n\n${targets
          .map((t) => t.label)
          .join("\n")}`
      )
    ) {
      return;
    }

    setActionLoading("cf-batch-delete-dns");
    try {
      const res = await apiFetch(`/api/domains/${cfSelectedZone.id}/dns/batch-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records: targets })
      });
      const data = await res.json();
      if (data.success) {
        const failed = (data.results || []).filter((r: { success: boolean }) => !r.success);
        if (failed.length === 0) {
          showToast("success", `已删除 ${data.success_count} 条解析记录`);
        } else {
          showToast(
            "error",
            `${failed.length} 条删除失败：${failed
              .map((f: { label: string; message: string }) => `${f.label}(${f.message})`)
              .join("；")}`
          );
        }
        setCfSelectedKeys(new Set());
        void reloadCfRecords(cfSelectedZone, true);
      } else {
        showToast("error", data.message || "批量删除解析记录失败");
      }
    } catch (e) {
      showToast("error", "批量删除解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 打开 DigitalPlat 域名的解析记录面板（复用 CF 面板；TTL 默认 300 —— DigitalPlat 无「自动」语义）
  const handleDpOpenDnsModal = (domain: Domain) => {
    handleCfOpenDnsModal(domain);
    setCfNewTtl(300);
    setCfEditTtl(300);
    setCfBatchTtl(300);
    setCfNewProxied(false);
    setCfEditProxied(false);
    setCfBatchProxied(false);
    // DP 无代理概念、批量修改默认不勾 TTL：避免沿用 CF 会话残留的 cfBatchEditTtl=1
    //（会把 DP 记录写成非法 TTL=1）或残留的 proxied=true 强制 TTL=1。
    setCfBatchEditTtl(300);
    setCfBatchEditProxied(false);
    setCfEditFields({ content: false, ttl: false, proxied: false });
    setCfSelectedKeys(new Set());
  };

  const dnsPanelProps = {
    open: cfDnsModalOpen,
    zone: cfSelectedZone,
    meta: dnsPanelMeta,
    onClose: () => setCfDnsModalOpen(false),
    records: cfRecords,
    loadingRecords: loadingCfRecords,
    recordsError: cfRecordsError,
    onReload: (force?: boolean) => {
      // 面板只在 open && zone 存在时渲染，这里再收窄一次让 TS 满意
      if (cfSelectedZone) void reloadCfRecords(cfSelectedZone, force);
    },
    actionLoading,
    formOpen: cfFormOpen,
    setFormOpen: setCfFormOpen,
    newType: cfNewType,
    setNewType: setCfNewType,
    newLine: cfNewLine,
    setNewLine: setCfNewLine,
    newName: cfNewName,
    setNewName: setCfNewName,
    newContent: cfNewContent,
    setNewContent: setCfNewContent,
    newTtl: cfNewTtl,
    setNewTtl: setCfNewTtl,
    newPriority: cfNewPriority,
    setNewPriority: setCfNewPriority,
    newProxied: cfNewProxied,
    setNewProxied: setCfNewProxied,
    onCreateRecord: handleCfCreateRecord,
    batchOpen: cfBatchOpen,
    setBatchOpen: setCfBatchOpen,
    batchInput: cfBatchInput,
    setBatchInput: setCfBatchInput,
    batchType: cfBatchType,
    setBatchType: setCfBatchType,
    batchLine: cfBatchLine,
    setBatchLine: setCfBatchLine,
    batchName: cfBatchName,
    setBatchName: setCfBatchName,
    batchTtl: cfBatchTtl,
    setBatchTtl: setCfBatchTtl,
    batchPriority: cfBatchPriority,
    setBatchPriority: setCfBatchPriority,
    batchProxied: cfBatchProxied,
    setBatchProxied: setCfBatchProxied,
    batchTextareaRef: cfBatchTextareaRef,
    validBatchLines: cfValidBatchLines,
    batchResults: cfBatchResults,
    onBatchCreate: handleCfBatchCreate,
    editingKey: cfEditingKey,
    setEditingKey: setCfEditingKey,
    editType: cfEditType,
    setEditType: setCfEditType,
    editLine: cfEditLine,
    setEditLine: setCfEditLine,
    editName: cfEditName,
    setEditName: setCfEditName,
    editContent: cfEditContent,
    setEditContent: setCfEditContent,
    editTtl: cfEditTtl,
    setEditTtl: setCfEditTtl,
    editPriority: cfEditPriority,
    setEditPriority: setCfEditPriority,
    editProxied: cfEditProxied,
    setEditProxied: setCfEditProxied,
    onStartEditRecord: handleCfStartEditRecord,
    onUpdateRecord: handleCfUpdateRecord,
    onDeleteRecord: handleCfDeleteRecord,
    selectedKeys: cfSelectedKeys,
    setSelectedKeys: setCfSelectedKeys,
    onToggleAllSelection: cfToggleAllSelection,
    editPanelOpen: cfEditPanelOpen,
    setEditPanelOpen: setCfEditPanelOpen,
    onOpenEditPanel: handleCfOpenEditPanel,
    editFields: cfEditFields,
    setEditFields: setCfEditFields,
    batchEditTtl: cfBatchEditTtl,
    setBatchEditTtl: setCfBatchEditTtl,
    batchEditProxied: cfBatchEditProxied,
    setBatchEditProxied: setCfBatchEditProxied,
    batchEditContents: cfBatchEditContents,
    setBatchEditContents: setCfBatchEditContents,
    batchEditTargets: cfBatchEditTargets,
    batchEditChanged: cfBatchEditChanged,
    editResults: cfEditResults,
    onBatchUpdateRecords: handleCfBatchUpdateRecords,
    onBatchDeleteRecords: handleCfBatchDeleteRecords,
  } satisfies DnsPanelProps;

  return { dnsPanelProps, handleCfOpenDnsModal, handleDpOpenDnsModal };
}
