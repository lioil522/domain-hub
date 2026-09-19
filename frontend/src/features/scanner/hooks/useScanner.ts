/**
 * useScanner —— 「规则多域名查重 / WHOIS 查重与注册」标签页（register）的状态 / 派生 / 动作。
 *
 * 由 App.tsx 纯搬运抽出（Phase 9）。DOM / className / 接口路径 / localStorage 键逐字未改，
 * 行为保持一致。词库（wordBanks）与保留前缀名单仅被本页消费，故一并迁入；
 * 而「线路解析支持名单 / 根域 NS 镜像」被设置页（line-settings）共享，留在 App。
 *
 * App 侧注入的依赖：
 *   - fetchDomains / setActiveTab：注册成功后刷新域名列表并跳转（App 本地状态与动作）
 *   - dnsheAccounts：DNSHE 账号列表（来自 useDnsheDomains(domains, accounts, ...)）
 * apiFetch / showToast 直接从 useAppData 取得。
 */
import { useMemo, useRef, useState } from "react";
import { toASCII } from "../../../punycode";
import {
  loadWordBanks,
  saveWordBanks,
  makeBankId,
  buildDefaultBanks,
  parseWords,
  BANK_KIND_META,
  type WordBank,
  type BankKind
} from "../../../wordbanks";
import {
  parseRule,
  countCombos,
  generateCombos,
  BUILTIN_TOKENS
} from "../../../rulegen";
import { useAppData } from "../../../state/AppDataContext";
import type { Account } from "../../../types/account";

const DEFAULT_ROOT_DOMAINS = [
  "us.ci", "l.cd", "cc.cd", "cn.mt", "bot.cd", "de5.net", "ccwu.cc", "ddns.ge", "bbroot.com"
];

export type WhoisResult = {
  searchedDomain?: string;
  success?: boolean;
  registered?: boolean;
  status?: string;
  registered_at?: string;
  expires_at?: string;
  registrant_email?: string;
  nameservers?: string[];
  message?: string;
};

export type AvailableDomain = {
  fullDomain: string;
  subdomain: string;
  rootdomain: string;
  time: string;
};

export type ScanLog = {
  id: number;
  time: string;
  text: string;
  status: "available" | "registered" | "error" | "info";
};

export type ScanCursor = {
  seqMode: boolean;
  charset: string;
  length: number;
  lastCandidate: string;
  taskIndex: number;
  checked: number;
  savedAt: string;
};

export type ScanStatus = "idle" | "running" | "paused" | "completed";

export type ScannerParams = { total: number; checked: number; available: number };

export interface UseScannerOptions {
  /** 注册成功后刷新 DNSHE 域名列表（App 本地动作） */
  fetchDomains: () => void;
  /** 注册成功后跳转到域名标签页 */
  setActiveTab: (tab: "domains") => void;
  /** DNSHE 账号列表（用于注册目标账号选择与多流水线并发） */
  dnsheAccounts: Account[];
  /** App 级 actionLoading：注册按钮的 loading 态复用它，保持一致（纯搬运） */
  actionLoading: string | null;
  setActionLoading: (v: string | null) => void;
}

export function useScanner({
  fetchDomains,
  setActiveTab,
  dnsheAccounts,
  actionLoading,
  setActionLoading
}: UseScannerOptions) {
  const { apiFetch, showToast } = useAppData();

  const [allRootDomains, setAllRootDomains] = useState<string[]>(() => {
    const saved = localStorage.getItem("DNSHE_CUSTOM_ROOT_DOMAINS");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch (e) {}
    }
    return DEFAULT_ROOT_DOMAINS;
  });
  const [newRootInput, setNewRootInput] = useState("");

  // 域名注册与查重状态
  const [searchSubdomain, setSearchSubdomain] = useState("");
  const [searchRootdomain, setSearchRootdomain] = useState("us.ci");
  const [whoisLoading, setWhoisLoading] = useState(false);
  const [whoisResult, setWhoisResult] = useState<WhoisResult | null>(null);
  const [registerAccountId, setRegisterAccountId] = useState<number | "">("");

  // 规则多域名查重状态
  const [regMode, setRegMode] = useState<"single" | "batch">("single");
  const [batchRules, setBatchRules] = useState<string>("");
  const [excludeChars, setExcludeChars] = useState<string>("");
  const [selectedRoots, setSelectedRoots] = useState<string[]>([]);
  const [batchLength, setBatchLength] = useState<number>(2);
  const [scanStatus, setScanStatus] = useState<ScanStatus>("idle");
  const scanControlRef = useRef<ScanStatus>("idle");

  const updateScanStatus = (status: ScanStatus) => {
    scanControlRef.current = status;
    setScanStatus(status);
  };
  const [scanProgress, setScanProgress] = useState<ScannerParams>({ total: 0, checked: 0, available: 0 });
  const [availableDomainsList, setAvailableDomainsList] = useState<AvailableDomain[]>([]);
  const [scanLogs, setScanLogs] = useState<ScanLog[]>([]);

  // ===== 顺序检测（进位递增）与断点续查状态 =====
  // 顺序模式开关：开启后忽略规则框，按字符集进位顺序惰性生成候选（如 aaa→aab→...）
  const [seqMode, setSeqMode] = useState(false);
  // 顺序模式的字符集与长度
  const [seqCharset, setSeqCharset] = useState<"字母" | "数字" | "字母数字">("字母");
  const [seqLength, setSeqLength] = useState<number>(3);
  // 顺序模式的起始串（留空则从最小串开始，如 aaa）
  const [seqStart, setSeqStart] = useState<string>("");
  // 已保存的断点光标（从 localStorage 恢复，供「继续上次」提示使用）
  const [scanCursor, setScanCursor] = useState<ScanCursor | null>(() => {
    try {
      const raw = localStorage.getItem("DNSHE_SCAN_CURSOR");
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  // 扫描运行期间实时记录当前进度，供暂停/限流时落盘
  const scanCursorRef = useRef<{ lastCandidate: string; taskIndex: number; checked: number }>({
    lastCandidate: "",
    taskIndex: 0,
    checked: 0
  });

  // 查重池：是否忽略池子强制全部重查（用于刷新可能已过期的结论）
  const [ignorePool, setIgnorePool] = useState(false);

  // ===== 官方保留前缀排除名单 =====
  // DNSHE 官方设置为不可注册的前缀（整词匹配，如 ai 不可注册但 ailu 可以）。
  // 查重前直接剔除，避免浪费 API 配额。名单可编辑并持久化。
  const DEFAULT_RESERVED_PREFIXES = ["ai", "jd", "qq", "mail"];
  const [reservedPrefixes, setReservedPrefixes] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("DNSHE_RESERVED_PREFIXES");
      if (!raw) return DEFAULT_RESERVED_PREFIXES;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : DEFAULT_RESERVED_PREFIXES;
    } catch {
      return DEFAULT_RESERVED_PREFIXES;
    }
  });
  // 是否启用保留前缀排除
  const [enableReservedFilter, setEnableReservedFilter] = useState(
    () => localStorage.getItem("DNSHE_RESERVED_FILTER_OFF") !== "1"
  );
  // 新增保留前缀的输入框
  const [newReservedInput, setNewReservedInput] = useState("");

  // ===== 可编辑词库状态 =====
  // 词库分组列表（首次从内置种子导入，之后持久化在 localStorage）
  const [wordBanks, setWordBanks] = useState<WordBank[]>(() =>
    loadWordBanks(new Set(BUILTIN_TOKENS))
  );
  // 词库管理弹窗开关
  const [bankModalOpen, setBankModalOpen] = useState(false);
  // 正在编辑的分组（null 表示新建）
  const [editingBank, setEditingBank] = useState<WordBank | null>(null);
  // 编辑表单字段
  const [bankFormName, setBankFormName] = useState("");
  const [bankFormKind, setBankFormKind] = useState<BankKind>("cn");
  const [bankFormWords, setBankFormWords] = useState("");

  // 执行 WHOIS 域名查重
  const handleCheckWhois = async (
    e?: React.FormEvent,
    overrideSub?: string,
    overrideRoot?: string
  ) => {
    if (e) e.preventDefault();
    // 中文等非 ASCII 前缀/根域名统一转 Punycode (xn--) 再查询
    const sub = toASCII((overrideSub !== undefined ? overrideSub : searchSubdomain).trim());
    const root = toASCII((overrideRoot !== undefined ? overrideRoot : searchRootdomain).trim());

    if (!sub) {
      showToast("error", "请输入想要查询的子域名前缀！");
      return;
    }

    // 官方保留前缀：直接拦截，不浪费一次上游查询
    if (enableReservedFilter && reservedPrefixes.some(p => p.toLowerCase() === sub.toLowerCase())) {
      showToast("error", `前缀 [${sub}] 属于官方保留名单，不可注册（可在批量页的保留名单中调整）`);
      return;
    }

    const fullTargetDomain = `${sub}.${root}`;
    setWhoisLoading(true);

    try {
      // 带上已选中的 DNSHE 账号，避免后端默认账号选中自定义服务商（空凭据）导致 401
      const accountQuery = registerAccountId ? `&account_id=${registerAccountId}` : "";
      const res = await apiFetch(`/api/whois?domain=${encodeURIComponent(fullTargetDomain)}${accountQuery}`);
      const data = await res.json();
        if (data.success && data.whois) {
          setWhoisResult({
            searchedDomain: fullTargetDomain,
            ...data.whois
          });
          if (dnsheAccounts.length > 0 && !registerAccountId) {
            setRegisterAccountId(dnsheAccounts[0].id);
          }
        } else {
        showToast("error", data.message || "WHOIS 查询失败");
      }
    } catch (err) {
      showToast("error", "WHOIS 查询请求失败，请检查网络连接");
    } finally {
      setWhoisLoading(false);
    }
  };

  // 提交在线注册免费域名
  const handleRegisterSubdomain = async () => {
    const sub = toASCII(searchSubdomain.trim());
    const root = toASCII(searchRootdomain.trim());
    if (!sub || !root) return;
    if (!registerAccountId) {
      showToast("error", "请先选择用于注册域名的 API 账号！");
      return;
    }

    setActionLoading("register-subdomain");
    try {
      const res = await apiFetch("/api/domains/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: registerAccountId,
          subdomain: sub,
          rootdomain: root
        })
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", `🎉 域名 [${data.full_domain || sub + "." + root}] 注册成功！`);
        setWhoisResult(null);
        setSearchSubdomain("");
        fetchDomains();
        setActiveTab("domains");
      } else {
        showToast("error", data.message || "注册子域名失败，请重试");
      }
    } catch (err) {
      showToast("error", "注册请求失败，请重试");
    } finally {
      setActionLoading(null);
    }
  };

  // 添加与删除自定义根域名 handler
  const handleAddCustomRootDomain = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleanRoot = toASCII(newRootInput.trim().replace(/^\./, ""));
    if (!cleanRoot) return;
    if (allRootDomains.includes(cleanRoot)) {
      showToast("error", `根域名 [.${cleanRoot}] 已在列表中！`);
      return;
    }
    const updated = [...allRootDomains, cleanRoot];
    setAllRootDomains(updated);
    setSelectedRoots(prev => Array.from(new Set([...prev, cleanRoot])));
    localStorage.setItem("DNSHE_CUSTOM_ROOT_DOMAINS", JSON.stringify(updated));
    setNewRootInput("");
    showToast("success", `成功追加根域名 [.${cleanRoot}]！`);
  };

  const handleRemoveCustomRootDomain = (rootToRemove: string) => {
    const updated = allRootDomains.filter(r => r !== rootToRemove);
    setAllRootDomains(updated);
    setSelectedRoots(prev => prev.filter(r => r !== rootToRemove));
    localStorage.setItem("DNSHE_CUSTOM_ROOT_DOMAINS", JSON.stringify(updated));
    showToast("info", `已移除根域名 [.${rootToRemove}]`);
  };

  // 批量规则生成：解析与组合逻辑见 rulegen.ts（花括号槽位模型）
  //
  // 生成上限对齐 west.cn 在线版的 30 万条。注意这只是「生成」上限，
  // 实际扫描速度受单账号 1.2s 限频约束（见 handleStartBatchScan 的 RATE_LIMIT_MS）。
  const MAX_PREFIXES = 300000;

  // 让用户自建词库也能作为 {词库名} 标签参与组合 —— 比 west.cn 固定的「我的字典1-6」更灵活
  const resolveBank = useMemo(
    () => (name: string): string[] | null => {
      const bank = wordBanks.find(b => b.name === name);
      return bank ? bank.words : null;
    },
    [wordBanks]
  );

  // 规则实时解析：组合数预估 + 耗时估算
  const rulePreview = useMemo(() => {
    const parsed = parseRule(batchRules, excludeChars, batchLength, resolveBank);
    const total = countCombos(parsed);
    const rootCount = Math.max(selectedRoots.length, 1);
    const workerCount = Math.max(dnsheAccounts.length, 1);
    // 每个候选前缀要对每个根域名各查一次，单账号 1.2s 限频，N 个账号 N 条流水线
    const scanned = Math.min(total, MAX_PREFIXES) * rootCount;
    // 规则本身有效但被排除字符清空 —— 与「还没输入规则」是两回事，提示语要能区分
    const emptiedByExclude =
      total === 0 &&
      parsed.unknownTokens.length === 0 &&
      (parsed.slots.length > 0 || parsed.literalList !== null) &&
      excludeChars.trim().length > 0;
    return {
      parsed,
      total,
      emptiedByExclude,
      isBraceSyntax: batchRules.includes("{"),
      estSeconds: (scanned * 1.2) / workerCount
    };
  }, [batchRules, excludeChars, batchLength, resolveBank, selectedRoots.length, dnsheAccounts.length]);

  // 把秒数格式化为「3.2 小时 / 12 分钟 / 45 秒」
  const formatDuration = (sec: number): string => {
    if (sec < 60) return `${Math.ceil(sec)} 秒`;
    if (sec < 3600) return `${(sec / 60).toFixed(1)} 分钟`;
    if (sec < 86400) return `${(sec / 3600).toFixed(1)} 小时`;
    return `${(sec / 86400).toFixed(1)} 天`;
  };

  // ===== 顺序检测：进位递增生成器 =====
  // 取顺序模式对应的字符集
  const getSeqCharset = (name: string): string[] => {
    const letters = "abcdefghijklmnopqrstuvwxyz".split("");
    const digits = "0123456789".split("");
    if (name === "数字") return digits;
    if (name === "字母数字") return [...letters, ...digits];
    return letters;
  };

  // 进位递增：给定当前串返回下一个串（qwe→qwf，qwz→qxa）；已到最大串则返回 null
  const nextSeqCandidate = (current: string, charset: string[]): string | null => {
    const idxMap = new Map(charset.map((c, i) => [c, i]));
    const chars = current.split("");
    let pos = chars.length - 1;
    while (pos >= 0) {
      const cur = idxMap.get(chars[pos]);
      if (cur === undefined) return null; // 出现字符集外的字符
      if (cur < charset.length - 1) {
        chars[pos] = charset[cur + 1];
        return chars.join("");
      }
      chars[pos] = charset[0]; // 进位：本位归零，继续向前进位
      pos--;
    }
    return null; // 全部进位完毕，空间穷尽
  };

  // 惰性生成顺序候选：从 start 开始最多取 limit 个（避免 26^4 一次性撑爆内存）
  const generateSeqPrefixes = (
    charsetName: string,
    length: number,
    start: string,
    limit: number
  ): string[] => {
    const charset = getSeqCharset(charsetName);
    const min = charset[0].repeat(length);
    let cur = start && start.length === length ? start.toLowerCase() : min;
    // 起始串含字符集外字符时回退到最小串
    if (cur.split("").some(c => !charset.includes(c))) cur = min;

    const out: string[] = [];
    while (out.length < limit) {
      out.push(cur);
      const nxt = nextSeqCandidate(cur, charset);
      if (nxt === null) break;
      cur = nxt;
    }
    return out;
  };

  // 保存/清除断点光标
  const saveScanCursor = (lastCandidate: string, taskIndex: number, checked: number) => {
    const cursor: ScanCursor = {
      seqMode,
      charset: seqCharset,
      length: seqLength,
      lastCandidate,
      taskIndex,
      checked,
      savedAt: new Date().toLocaleString()
    };
    localStorage.setItem("DNSHE_SCAN_CURSOR", JSON.stringify(cursor));
    setScanCursor(cursor);
  };

  const clearScanCursor = () => {
    localStorage.removeItem("DNSHE_SCAN_CURSOR");
    setScanCursor(null);
  };

  // ===== 保留前缀名单增删 =====
  const persistReserved = (next: string[]) => {
    setReservedPrefixes(next);
    localStorage.setItem("DNSHE_RESERVED_PREFIXES", JSON.stringify(next));
  };
  // 添加保留前缀（支持一次粘贴多个，逗号/空格/换行分隔）
  const handleAddReserved = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const incoming = parseWords(newReservedInput).map(w => w.toLowerCase());
    if (incoming.length === 0) return;

    const merged = Array.from(new Set([...reservedPrefixes, ...incoming]));
    const added = merged.length - reservedPrefixes.length;
    persistReserved(merged);
    setNewReservedInput("");
    if (added > 0) {
      showToast("success", `已添加 ${added} 个保留前缀`);
    } else {
      showToast("info", "输入的前缀均已在名单中");
    }
  };

  const handleRemoveReserved = (prefix: string) => {
    persistReserved(reservedPrefixes.filter(p => p !== prefix));
    showToast("info", `已从名单移除 [${prefix}]`);
  };

  const handleResetReserved = () => {
    persistReserved(DEFAULT_RESERVED_PREFIXES);
    showToast("success", "已恢复官方默认保留前缀名单");
  };

  // 切换启用状态并持久化
  const toggleReservedFilter = (enabled: boolean) => {
    setEnableReservedFilter(enabled);
    localStorage.setItem("DNSHE_RESERVED_FILTER_OFF", enabled ? "0" : "1");
  };

  // ===== 词库增删改 =====
  // 统一落盘：状态与 localStorage 同步更新
  const persistBanks = (next: WordBank[]) => {
    setWordBanks(next);
    saveWordBanks(next);
  };

  // 打开新建分组弹窗
  const openCreateBank = () => {
    setEditingBank(null);
    setBankFormName("");
    setBankFormKind("cn");
    setBankFormWords("");
    setBankModalOpen(true);
  };

  // 打开编辑分组弹窗
  const openEditBank = (bank: WordBank) => {
    setEditingBank(bank);
    setBankFormName(bank.name);
    setBankFormKind(bank.kind);
    setBankFormWords(bank.words.join(", "));
    setBankModalOpen(true);
  };

  // 保存（新建或更新）分组
  const handleSaveBank = () => {
    const name = bankFormName.trim();
    if (!name) {
      showToast("error", "请填写词库名称！");
      return;
    }
    // 词库名会作为 {名称} 标签写进规则，含花括号或逗号会破坏规则解析
    if (/[{},]/.test(name)) {
      showToast("error", "词库名称不能包含 { } 或逗号，否则无法作为规则标签使用！");
      return;
    }
    // 与内置标签重名会被内置定义遮蔽，导致点击词库标签却取到内置候选集
    if ((BUILTIN_TOKENS as readonly string[]).includes(name)) {
      showToast("error", `[${name}] 与内置标签同名，请换一个词库名称！`);
      return;
    }
    const words = parseWords(bankFormWords);
    if (words.length === 0) {
      showToast("error", "请至少填写一个词条！");
      return;
    }

    // 同类型下不允许重名（编辑自身除外）
    const dup = wordBanks.some(
      b => b.kind === bankFormKind && b.name === name && b.id !== editingBank?.id
    );
    if (dup) {
      showToast("error", `「${BANK_KIND_META[bankFormKind].label}」下已存在同名词库 [${name}]！`);
      return;
    }

    if (editingBank) {
      persistBanks(
        wordBanks.map(b =>
          b.id === editingBank.id ? { ...b, name, kind: bankFormKind, words } : b
        )
      );
      showToast("success", `词库 [${name}] 已更新（${words.length} 个词）`);
    } else {
      persistBanks([...wordBanks, { id: makeBankId(), kind: bankFormKind, name, words }]);
      showToast("success", `已新建词库 [${name}]（${words.length} 个词）`);
    }
    setBankModalOpen(false);
  };

  // 删除分组
  const handleDeleteBank = (bank: WordBank) => {
    if (!confirm(`确定要删除词库 [${bank.name}] 吗？该分组下 ${bank.words.length} 个词条将一并移除。`)) return;
    persistBanks(wordBanks.filter(b => b.id !== bank.id));
    showToast("info", `已删除词库 [${bank.name}]`);
  };

  // 恢复内置默认词库（覆盖当前全部自定义内容）
  const handleResetBanks = () => {
    if (!confirm("确定要恢复内置默认词库吗？您当前所有的自定义词库分组与修改都将被覆盖！")) return;
    const defaults = buildDefaultBanks();
    persistBanks(defaults);
    showToast("success", `已恢复内置默认词库（${defaults.length} 个分组）`);
  };

  // 把词库作为 {词库名} 标签插入规则框。
  // 早先是把整类词逗号展开进输入框，几百个词会把框挤满、完全看不清规则结构；
  // 改插占位符后词库还能与其它标签组合（如 {地名城市}{数字}）。
  const appendWordbank = (words: string[], label: string) => {
    setBatchRules(prev => `${prev}{${label}}`);
    showToast("success", `已插入「${label}」词库标签（${words.length} 个词）`);
  };

  // 执行批量扫域名引擎（resumeFrom 非空时表示从断点续查）
  const handleStartBatchScan = async (resumeFrom?: string) => {
    if (scanControlRef.current === "paused") {
      updateScanStatus("running");
      showToast("info", "▶️ 已恢复批量扫描任务！");
      return;
    }

    if (selectedRoots.length === 0) {
      showToast("error", "请至少勾选一个根域名后缀！");
      return;
    }

    // 顺序模式：按字符集进位递增惰性生成；否则走原有规则词库生成
    let prefixes: string[];
    if (seqMode) {
      const startFrom = resumeFrom || seqStart;
      prefixes = generateSeqPrefixes(seqCharset, seqLength, startFrom, 20000);
      if (prefixes.length === 0) {
        showToast("error", "顺序模式未能生成候选，请检查字符集与长度设置！");
        return;
      }
      showToast(
        "info",
        `🔢 顺序模式：从 [${prefixes[0]}] 开始，本轮生成 ${prefixes.length} 个候选前缀`
      );
    } else {
      const parsed = parseRule(batchRules, excludeChars, batchLength, resolveBank);
      if (parsed.unknownTokens.length > 0) {
        showToast("error", `规则中存在无法识别的标签：${parsed.unknownTokens.join("、")}`);
        return;
      }
      prefixes = generateCombos(parsed, MAX_PREFIXES);
      if (prefixes.length === 0) {
        showToast("error", "根据当前规则未能生成有效的前缀词库，请修改规则！");
        return;
      }
      const totalCombos = countCombos(parsed);
      if (totalCombos > MAX_PREFIXES) {
        showToast(
          "warning",
          `⚠️ 该规则共 ${totalCombos.toLocaleString()} 条组合，已截断为前 ${MAX_PREFIXES.toLocaleString()} 条。超大规则建议改用顺序模式配合断点续查。`
        );
      }
    }

    // ── 官方保留前缀过滤：整词匹配剔除不可注册的前缀，避免浪费 API 配额 ──
    if (enableReservedFilter && reservedPrefixes.length > 0) {
      const reservedSet = new Set(reservedPrefixes.map(p => p.toLowerCase()));
      const before = prefixes.length;
      prefixes = prefixes.filter(p => !reservedSet.has(p.toLowerCase()));
      const removed = before - prefixes.length;
      if (removed > 0) {
        showToast("info", `🚫 已排除 ${removed} 个官方保留前缀（不可注册）`);
      }
      if (prefixes.length === 0) {
        showToast("error", "全部候选前缀都属于官方保留名单，无可查询项！");
        return;
      }
    }

    // 生成任务：中文等非 ASCII 前缀转 Punycode 用于实际查询(queryFull)，
    // 同时保留中文原文(full)用于日志与结果展示
    const allTasks: Array<{ sub: string; root: string; full: string; queryFull: string }> = [];
    for (const sub of prefixes) {
      for (const root of selectedRoots) {
        const full = `${sub}.${root}`;
        allTasks.push({ sub, root, full, queryFull: toASCII(full) });
      }
    }

    // ── 查重池过滤 ──
    // 池子只用于「跳过已确认已注册的域名」，属于纯优化项，不是扫描的前置依赖。
    // 因此这里不再阻塞等待全部批次查完（旧实现串行 await 40+ 次往返，
    // 用户开扫前要白等十几秒），而是：
    //   1) 先同步查第一批，拿到即可开工；
    //   2) 其余批次在后台并发补充进 skipSet，worker 领任务时实时查表跳过。
    const POOL_BATCH = 400; // 与后端单条语句内联上限对齐
    const skipSet = new Set<string>();
    let poolFailed = false;

    const fetchPoolChunk = async (chunk: typeof allTasks) => {
      const res = await apiFetch("/api/whois/pool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domains: chunk.map(t => t.queryFull) })
      });
      const data = await res.json();
      if (data.success && Array.isArray(data.registered)) {
        data.registered.forEach((d: string) => skipSet.add(d));
      }
    };

    const logPoolFailure = (e: unknown) => {
      if (poolFailed) return; // 只提示一次，避免日志被刷屏
      poolFailed = true;
      console.error("查重池查询失败，将退化为全量扫描:", e);
      setScanLogs(prev => [
        {
          id: Date.now() + Math.random(),
          time: new Date().toLocaleTimeString(),
          text: "⚠️ 查重池查询失败，本轮已退化为全量扫描（不影响结果，仅多消耗 API 配额）",
          status: "error"
        },
        ...prev.slice(0, 49)
      ]);
      showToast("warning", "⚠️ 查重池查询失败，已退化为全量扫描");
    };

    if (!ignorePool) {
      const chunks: Array<typeof allTasks> = [];
      for (let i = 0; i < allTasks.length; i += POOL_BATCH) {
        chunks.push(allTasks.slice(i, i + POOL_BATCH));
      }

      // 第一批同步等待：小规模扫描（单批）到这里池子就已完整
      try {
        if (chunks.length > 0) await fetchPoolChunk(chunks[0]);
      } catch (e) {
        logPoolFailure(e);
      }

      // 其余批次后台并发补充，不阻塞扫描启动
      if (chunks.length > 1) {
        void Promise.all(
          chunks.slice(1).map(ch => fetchPoolChunk(ch).catch(logPoolFailure))
        ).then(() => {
          if (!poolFailed && skipSet.size > 0) {
            setScanLogs(prev => [
              {
                id: Date.now() + Math.random(),
                time: new Date().toLocaleTimeString(),
                text: `🗂️ 查重池加载完毕，共命中 ${skipSet.size} 个已注册域名（扫描中自动跳过）`,
                status: "info"
              },
              ...prev.slice(0, 49)
            ]);
          }
        });
      }

      if (skipSet.size > 0) {
        showToast("info", `🗂️ 查重池已命中 ${skipSet.size} 个已注册域名，将在扫描中自动跳过`);
      }
    }

    // 全部候选都在池中（仅当池子已完整加载时才可能成立）
    if (allTasks.length > 0 && skipSet.size >= allTasks.length) {
      showToast("success", "🎉 本轮全部候选均已在查重池中确认为已注册，无需重复查询！");
      updateScanStatus("completed");
      return;
    }

    const totalTasks = allTasks;

    // 多账号并发查重：
    // 为每个 API 账号开一条独立的流水线（worker），各自绑定固定账号并遵守自身 1.2s (1200ms) 限频。
    // N 条流水线同时工作 => 整体吞吐量约为单账号的 N 倍（真并发，而非串行轮询）。
    const RATE_LIMIT_MS = 1200; // 单个 API 账号的独立限频底线
    const workerAccounts = dnsheAccounts.length > 0 ? dnsheAccounts : [null];
    const workerCount = workerAccounts.length;

    updateScanStatus("running");
    setScanProgress({ total: totalTasks.length, checked: 0, available: availableDomainsList.length });
    showToast(
      "info",
      `🚀 开始多账号并发查重！绑定 ${workerCount} 个 API 账号，${workerCount} 条流水线并行（每个 API 独立保障 1.2s 限频），查重吞吐提升约 ${workerCount} 倍！`
    );

    // 共享的任务游标：各 worker 抢占式领取任务，天然实现负载均衡
    let nextTaskIndex = 0;
    let checkedCount = 0;
    let skippedCount = 0; // 因命中查重池而跳过的数量（未消耗上游 API 配额）

    // 单个域名的查询与日志上报逻辑
    const processTask = async (
      task: { sub: string; root: string; full: string; queryFull: string },
      account: (typeof workerAccounts)[number]
    ) => {
      const accountQuery = account ? `&account_id=${account.id}` : "";
      const accAlias = account ? account.alias : "公共轮询";
      const nowTime = new Date().toLocaleTimeString();
      try {
        const res = await apiFetch(`/api/whois?domain=${encodeURIComponent(task.queryFull)}${accountQuery}&batch=1`);
        const data = await res.json();

        // 限流感知：撞到 429 / 配额耗尽时自动暂停，保住断点光标供稍后继续
        if (res.status === 429 || data.error_code === "rate_limited" || data.error_code === "quota_exceeded") {
          saveScanCursor(task.sub, nextTaskIndex, checkedCount);
          updateScanStatus("paused");
          setScanLogs(prev => [
            { id: Date.now() + Math.random(), time: nowTime, text: `[${accAlias}] ⛔ 触发 API 限流/配额上限，已自动暂停（断点已保存至 ${task.sub}）`, status: "error" },
            ...prev.slice(0, 49)
          ]);
          showToast("warning", "⛔ 触发 API 限流，已自动暂停并保存断点，稍后可点击继续");
          return;
        }

        if (data.success && data.whois && data.whois.registered === false) {
          setAvailableDomainsList(prev => [
            { fullDomain: task.full, subdomain: task.sub, rootdomain: task.root, time: nowTime },
            ...prev
          ]);
          checkedCount++;
          setScanProgress(p => ({ ...p, checked: checkedCount, available: p.available + 1 }));
          setScanLogs(prev => [
            { id: Date.now() + Math.random(), time: nowTime, text: `[${accAlias}] 校验域名 ${task.full} ➔ 🎉 尚未注册（可立即在线注册！）`, status: "available" },
            ...prev.slice(0, 49)
          ]);
        } else {
          checkedCount++;
          setScanProgress(p => ({ ...p, checked: checkedCount }));
          setScanLogs(prev => [
            { id: Date.now() + Math.random(), time: nowTime, text: `[${accAlias}] 校验域名 ${task.full} ➔ 已被他人注册`, status: "registered" },
            ...prev.slice(0, 49)
          ]);
        }
      } catch (err) {
        checkedCount++;
        setScanProgress(p => ({ ...p, checked: checkedCount }));
        setScanLogs(prev => [
          { id: Date.now() + Math.random(), time: nowTime, text: `[${accAlias}] 校验域名 ${task.full} ➔ ⚠️ 查询请求异常，已跳过`, status: "error" },
          ...prev.slice(0, 49)
        ]);
      }
    };

    // 单条流水线：固定绑定一个账号，循环领取任务并遵守自身 1.2s 限频
    const runWorker = async (account: (typeof workerAccounts)[number]) => {
      while (true) {
        // 停止或重置
        if ((scanControlRef.current as string) === "idle") return;

        // 暂停：挂起直到解冻或停止
        while ((scanControlRef.current as string) === "paused") {
          await new Promise(r => setTimeout(r, 300));
          if ((scanControlRef.current as string) === "idle") return;
        }

        // 抢占式领取下一个任务
        const idx = nextTaskIndex++;
        if (idx >= totalTasks.length) return;

        // 实时记录进度，供暂停/限流时落盘为断点光标
        scanCursorRef.current = {
          lastCandidate: totalTasks[idx].sub,
          taskIndex: idx,
          checked: checkedCount
        };

        // 查重池命中：直接跳过，既不发请求也不占用该账号的限频窗口。
        // 池子在后台持续加载，越往后命中率越完整。
        if (!ignorePool && skipSet.has(totalTasks[idx].queryFull)) {
          checkedCount++;
          skippedCount++;
          setScanProgress(p => ({ ...p, checked: checkedCount }));
          continue;
        }

        const startedAt = Date.now();
        await processTask(totalTasks[idx], account);

        // 该账号自身限频：距上次请求发起不足 1.2s 则补足剩余时间
        const elapsed = Date.now() - startedAt;
        if (elapsed < RATE_LIMIT_MS) {
          await new Promise(r => setTimeout(r, RATE_LIMIT_MS - elapsed));
        }
      }
    };

    // 所有流水线同时启动，等待全部跑完
    await Promise.all(workerAccounts.map(acc => runWorker(acc)));

    if (scanControlRef.current === "running") {
      updateScanStatus("completed");
      clearScanCursor(); // 正常跑完，断点光标不再需要
      showToast(
        "success",
        skippedCount > 0
          ? `🎉 所有生成的域名字典查询完毕！其中 ${skippedCount} 个命中查重池已跳过，节省了同等数量的 API 配额。`
          : "🎉 所有生成的域名字典查询完毕！"
      );
    }
  };

  // 导出生成的 txt 结果
  const handleExportAvailableTxt = () => {
    if (availableDomainsList.length === 0) {
      showToast("info", "暂无已发现的可用域名供导出！");
      return;
    }

    const content = availableDomainsList.map(item => item.fullDomain).join("\n");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `available_domains_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("success", "已成功导出可用域名 txt 文本！");
  };

  // 从「发现可用域名」卡片点击注册：回填单域名表单并瞬发绿色卡片 + 拉取 WHOIS
  const handleRegisterFromResult = (item: AvailableDomain) => {
    const sub = item.subdomain;
    const root = item.rootdomain;
    setSearchSubdomain(sub);
    setSearchRootdomain(root);
    setRegMode("single");
    if (dnsheAccounts.length > 0 && !registerAccountId) {
      setRegisterAccountId(dnsheAccounts[0].id);
    }
    // 瞬发呈现绿色【尚未注册】卡片，提升即时响应体验
    setWhoisResult({
      searchedDomain: item.fullDomain,
      registered: false
    });
    // 显式带参数自动触发后台 WHOIS 重新拉取详细元数据
    handleCheckWhois(undefined, sub, root);
  };

  return {
    // 常量
    DEFAULT_ROOT_DOMAINS,
    MAX_PREFIXES,
    // toast（供页面内联按钮复用，保持纯搬运）
    showToast,
    // 根域名
    allRootDomains,
    newRootInput,
    setNewRootInput,
    handleAddCustomRootDomain,
    handleRemoveCustomRootDomain,
    // 单域名 WHOIS / 注册
    searchSubdomain,
    setSearchSubdomain,
    searchRootdomain,
    setSearchRootdomain,
    whoisLoading,
    whoisResult,
    setWhoisResult,
    registerAccountId,
    setRegisterAccountId,
    handleCheckWhois,
    handleRegisterSubdomain,
    // 模式切换
    regMode,
    setRegMode,
    // 规则生成
    batchRules,
    setBatchRules,
    excludeChars,
    setExcludeChars,
    selectedRoots,
    setSelectedRoots,
    batchLength,
    setBatchLength,
    resolveBank,
    rulePreview,
    formatDuration,
    // 顺序模式
    seqMode,
    setSeqMode,
    seqCharset,
    setSeqCharset,
    seqLength,
    setSeqLength,
    seqStart,
    setSeqStart,
    // 扫描控制 / 进度 / 结果
    scanStatus,
    scanProgress,
    availableDomainsList,
    scanLogs,
    scanCursor,
    scanCursorRef,
    updateScanStatus,
    handleStartBatchScan,
    handleExportAvailableTxt,
    saveScanCursor,
    clearScanCursor,
    handleRegisterFromResult,
    ignorePool,
    setIgnorePool,
    // 保留前缀
    reservedPrefixes,
    enableReservedFilter,
    newReservedInput,
    setNewReservedInput,
    handleAddReserved,
    handleRemoveReserved,
    handleResetReserved,
    toggleReservedFilter,
    // 词库
    wordBanks,
    bankModalOpen,
    setBankModalOpen,
    editingBank,
    bankFormName,
    setBankFormName,
    bankFormKind,
    setBankFormKind,
    bankFormWords,
    setBankFormWords,
    openCreateBank,
    openEditBank,
    handleSaveBank,
    handleDeleteBank,
    handleResetBanks,
    appendWordbank,
    // 重置扫描（「重新开始」按钮）
    resetScan: () => {
      updateScanStatus("idle");
      setAvailableDomainsList([]);
      setScanLogs([]);
      setScanProgress({ total: 0, checked: 0, available: 0 });
      clearScanCursor();
      showToast("info", "🔄 已重置查重逻辑（断点已清除）");
    },
    // 暂停扫描（「暂停查询」按钮）
    pauseScan: () => {
      const c = scanCursorRef.current;
      saveScanCursor(c.lastCandidate, c.taskIndex, c.checked);
      updateScanStatus("paused");
      showToast("info", `⏸️ 已暂停并保存断点（当前位置：${c.lastCandidate || "起点"}）`);
    },
    // 注册按钮的 loading 标识（复用 App 级 actionLoading）
    registerLoading: actionLoading === "register-subdomain",
  };
}

export type UseScannerReturn = ReturnType<typeof useScanner>;
export { DEFAULT_ROOT_DOMAINS };
