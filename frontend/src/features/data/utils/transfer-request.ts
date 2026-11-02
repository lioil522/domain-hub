import { apiJson } from "../../../api/request";
import type { ApiFetch } from "../../../api/client";

export interface ImportPreview { totalAdd: number; totalUpdate: number; totalRemove: number; totalConflicts: number }
/** Never trust HTTP errors or malformed successful responses as a preview or
 * commit receipt. Callers explicitly choose preview vs import, never retry. */
export async function requestTransfer(apiFetch: ApiFetch, mode: "preview" | "import", body: unknown) {
  const result = await apiJson<Record<string, unknown>>(apiFetch, `/api/data/${mode}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (result.success !== true) throw new Error(mode === "preview" ? "预览失败；未导入" : "导入结果未确认；请检查审计，不自动重试");
  if (mode === "preview") {
    const diff = result.diff as ImportPreview | undefined;
    if (!diff || !Number.isSafeInteger(diff.totalAdd) || diff.totalAdd < 0 || diff.totalAdd > 500 ||
      diff.totalUpdate !== 0 || diff.totalRemove !== 0 || diff.totalConflicts !== 0) throw new Error("预览结果无效；未导入");
  } else if (!result.imported || typeof result.imported !== "object" || Array.isArray(result.imported) ||
    !Object.values(result.imported).every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 500)) {
    throw new Error("导入结果未确认；请检查审计，不自动重试");
  }
  return result;
}
