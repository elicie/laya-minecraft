import { defineConfig, type ViteDevServer, type PreviewServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { createViewerAssets } from "../server/src/viewer-assets";

export default defineConfig(async () => {
  const require = createRequire(import.meta.url);
  const assets = await createViewerAssets({
    publicRoot: resolve(
      dirname(require.resolve("prismarine-viewer/package.json")),
      "public",
    ),
  });
  return {
    root: fileURLToPath(new URL(".", import.meta.url)),
    plugins: [
      react(),
      {
        name: "laya-viewer-assets",
        configureServer(server: ViteDevServer) {
          server.middlewares.use((req, res, next) => {
            void assets.handle(req, res).then((handled) => {
              if (!handled) next();
            }, next);
          });
        },
        configurePreviewServer(server: PreviewServer) {
          server.middlewares.use((req, res, next) => {
            void assets.handle(req, res).then((handled) => {
              if (!handled) next();
            }, next);
          });
        },
      },
    ],
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
  };
});
