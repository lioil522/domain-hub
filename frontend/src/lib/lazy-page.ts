import { lazy } from "react";
import type { ComponentType } from "react";

/**
 * lazyPage —— 把「具名导出的页面组件」包成 React.lazy 可用的默认导出
 *
 * WHY：
 * 项目里的页面组件一律用具名导出（`export function XxxPage`），而 React.lazy
 * 只认默认导出。手写 `lazy(() => import("...").then((m) => ({ default: m.XxxPage })))`
 * 每处都要重复一遍模块路径 + 组件名，既啰嗦又容易写歪。
 *
 * 用法：
 *   const SettingsPage = lazyPage(() => import("./features/settings/components/SettingsPage"), "SettingsPage");
 *
 * 泛型只在模块组件边界使用 `any`，用于兼容不同页面组件 props；返回值保持具体组件类型。
 */
export function lazyPage<
  M extends Record<string, ComponentType<any>>,
  K extends keyof M & string
>(
  loader: () => Promise<M>,
  name: K
): M[K] {
  return lazy(async () => {
    const mod = await loader();
    return { default: mod[name] };
  }) as unknown as M[K];
}
