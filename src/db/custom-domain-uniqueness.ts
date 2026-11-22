import { CATALOG_REVISION_KEY } from "./catalog-version";

/** Permanent settings namespace: never a TTL cache, session or application config. */
export const CUSTOM_DOMAIN_ARCHIVE_PREFIX = "schema_v6_custom_domain_duplicate:";
export const CUSTOM_DOMAIN_ARCHIVE_FORMAT = "domain-hub/custom-null-archive/v1";
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
const identifier = (value: string) => `"${value.replace(/"/g, '""')}"`;
const duplicate = `d.account_id IS NULL AND EXISTS (
  SELECT 1 FROM custom_domains earlier WHERE earlier.account_id IS NULL
  AND earlier.group_id=d.group_id AND earlier.full_domain=d.full_domain AND earlier.id<d.id)`;
const keeper = `(SELECT CAST(MIN(k.id) AS TEXT) FROM custom_domains k
  WHERE k.account_id IS NULL AND k.group_id=d.group_id AND k.full_domain=d.full_domain)`;

function snapshot(columns: string[]) {
  const fields = columns.map(name => {
    const value = `d.${identifier(name)}`;
    // Numeric text avoids JSON/JavaScript precision loss, Blob hex preserves
    // operator-added bytes, and explicit storage tags distinguish NULL/text/etc.
    return `${literal(name)},json_object('storage',typeof(${value}),'value',
      CASE typeof(${value}) WHEN 'blob' THEN hex(${value})
      WHEN 'real' THEN printf('%!.26g',${value}) ELSE CAST(${value} AS TEXT) END)`;
  });
  const chunks: string[] = [];
  for (let i = 0; i < fields.length; i += 16) chunks.push(`json_object(${fields.slice(i, i + 16).join(",")})`);
  const values = chunks.reduce((left, right) => `json_patch(${left},${right})`);
  return `json_object('format',${literal(CUSTOM_DOMAIN_ARCHIVE_FORMAT)},'survivor_id',${keeper},'columns',${values})`;
}

/** Build lossless archive/delete SQL; the caller adds index+ledger in one batch. */
export async function archiveCustomDomainDuplicates(db: D1Database): Promise<string[]> {
  if (!await db.prepare(`SELECT 1 FROM custom_domains d WHERE ${duplicate} LIMIT 1`).first()) return [];
  // Unknown child references or operator triggers could destroy non-domain data
  // on DELETE. Never guess how to migrate those extensions automatically.
  const dependencies = await db.prepare(`WITH tables AS MATERIALIZED
    (SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB '_cf_*' AND name NOT GLOB 'sqlite_*')
    SELECT t.name FROM tables t,pragma_foreign_key_list(t.name) f WHERE f."table"='custom_domains'
    UNION ALL SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='custom_domains'`).all<{ name: string }>();
  if (!dependencies.success || dependencies.results.length) throw new Error("custom_domains 存在自定义引用或触发器，不能安全自动归档重复行；请先完整备份并在维护窗口处理");
  const result = await db.prepare("SELECT name FROM pragma_table_xinfo('custom_domains') ORDER BY cid").all<{ name: string }>();
  if (!result.success || !result.results.length || result.results.length > 128) throw new Error("无法完整读取自定义域名字段，拒绝归档或去重");
  const payload = snapshot(result.results.map(column => column.name));
  const key = `${literal(CUSTOM_DOMAIN_ARCHIVE_PREFIX)} || CAST(d.id AS TEXT)`;
  return [
    `INSERT INTO settings(key,value) SELECT ${key},${payload} FROM custom_domains d WHERE ${duplicate}`,
    // Verify the exact full snapshot exists before removing any active row.
    // A trigger that ignores/corrupts an archive cannot silently lose a domain:
    // duplicates remain, index creation fails, and the entire batch rolls back.
    `DELETE FROM custom_domains AS d WHERE ${duplicate} AND EXISTS
      (SELECT 1 FROM settings archive WHERE archive.key=${key} AND archive.value COLLATE BINARY=${payload})`,
    `INSERT INTO settings(key,value) VALUES(${literal(CATALOG_REVISION_KEY)},${literal(crypto.randomUUID())})
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ];
}
