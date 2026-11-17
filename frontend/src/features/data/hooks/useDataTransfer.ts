import { useEffect, useRef, useState } from "react";
import type { ApiFetch } from "../../../api/client";
import type { ToastType } from "../../../hooks/useToast";
import type { AccountInfo } from "../../auth/types";
import { downloadableBackup, isBackupPreview, type BackupPreview } from "../utils/backup-transfer";
import { prepareStagedRestore, restoreRequest, restoreStorageKey, clearRestoreReference } from "../utils/staged-restore";

/** 已选中的备份文件（导入用）：名字用于回显，text 保留原始文本以便提交 */
export interface ImportSnapshot {
  name: string;
  text: string;
}

export interface UseDataTransferDeps {
  apiFetch: ApiFetch;
  backendUrl: string;
  sessionToken: string | null;
  showToast: (type: ToastType, message: string) => void;
  /** 账户安全信息 —— 决定导出/导入是否需要 2FA 动态码 */
  accountInfo: AccountInfo;
  setActionLoading: (v: string | null) => void;
  /** Refresh accounts, every provider, custom domains and derived quota state. */
  onRestored: () => Promise<boolean>;
}

/**
 * useDataTransfer —— 数据导入 / 导出（全量业务数据 JSON 快照）
 *
 * WHY 抽成 hook：
 * 「导出（需 2FA）→ 落盘为文件」「选文件 → 本地先校验格式 → 导入（合并 upsert）→ 刷新列表」
 * 是一条完整流程，连同它自己的「2FA 二次验证弹窗」开关状态，原先平铺在 App 中部。
 * 抽出来后 App 只保留一次解构，弹窗 JSX 仍留在 App（它读的就是这里返回的状态与 setter）。
 *
 * 关键不变量：
 * - **导出强制 2FA**：未开启 2FA 时按钮直接置灰（在 App 的 JSX 里判定），
 *   这里只做「已开启但没填码」的兜底拦截。
 * - 导入前预览身份冲突；同 ID 且身份一致才覆盖，新 ID 追加，不删除。
 * - **选文件时必须本地先 `JSON.parse` 一次**：格式不对就别浪费一次往返，也让用户早看到问题；
 *   20MB 上限也在本地拦（`file.size` 判定，不读进内存）。
 * - **落盘的 blob URL 必须延后 revoke**：同步 revoke 会让部分浏览器的下载拿到空文件。
 * - 导入仅涉及业务表，不覆盖登录/2FA 配置；完成后刷新所有业务来源。
 */
export function useDataTransfer({
  apiFetch,
  backendUrl,
  sessionToken,
  showToast,
  accountInfo,
  setActionLoading,
  onRestored,
}: UseDataTransferDeps) {
  // 数据导入/导出：二次验证弹窗（导出强制 2FA；导入在已开启 2FA 时也需验证）
  const [dataOpOpen, setDataOpOpen] = useState(false);
  const [dataOpMode, setDataOpMode] = useState<"export" | "import">("export");
  const [dataOpToken, setDataOpToken] = useState("");
  // 已选中的备份文件（导入用），同时保留原始文本以便提交
  const [importSnapshot, setImportSnapshotState] = useState<ImportSnapshot | null>(null);
  const selectedSnapshot = useRef<ImportSnapshot | null>(null);
  const selectionGeneration = useRef(0);
  const [importPreview, setImportPreview] = useState<BackupPreview | null>(null);
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [restoreProgress, setRestoreProgress] = useState<{ done: number; total: number } | null>(null);
  const stagedReady = useRef<{ id: string; file: ImportSnapshot } | null>(null);
  const stagedReference = useRef<{ key: string; id: string; digest: string } | null>(null);
  const setImportSnapshot = (value: ImportSnapshot | null) => {
    selectionGeneration.current++;
    selectedSnapshot.current = value;
    setImportSnapshotState(value);
    setImportPreview(null);
    stagedReady.current = null;
    setRestoreProgress(null);
  };
  useEffect(() => {
    selectedSnapshot.current = null; selectionGeneration.current++;
    setImportSnapshotState(null); setImportPreview(null); stagedReady.current = null; stagedReference.current = null; setRestoreId(null);
  }, [backendUrl, sessionToken]);

  /** 把导出的快照以文件形式落盘 */
  const downloadSnapshot = (snapshot: unknown) => {
    const json = JSON.stringify(snapshot, null, 2);
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
        downloadSnapshot(downloadableBackup(data));
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
    const generation = selectionGeneration.current;
    if (!file) {
      setImportSnapshot(null);
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      showToast("error", "备份文件过大（上限 20MB）");
      setImportSnapshot(null);
      return;
    }
    try {
      const text = await file.text();
      if (generation !== selectionGeneration.current) return;
      // 本地先解析一次：格式不对就别浪费一次往返，也让用户早看到问题
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || !parsed.data) {
        showToast("error", "该文件不是有效的备份（缺少 data 字段）");
        setImportSnapshot(null);
        return;
      }
      setImportSnapshot({ name: file.name, text });
    } catch {
      showToast("error", "文件不是合法 JSON，无法解析");
      setImportSnapshot(null);
    }
  };

  /** 执行导入（合并 upsert） */
  const handleImportData = async () => {
    if (!importSnapshot) {
      showToast("error", "请先选择备份文件");
      return;
    }
    if (accountInfo.two_fa_enabled && !dataOpToken.trim()) {
      showToast("error", "请输入身份验证器上的 6 位动态码");
      return;
    }
    setActionLoading("data-import");
    const selected = importSnapshot;
    try {
      const snapshot = JSON.parse(importSnapshot.text);
      const large = snapshot.data && Object.values(snapshot.data).reduce((n: number, rows) => n + (Array.isArray(rows) ? rows.length : 0), 0) > 500;
      if (!importPreview) {
        if (large) {
          if (!sessionToken) return;
          const key = await restoreStorageKey(backendUrl, sessionToken);
          const state = await prepareStagedRestore(apiFetch, snapshot, dataOpToken.trim(), key, {
            isCurrent: () => selectedSnapshot.current === selected,
            remembered: stagedReference.current,
            onSession: (id, digest) => { setRestoreId(id); stagedReference.current = { key, id, digest }; },
            onProgress: (done, total) => { setRestoreProgress({ done, total }); if (done === total) showToast("info", "分块已上传，正在完整校验；业务表尚未写入"); },
            onStorageFailure: () => showToast("warning", "本地会话引用保存失败，请勿刷新；服务器 staging 仍会保存"),
          });
          if (selectedSnapshot.current !== selected) return;
          if (state.status === "committed") {
            clearRestoreReference(key, state.id);
            showToast("success", "该分段会话已提交，无需重复导入");
            if (!await onRestored().catch(() => false)) showToast("warning", "数据已经提交，但列表刷新失败，请手动刷新");
            setImportSnapshot(null); setRestoreId(null);
            stagedReference.current = null; setDataOpOpen(false);
            return;
          }
          setImportPreview(state.result!.diff!);
          if (state.status === "ready") stagedReady.current = { id: state.id, file: selected };
          showToast(state.status === "ready" ? "info" : "warning", state.status === "ready" ? "分段完整校验通过，请核对预览并确认提交" : "身份冲突尚未解决，业务表未改动");
          return;
        }
        const response = await apiFetch("/api/data/preview", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: dataOpToken.trim(), snapshot }),
        });
        const data = await response.json();
        if (selectedSnapshot.current !== selected) return;
        if (!response.ok || !data.success || !isBackupPreview(data.diff)) { showToast("error", data.message || "备份预览失败或响应格式无效"); return; }
        setImportPreview(data.diff);
        showToast(data.diff.canImport ? "info" : "warning", data.diff.canImport ? "预览已生成，请核对新增与覆盖数量，再点击确认导入" : "存在身份冲突或超出行数上限，尚未写入任何数据");
        return;
      }
      if (!importPreview.canImport) { showToast("error", "请先解决冲突或行数上限问题"); return; }
      if (stagedReady.current?.file === selected) {
        const id = stagedReady.current.id;
        const response = await restoreRequest(apiFetch, `${id}/commit`, { token: dataOpToken.trim() });
        showToast("success", "分段恢复已完整提交");
        if (sessionToken) clearRestoreReference(await restoreStorageKey(backendUrl, sessionToken), id);
        setDataOpOpen(false); setDataOpToken(""); setImportSnapshot(null); setRestoreId(null);
        stagedReference.current = null;
        if (!await onRestored().catch(() => false)) showToast("warning", "数据已提交，但部分列表刷新失败，请手动刷新");
        if (response.warnings?.length) showToast("warning", response.warnings.join("；"));
        return;
      }
      const res = await apiFetch("/api/data/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: dataOpToken.trim(), snapshot }),
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", data.message || "导入完成");
        setDataOpOpen(false);
        setDataOpToken("");
        setImportSnapshot(null);
        const refreshed = await onRestored().catch(() => false);
        if (!refreshed) showToast("warning", "数据已导入，但部分列表刷新失败，请手动刷新；无需重复导入");
        if (Array.isArray(data.warnings) && data.warnings.length) showToast("warning", data.warnings.join("；"));
      } else {
        showToast("error", data.message || "导入失败");
      }
    } catch (e) {
      showToast("error", e instanceof Error ? e.message : "导入请求失败；分段会话可重试，业务状态以服务器为准");
    } finally {
      setActionLoading(null);
    }
  };
  const handleCancelRestore = async () => {
    if (!restoreId || !sessionToken) return;
    try {
      const state = (await restoreRequest(apiFetch, `${restoreId}/cancel`, {})).session;
      clearRestoreReference(await restoreStorageKey(backendUrl, sessionToken), restoreId);
      setRestoreId(null); setImportPreview(null); stagedReady.current = null; stagedReference.current = null;
      showToast(state.status === "committed" ? "info" : "success", state.status === "committed" ? "数据已经提交，取消不会回滚业务数据" : "分段会话已取消，staging 已清除");
    } catch (error) { showToast("error", error instanceof Error ? error.message : "取消分段会话失败"); }
  };

  return {
    dataOpOpen,
    setDataOpOpen,
    dataOpMode,
    setDataOpMode,
    dataOpToken,
    setDataOpToken,
    importSnapshot,
    importPreview,
    restoreId,
    restoreProgress,
    handleCancelRestore,
    setImportSnapshot,
    handleExportData,
    handlePickSnapshotFile,
    handleImportData,
  };
}

export type UseDataTransferReturn = ReturnType<typeof useDataTransfer>;
