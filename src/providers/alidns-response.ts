import { incompleteResponse } from "../errors/provider-api-error";
import { isObject } from "./list-integrity";

interface XmlNode { name: string; text: string; children: XmlNode[] }
const arrayChildren: Record<string, string> = { Domains: "Domain", DomainRecords: "Record", DnsServers: "DnsServer" };
const numericFields = new Set(["TotalCount", "PageNumber", "PageSize", "RecordCount", "TTL", "Priority"]);

function decodeText(text: string): string {
  return text.replace(/&([^;\s]+);|&/g, (entity, code: string | undefined) => {
    const named: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
    if (code && Object.hasOwn(named, code)) return named[code];
    if (code && /^#(?:\d+|x[\da-f]+)$/i.test(code)) {
      const point = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      if (point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)) return String.fromCodePoint(point);
    }
    throw incompleteResponse("alidns", "阿里云 XML 响应包含无效实体，旧缓存保持不变");
  });
}

/** Restricted RPC XML compatibility: no DTD, attributes, external entities or recovery of truncated documents. */
export function parseAlidnsResponse(text: string, action: string, errorOnly = false): Record<string, unknown> {
  if (text.trimStart().startsWith("{")) {
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw incompleteResponse("alidns"); }
    if (!isObject(value)) throw incompleteResponse("alidns");
    return value;
  }

  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  const tokens = /<\?xml\s[^?]*\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z][A-Za-z0-9_]*(?:\s*\/)?\s*>|[^<]+/g;
  let cursor = 0;
  for (const match of text.matchAll(tokens)) {
    if (match.index !== cursor) throw incompleteResponse("alidns");
    const token = match[0];
    cursor += token.length;
    if (token.startsWith("<?xml")) {
      if (root || stack.length) throw incompleteResponse("alidns");
    } else if (token.startsWith("<![CDATA[")) {
      if (!stack.length) throw incompleteResponse("alidns");
      stack[stack.length - 1].text += token.slice(9, -3);
    } else if (token.startsWith("</")) {
      if (stack.pop()?.name !== token.slice(2, -1).trim()) throw incompleteResponse("alidns");
    } else if (token.startsWith("<")) {
      const name = token.replace(/^<|\s*\/?\s*>$/g, "");
      const node: XmlNode = { name, text: "", children: [] };
      if (stack.length) stack[stack.length - 1].children.push(node);
      else {
        if (root) throw incompleteResponse("alidns");
        root = node;
      }
      if (!/\/\s*>$/.test(token)) stack.push(node);
      if (stack.length > 32) throw incompleteResponse("alidns");
    } else if (stack.length) {
      stack[stack.length - 1].text += decodeText(token);
    } else if (token.trim()) throw incompleteResponse("alidns");
  }
  if (cursor !== text.length || stack.length || !root || !(errorOnly ? ["Error"] : [`${action}Response`, "Error"]).includes(root.name)) {
    throw incompleteResponse("alidns");
  }

  function convert(node: XmlNode): unknown {
    const childName = arrayChildren[node.name];
    if (!node.children.length && !childName) {
      if (numericFields.has(node.name)) return /^\d+$/.test(node.text.trim()) ? Number(node.text.trim()) : undefined;
      if (node.name === "AliDomain") return node.text.trim() === "true";
      return node.text;
    }
    if (node.text.trim()) throw incompleteResponse("alidns");
    const result: Record<string, unknown> = Object.create(null);
    if (childName) result[childName] = [];
    for (const child of node.children) {
      if (childName && child.name !== childName) throw incompleteResponse("alidns");
      if (child.name === childName) (result[childName] as unknown[]).push(convert(child));
      else {
        if (Object.hasOwn(result, child.name)) throw incompleteResponse("alidns");
        result[child.name] = convert(child);
      }
    }
    return result;
  }
  const value = convert(root);
  if (!isObject(value)) throw incompleteResponse("alidns");
  return value;
}
