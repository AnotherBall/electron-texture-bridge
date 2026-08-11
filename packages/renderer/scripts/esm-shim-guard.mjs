/**
 * Regression guard for the ESM `__dirname` shim (renderer 0.13.1 fix).
 *
 * PreviewManager resolves bundled assets via `__dirname`, which only exists in
 * the ESM output because tsdown injects a shim (`shims: true` in
 * tsdown.config.mts). If that flag is ever dropped, the .mjs build throws
 * `ReferenceError: __dirname is not defined` at import time under an ESM
 * Electron main — exactly the 0.13.0 bug consumers had to patch around.
 *
 * Invariant checked here: every dist .mjs that references `__dirname` must
 * also define it (`const __dirname = ...` — the shape of tsdown's shim).
 */
import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const findUnshimmedSources = (sources) =>
  sources
    .filter(({ content }) => /\b__dirname\b/.test(content) && !/const __dirname\s*=/.test(content))
    .map(({ path }) => path);

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  const distDir = new URL("../dist/", import.meta.url);
  const entries = await readdir(distDir, { recursive: true });
  const mjsPaths = entries.filter((entry) => entry.endsWith(".mjs"));
  if (mjsPaths.length === 0) {
    console.error(
      "[esm-shim-guard] no .mjs files found under dist/ — the guard has nothing to check, failing loudly.",
    );
    process.exit(1);
  }
  const sources = await Promise.all(
    mjsPaths.map(async (entryPath) => ({
      path: entryPath,
      content: await readFile(new URL(entryPath, distDir), "utf8"),
    })),
  );
  const offenders = findUnshimmedSources(sources);
  if (offenders.length > 0) {
    console.error(
      `[esm-shim-guard] ESM output references __dirname without a shim: ${offenders.join(", ")}\n` +
        `[esm-shim-guard] Check that tsdown.config.mts still sets \`shims: true\`.`,
    );
    process.exit(1);
  }
  console.log(`[esm-shim-guard] OK — ${mjsPaths.length} .mjs file(s) checked`);
}
