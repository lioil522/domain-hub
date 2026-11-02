import { useEffect, useRef, useState } from "react";
import { readSessionToken } from "../../../api/client";
import { requestTransfer, type ImportPreview } from "../utils/transfer-request";
import type { ApiFetch } from "../../../api/client";
import type { ToastType } from "../../../hooks/useToast";
import type { AccountInfo } from "../../auth/types";

/** 已选中的备份文件（导入用）：名字用于回显，text 保留原始文本以便提交 */
export interface ImportSnapshot {
  name: string;
  text: string;
}

export interface UseDataTransferDeps {
  apiFetch: ApiFetch;
  showToast: (type: ToastType, message: string) => void;
  /** 账户安全信息 —— 决定导出/导入是否需要 2FA 动态码 */
  accountInfo: AccountInfo;
  setActionLoading: (v: string | null) => void;
  /**
   * 导入成功后刷新域名列表。
   * ⚠️ 因为它在 App 里是 `const fetchDomains = …`，存在 TDZ，
   * 所以本 hook 的**调用点必须晚于该声明**（见 App.tsx 里的 NOTE）。
   */
  fetchDomains: () => Promise<void> | void;
  /** 导入成功后刷新账户安全信息；快照不包含 settings/2FA。 */
  fetchAccountInfo: () => Promise<void> | void;
}

/**
 * useDataTransfer —— 数据导入 / 导出（全量业务数据 JSON 快照）
 *
 * WHY 抽成 hook：
 * 「导出（需 2FA）→ 落盘为文件」「选文件 → 只读预览 → 明确确认追加 → 刷新列表」
 * 是一条完整流程，连同它自己的「2FA 二次验证弹窗」开关状态，原先平铺在 App 中部。
 * 抽出来后 App 只保留一次解构，弹窗 JSX 仍留在 App（它读的就是这里返回的状态与 setter）。
 *
 * 关键不变量：
 * - **导出强制 2FA**：未开启 2FA 时按钮直接置灰（在 App 的 JSX 里判定），
 *   这里只做「已开启但没填码」的兜底拦截。
 * - 导入映射本地 ID，已有冲突整批拒绝，不覆盖、不删除。
 * - **选文件时必须本地先 `JSON.parse` 一次**：格式不对就别浪费一次往返，也让用户早看到问题；
 *   8MiB/500行上限也在本地拦。
 * - **落盘的 blob URL 必须延后 revoke**：同步 revoke 会让部分浏览器的下载拿到空文件。
 * - 导入成功后要刷新两处：`fetchDomains()`（域名列表）与 `fetchAccountInfo()`
 *   （settings/2FA不在备份中）。二者以依赖注入方式传入。
 */
export function useDataTransfer({
  apiFetch,
  showToast,
  accountInfo,
  setActionLoading,
  fetchDomains,
  fetchAccountInfo,
}: UseDataTransferDeps) {
  // 数据导入/导出：二次验证弹窗（导出强制 2FA；导入在已开启 2FA 时也需验证）
  const [dataOpOpen, updateDataOpOpen] = useState(false);
  const [dataOpMode, setDataOpMode] = useState<"export" | "import">("export");
  const [dataOpToken, setDataOpToken] = useState("");
  // 已选中的备份文件（导入用），同时保留原始文本以便提交
  const [importSnapshot, updateSnapshot] = useState<ImportSnapshot | null>(null);
  const [sourceAesKey, updateSourceKey] = useState("");
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const revision = useRef(0), inFlight = useRef(false);
  const currentSession = readSessionToken();
  const setImportSnapshot = (value: ImportSnapshot | null) => { revision.current++; updateSnapshot(value); setImportPreview(null); };
  const setSourceAesKey = (value: string) => { revision.current++; updateSourceKey(value); setImportPreview(null); };
  const setDataOpOpen = (open: boolean) => {
    updateDataOpOpen(open);
    if (!open) { revision.current++; setDataOpToken(""); updateSourceKey(""); updateSnapshot(null); setImportPreview(null); }
  };
  useEffect(() => {
    setDataOpOpen(false);
    return () => { revision.current++; };
    // Session changes and unmount fence late reads/results and clear source keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSession]);

  /** 把导出的快照以文件形式落盘 */
  const downloadSnapshot = (snapshot: unknown) => {
    const json = JSON.stringify(snapshot);
    const blob = new Blob([json], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const a = document.createElement("a");
    a.href = url;
    a.download = `domain-hub-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // NOTE: revoke 必须延后。同步 revoke 会在部分浏览器上让下载直接拿到空文件
    // （点击的下载动作还没开始读 blob，URL 就已经失效）。
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  /** 执行导出（需 2FA 动态码） */
  const handleExportData = async () => {
    if (accountInfo.two_fa_enabled && !dataOpToken.trim()) {
      showToast("error", "请输入身份验证器上的 6 位动态码");
      return;
    }
    setActionLoading("data-export");
    try {
      const res = await apiFetch("/api/data/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: dataOpToken.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        downloadSnapshot({
          version: data.version,
          exported_at: data.exported_at,
          counts: data.counts,
          data: data.data,
        });
        const c = data.counts || {};
        showToast(
          "success",
          `导出成功：账号 ${c.accounts ?? 0} 个 / 域名缓存 ${c.domains_cache ?? 0} 条 / 自定义域名 ${c.custom_domains ?? 0} 条`
        );
        setDataOpOpen(false);
        setDataOpToken("");
      } else {
        // 后端 2FA 相关错误码单独提示，避免用户以为是自己密码错了
        showToast("error", data.message || "导出失败");
      }
    } catch (e) {
      showToast("error", "导出请求失败，请检查网络");
    } finally {
      setActionLoading(null);
    }
  };

  /** 读取用户选中的备份文件 */
  const handlePickSnapshotFile = async (file: File | null) => {
    setImportSnapshot(null);
    const expected = revision.current;
    if (!file) {
      setImportSnapshot(null);
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      showToast("error", "备份文件过大（上限 8MiB/500行）；请使用数据库/AES成对备份");
      setImportSnapshot(null);
      return;
    }
    try {
      const text = await file.text();
      if (revision.current !== expected) return;
      // 本地先解析一次：格式不对就别浪费一次往返，也让用户早看到问题
      const parsed = JSON.parse(text);
      if (parsed?.version !== 1 || !parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data) ||
        Object.values(parsed.data).some(rows => !Array.isArray(rows)) ||
        Object.values(parsed.data).reduce<number>((n, rows) => n + (rows as unknown[]).length, 0) > 500) {
        showToast("error", "备份无效：需要版本1、完整归属，最多500行/8MiB");
        setImportSnapshot(null);
        return;
      }
      setImportSnapshot({ name: file.name, text });
    } catch {
      if (revision.current !== expected) return;
      showToast("error", "文件不是合法 JSON，无法解析");
      setImportSnapshot(null);
    }
  };

  /** 首次点击只读预览；第二次明确确认才导入。文件/源Key变化使预览失效。 */
  const handleImportData = async () => {
    if (inFlight.current) return;
    if (!importSnapshot) {
      showToast("error", "请先选择备份文件");
      return;
    }
    if (accountInfo.two_fa_enabled && !dataOpToken.trim()) {
      showToast("error", "请输入身份验证器上的 6 位动态码");
      return;
    }
    const mode = importPreview ? "import" : "preview";
    const expected = revision.current, session = readSessionToken();
    const active = () => revision.current === expected && readSessionToken() === session;
    inFlight.current = true;
    setActionLoading(mode === "import" ? "data-import" : "data-preview");
    try {
      const snapshot = JSON.parse(importSnapshot.text);
      const data = await requestTransfer(apiFetch, mode, { token: dataOpToken.trim(), snapshot, ...(sourceAesKey ? { sourceAesKey } : {}) });
      if (!active()) return;
      if (mode === "preview") { setImportPreview(data.diff as ImportPreview); return; }
      if (data.success === true) {
        showToast("success", typeof data.message === "string" ? data.message : "导入完成");
        setDataOpOpen(false);
        setDataOpToken("");
        setImportSnapshot(null);
        // 数据变了，刷新各页面的列表
        await Promise.allSettled([Promise.resolve().then(fetchDomains), Promise.resolve().then(fetchAccountInfo)]);
      }
    } catch {
      if (active()) { setImportPreview(null); showToast("error", mode === "preview" ? "预览失败：请核对文件、源AES密钥及目标冲突；未导入" : "导入失败或结果未确认；请检查审计/目标数据，不自动重试"); }
    } finally {
      inFlight.current = false;
      setActionLoading(null);
    }
  };

  return {
    dataOpOpen,
    setDataOpOpen,
    dataOpMode,
    setDataOpMode,
    dataOpToken,
    setDataOpToken,
    importSnapshot,
    setImportSnapshot,
    sourceAesKey, setSourceAesKey, importPreview,
    handleExportData,
    handlePickSnapshotFile,
    handleImportData,
  };
}

export type UseDataTransferReturn = ReturnType<typeof useDataTransfer>;
