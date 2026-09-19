import { useEffect, useState } from "react";

export type ToastType = "success" | "error" | "info" | "warning";
export interface ToastState {
  type: ToastType;
  message: string;
}

/**
 * Toast 提示 hook（Phase 2-E，从 App.tsx 抽出）
 *
 * 行为与原组件内的实现完全一致：
 *   - showToast(type, message) 设置提示
 *   - 设置后 4000ms 自动淡出
 */
export const useToast = () => {
  const [toast, setToast] = useState<ToastState | null>(null);

  const showToast = (type: ToastType, message: string) => {
    setToast({ type, message });
  };

  // 自动淡出 Toast 提示
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  return { toast, showToast, setToast };
};
