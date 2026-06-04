import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
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
