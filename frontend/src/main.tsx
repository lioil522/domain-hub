import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

/*
 * 设计系统展示页分流
 *
 * NOTE: 走 hash 路由（#/design-system）而不是新增一个 Vite 入口，
 * 理由是这个项目有两条部署链路（Workers 的 [assets] 与自建侧的
 * server/static.ts），两者都靠 SPA 兜底把未知路径回落到 index.html。
 * 新增入口意味着要同步改这两处配置与构建脚本，收益不抵风险。
 * hash 路由不需要任何服务端配合，且与 App.tsx 既有的 #/register 直入约定一致。
 *
 * 该页面是开发者工具，不进入侧栏导航，只有知道地址的人能访问。
 */
const isDesignSystem =
  window.location.hash.replace(/^#\/?/, "").split("?")[0] === "design-system";

// 按需加载：设计系统页不属于业务路径，拆出去避免增大首屏包体。
// 200ms 内这个 chunk 会加载完，用户无感知。
const DesignSystem = React.lazy(() => import("./DesignSystem.tsx"));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isDesignSystem ? (
      <React.Suspense fallback={null}>
        <DesignSystem />
      </React.Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>
);
