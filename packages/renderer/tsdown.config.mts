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
  // PreviewManager loads `preview.html` / `preview-preload.js` from
  // `dist/assets/` at runtime, so they must ship alongside the bundle. This
  // used to be a `cp -r src/assets dist/assets` step in the build script,
  // which fails on Windows (pnpm runs scripts through cmd.exe, where `cp`
  // only exists if Git's usr/bin happens to be on PATH).
  //
  // `flatten: false` preserves each match's path relative to the first
  // non-glob segment of `from` (`src/`), so `src/assets/x` lands at
  // `dist/assets/x` — hence `to: "dist"`, not `to: "dist/assets"`. This
  // matches `cp -r` for any future subdirectory under `src/assets`.
  copy: { from: "src/assets/**/*", to: "dist", flatten: false },
});
