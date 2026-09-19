export const UNDELETABLE_STATUS: Record<string, string> = {
  serverhold: "域名处于 ServerHold（服务器暂停）状态",
  pendingdelete: "域名处于 PendingDelete（等待删除）状态",
  transferring: "域名处于转赠 / 转移中状态",
  transfer: "域名处于转赠 / 转移中状态",
  gifting: "域名处于转赠中状态",
  pendingtransfer: "域名处于等待转赠状态",
};

export function translateDeleteError(raw: string): string {
  const s = (raw || "").toLowerCase();
  if (s.includes("dns") && (s.includes("record") || s.includes("history"))) {
    return "该域名存在 DNS 解析记录历史，上游不允许删除";
  }
  if (s.includes("serverhold")) return "域名处于 ServerHold 状态，不支持删除";
  if (s.includes("pendingdelete") || s.includes("pending delete")) return "域名处于 PendingDelete 状态，不支持删除";
  if (s.includes("transfer") || s.includes("gift")) return "域名处于转赠 / 转移状态，不支持删除";
  return raw || "上游拒绝了删除请求";
}
