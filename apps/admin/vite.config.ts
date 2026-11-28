import { adaptLoopbackRefreshCookie } from "./dev-proxy";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";

const backendVersion = readFileSync(new URL("../../SYSTEM_VERSION", import.meta.url), "utf8").trim();

export default defineConfig(({ mode }) => {
  const envDir = fileURLToPath(new URL("../../.data/mygo/frontend-env", import.meta.url));
  const env = loadEnv(mode, envDir, "");
  const apiTarget = process.env.CHORDV_DEV_API_TARGET || env.CHORDV_DEV_API_TARGET
    || process.env.VITE_API_BASE_URL || env.VITE_API_BASE_URL || "http://127.0.0.1:3100";
  if (mode !== "release") {
    const target = new URL(apiTarget);
    if (!["http:", "https:"].includes(target.protocol)
        || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
        || target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
      throw new Error("本地调试后台只允许连接回环地址，不能连接线上 API。");
    }
  }
  return {
  envDir,
  plugins: [react(), {
    name: "chordv-backend-version",
    transformIndexHtml: () => [{ tag: "meta", attrs: { name: "chordv-backend-version", content: backendVersion }, injectTo: "head" }]
  }],
  resolve: {
    alias: {
      "@chordv/shared/update-limits": fileURLToPath(new URL("../../packages/shared/src/update-limits.ts", import.meta.url)),
      "@chordv/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url))
    }
  },
  build: {
    commonjsOptions: {
      include: [/packages\/shared\/dist/, /node_modules/]
    }
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.CHORDV_ADMIN_PORT ?? 5174),
    strictPort: true,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        secure: true,
        ws: true,
        configure(proxy) { proxy.on("proxyRes", adaptLoopbackRefreshCookie); }
      }
    }
  }
  };
});
