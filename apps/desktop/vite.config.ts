import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { resolveClientApiBase } from "./src/lib/localEndpoint";

export default defineConfig(({ mode }) => {
  const envDir = fileURLToPath(new URL("../../.data/mygo/frontend-env", import.meta.url));
  const env = loadEnv(mode, envDir, "VITE_");
  const buildMode = process.env.CHORDV_BUILD_MODE === "release" ? "release" : "local";
  const apiBase = resolveClientApiBase(process.env.VITE_API_BASE_URL ?? env.VITE_API_BASE_URL, buildMode === "release");
  return {
  envDir,
  define: {
    "import.meta.env.VITE_API_BASE_URL": JSON.stringify(apiBase),
    "import.meta.env.VITE_CHORDV_BUILD_MODE": JSON.stringify(buildMode)
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@chordv/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url))
    }
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.CHORDV_LOCAL_DESKTOP_PORT ?? 5173),
    strictPort: true
  }
  };
});
