import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const publicRoot = fileURLToPath(
  new URL("../../public/compact-viewer", import.meta.url),
);
export default defineConfig({
  publicDir: false,
  plugins: [
    {
      name: "compact-viewer-public-assets",
      closeBundle() {
        mkdirSync(join(publicRoot, "textures"), { recursive: true });
        copyFileSync(
          require.resolve("three/build/three.module.js"),
          join(publicRoot, "three.module.js"),
        );
        const textures = join(
          dirname(require.resolve("prismarine-viewer/package.json")),
          "public/textures",
        );
        // All exact version atlases total 3.7 MB on disk. The browser requests only
        // its observed version, selected and fingerprinted by the server.
        for (const file of readdirSync(textures)) {
          if (/^\d+\.\d+(?:\.\d+)?\.png$/.test(file))
            copyFileSync(
              join(textures, file),
              join(publicRoot, "textures", file),
            );
        }
      },
    },
  ],
  base: "./",
  build: {
    outDir: publicRoot,
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL("./src/viewer/client.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "index.js",
      cssFileName: "viewer",
    },
    rollupOptions: {
      external: ["three"],
      output: { paths: { three: "./three.module.js" } },
    },
  },
  worker: {
    format: "es",
    rollupOptions: { output: { entryFileNames: "worker.js" } },
  },
});
