import type { DnsRecordInput } from "../types/dns";
import { ValidationError } from "../errors";
import { normalizeDnsRecordName } from "./dns-operations";
import { toASCII } from "../punycode";

function integer(value: unknown, name: string, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") {
    throw new ValidationError(`${name} 必须是 ${min}–${max} 范围内的整数`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new ValidationError(`${name} 必须是 ${min}–${max} 范围内的整数`);
  return number;
}

/** Whitelist client fields. Domain and record identifiers are always server-resolved. */
export function normalizeDnsInput(item: Record<string, unknown>, fullDomain: string): DnsRecordInput {
  const type = String(item.type || "").trim().toUpperCase();
  // Keep other providers' extended types available; each provider validates its capabilities.
  if (!/^[A-Z][A-Z0-9]{0,15}$/.test(type)) throw new ValidationError("无效的 DNS 记录类型");
  const name = normalizeDnsRecordName(String(item.name ?? ""), fullDomain);
  let content = String(item.content ?? "");
  // TXT whitespace is data, not formatting.
  if (type !== "TXT") content = content.trim();
  const priority = type === "MX" || type === "SRV" ? integer(item.priority, "priority", 0, 65535, type === "MX" ? 10 : 0) : undefined;
  if (!content && type === "SRV") {
    const weight = integer(item.weight ?? item.record_weight, "weight", 0, 65535, 0);
    const port = integer(item.port ?? item.record_port, "port", 1, 65535);
    const target = toASCII(String(item.target ?? item.record_target ?? "").trim());
    if (!target || /\s/.test(target)) throw new ValidationError("SRV 必须提供有效的 target");
    content = `${priority} ${weight} ${port} ${target}`;
  }
  if (!content && type === "CAA") {
    const flag = integer(item.caa_flag, "caa_flag", 0, 255, 0);
    const tag = String(item.caa_tag ?? "issue").trim();
    const value = String(item.caa_value ?? "");
    if (!/^[A-Za-z0-9]+$/.test(tag) || !value || /[\r\n\0]/.test(value)) throw new ValidationError("CAA 必须提供有效的 tag 和 value");
    content = `${flag} ${tag} "${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  if (!content) throw new ValidationError("记录值不能为空");
  const result: DnsRecordInput = { type, name, content, ttl: integer(item.ttl, "ttl", 1, 2147483647, 600) };
  if (priority !== undefined) result.priority = priority;
  const line = String(item.line ?? "").trim();
  if (line) result.line = line;
  if (item.proxied !== undefined) result.proxied = item.proxied === true || item.proxied === "true";
  return result;
}
