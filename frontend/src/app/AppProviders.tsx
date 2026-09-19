import type { ReactNode } from "react";
import { AppDataProvider } from "../state/AppDataContext";
import { DensityProvider } from "./DensityContext";

/**
 * AppProviders —— 应用级 Provider 组装层
 *
 * WHY 需要它:
 *   原先 main.tsx 直接把 <AppDataProvider> 包在 <App> 外层,「有哪些全局 Provider」
 *   这件事散落在入口文件里。收敛到这里后入口只认一个 <AppProviders>,后续新增
 *   全局 Provider(如后续 Phase 把 domains / quotas / logs 各域并入 Context)时
 *   只在本文加一行,不必改 main.tsx。
 *
 * NOTE: 当前唯一的全局 Provider 是 AppDataProvider(账号域 + 横切基础设施:
 *       sessionToken / backendUrl / apiFetch / accounts / toast)。
 *       Auth、Theme 目前是 hook(state 在 App 内)与 props,不是 Context Provider ——
 *       在它们各自真正提升为 Context 之前,这里不为对齐计划书措辞而空造 Provider。
 *       见 docs/ADR/ADR-001 与 docs/ARCHITECTURE-2.0.md §2.1。
 *
 * 依赖方向:app → state,不反向依赖 App.tsx。
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <DensityProvider>
      <AppDataProvider>{children}</AppDataProvider>
    </DensityProvider>
  );
}