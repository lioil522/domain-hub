import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from "../../errors";
import { BACKUP_PLAN, canonicalJson, isObject, normalizeBackup, type BackupRow, type BackupSnapshot } from "../backup-snapshot";
import { diffBackup, type BackupDiff } from "../backup-diff";
import { backupKeyId, verifyBackupIntegrity } from "../backup-integrity";
import { decryptText, encryptText, sha256Hex } from "../crypto";
import { readBackupData } from "./backup-dao";
import { SCHEMA_VERSION } from "../schema-definition";
import {
  RESTORE_TABLES, RESTORE_MAX_ROWS, RESTORE_MAX_BYTES, RESTORE_CHUNK_ROWS, RESTORE_CHUNK_BYTES,
  type RestoreManifest, type RestoreTable,
} from "../../../shared/restore-wire";

interface Session {
  id: string; owner: string; manifest: string; key_id: string;
  status: "uploading" | "ready" | "committed" | "cancelled";
  next_chunk: number; uploaded_rows: number; uploaded_bytes: number; expires_at: number;
  fence: string | null; result: string | null;
}
const TTL_MS = 60 * 60 * 1000;
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const isDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const number = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const identity = (table: RestoreTable, row: BackupRow) => canonicalJson(
  (table === "accounts" ? ["api_key"] : table === "domains_cache" ? ["account_id", "full_domain"] :
    BACKUP_PLAN.find(step => step.table === table)!.identity).map(column => row[column]));

function validateManifest(input: unknown): RestoreManifest {
  if (!isObject(input) || !isObject(input.header) || !isObject(input.counts) || !Array.isArray(input.chunks) ||
      !Array.isArray(input.data_tables) || !isDigest(input.digest)) throw new ValidationError("分段恢复清单格式无效");
  const allowed = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
  if (!allowed(input, ["header", "data_tables", "counts", "chunks", "digest"]) ||
      !allowed(input.header, ["version", "exported_at", "counts", "metadata"]) ||
      !allowed(input.counts, RESTORE_TABLES) ||
      (input.header.counts !== undefined && (!isObject(input.header.counts) || !allowed(input.header.counts, RESTORE_TABLES))) ||
      (input.header.metadata !== undefined && (!isObject(input.header.metadata) ||
        !allowed(input.header.metadata, ["scope", "schema_version", "key_id", "checksum"])))) {
    throw new ValidationError("分段清单包含不支持的字段；额外凭据或原始内容不得存入明文清单");
  }
  if ("data" in input.header || canonicalJson(input).length > RESTORE_CHUNK_BYTES) throw new ValidationError("分段清单过大或包含行数据");
  const header = normalizeBackup({ ...input.header, counts: undefined, data: {} });
  const counts = input.counts;
  if (header.metadata && header.metadata.schema_version > SCHEMA_VERSION) throw new ValidationError("请先升级目标应用的 schema");
  if (new Set(input.data_tables).size !== input.data_tables.length ||
      input.data_tables.some(table => !RESTORE_TABLES.includes(table))) throw new ValidationError("清单包含不支持或重复的表");
  let total = 0;
  for (const table of RESTORE_TABLES) {
    const count = input.counts[table];
    if (!number(count) || (!input.data_tables.includes(table) && count > 0)) throw new ValidationError("清单行数无效");
    if (isObject(input.header.counts) && input.header.counts[table] !== count) throw new ValidationError("清单与快照 counts 不一致");
    total += count;
  }
  if (total > RESTORE_MAX_ROWS || Number(input.counts.accounts) > 500 || input.chunks.length > 1000) throw new ValidationError("分段恢复最多 10,000 行、500 个 API 账号");
  const offsets = Object.fromEntries(RESTORE_TABLES.map(table => [table, 0])) as Record<RestoreTable, number>;
  let lastTable = -1;
  for (const chunk of input.chunks) {
    if (!isObject(chunk) || !allowed(chunk, ["table", "offset", "count", "digest"]) || !RESTORE_TABLES.includes(chunk.table as RestoreTable) ||
        !number(chunk.offset) || !number(chunk.count) || !chunk.count || chunk.count > RESTORE_CHUNK_ROWS || !isDigest(chunk.digest)) {
      throw new ValidationError("分块描述无效");
    }
    const table = chunk.table as RestoreTable;
    const tableIndex = RESTORE_TABLES.indexOf(table);
    if (tableIndex < lastTable || chunk.offset !== offsets[table]) throw new ValidationError("分块顺序或偏移不连续");
    lastTable = tableIndex;
    offsets[table] += chunk.count;
  }
  if (RESTORE_TABLES.some(table => offsets[table] !== counts[table])) throw new ValidationError("分块数量与清单行数不一致");
  return input as unknown as RestoreManifest;
}

/** Persistent staging, never partial business-table writes during upload. */
export class StagedRestore {
  constructor(private readonly db: D1Database, private readonly aesKey?: string, private readonly now = Date.now) {}

  private async session(id: string, owner: string): Promise<Session> {
    const row = await this.db.prepare("SELECT * FROM restore_sessions WHERE id=? AND owner=?").bind(id, owner).first<Session>();
    if (!row || row.expires_at <= this.now()) throw new NotFoundError("分段会话不存在、已过期或不属于当前登录会话");
    if (row.status !== "committed" && row.key_id !== await backupKeyId(this.aesKey)) throw new ConflictError("分段期间 AES_KEY 已改变，请恢复原密钥", "backup_key_mismatch");
    return row;
  }

  async get(id: string, owner: string) {
    const row = await this.session(id, owner);
    const manifest = JSON.parse(row.manifest) as RestoreManifest;
    return { id: row.id, status: row.status, next_chunk: row.next_chunk, chunk_count: manifest.chunks.length,
      uploaded_rows: row.uploaded_rows, expires_at: row.expires_at,
      result: row.result ? JSON.parse(row.result) as { diff?: BackupDiff; imported?: Record<string, number> } : null };
  }

  async create(id: string, owner: string, input: unknown) {
    if (!/^[a-f0-9-]{36}$/i.test(id) || !isDigest(owner)) throw new ValidationError("分段会话 ID 或所有者格式无效");
    const manifest = validateManifest(input);
    const keyId = await backupKeyId(this.aesKey);
    if (!keyId) throw new ServiceUnavailableError("分段恢复需要配置稳定的 AES_KEY");
    const metadata = normalizeBackup({ ...manifest.header, counts: undefined, data: {} }).metadata;
    if (metadata && metadata.key_id !== keyId) throw new ConflictError("备份与目标 AES_KEY 不匹配", "backup_key_mismatch");
    const encoded = canonicalJson(manifest), now = this.now();
    await this.db.prepare("DELETE FROM restore_sessions WHERE expires_at<=?").bind(now).run();
    const existing = await this.db.prepare("SELECT owner,manifest FROM restore_sessions WHERE id=?").bind(id).first<{ owner: string; manifest: string }>();
    if (existing) {
      if (existing.owner !== owner) throw new NotFoundError("分段会话不存在");
      if (existing.manifest !== encoded) throw new ConflictError("相同会话 ID 对应不同快照清单");
      return this.get(id, owner);
    }
    await this.db.prepare(`INSERT INTO restore_sessions(id,owner,manifest,key_id,status,expires_at,created_at)
      SELECT ?,?,?,?,'uploading',?,?
      WHERE (SELECT COUNT(*) FROM restore_sessions WHERE owner=?)<20
        AND (SELECT COUNT(*) FROM restore_sessions)<100
        AND (SELECT COUNT(*) FROM restore_sessions WHERE status IN ('uploading','ready') AND owner=?)<2
        AND (SELECT COUNT(*) FROM restore_sessions WHERE status IN ('uploading','ready'))<4
      ON CONFLICT(id) DO NOTHING`).bind(id, owner, encoded, keyId, now + TTL_MS, now, owner, owner).run();
    const created = await this.db.prepare("SELECT owner,manifest FROM restore_sessions WHERE id=?").bind(id).first<{ owner: string; manifest: string }>();
    if (!created) throw new ConflictError("活跃或近期分段会话过多，请取消旧会话或等待过期");
    if (created.owner !== owner || created.manifest !== encoded) throw new ConflictError("分段会话创建竞争，请重新选择恢复会话");
    return this.get(id, owner);
  }

  async upload(id: string, owner: string, index: number, rows: unknown) {
    const row = await this.session(id, owner), manifest = JSON.parse(row.manifest) as RestoreManifest;
    if (!number(index) || !manifest.chunks[index] || !Array.isArray(rows)) throw new ValidationError("分块索引或内容无效");
    const descriptor = manifest.chunks[index], raw = canonicalJson(rows);
    const bytes = new TextEncoder().encode(raw).byteLength;
    if (rows.length !== descriptor.count || bytes > RESTORE_CHUNK_BYTES || await sha256Hex(raw) !== descriptor.digest) throw new ValidationError("分块长度或摘要与清单不一致");
    if (row.status === "committed") return this.get(id, owner);
    if (index < row.next_chunk) {
      const stored = await this.db.prepare("SELECT digest FROM restore_chunks WHERE session_id=? AND chunk_index=?").bind(id, index).first<{ digest: string }>();
      if (stored?.digest === descriptor.digest && row.status !== "cancelled") return this.get(id, owner);
      const latest = await this.get(id, owner);
      if (latest.status === "committed") return latest;
      throw new ConflictError("已提交的分块内容不一致或会话已结束");
    }
    if (row.status !== "uploading" || index !== row.next_chunk) throw new ConflictError("请从服务端 next_chunk 继续顺序上传");
    const snapshot = normalizeBackup({ version: 1, data: { [descriptor.table]: rows } });
    await verifyBackupIntegrity(snapshot, snapshot, this.aesKey);
    const normalized = snapshot.data[descriptor.table];
    const rawCipher = await encryptText(raw, this.aesKey), normalizedDigest = await sha256Hex(canonicalJson(normalized));
    const fence = crypto.randomUUID(), now = this.now();
    const allowed = "EXISTS (SELECT 1 FROM restore_sessions WHERE id=? AND owner=? AND fence=? AND status='uploading')";
    try {
      await this.db.batch([
        this.db.prepare(`UPDATE restore_sessions SET next_chunk=next_chunk+1, uploaded_rows=uploaded_rows+?,
          uploaded_bytes=uploaded_bytes+?, fence=? WHERE id=? AND owner=? AND status='uploading'
          AND next_chunk=? AND expires_at>? AND uploaded_bytes+?<=?`).bind(rows.length, bytes, fence, id, owner, index, now, bytes, RESTORE_MAX_BYTES),
        this.db.prepare(`INSERT INTO restore_chunks(session_id,chunk_index,digest,normalized_digest,raw_cipher)
          SELECT ?,?,?,?,? WHERE ${allowed}`).bind(id, index, descriptor.digest, normalizedDigest, rawCipher, id, owner, fence),
        ...normalized.map((item, offset) => this.db.prepare(`INSERT INTO restore_rows(session_id,table_name,row_index,row_id,identity,remote_identity,payload)
          SELECT ?,?,?,?,?,?,? WHERE ${allowed}`).bind(id, descriptor.table, descriptor.offset + offset, item.id,
            identity(descriptor.table, item),
            descriptor.table === "domains_cache" && item.remote_id !== null ? canonicalJson([item.account_id, item.remote_id]) : null,
            canonicalJson(item), id, owner, fence)),
      ]);
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint/i.test(error.message)) throw new ConflictError("分块存在重复 ID 或业务身份，整个分块未提交", "backup_conflict");
      throw error;
    }
    const state = await this.get(id, owner);
    if (state.status === "cancelled" || state.next_chunk <= index) throw new ConflictError("上传已取消、过期、超出 8MB 上限或被其他操作改变");
    return state;
  }

  private async stagedData(id: string) {
    const result = await this.db.prepare("SELECT table_name,row_index,payload FROM restore_rows WHERE session_id=? ORDER BY table_name,row_index")
      .bind(id).all<{ table_name: RestoreTable; row_index: number; payload: string }>();
    const data: Record<RestoreTable, BackupRow[]> = { accounts: [], custom_accounts: [], custom_domains: [], domains_cache: [], domain_date_overrides: [] };
    for (const item of result.results) {
      if (!RESTORE_TABLES.includes(item.table_name) || data[item.table_name].length !== item.row_index) throw new ConflictError("staging 行顺序不完整");
      data[item.table_name].push(JSON.parse(item.payload) as BackupRow);
    }
    return data;
  }

  async validate(id: string, owner: string) {
    const row = await this.session(id, owner), manifest = JSON.parse(row.manifest) as RestoreManifest;
    if (row.status === "committed") return this.get(id, owner);
    if (!["uploading", "ready"].includes(row.status) || row.next_chunk !== manifest.chunks.length) throw new ConflictError("分块未上传齐或会话已取消");
    const chunks = await this.db.prepare("SELECT * FROM restore_chunks WHERE session_id=? ORDER BY chunk_index").bind(id)
      .all<{ chunk_index: number; digest: string; normalized_digest: string; raw_cipher: string }>();
    const staged = await this.stagedData(id);
    const rawData = Object.fromEntries(manifest.data_tables.map(table => [table, []])) as Record<string, unknown[]>;
    if (chunks.results.length !== manifest.chunks.length) throw new ConflictError("分块存储不完整");
    for (const [index, chunk] of chunks.results.entries()) {
      const descriptor = manifest.chunks[index], raw = await decryptText(chunk.raw_cipher, this.aesKey);
      if (chunk.chunk_index !== index || chunk.digest !== descriptor.digest || await sha256Hex(raw) !== descriptor.digest) throw new ConflictError("staging 分块摘要不匹配");
      const source: unknown = JSON.parse(raw);
      if (!Array.isArray(source) || source.length !== descriptor.count) throw new ConflictError("staging 分块内容无效");
      rawData[descriptor.table].push(...source);
      if (await sha256Hex(canonicalJson(staged[descriptor.table].slice(descriptor.offset, descriptor.offset + descriptor.count))) !== chunk.normalized_digest) throw new ConflictError("staging 规范化数据摘要不匹配");
    }
    if (RESTORE_TABLES.some(table => staged[table].length !== manifest.counts[table])) throw new ConflictError("staging 行数不匹配");
    const source = { ...manifest.header, data: rawData };
    if (await sha256Hex(canonicalJson(source)) !== manifest.digest) throw new ValidationError("快照总摘要不匹配");
    const original = normalizeBackup(source);
    await verifyBackupIntegrity(source as BackupSnapshot, original, this.aesKey);
    const diff = diffBackup(await readBackupData(this.db), { version: 1, exported_at: "", data: staged });
    diff.importLimit = RESTORE_MAX_ROWS;
    diff.canImport = !diff.totalConflicts && diff.rowCount <= RESTORE_MAX_ROWS;
    const fence = crypto.randomUUID();
    await this.db.prepare(`UPDATE restore_sessions SET status=?, fence=?, result=? WHERE id=? AND owner=?
      AND status IN ('uploading','ready') AND next_chunk=? AND expires_at>?`)
      .bind(diff.canImport ? "ready" : "uploading", fence, JSON.stringify({ diff }), id, owner, manifest.chunks.length, this.now()).run();
    return this.get(id, owner);
  }

  async commit(id: string, owner: string) {
    const row = await this.session(id, owner);
    if (row.status === "committed") return this.get(id, owner);
    if (row.status !== "ready") throw new ConflictError("分段恢复尚未通过完整校验");
    const manifest = JSON.parse(row.manifest) as RestoreManifest;
    const data = await this.stagedData(id);
    if (RESTORE_TABLES.some(table => data[table].length !== manifest.counts[table])) {
      const latest = await this.get(id, owner);
      if (latest.status === "committed") return latest;
      throw new ConflictError("提交前 staging 行数发生变化");
    }
    if (diffBackup(await readBackupData(this.db), { version: 1, exported_at: "", data }).totalConflicts) throw new ConflictError("目标库身份已改变，请重新预览", "backup_conflict");
    const fence = crypto.randomUUID(), result = JSON.stringify({ imported: manifest.counts });
    const now = this.now();
    const permitted = "EXISTS (SELECT 1 FROM restore_sessions WHERE id=? AND owner=? AND status='committed' AND fence=?)";
    const statements = [
      this.db.prepare(`UPDATE restore_sessions SET status='committed',fence=?,result=?,expires_at=? WHERE id=? AND owner=?
        AND status='ready' AND fence IS ? AND expires_at>?`).bind(fence, result, now + RECEIPT_TTL_MS, id, owner, row.fence, now),
      ...BACKUP_PLAN.map(step => {
        const field = (column: string) => `json_extract(r.payload,'$.${column}')`;
        const sameIdentity = step.identity.map(column => `${step.table}.${column} IS excluded.${column}`).join(" AND ");
        let natural = step.identity.map(column => `t.${column} IS ${field(column)}`).join(" AND ");
        if (step.table === "accounts") natural = `t.api_key IS ${field("api_key")}`;
        if (step.table === "domains_cache") natural = `t.account_id IS ${field("account_id")} AND
          (t.full_domain IS ${field("full_domain")} OR (${field("remote_id")} IS NOT NULL AND t.remote_id IS ${field("remote_id")}))`;
        let collision = `EXISTS (SELECT 1 FROM ${step.table} t WHERE ${natural} AND t.id != ${field("id")})`;
        if (step.table === "domains_cache") collision = `EXISTS (SELECT 1 FROM domains_cache t WHERE
          t.account_id IS ${field("account_id")} AND t.full_domain IS ${field("full_domain")} AND t.id != ${field("id")})
          OR (${field("remote_id")} IS NOT NULL AND EXISTS (SELECT 1 FROM domains_cache t WHERE
          t.account_id IS ${field("account_id")} AND t.remote_id IS ${field("remote_id")} AND t.id != ${field("id")}))`;
        if (step.table === "custom_domains") collision += ` OR (${field("account_id")} IS NOT NULL AND EXISTS
          (SELECT 1 FROM custom_accounts ca WHERE ca.id=${field("account_id")} AND ca.group_id IS NOT ${field("group_id")}))`;
        return this.db.prepare(`INSERT INTO ${step.table} (${step.columns.join(",")})
          SELECT CASE WHEN ${collision} THEN 'backup_identity_conflict' ELSE ${field("id")} END,
          ${step.columns.slice(1).map(field).join(",")} FROM restore_rows r
          WHERE r.session_id=? AND r.table_name=? AND ${permitted}
          ON CONFLICT(id) DO UPDATE SET id=CASE WHEN ${sameIdentity} THEN ${step.table}.id ELSE 'backup_identity_conflict' END,
            ${step.columns.filter(column => column !== "id").map(column => `${column}=excluded.${column}`).join(",")}`)
          .bind(id, step.table, id, owner, fence);
      }),
      this.db.prepare(`DELETE FROM restore_rows WHERE session_id=? AND ${permitted}`).bind(id, id, owner, fence),
      this.db.prepare(`DELETE FROM restore_chunks WHERE session_id=? AND ${permitted}`).bind(id, id, owner, fence),
    ];
    try { await this.db.batch(statements); }
    catch (error) {
      if (error instanceof Error && /datatype mismatch|UNIQUE constraint|FOREIGN KEY/i.test(error.message)) throw new ConflictError("提交时目标身份或引用发生冲突，整批已回滚", "backup_conflict");
      throw error;
    }
    const state = await this.get(id, owner);
    if (state.status !== "committed") throw new ConflictError("恢复会话在提交前已改变或取消");
    return state;
  }

  async cancel(id: string, owner: string) {
    const row = await this.session(id, owner);
    if (row.status === "committed") return this.get(id, owner);
    const allowed = "EXISTS (SELECT 1 FROM restore_sessions WHERE id=? AND owner=? AND status='cancelled')";
    await this.db.batch([
      this.db.prepare("UPDATE restore_sessions SET status='cancelled',fence=? WHERE id=? AND owner=? AND status IN ('uploading','ready')")
        .bind(crypto.randomUUID(), id, owner),
      this.db.prepare(`DELETE FROM restore_rows WHERE session_id=? AND ${allowed}`).bind(id, id, owner),
      this.db.prepare(`DELETE FROM restore_chunks WHERE session_id=? AND ${allowed}`).bind(id, id, owner),
    ]);
    return this.get(id, owner);
  }
}
