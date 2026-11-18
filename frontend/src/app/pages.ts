import { lazyPage } from "../lib/lazy-page";

/**
 * app/pages.ts —— 页面组件注册表
 *
 * WHY 集中到这里:
 *   原先 12 个 `lazyPage(() => import(...))` 声明散落在 App.tsx 顶部,
 *   与业务 import 混在一起。「项目里有哪些页面、各自从哪加载」是应用级信息,
 *   归 app/ 层集中管理;App.tsx 只消费组件,不再关心加载细节。
 *
 * NOTE: 这里只做「声明与按需加载」,不涉及页面选择(那是 App 的 activeTab 分发)。
 *       页面组件保持 React.lazy；Scanner 的状态与页面一起由 ScannerHost 按需加载，
 *       不在这里单独注册一个仍依赖根控制器 eager hook 的空壳页面。
 *
 * 依赖方向:app → features / components,不反向依赖 App.tsx。
 */

export const AccountsPage = lazyPage(() => import("../components/AccountsPage"), "AccountsPage");
export const MultiProviderPage = lazyPage(() => import("../features/providers/components/MultiProviderPage"), "MultiProviderPage");
export const CustomProvidersPage = lazyPage(() => import("../features/custom/components/CustomProvidersPage"), "CustomProvidersPage");
export const DashboardPage = lazyPage(() => import("../features/dashboard/components/DashboardPage"), "DashboardPage");
export const SettingsPage = lazyPage(() => import("../features/settings/components/SettingsPage"), "SettingsPage");
export const DomainsPage = lazyPage(() => import("../features/domains/components/DomainsPage"), "DomainsPage");
export const LineSettingsPage = lazyPage(() => import("../features/domains/components/LineSettingsPage"), "LineSettingsPage");
export const QuotaPage = lazyPage(() => import("../features/quota/components/QuotaPage"), "QuotaPage");
export const LogsPage = lazyPage(() => import("../features/logs/components/LogsPage"), "LogsPage");
export const CfZonesPage = lazyPage(() => import("../features/cloudflare/components/CfZonesPage"), "CfZonesPage");
export const DpZonesPage = lazyPage(() => import("../features/digitalplat/components/DpZonesPage"), "DpZonesPage");
