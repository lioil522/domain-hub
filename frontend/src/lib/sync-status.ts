import type { SliceState } from "./sliced-sync";

export function syncStatusText(state: SliceState, enabled: boolean) {
  const labels: Record<string, string> = { stale: "尚未同步", queued: "等待页面继续", running: "正在同步", paused: "暂缓", blocked: "同步受阻，需手动处理", completed: "完整同步完成", cancelled: "已取消", invalidated: "账号配置已变化，原任务失效" };
  const phases: Record<string, string> = { list: state.list_stage === "candidates" ? "捕获本地快照" : state.list_stage === "publish" ? "保存完整域名列表" : "读取域名列表", dns: "同步 DNS", quota: "DNS 收尾", cleanup: "核对旧域名", done: "" };
  const label = state.client_error ? "页面推进失败，断点保留" : state.advancing ? "正在推进" : state.status === "running" && state.executing !== false ? "当前分片正在执行" : state.retry_after_ms ? `等待 ${Math.ceil(state.retry_after_ms / 1000)} 秒后可继续` : !enabled && state.continuation ? "已暂停：自动同步关闭，请点击同步继续" : state.status === "running" ? "断点保留，等待页面继续" : labels[state.status] ?? state.status;
  const progress = state.phase === "dns" && state.dns_completed !== undefined ? `DNS ${state.dns_completed}/${state.domain_count ?? "未知"}` : state.list_pages ? `已读取 ${state.list_pages} 页 · ${state.domain_count ?? 0} 个域名` : "";
  return [label, state.phase && phases[state.phase], progress].filter(Boolean).join(" · ");
}
