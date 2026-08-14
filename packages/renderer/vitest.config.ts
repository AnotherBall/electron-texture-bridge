import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: {
      // Vite resolves alias entries in declaration order via prefix matching,
      // so the "/electron" subpath MUST precede the bare package name below —
      // reordering makes the subpath resolve under the bare entry's target
      // file instead (ENOTDIR at runtime), breaking every renderer test.
      "@napolab/texture-bridge-core/electron": path.resolve(__dirname, "../core/src/electron.ts"),
      "@napolab/texture-bridge-core": path.resolve(__dirname, "../core/src/index.ts"),
      "@napolab/texture-bridge": path.resolve(__dirname, "../native/index.stub.js"),
    },
  },
});
