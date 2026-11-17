import type { ApiFetch } from "../../../api/client";
import { apiJson, ApiRequestError, jsonHeaders } from "../../../api/request";
import { requestDeadline } from "../../../api/request-deadline";
import {
  RESTORE_TABLES, RESTORE_MAX_ROWS, RESTORE_MAX_BYTES, RESTORE_CHUNK_BYTES, RESTORE_CHUNK_ROWS,
  canonicalJson, type RestoreManifest, type RestoreTable,
} from "../../../../../shared/restore-wire";
import { isBackupPreview, type BackupPreview } from "./backup-transfer";

export interface RestoreState {
  id: string; status: "uploading" | "ready" | "committed" | "cancelled";
  next_chunk: number; chunk_count: number; uploaded_rows: number; expires_at: number;
  result: { diff?: BackupPreview; imported?: Record<string, number> } | null;
}
async function digest(text: string) {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join("");
}
export const restoreStorageKey = async (backend: string, token: string) =>
  `DOMAIN_HUB_RESTORE:${encodeURIComponent(backend.trim().replace(/\/+$/, "") || "/")}:${await digest(token)}`;

export async function planStagedRestore(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("备份格式无效");
  const value = snapshot as Record<string, unknown>;
  if (!value.data || typeof value.data !== "object" || Array.isArray(value.data)) throw new Error("备份 data 无效");
  const data = value.data as Record<string, unknown>;
  if (Object.keys(data).some(table => !RESTORE_TABLES.includes(table as RestoreTable))) throw new Error("备份包含不支持的表");
  const { data: _data, ...header } = value;
  const manifest: RestoreManifest = { header, data_tables: Object.keys(data) as RestoreTable[],
    counts: {} as Record<RestoreTable, number>, chunks: [], digest: await digest(canonicalJson(value)) };
  const chunks: unknown[][] = [];
  let total = 0, bytes = 0;
  for (const table of RESTORE_TABLES) {
    const rows = data[table] ?? [];
    if (!Array.isArray(rows)) throw new Error(`${table} 必须是数组`);
    manifest.counts[table] = rows.length; total += rows.length;
    if (total > RESTORE_MAX_ROWS || (table === "accounts" && rows.length > 500)) throw new Error("分段恢复最多 10,000 行、500 个 API 账号");
    let chunk: unknown[] = [], offset = 0, chunkBytes = 2;
    const flush = async () => {
      if (!chunk.length) return;
      const raw = canonicalJson(chunk);
      manifest.chunks.push({ table, offset, count: chunk.length, digest: await digest(raw) });
      chunks.push(chunk); offset += chunk.length; chunk = []; chunkBytes = 2;
    };
    for (const row of rows) {
      const size = new TextEncoder().encode(canonicalJson(row)).byteLength;
      if (size + 2 > RESTORE_CHUNK_BYTES) throw new Error("单行超过分段大小上限");
      if (chunk.length >= RESTORE_CHUNK_ROWS || chunkBytes + size + 1 > RESTORE_CHUNK_BYTES) await flush();
      chunk.push(row); chunkBytes += size + 1; bytes += size + 1;
      if (bytes > RESTORE_MAX_BYTES) throw new Error("分段恢复内容超过 8MB 上限");
    }
    await flush();
  }
  return { manifest, chunks };
}

function reference(key: string): { id: string; digest: string } | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value && /^[a-f0-9-]{36}$/i.test(value.id) && /^[a-f0-9]{64}$/.test(value.digest) ? value : null;
  } catch { return null; }
}
export function clearRestoreReference(key: string, id: string) {
  try { if (reference(key)?.id === id) localStorage.removeItem(key); } catch { /* server state remains authoritative */ }
}

export async function restoreRequest(apiFetch: ApiFetch, path: string, body?: unknown): Promise<{ session: RestoreState; warnings?: string[] }> {
  const deadline = requestDeadline(undefined, 30000);
  try {
    const response = await apiJson<{ session: RestoreState; warnings?: string[] }>(apiFetch, `/api/data/restore/${path}`, body === undefined
      ? { signal: deadline.signal }
      : { method: "POST", headers: jsonHeaders, body: JSON.stringify(body), signal: deadline.signal });
    const state = response.session;
    if (!state || !["uploading", "ready", "committed", "cancelled"].includes(state.status) ||
        !/^[a-f0-9-]{36}$/i.test(state.id) ||
        ![state.next_chunk, state.chunk_count, state.uploaded_rows, state.expires_at].every(value => Number.isSafeInteger(value) && value >= 0) ||
        state.next_chunk > state.chunk_count) throw new Error("分段会话响应无效");
    return response;
  } finally { deadline.dispose(); }
}

export async function prepareStagedRestore(apiFetch: ApiFetch, snapshot: unknown, token: string, key: string,
  options: { isCurrent: () => boolean; onSession: (id: string, digest: string) => void; onProgress: (done: number, total: number) => void;
    onStorageFailure: () => void; remembered?: { key: string; id: string; digest: string } | null }) {
  const { manifest, chunks } = await planStagedRestore(snapshot);
  if (!options.isCurrent()) throw new Error("文件选择已改变，分段上传已停止");
  const stored = reference(key) || (options.remembered?.key === key ? options.remembered : null);
  const id = stored?.digest === manifest.digest ? stored.id : crypto.randomUUID();
  options.onSession(id, manifest.digest);
  try { localStorage.setItem(key, JSON.stringify({ id, digest: manifest.digest })); }
  catch { options.onStorageFailure(); }
  let state: RestoreState;
  try { state = (await restoreRequest(apiFetch, id)).session; }
  catch (error) {
    if (!(error instanceof ApiRequestError) || error.status !== 404) throw error;
    state = (await restoreRequest(apiFetch, "create", { id, manifest, token })).session;
  }
  if (state.status === "cancelled") { clearRestoreReference(key, id); throw new Error("分段会话已取消，请重新选择文件开始新会话"); }
  if (state.chunk_count !== chunks.length) throw new Error("分段会话与当前文件不一致");
  for (let index = state.next_chunk; index < chunks.length; index++) {
    if (!options.isCurrent()) throw new Error("文件选择已改变；staging 已保存，可稍后续传");
    state = (await restoreRequest(apiFetch, `${id}/chunks/${index}`, { rows: chunks[index] })).session;
    options.onProgress(state.next_chunk, chunks.length);
  }
  if (!options.isCurrent()) throw new Error("文件选择已改变，尚未提交业务数据");
  if (state.status !== "committed") state = (await restoreRequest(apiFetch, `${id}/validate`, {})).session;
  if (state.status !== "committed" && !isBackupPreview(state.result?.diff)) throw new Error("分段预览响应无效");
  return state;
}
