import { useState } from "react";
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
  /** 导入成功后刷新账户安全信息（2FA 状态可能被备份覆盖） */
  fetchAccountInfo: () => Promise<void> | void;
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
 * - **导入是合并 upsert，不删数据**：同名 ID 覆盖、新 ID 追加。
 * - **选文件时必须本地先 `JSON.parse` 一次**：格式不对就别浪费一次往返，也让用户早看到问题；
 *   20MB 上限也在本地拦（`file.size` 判定，不读进内存）。
 * - **落盘的 blob URL 必须延后 revoke**：同步 revoke 会让部分浏览器的下载拿到空文件。
 * - 导入成功后要刷新两处：`fetchDomains()`（域名列表）与 `fetchAccountInfo()`
 *   （备份可能覆盖了 2FA 开关）。二者的定义都在 Hook 外，故以依赖注入方式传入。
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
  const [dataOpOpen, setDataOpOpen] = useState(false);
  const [dataOpMode, setDataOpMode] = useState<"export" | "import">("export");
  const [dataOpToken, setDataOpToken] = useState("");
  // 已选中的备份文件（导入用），同时保留原始文本以便提交
  const [importSnapshot, setImportSnapshot] = useState<ImportSnapshot | null>(null);

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
    try {
      const snapshot = JSON.parse(importSnapshot.text);
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
        // 数据变了，刷新各页面的列表
        void fetchDomains();
        void fetchAccountInfo();
      } else {
        showToast("error", data.message || "导入失败");
      }
    } catch (e) {
      showToast("error", "导入请求失败，请检查网络");
    } finally {
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
    handleExportData,
    handlePickSnapshotFile,
    handleImportData,
  };
}

export type UseDataTransferReturn = ReturnType<typeof useDataTransfer>;
