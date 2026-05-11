import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    commonjsOptions: {
      include: [/packages\/shared\/dist/, /node_modules/]
    }
  },
  server: {
    port: 5173
  }
});
