// Prototype-only SQL. No production module imports this file.
// JSONB is only an internal, per-query SQLite representation; cache values stay
// portable JSON text. Materialize once rather than reparsing each field.
const record = "b.record";
const field = (name: string) => `json_extract(${record},'$.${name}')`;
const textFields = ["canonical", "full_domain", "alias", "source", "table", "raw_expiry", "raw_status", "resolved_expiry", "created_at"];
const integerFields = ["ordinal", "source_rank", "inventory_id", "permanent", "raw_status_expired", "created_present"];
const timeFields = ["raw_time", "resolved_time", "created_time"];
const invalid = [
  "b.record_type<>'object'",
  ...textFields.map(name => `json_type(${record},'$.${name}')<>'text' OR json_type(${record},'$.${name}') IS NULL`),
  ...integerFields.map(name => `json_type(${record},'$.${name}')<>'integer' OR json_type(${record},'$.${name}') IS NULL`),
  ...timeFields.map(name => `(json_type(${record},'$.${name}') NOT IN ('integer','null') OR json_type(${record},'$.${name}') IS NULL)`),
  ...["account_id", "group_id"].map(name => `(json_type(${record},'$.${name}') NOT IN ('integer','null') OR json_type(${record},'$.${name}') IS NULL)`),
  `${field("ordinal")}<0 OR ${field("inventory_id")}<0`,
  `${field("source_rank")} NOT BETWEEN 0 AND 7`,
  ...["permanent", "raw_status_expired", "created_present"].map(name => `${field(name)} NOT IN (0,1)`),
  `${field("table")}<>CASE WHEN ${field("source_rank")}=3 THEN 'custom' ELSE 'managed' END`,
  `${field("source")}<>CASE ${field("source_rank")} WHEN 0 THEN 'DNSHE' WHEN 1 THEN 'Cloudflare' WHEN 2 THEN 'DigitalPlat'
    WHEN 3 THEN '自定义' WHEN 4 THEN 'DNSPod' WHEN 5 THEN '阿里云 DNS' WHEN 6 THEN '华为云 DNS' ELSE 'Vercel' END`,
].join(" OR ");
export const GUARDED_PAGE = `CASE WHEN length(CAST(c.value AS BLOB))<=524288 THEN
  CASE WHEN json_valid(c.value) THEN CASE WHEN json_type(c.value)='array' THEN c.value ELSE '[]' END ELSE '[]' END ELSE '[]' END`;
export const PROJECTION_CTE = `WITH context AS (
  SELECT json_extract(?,'$.now') now,json_extract(?,'$.seconds') seconds
), pages AS (
  SELECT c.key,c.value,c.expires_at,${GUARDED_PAGE} guarded
  FROM cache c WHERE c.key>? AND c.key<?
), records AS MATERIALIZED (
  SELECT r.type record_type,CASE WHEN r.type='object' THEN jsonb(r.value) ELSE jsonb('{}') END record
  FROM pages c CROSS JOIN json_each(c.guarded) r
), fields AS (
  SELECT ${textFields.map(name => `${field(name)} "${name}"`).join(",")},
    ${integerFields.map(name => `${field(name)} ${name}`).join(",")},
    ${timeFields.map(name => `${field(name)} ${name}`).join(",")},
    CASE WHEN ${invalid} THEN 1 ELSE 0 END invalid
  FROM records b
), calculated AS (
  SELECT *, (CAST(resolved_time AS REAL)-(SELECT now FROM context))/86400000.0 days_left
  FROM fields WHERE canonical<>''
), canonical AS (
  SELECT canonical,MAX(raw_status_expired=1 OR raw_time<(SELECT now FROM context) OR resolved_time<(SELECT now FROM context)) expired,
    MAX(permanent) permanent,COUNT(resolved_time) finite_expiries
  FROM calculated GROUP BY canonical
), expiry_ranked AS (
  SELECT *,MIN(ordinal) OVER(PARTITION BY canonical) first_finite,
    ROW_NUMBER() OVER(PARTITION BY canonical ORDER BY days_left<0 DESC,days_left,ordinal) winner
  FROM calculated WHERE resolved_time IS NOT NULL
), winners AS (SELECT * FROM expiry_ranked WHERE winner=1),
recent_ranked AS (
  SELECT *,ROW_NUMBER() OVER(PARTITION BY canonical ORDER BY ordinal) first_registration
  FROM calculated WHERE created_present=1
), recent_first AS (SELECT * FROM recent_ranked WHERE first_registration=1)`;

export const PROJECTION_AUDIT_SQL = `${PROJECTION_CTE}
SELECT (SELECT COUNT(*) FROM pages) pages,
  (SELECT COALESCE(SUM(length(CAST(value AS BLOB))),0) FROM pages) encoded_bytes,
  (SELECT COUNT(*) FROM pages WHERE expires_at<=(SELECT seconds FROM context) OR guarded<>value) invalid_pages,
  COUNT(*) rows,COUNT(DISTINCT ordinal) ordinals,MIN(ordinal) first_ordinal,MAX(ordinal) last_ordinal,
  COALESCE(SUM(invalid),0) invalid_rows FROM fields`;

export const PROJECTION_AGGREGATE_SQL = `${PROJECTION_CTE}, months AS (
  SELECT value bucket FROM json_each(?)
), bucketed AS (
  SELECT w.*,json_extract(m.bucket,'$.slot') slot,
    CAST((CAST(w.resolved_time AS REAL)-json_extract(m.bucket,'$.start'))/86400000.0 AS INTEGER)+1 day
  FROM winners w JOIN months m ON w.resolved_time>=json_extract(m.bucket,'$.start')
    AND w.resolved_time<json_extract(m.bucket,'$.end') WHERE w.days_left>=0
), month_ranked AS (
  SELECT *,ROW_NUMBER() OVER(PARTITION BY slot ORDER BY day,first_finite) position FROM bucketed
)
SELECT (SELECT COUNT(*) FROM canonical) total,
  (SELECT COUNT(*) FROM canonical WHERE expired=1) expired,
  (SELECT COUNT(*) FROM canonical WHERE permanent=1 AND expired IS NOT 1 AND finite_expiries=0) permanent,
  (SELECT COUNT(*) FROM winners WHERE days_left<0 OR days_left<=90) expiring_total,
  (SELECT json_group_array(json_object('full_domain',full_domain,'time',resolved_time,'source',source,'alias',alias))
    FROM (SELECT * FROM winners WHERE days_left<0 OR days_left<=90 ORDER BY days_left,first_finite LIMIT 8)) warnings,
  (SELECT json_group_array(json_object('slot',slot,'count',n))
    FROM (SELECT slot,COUNT(*) n FROM bucketed GROUP BY slot ORDER BY slot)) bucket_counts,
  (SELECT json_group_array(json_object('slot',slot,'full_domain',full_domain,'time',resolved_time,'source',source,'alias',alias,'day',day))
    FROM (SELECT * FROM month_ranked WHERE position<=20 ORDER BY slot,day,first_finite)) bucket_items,
  (SELECT COUNT(*) FROM recent_first WHERE created_time IS NULL) invalid_recent,
  CASE WHEN EXISTS(SELECT 1 FROM recent_first WHERE created_time IS NULL) THEN '[]' ELSE
    (SELECT json_group_array(json_object('full_domain',full_domain,'created_at',created_at,'source',source,'alias',alias))
      FROM (SELECT * FROM recent_first ORDER BY created_time DESC,ordinal LIMIT 6)) END recent`;

export const PROJECTION_LEGACY_RECENT_SQL = `${PROJECTION_CTE}
SELECT full_domain,created_at,source,alias FROM recent_first ORDER BY ordinal`;
