import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)) },
  },
  build: { outDir: "dist/client", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8787" },
  },
});
