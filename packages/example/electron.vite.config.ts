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
          multiviewer: resolve("src/preload/multiviewer.ts"),
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
          multiviewer: resolve("src/renderer/multiviewer.html"),
        },
      },
    },
    worker: {
      format: "es",
    },
  },
});
