import { defineConfig, type ViteDevServer, type PreviewServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { createViewerAssets, type ViewerAssets } from "../../packages/minecraft/src/viewer-assets";

function compactViewerAssets() {
  let assets: Promise<ViewerAssets> | undefined;
  function mount(server: ViteDevServer | PreviewServer) {
    server.middlewares.use((req, res, next) => {
      if (!(req.url ?? "").split("?")[0]!.startsWith("/viewer-assets/")) return next();
      assets ??= createViewerAssets();
      void assets.then(value => value.handle(req, res)).then(handled => {
        if (!handled) next();
      }).catch((error: unknown) => {
        if (res.headersSent) { res.destroy(); return; }
        const detail = error as { statusCode?: number; code?: string; message?: string };
        res.writeHead(detail.statusCode ?? 500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        res.end(JSON.stringify({ error: { code: detail.code ?? "VIEWER_ASSETS_UNAVAILABLE", message: detail.message ?? "3D 화면 자산을 읽을 수 없습니다." } }));
      });
    });
  }
  return { name: "laya-compact-viewer-assets", configureServer: mount, configurePreviewServer: mount };
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), compactViewerAssets()],
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
