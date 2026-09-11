import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";

const backendVersion = readFileSync(new URL("../../SYSTEM_VERSION", import.meta.url), "utf8").trim();

export default defineConfig({
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
        target: process.env.CHORDV_DEV_API_TARGET ?? `http://127.0.0.1:${process.env.CHORDV_API_PORT ?? 3000}`,
        changeOrigin: true,
        secure: true,
        ws: true
      }
    }
  }
});
