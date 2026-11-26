import { aggregateSql, GUARDED_PAGE } from "./catalog-projection-sql";

const val = (path: string) => `json_extract(record,'$.${path}')`;
const kind = (path: string) => `json_type(record,'$.${path}')`;
const isText = (path: string) => `${kind(path)} IS 'text'`;
const isTime = (path: string) => `(${kind(path)} IN ('integer','null')) IS 1`;
const pos = (path: string) => `(${kind(path)} IS 'integer' AND ${val(path)}>=0 AND ${val(path)}<s.source_rows)`;
const flag = (path: string) => `(${kind(path)} IS 'integer' AND ${val(path)} IN (0,1))`;
const registration = `(${kind("registration")} IS 'null' OR (${kind("registration")} IS 'object'
  AND ${pos("registration.pos")} AND ${isTime("registration.created_time")}
  AND ${["full_domain", "alias", "source", "created_at"].map(p => isText("registration." + p)).join(" AND ")}
  AND ${val("registration.created_at")}<>''))`;
const CTE = `WITH scope AS MATERIALIZED (
  SELECT json_extract(?1,'$.now') now,json_extract(?2,'$.seconds') seconds,json_extract(?1,'$.source_rows') source_rows,
    json_extract(?1,'$.rows') rows,json_extract(?1,'$.pages') pages,json_extract(?1,'$.encoded_bytes') bytes
), pages AS MATERIALIZED (
  SELECT c.value,c.expires_at,${GUARDED_PAGE} guarded FROM cache c WHERE c.key>?3 AND c.key<?4
), objects AS MATERIALIZED (
  SELECT CASE WHEN r.type='object' THEN jsonb(r.value) ELSE jsonb('{}') END record
  FROM pages p CROSS JOIN json_each(p.guarded) r
), records AS MATERIALIZED (
  SELECT record,${val("ordinal")} ordinal,${val("canonical")} canonical,${val("resolved_time")} resolved_time,
    ${val("first_finite")} first_finite,${val("registration.pos")} registration_pos,${val("registration.created_time")} created_time,
    (${val("raw_status_expired")}=1 OR ${val("raw_time")}<s.now OR ${val("resolved_time")}<s.now) expired,
    ${val("permanent")} permanent,(CAST(${val("resolved_time")} AS REAL)-s.now)/86400000.0 days_left,
    CASE WHEN ${pos("ordinal")} AND ${isText("canonical")} AND ${val("canonical")}<>''
      AND ${["full_domain", "source", "alias"].map(isText).join(" AND ")}
      AND ${flag("raw_status_expired")} AND ${flag("permanent")} AND ${isTime("raw_time")} AND ${isTime("resolved_time")}
      AND ((${kind("resolved_time")} IS 'null' AND ${kind("first_finite")} IS 'null')
        OR (${kind("resolved_time")} IS 'integer' AND ${pos("first_finite")}))
      AND ${registration} THEN 0 ELSE 1 END invalid
  FROM objects CROSS JOIN scope s
), page_audit AS (
  SELECT COUNT(*) pages,COALESCE(SUM(length(CAST(value AS BLOB))),0) encoded_bytes,
    COALESCE(SUM(expires_at<=(SELECT seconds FROM scope) OR value<>guarded),0) invalid_pages FROM pages
), row_audit AS (
  SELECT COUNT(*) rows,COUNT(DISTINCT ordinal) ordinals,MIN(ordinal) first_ordinal,MAX(ordinal) last_ordinal,
    COALESCE(SUM(invalid),0) + (COUNT(*)-COUNT(DISTINCT canonical))
      + (COUNT(first_finite)-COUNT(DISTINCT first_finite)) + (COUNT(registration_pos)-COUNT(DISTINCT registration_pos)) invalid_rows
  FROM records
), audit AS MATERIALIZED (
  SELECT p.*,r.*, (p.pages=s.pages AND p.encoded_bytes=s.bytes AND r.rows=s.rows AND r.ordinals=r.rows
    AND (r.rows=0 OR (r.first_ordinal=0 AND r.last_ordinal=r.rows-1))
    AND p.invalid_pages=0 AND r.invalid_rows=0) valid FROM page_audit p CROSS JOIN row_audit r CROSS JOIN scope s
), canonical_counts AS (
  SELECT COUNT(*) total,COALESCE(SUM(expired=1),0) expired,
    COALESCE(SUM(permanent=1 AND expired IS NOT 1 AND resolved_time IS NULL),0) permanent,
    COALESCE(SUM(days_left<=90),0) expiring_total FROM records WHERE (SELECT valid FROM audit)
), winners AS (
  SELECT ordinal,resolved_time,first_finite,days_left FROM records WHERE resolved_time IS NOT NULL AND (SELECT valid FROM audit)
), recent_first AS (
  SELECT ordinal,registration_pos,created_time FROM records WHERE registration_pos IS NOT NULL AND (SELECT valid FROM audit)
), recent_info AS (SELECT COUNT(*) invalid_recent FROM recent_first WHERE created_time IS NULL)`;

export const FOLDED_AGGREGATE_SQL = aggregateSql(CTE, true);
export const FOLDED_LEGACY_RECENT_SQL = `${CTE}
SELECT ${val("registration.full_domain")} full_domain,${val("registration.created_at")} created_at,
  ${val("registration.source")} source,${val("registration.alias")} alias
FROM records WHERE registration_pos IS NOT NULL AND (SELECT valid FROM audit) ORDER BY registration_pos`;
