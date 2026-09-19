import type { Hono } from "hono";
import type { AppEnv } from "./types";
import { DatabaseManager } from "../db";
import type { DBDomain } from "../db";
import type { DnsRecordInput } from "../types/dns";
import { DomainRepository } from "../repositories/domain-repository";
import { LogRepository } from "../repositories/log-repository";
import { DomainService } from "../services/domain-service";
import { LogService } from "../services/log-service";
import { AuditService } from "../services/audit-service";
import { AuditRepository } from "../repositories/audit-repository";
import { successRes, errorRes } from "./response";
import { normalizeDnsRecordName, translateDnsWriteError } from "../services/dns-operations";
import { dnsService } from "../services/dns-service";

function domainService(db: DatabaseManager) { return new DomainService(new DomainRepository(db)); }
function logService(db: DatabaseManager) { return new LogService(new LogRepository(db)); }
function auditService(db: DatabaseManager) { return new AuditService(new AuditRepository(db)); }

export interface DnsRouteDeps { sleep: (ms: number) => Promise<void>; }

const DNS_BATCH_LIMIT = 50;
const DNS_BATCH_INTERVAL = 300;

interface DnsBatchItemResult { label: string; success: boolean; message: string; }

function buildBatchDnsParams(item: Record<string, unknown> | null | undefined, fullDomain: string) {
  const type = String(item?.type || "").trim().toUpperCase();
  const name = normalizeDnsRecordName(String(item?.name ?? ""), fullDomain);
  const content = String(item?.content || "").trim();
  const ttl = Number(item?.ttl) > 0 ? Number(item?.ttl) : 600;
  const params: Record<string, unknown> = { ...item, type, name, content, ttl };
  if ((type === "MX" || type === "SRV") && Number.isFinite(Number(item?.priority))) params.priority = Number(item?.priority);
  else delete params.priority;
  const line = String(item?.line || "").trim();
  if (line) params.line = line; else delete params.line;
  if (item?.proxied === true || item?.proxied === "true") params.proxied = true;
  return { type, name, content, ttl, params };
}

function normalizedInput(item: Record<string, unknown>, fullDomain: string): DnsRecordInput {
  const { type, name, content, ttl, params } = buildBatchDnsParams(item, fullDomain);
  return params as DnsRecordInput;
}

export function registerDnsRoutes(app: Hono<AppEnv>, deps: DnsRouteDeps) {
  app.get("/api/domains/:id/dns", async (c) => {
    const db = c.get("db");
    const domainId = Number(c.req.param("id"));
    const forceRefresh = c.req.query("refresh") === "1";
    try {
      const domain = await domainService(db).get(domainId);
      if (!domain) return c.json(errorRes("未找到域名记录", "not_found"), 404);
      const result = await dnsService(db).list(domain, forceRefresh);
      await logService(db).write("success", "api", `查看了域名 [${domain.full_domain}] 的 DNS 解析记录 (${result.records.length} 条)`);
      return c.json(successRes({ records: result.records }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "未知错误"), 400);
    }
  });

  app.post("/api/domains/:id/dns", async (c) => {
    const db = c.get("db");
    const domainId = Number(c.req.param("id"));
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
      const domain = await domainService(db).get(domainId);
      if (!domain) return c.json(errorRes("未找到域名记录", "not_found"), 404);
      const input = normalizedInput(body, domain.full_domain);
      if (!input.type || !input.content) return c.json(errorRes("记录类型与记录值均不能为空", "bad_request"), 400);
      const result = await dnsService(db).create(domain, input);
      await dnsService(db).refreshStatus(domain);
      await logService(db).write("success", "api", `在域名 [${domain.full_domain}] 下创建了 [${input.type}] 记录: ${input.name} -> ${input.content}`);
      await auditService(db).write({ actor: "session", action: "create", resourceType: "dns_record", resourceId: String((result.record as any)?.id || ""), result: "success", details: { domainId, type: input.type, name: input.name, content: input.content } });
      return c.json(successRes({ message: "创建DNS记录成功", record: result.record }));
    } catch (e: unknown) {
      const { message, errorCode } = translateDnsWriteError(e instanceof Error ? e.message : "未知错误", body.type);
      return c.json(errorRes(message, errorCode), 400);
    }
  });

  app.post("/api/domains/:id/dns/batch", async (c) => {
    const db = c.get("db");
    const domainId = Number(c.req.param("id"));
    try {
      const body = await c.req.json().catch(() => ({}));
      const items = Array.isArray(body.records) ? body.records : [];
      if (!Number.isInteger(domainId) || domainId <= 0) return c.json(errorRes("无效的域名 ID", "bad_request"), 400);
      if (items.length === 0) return c.json(errorRes("请至少提供一条解析记录", "bad_request"), 400);
      if (items.length > DNS_BATCH_LIMIT) return c.json(errorRes(`单次最多批量添加 ${DNS_BATCH_LIMIT} 条解析记录`, "bad_request"), 400);
      const domain = await domainService(db).get(domainId);
      if (!domain) return c.json(errorRes("未找到域名记录", "not_found"), 404);
      const results: DnsBatchItemResult[] = [];
      let successCount = 0, failCount = 0, nsDisabled = false, changed = false;
      for (const raw of items) {
        const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const input = normalizedInput(item, domain.full_domain);
        const label = `${input.type || "?"} ${input.name} → ${input.content || "(空)"}`;
        if (!input.type || !input.content) { failCount++; results.push({ label, success: false, message: "记录类型与记录值均不能为空" }); continue; }
        try { await dnsService(db).create(domain, input); successCount++; changed = true; results.push({ label, success: true, message: "创建成功" }); }
        catch (e: unknown) { const { message, errorCode } = translateDnsWriteError(e instanceof Error ? e.message : "未知错误", input.type); if (errorCode === "ns_management_disabled") nsDisabled = true; failCount++; results.push({ label, success: false, message }); }
        await deps.sleep(DNS_BATCH_INTERVAL);
      }
      if (changed) await dnsService(db).refreshStatus(domain);
      await logService(db).write(failCount === 0 ? "success" : "warning", "api", `批量添加域名 [${domain.full_domain}] 的解析记录完成：成功 ${successCount} 条，失败 ${failCount} 条`, results);
      await auditService(db).write({ actor: "session", action: "batch-create", resourceType: "dns_record", resourceId: String(domainId), result: failCount === 0 ? "success" : "failure", details: { successCount, failCount } });
      return c.json(successRes({ success_count: successCount, fail_count: failCount, results, error_code: nsDisabled ? "ns_management_disabled" : undefined, message: `批量添加完成：成功 ${successCount} 条，失败 ${failCount} 条` }));
    } catch (e: unknown) { return c.json(errorRes(`批量添加解析记录失败: ${e instanceof Error ? e.message : "未知错误"}`), 400); }
  });

  app.post("/api/domains/:id/dns/batch-update", async (c) => {
    const db = c.get("db");
    const domainId = Number(c.req.param("id"));
    try {
      const body = await c.req.json().catch(() => ({}));
      const items = Array.isArray(body.records) ? body.records : [];
      if (!Number.isInteger(domainId) || domainId <= 0) return c.json(errorRes("无效的域名 ID", "bad_request"), 400);
      if (items.length === 0) return c.json(errorRes("请至少选择一条要修改的解析记录", "bad_request"), 400);
      if (items.length > DNS_BATCH_LIMIT) return c.json(errorRes(`单次最多批量修改 ${DNS_BATCH_LIMIT} 条解析记录`, "bad_request"), 400);
      const domain = await domainService(db).get(domainId);
      if (!domain) return c.json(errorRes("未找到域名记录", "not_found"), 404);
      const results: DnsBatchItemResult[] = [];
      let successCount = 0, failCount = 0, nsDisabled = false, changed = false;
      for (const raw of items) {
        const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const input = normalizedInput(item, domain.full_domain);
        const recordId = String(item.record_id ?? item.id ?? "").trim();
        const label = String(item.label || "").trim() || `${input.type || "?"} ${input.name} → ${input.content || "(空)"}`;
        if (!recordId) { failCount++; results.push({ label, success: false, message: "缺少记录 ID，无法定位要修改的记录" }); continue; }
        if (!input.type || !input.content) { failCount++; results.push({ label, success: false, message: "记录类型与记录值均不能为空" }); continue; }
        try { await dnsService(db).update(domain, recordId, input); successCount++; changed = true; results.push({ label, success: true, message: "修改成功" }); }
        catch (e: unknown) { const { message, errorCode } = translateDnsWriteError(e instanceof Error ? e.message : "未知错误", input.type); if (errorCode === "ns_management_disabled") nsDisabled = true; failCount++; results.push({ label, success: false, message }); }
        await deps.sleep(DNS_BATCH_INTERVAL);
      }
      if (changed) await dnsService(db).refreshStatus(domain);
      await logService(db).write(failCount === 0 ? "success" : "warning", "api", `批量修改域名 [${domain.full_domain}] 的解析记录完成：成功 ${successCount} 条，失败 ${failCount} 条`, results);
      await auditService(db).write({ actor: "session", action: "batch-update", resourceType: "dns_record", resourceId: String(domainId), result: failCount === 0 ? "success" : "failure", details: { successCount, failCount } });
      return c.json(successRes({ success_count: successCount, fail_count: failCount, results, error_code: nsDisabled ? "ns_management_disabled" : undefined, message: `批量修改完成：成功 ${successCount} 条，失败 ${failCount} 条` }));
    } catch (e: unknown) { return c.json(errorRes(`批量修改解析记录失败: ${e instanceof Error ? e.message : "未知错误"}`), 400); }
  });

  app.post("/api/domains/:id/dns/batch-delete", async (c) => {
    const db = c.get("db");
    const domainId = Number(c.req.param("id"));
    try {
      const body = await c.req.json().catch(() => ({}));
      const rawItems = Array.isArray(body.records) ? body.records : [];
      if (!Number.isInteger(domainId) || domainId <= 0) return c.json(errorRes("无效的域名 ID", "bad_request"), 400);
      if (rawItems.length === 0) return c.json(errorRes("请至少选择一条要删除的解析记录", "bad_request"), 400);
      if (rawItems.length > DNS_BATCH_LIMIT) return c.json(errorRes(`单次最多批量删除 ${DNS_BATCH_LIMIT} 条解析记录`, "bad_request"), 400);
      const domain = await domainService(db).get(domainId);
      if (!domain) return c.json(errorRes("未找到域名记录", "not_found"), 404);
      const items = rawItems.map((raw: unknown) => { const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : null; return { recordId: String(item?.record_id ?? item?.id ?? raw ?? "").trim(), label: String(item?.label ?? item?.record_id ?? item?.id ?? raw ?? "").trim() }; }).filter((x: { recordId: string; label: string }) => Boolean(x.recordId));
      const results: DnsBatchItemResult[] = [];
      let successCount = 0, failCount = 0, nsDisabled = false, changed = false;
      for (const item of items) {
        try { await dnsService(db).remove(domain, item.recordId); successCount++; changed = true; results.push({ label: item.label || item.recordId, success: true, message: "删除成功" }); }
        catch (e: unknown) { const { message, errorCode } = translateDnsWriteError(e instanceof Error ? e.message : "未知错误", "NS"); if (errorCode === "ns_management_disabled") nsDisabled = true; failCount++; results.push({ label: item.label || item.recordId, success: false, message }); }
        await deps.sleep(DNS_BATCH_INTERVAL);
      }
      if (changed) await dnsService(db).refreshStatus(domain);
      await logService(db).write(failCount === 0 ? "success" : "warning", "api", `批量删除域名 [${domain.full_domain}] 的解析记录完成：成功 ${successCount} 条，失败 ${failCount} 条`, results);
      await auditService(db).write({ actor: "session", action: "batch-delete", resourceType: "dns_record", resourceId: String(domainId), result: failCount === 0 ? "success" : "failure", details: { successCount, failCount } });
      return c.json(successRes({ success_count: successCount, fail_count: failCount, results, error_code: nsDisabled ? "ns_management_disabled" : undefined, message: `批量删除完成：成功 ${successCount} 条，失败 ${failCount} 条` }));
    } catch (e: unknown) { return c.json(errorRes(`批量删除解析记录失败: ${e instanceof Error ? e.message : "未知错误"}`), 400); }
  });

  app.put("/api/domains/:id/dns/:record_id", async (c) => {
    const db = c.get("db"); const domainId = Number(c.req.param("id")); const recordId = c.req.param("record_id"); let body: Record<string, unknown> = {};
    try {
      body = await c.req.json(); const domain = await domainService(db).get(domainId);
      if (!domain) return c.json(errorRes("未找到域名记录", "not_found"), 404);
      const input = normalizedInput(body, domain.full_domain);
      if (!input.type || !input.content) return c.json(errorRes("记录类型与记录值均不能为空", "bad_request"), 400);
      const result = await dnsService(db).update(domain, recordId, input);
      await dnsService(db).refreshStatus(domain);
      await logService(db).write("success", "api", `修改了域名 [${domain.full_domain}] 下的记录 (ID: ${recordId}): ${input.type} ${input.name} -> ${input.content}`);
      await auditService(db).write({ actor: "session", action: "update", resourceType: "dns_record", resourceId: recordId, result: "success", details: { domainId, type: input.type, name: input.name } });
      return c.json(successRes({ message: "更新DNS记录成功", record: result.record }));
    } catch (e: unknown) { const { message, errorCode } = translateDnsWriteError(e instanceof Error ? e.message : "未知错误", body.type); return c.json(errorRes(message, errorCode), 400); }
  });

  app.delete("/api/domains/:id/dns/:record_id", async (c) => {
    const db = c.get("db"); const domainId = Number(c.req.param("id")); const recordId = c.req.param("record_id");
    try {
      const domain = await domainService(db).get(domainId); if (!domain) return c.json(errorRes("未找到域名记录", "not_found"), 404);
      await dnsService(db).remove(domain, recordId); await dnsService(db).refreshStatus(domain);
      await logService(db).write("success", "api", `删除了域名 [${domain.full_domain}] 下的 DNS 记录 (ID: ${recordId})`);
      await auditService(db).write({ actor: "session", action: "delete", resourceType: "dns_record", resourceId: recordId, result: "success", details: { domainId } });
      return c.json(successRes({ message: "删除DNS记录成功" }));
    } catch (e: unknown) { return c.json(errorRes(e instanceof Error ? e.message : "未知错误"), 400); }
  });
}
