import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // 手动分包：把「长期不变的大依赖」从业务代码里拆出来，
        // 让它们各自成为可长期缓存的独立 chunk，业务代码更新时不至于
        // 让用户重新下载整个 React / 图标库。
        //   - react-vendor：React 运行时 + 图库（qrcode.react 也依赖 react）
        //   - icons：lucide 图标（体量大、跨页共享、几乎不变）
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("lucide-react")) return "icons";
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/scheduler/") ||
            id.includes("qrcode.react")
          ) {
            return "react-vendor";
          }
          return "vendor";
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
