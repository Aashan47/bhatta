import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The real API runs at http://127.0.0.1:8787 and is served under /api at the same origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: true } },
  },
  preview: {
    port: 4173,
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: true } },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: { maplibre: ["maplibre-gl"], viem: ["viem"] },
      },
    },
  },
});
