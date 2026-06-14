import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/client/index.ts", "src/client/worker-protocol.ts"],
  format: ["cjs", "esm"],
  dts: true,
  // Inject `__dirname`/`__filename` shims into the ESM output. PreviewManager
  // resolves bundled assets via `__dirname`, which is undefined in ESM scope
  // without this. The shim is derived from `import.meta.url`.
  shims: true,
  // The shim helper is inlined from tsdown's own package; this is intentional,
  // so silence the "dependency bundled" warning (which would fail CI on warn).
  inlineOnly: false,
});
