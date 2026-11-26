// Prototype-only optimized reader. No production module imports this file.
// Cache protocol and source projection are unchanged.
import { GUARDED_PAGE } from "./catalog-projection-sql-baseline";
export { GUARDED_PAGE };

const value = (name: string) => `json_extract(b.record,'$.${name}')`;
const type = (name: string) => `json_type(b.record,'$.${name}')`;
const text = ["canonical", "full_domain", "alias", "source", "table", "raw_expiry", "raw_status", "resolved_expiry", "created_at"];
const integer = ["ordinal", "source_rank", "inventory_id", "permanent", "raw_status_expired", "created_present"];
const nullable = ["raw_time", "resolved_time", "created_time", "account_id", "group_id"];
// IS NOT is null-safe: missing fields still fail, without evaluating json_type
// twice for every valid field. Do not narrow or remove the original audit.
const invalid = [
  "b.record_type<>'object'",
  ...text.map(name => `${type(name)} IS NOT 'text'`),
  ...integer.map(name => `${type(name)} IS NOT 'integer'`),
  ...nullable.map(name => `(${type(name)} IN ('integer','null')) IS NOT 1`),
  "b.ordinal<0", `${value("inventory_id")}<0`,
  `${value("source_rank")} NOT BETWEEN 0 AND 7`,
  ...["permanent", "raw_status_expired", "created_present"].map(name => `${value(name)} NOT IN (0,1)`),
  `${value("table")}<>CASE WHEN ${value("source_rank")}=3 THEN 'custom' ELSE 'managed' END`,
  `${value("source")}<>CASE ${value("source_rank")} WHEN 0 THEN 'DNSHE' WHEN 1 THEN 'Cloudflare' WHEN 2 THEN 'DigitalPlat'
    WHEN 3 THEN '自定义' WHEN 4 THEN 'DNSPod' WHEN 5 THEN '阿里云 DNS' WHEN 6 THEN '华为云 DNS' ELSE 'Vercel' END`,
].join(" OR ");

export const PROJECTION_CTE = `WITH context AS MATERIALIZED (
  SELECT json_extract(?1,'$.now') now,json_extract(?2,'$.seconds') seconds,
    json_extract(?1,'$.rows') expected_rows,json_extract(?1,'$.pages') expected_pages,
    json_extract(?1,'$.encoded_bytes') expected_bytes
), pages AS MATERIALIZED (
  SELECT c.key,c.value,c.expires_at,${GUARDED_PAGE} guarded
  FROM cache c WHERE c.key>?3 AND c.key<?4
), records AS MATERIALIZED (
  SELECT r.type record_type,CASE WHEN r.type='object' THEN jsonb(r.value) ELSE jsonb('{}') END record,
    CASE WHEN r.type='object' THEN json_extract(r.value,'$.ordinal') ELSE NULL END ordinal
  FROM pages c CROSS JOIN json_each(c.guarded) r
), fields AS MATERIALIZED (
  SELECT b.ordinal,${value("canonical")} canonical,${value("raw_time")} raw_time,
    ${value("resolved_time")} resolved_time,${value("raw_status_expired")} raw_status_expired,
    ${value("permanent")} permanent,${value("created_present")} created_present,${value("created_time")} created_time,
    CASE WHEN ${invalid} THEN 1 ELSE 0 END invalid
  FROM records b
), page_audit AS (
  SELECT COUNT(*) pages,COALESCE(SUM(length(CAST(value AS BLOB))),0) encoded_bytes,
    COALESCE(SUM(expires_at<=(SELECT seconds FROM context) OR guarded<>value),0) invalid_pages FROM pages
), row_audit AS (
  SELECT COUNT(*) rows,COUNT(DISTINCT ordinal) ordinals,MIN(ordinal) first_ordinal,MAX(ordinal) last_ordinal,
    COALESCE(SUM(invalid),0) invalid_rows FROM fields
), audit AS MATERIALIZED (
  SELECT p.*,r.*,CASE WHEN p.pages=c.expected_pages AND p.encoded_bytes=c.expected_bytes AND r.rows=c.expected_rows
    AND p.invalid_pages=0 AND r.invalid_rows=0 AND r.ordinals=r.rows
    AND (r.rows=0 OR (r.first_ordinal=0 AND r.last_ordinal=r.rows-1)) THEN 1 ELSE 0 END valid
  FROM page_audit p CROSS JOIN row_audit r CROSS JOIN context c
), calculated AS MATERIALIZED (
  SELECT f.*, (CAST(f.resolved_time AS REAL)-c.now)/86400000.0 days_left
  FROM fields f CROSS JOIN context c CROSS JOIN audit a WHERE a.valid=1 AND f.canonical<>''
), canonical AS MATERIALIZED (
  SELECT canonical,MAX(raw_status_expired=1 OR raw_time<c.now OR resolved_time<c.now) expired,
    MAX(permanent) permanent,COUNT(resolved_time) finite_expiries,MIN(days_left) min_days,
    MIN(CASE WHEN resolved_time IS NOT NULL THEN ordinal END) first_finite
  FROM calculated CROSS JOIN context c GROUP BY canonical
), canonical_counts AS (
  SELECT COUNT(*) total,COALESCE(SUM(expired=1),0) expired,
    COALESCE(SUM(permanent=1 AND expired IS NOT 1 AND finite_expiries=0),0) permanent,
    COALESCE(SUM(min_days<=90),0) expiring_total FROM canonical
), expiry_ranked AS (
  SELECT canonical,ordinal,resolved_time,days_left,
    ROW_NUMBER() OVER(PARTITION BY canonical ORDER BY days_left<0 DESC,days_left,ordinal) winner
  FROM calculated WHERE resolved_time IS NOT NULL
), winners AS MATERIALIZED (
  SELECT w.canonical,w.ordinal,w.resolved_time,w.days_left,c.first_finite
  FROM expiry_ranked w JOIN canonical c ON c.canonical=w.canonical WHERE w.winner=1
), recent_ranked AS (
  SELECT canonical,ordinal,created_time,ROW_NUMBER() OVER(PARTITION BY canonical ORDER BY ordinal) first_registration
  FROM calculated WHERE created_present=1
), recent_first AS MATERIALIZED (SELECT ordinal,created_time FROM recent_ranked WHERE first_registration=1),
recent_info AS (SELECT COUNT(*) invalid_recent FROM recent_first WHERE created_time IS NULL)`;

export const PROJECTION_AUDIT_SQL = `${PROJECTION_CTE} SELECT * FROM audit`;

const display = (record: string) => [
  `'full_domain',json_extract(${record},'$.full_domain')`,
  `'source',json_extract(${record},'$.source')`,
  `'alias',json_extract(${record},'$.alias')`,
].join(",");

export function aggregateSql(cte: string, folded = false) {
  const registration = folded ? "json_extract(x.record,'$.registration')" : "x.record";
  return `${cte}, months AS MATERIALIZED (
  SELECT json_extract(value,'$.slot') slot,json_extract(value,'$.start') start,json_extract(value,'$.end') end
  FROM json_each(?5)
), bucketed AS MATERIALIZED (
  SELECT w.ordinal,w.resolved_time,w.first_finite,m.slot,
    CAST((CAST(w.resolved_time AS REAL)-m.start)/86400000.0 AS INTEGER)+1 day
  FROM winners w JOIN months m ON w.resolved_time>=m.start AND w.resolved_time<m.end WHERE w.days_left>=0
), month_ranked AS (
  SELECT *,ROW_NUMBER() OVER(PARTITION BY slot ORDER BY day,first_finite) position FROM bucketed
), warning_selected AS MATERIALIZED (
  SELECT ordinal,resolved_time,days_left,first_finite FROM winners WHERE days_left<0 OR days_left<=90 ORDER BY days_left,first_finite LIMIT 8
), month_selected AS MATERIALIZED (
  SELECT ordinal,resolved_time,slot,day,first_finite FROM month_ranked WHERE position<=20 ORDER BY slot,day,first_finite
), recent_selected AS MATERIALIZED (
  SELECT ordinal,created_time,${folded ? "registration_pos" : "ordinal"} tie FROM recent_first WHERE (SELECT invalid_recent FROM recent_info)=0 ORDER BY created_time DESC,tie LIMIT 6
)
SELECT a.*,s.*,i.invalid_recent,
  (SELECT json_group_array(json_object(${display("x.record")},'time',x.resolved_time))
    FROM (SELECT w.*,b.record FROM warning_selected w JOIN records b ON b.ordinal=w.ordinal ORDER BY w.days_left,w.first_finite) x) warnings,
  (SELECT json_group_array(json_object('slot',slot,'count',n))
    FROM (SELECT slot,COUNT(*) n FROM bucketed GROUP BY slot ORDER BY slot)) bucket_counts,
  (SELECT json_group_array(json_object(${display("x.record")},'time',x.resolved_time,'slot',x.slot,'day',x.day))
    FROM (SELECT m.*,b.record FROM month_selected m JOIN records b ON b.ordinal=m.ordinal ORDER BY m.slot,m.day,m.first_finite) x) bucket_items,
  (SELECT json_group_array(json_object('full_domain',json_extract(${registration},'$.full_domain'),
      'created_at',json_extract(${registration},'$.created_at'),'source',json_extract(${registration},'$.source'),'alias',json_extract(${registration},'$.alias')))
    FROM (SELECT r.*,b.record FROM recent_selected r JOIN records b ON b.ordinal=r.ordinal ORDER BY r.created_time DESC,r.tie) x) recent
FROM audit a CROSS JOIN canonical_counts s CROSS JOIN recent_info i`;
}
export const PROJECTION_AGGREGATE_SQL = aggregateSql(PROJECTION_CTE);

export const PROJECTION_LEGACY_RECENT_SQL = `${PROJECTION_CTE}
SELECT json_extract(b.record,'$.full_domain') full_domain,json_extract(b.record,'$.created_at') created_at,
  json_extract(b.record,'$.source') source,json_extract(b.record,'$.alias') alias
FROM recent_first r JOIN records b ON b.ordinal=r.ordinal ORDER BY r.ordinal`;
