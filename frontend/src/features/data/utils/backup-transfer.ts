export interface BackupPreview {
  totalAdd: number; totalUpdate: number; totalRemove: number; totalConflicts: number;
  canImport: boolean; rowCount: number; importLimit: number;
  conflictDetails: Array<{ table: string; id: number; reason: string }>;
}

export function isBackupPreview(value: unknown): value is BackupPreview {
  if (!value || typeof value !== "object") return false;
  const data = value as BackupPreview;
  return [data.totalAdd, data.totalUpdate, data.totalRemove, data.totalConflicts, data.rowCount, data.importLimit]
    .every(number => Number.isSafeInteger(number) && number >= 0) &&
    data.canImport === (data.totalConflicts === 0 && data.rowCount <= data.importLimit) &&
    Array.isArray(data.conflictDetails) && data.conflictDetails.length <= 50 && data.conflictDetails.every(item =>
      item && typeof item.table === "string" && Number.isSafeInteger(item.id) && typeof item.reason === "string");
}

/** Preserve integrity metadata when stripping the HTTP envelope for download. */
export function downloadableBackup(data: Record<string, unknown>) {
  return { version: data.version, exported_at: data.exported_at, counts: data.counts, data: data.data, metadata: data.metadata };
}

export async function refreshRestoredData(actions: Array<() => Promise<unknown> | unknown>): Promise<boolean> {
  const results = await Promise.allSettled(actions.map(action => Promise.resolve().then(action)));
  return results.every(result => result.status === "fulfilled");
}
