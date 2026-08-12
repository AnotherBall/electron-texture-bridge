import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts"),
          receiver: resolve("src/preload/receiver.ts"),
          // "multiviewer" input deferred to Task 4 — src/preload/multiviewer.ts
          // doesn't exist yet on this branch.
        },
      },
    },
  },
  renderer: {
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
          "receiver-test": resolve("src/renderer/receiver-test.html"),
          "grid-demo": resolve("src/renderer/grid-demo.html"),
          // "multiviewer" input deferred to Task 4 — src/renderer/multiviewer.html
          // doesn't exist yet on this branch.
        },
      },
    },
    worker: {
      format: "es",
    },
  },
});
