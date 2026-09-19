import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import type { ToastState } from "../../hooks/useToast";

/**
 * Toast 通知视图（Phase 2-E，从 App.tsx 抽出）
 *
 * 项目里有两处 Toast 渲染（登录页 / 全局），DOM 与类名完全一致，
 * 唯一差别是全局那处多了一组入场过渡类。用 `animated` 开关复用同一份实现，
 * 避免两处各写一遍（铁律 3）。
 *
 * 无障碍（P3-§十八）：
 * 视觉 Toast 是「随内容一起插入」的浮层，而读屏器对「live region 与内容同时出现」
 * 的支持并不可靠（可能完全不播报）。因此改为常驻播报区：
 *   - 两个 sr-only 的 live region 永久存在（polite / assertive 各一），
 *     消息按类型路由到其中之一，另一处清空，避免动态改 role 的兼容性抖动；
 *   - 视觉节点标记 aria-hidden，防止同一句话在无障碍树里出现两次。
 * `sr-only` 为项目既有工具类（Field.tsx 已在用），不引入新增 CSS。
 */
export const ToastView = ({ toast, animated = false }: { toast: ToastState | null; animated?: boolean }) => {
  const message = toast?.message ?? "";
  const isAlert = toast?.type === "error" || toast?.type === "warning";

  return (
    <>
      {/* 常驻播报区：polite（success / info） */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {isAlert ? "" : message}
      </div>
      {/* 常驻播报区：assertive（error / warning） */}
      <div role="alert" aria-live="assertive" aria-atomic="true" className="sr-only">
        {isAlert ? message : ""}
      </div>

      {toast && (
        <div
          aria-hidden="true"
          className={
            "fixed bottom-5 right-5 z-toast max-w-[min(90vw,28rem)] flex items-start gap-2.5 px-4 py-3 rounded-lg shadow-2xl border text-sm font-semibold bg-surface text-content-primary border-border-base" +
            (animated ? " transition-all duration-300 transform translate-y-0" : "")
          }
        >
          {toast.type === "success" && <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0" />}
          {toast.type === "error" && <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0" />}
          {toast.type === "info" && <Info className="w-5 h-5 text-accent flex-shrink-0" />}
          {toast.type === "warning" && <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0" />}
          <span className="min-w-0 break-words line-clamp-6">{toast.message}</span>
        </div>
      )}
    </>
  );
};
