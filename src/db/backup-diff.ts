import { BACKUP_IMPORT_LIMIT, BACKUP_PLAN, type BackupSnapshot, type BackupRow, canonicalJson } from "./backup-snapshot";

export interface BackupDiffItem { table: string; add: number; update: number; remove: number; conflicts: number; }
export interface BackupConflict { table: string; id: number; reason: string; }
export interface BackupDiff {
  tables: BackupDiffItem[];
  totalAdd: number; totalUpdate: number; totalRemove: number; totalConflicts: number;
  conflictDetails: BackupConflict[];
  canImport: boolean; rowCount: number; importLimit: number;
}

const key = (row: BackupRow, columns: readonly string[]) => canonicalJson(columns.map(column => row[column] ?? (column === "provider" ? "dnshe" : null)));
const rowsFor = (snapshot: BackupSnapshot, table: string) => (snapshot.data[table] || []) as BackupRow[];

/** Different identities must never be merged merely because numeric IDs coincide. */
export function diffBackup(current: BackupSnapshot, incoming: BackupSnapshot): BackupDiff {
  const conflicts: BackupConflict[] = [];
  const accounts = new Map([...rowsFor(current, "accounts"), ...rowsFor(incoming, "accounts")].map(row => [row.id, row]));
  const customAccounts = new Map([...rowsFor(current, "custom_accounts"), ...rowsFor(incoming, "custom_accounts")].map(row => [row.id, row]));
  const tables = BACKUP_PLAN.map(step => {
    const before = rowsFor(current, step.table);
    const after = rowsFor(incoming, step.table);
    const byId = new Map(before.map(row => [row.id, row]));
    const natural = new Map<string, Set<BackupRow["id"]>>();
    const extra = new Map<string, Set<BackupRow["id"]>>();
    const addKey = (map: typeof natural, identity: string, id: BackupRow["id"]) => {
      const bucket = map.get(identity) || new Set<BackupRow["id"]>();
      bucket.add(id); map.set(identity, bucket);
    };
    const collides = (map: typeof natural, identity: string, id: BackupRow["id"]) => {
      const bucket = map.get(identity);
      return !!bucket && (bucket.size > 1 || !bucket.has(id));
    };
    for (const row of before) {
      const identity = key(row, step.identity);
      addKey(natural, identity, row.id);
      if (step.table === "accounts") addKey(extra, key(row, ["api_key"]), row.id);
      if (step.table === "domains_cache") {
        addKey(extra, `name:${key(row, ["account_id", "full_domain"])}`, row.id);
        if (row.remote_id !== null) addKey(extra, `remote:${key(row, ["account_id", "remote_id"])}`, row.id);
      }
    }
    const seenIds = new Set(), seenKeys = new Set();
    const domainNames = new Set(), remoteIds = new Set();
    const apiKeys = new Set();
    let add = 0, update = 0, conflictCount = 0;
    for (const row of after) {
      const identity = key(row, step.identity);
      const existing = byId.get(row.id);
      let reason = "";
      if (seenIds.has(row.id) || seenKeys.has(identity)) reason = "备份中存在重复 ID 或业务身份";
      else if (step.table === "accounts" && (apiKeys.has(row.api_key) ||
        collides(extra, key(row, ["api_key"]), row.id))) reason = "API Key 在备份或目标库中已使用另一 ID";
      else if (step.table === "domains_cache" && (domainNames.has(key(row, ["account_id", "full_domain"])) ||
        (row.remote_id !== null && remoteIds.has(key(row, ["account_id", "remote_id"]))))) reason = "备份中存在重复同账号域名或远端对象";
      else if (existing && key(existing, step.identity) !== identity) reason = "数字 ID 已属于目标库中的另一业务对象";
      else if (collides(natural, identity, row.id)) reason = "同一业务对象已使用另一 ID，需显式映射后导入";
      // domains_cache has both a display identity and a remote identity.
      else if (step.table === "domains_cache" && (collides(extra, `name:${key(row, ["account_id", "full_domain"])}`, row.id) ||
        (row.remote_id !== null && collides(extra, `remote:${key(row, ["account_id", "remote_id"])}`, row.id)))) reason = "目标库已有同账号域名或远端对象";
      else if (step.table !== "accounts") {
        const parent = step.table === "custom_accounts" || step.table === "custom_domains" ? row.group_id : row.account_id;
        if (!accounts.has(parent)) reason = "账号或服务商分组引用不存在";
        if (step.table === "custom_domains" && row.account_id !== null) {
          if (customAccounts.get(row.account_id)?.group_id !== row.group_id) reason = "手动账号引用不存在或属于另一分组";
        }
      }
      seenIds.add(row.id); seenKeys.add(identity);
      if (step.table === "accounts") apiKeys.add(row.api_key);
      if (step.table === "domains_cache") {
        domainNames.add(key(row, ["account_id", "full_domain"]));
        if (row.remote_id !== null) remoteIds.add(key(row, ["account_id", "remote_id"]));
      }
      if (reason) {
        conflictCount++;
        if (conflicts.length < 50) conflicts.push({ table: step.table, id: Number(row.id), reason });
      } else if (!existing) add++;
      else if (canonicalJson(existing) !== canonicalJson(row)) update++;
    }
    return { table: step.table, add, update, remove: before.filter(row => !seenIds.has(row.id)).length, conflicts: conflictCount };
  });
  const totalConflicts = tables.reduce((n, table) => n + table.conflicts, 0);
  const rowCount = BACKUP_PLAN.reduce((n, step) => n + rowsFor(incoming, step.table).length, 0);
  return {
    tables, totalAdd: tables.reduce((n, table) => n + table.add, 0),
    totalUpdate: tables.reduce((n, table) => n + table.update, 0),
    totalRemove: tables.reduce((n, table) => n + table.remove, 0),
    totalConflicts, conflictDetails: conflicts, canImport: !totalConflicts && rowCount <= BACKUP_IMPORT_LIMIT,
    rowCount, importLimit: BACKUP_IMPORT_LIMIT,
  };
}
