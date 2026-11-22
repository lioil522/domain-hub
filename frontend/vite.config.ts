import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { bundleBudget } from "./tooling/bundle-budget";
import { dependencyChunkName } from "./tooling/chunking";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), bundleBudget()],
  build: {
    // Preserve the previous Vite 5 browser floor rather than silently adopting
    // Vite 8's newer baseline. CSS keeps the existing esbuild minifier.
    target: ["es2020", "chrome87", "edge88", "firefox78", "safari14"],
    cssMinify: "esbuild",
    rolldownOptions: {
      output: {
        // 手动分包：把「长期不变的大依赖」从业务代码里拆出来，
        // 让它们各自成为可长期缓存的独立 chunk，业务代码更新时不至于
        // 让用户重新下载整个 React / 图标库。
        //   - react-vendor：React 运行时 + 图库（qrcode.react 也依赖 react）
        //   - icons：lucide 图标（体量大、跨页共享、几乎不变）
        codeSplitting: {
          groups: [{ debugName: "stable-dependencies", name: dependencyChunkName }],
        },
      },
    },
  },
  server: {
    port: 3000,
    proxy: {
      // 本地开发代理，将所有 /api 请求代理到正在运行的 wrangler dev 本地服务 (默认 8787 端口)
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
});
