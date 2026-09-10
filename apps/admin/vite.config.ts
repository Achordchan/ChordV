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
    port: 5174,
    proxy: {
      "/api": {
        target: process.env.VITE_API_BASE_URL ?? "https://v.baymaxgroup.com",
        changeOrigin: true,
        secure: true
      }
    }
  }
});
