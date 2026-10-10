import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    allowedHosts: ["gti12-1", "gti12-1.tailc6b81b.ts.net"],
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:3001" },
      "/viewer": { target: "http://127.0.0.1:3001", ws: true },
    },
  },
  build: { outDir: "../../dist/web", emptyOutDir: true },
});
