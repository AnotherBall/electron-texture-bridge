/**
 * Build guard: the MAIN entry must stay importable without Electron (the
 * plain-Node sendRgbaBuffer sanity check depends on it). Only the ./electron
 * subpath (`dist/electron.mjs` / `dist/electron.cjs`) may import electron.
 *
 * Scans every emitted `dist/**\/*.{mjs,cjs}` file EXCEPT the quarantined
 * `electron.mjs` / `electron.cjs` entries themselves — not just `index.*` —
 * because a two-entry tsdown build can split shared code into chunk files
 * (e.g. the `types-*.d.mts` chunk already proves this happens for types), and
 * a chunk reachable from the main entry could smuggle an `electron` import
 * past a guard that only ever looked at `index.mjs` / `index.cjs`.
 *
 * Accepted limitation: this is a text scan, not an import-graph walk. If
 * tsdown ever emits a chunk that imports `electron` but is reachable ONLY
 * from the `electron.mjs` / `electron.cjs` entry (never from the main
 * entry), this guard will false-positive on that chunk. If that happens,
 * refine this to actually walk the import graph from each entry instead of
 * scanning the whole `dist/` directory.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const ELECTRON_ENTRY_BASENAMES = new Set(["electron.mjs", "electron.cjs"]);

// Matches `require("electron")`, static `from "electron"` (including the
// zero-whitespace minified form `from"electron"`), bare side-effect
// `import "electron"`, and dynamic `import("electron")` — plus any subpath
// of each (`electron/main`, etc).
const ELECTRON_IMPORT_PATTERN =
  /(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)["']electron(\/[^"']*)?["']/;

export const findElectronImports = (sources) =>
  sources.filter(({ content }) => ELECTRON_IMPORT_PATTERN.test(content)).map(({ path }) => path);

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  const distDir = new URL("../dist/", import.meta.url);
  const electronEntryMjs = new URL("../dist/electron.mjs", import.meta.url);
  const electronEntryCjs = new URL("../dist/electron.cjs", import.meta.url);
  const [electronMjsExists, electronCjsExists] = await Promise.all([
    stat(electronEntryMjs)
      .then(() => true)
      .catch(() => false),
    stat(electronEntryCjs)
      .then(() => true)
      .catch(() => false),
  ]);
  // `exports["./electron"]` in package.json declares BOTH `import` and
  // `require` conditions, and the renderer package's CJS build really does
  // `require(".../electron")` — so both artifacts must exist, not just
  // either one. A missing .cjs would dangle for every CJS consumer even
  // though the guard's own .mjs check passed.
  const missing = [
    !electronMjsExists ? "dist/electron.mjs" : null,
    !electronCjsExists ? "dist/electron.cjs" : null,
  ].filter((path) => path !== null);
  if (missing.length > 0) {
    console.error(
      `[electron-free-guard] ${missing.join(" and ")} missing — the ./electron export in ` +
        `package.json declares both import and require conditions, so both artifacts must exist. ` +
        `Did the electron.ts build entry fail or get dropped?`,
    );
    process.exit(1);
  }

  const entries = await readdir(distDir, { recursive: true });
  const scannedPaths = entries.filter(
    (entry) =>
      (entry.endsWith(".mjs") || entry.endsWith(".cjs")) &&
      !ELECTRON_ENTRY_BASENAMES.has(entry.split("/").pop() ?? entry),
  );
  if (scannedPaths.length === 0) {
    console.error(
      "[electron-free-guard] no non-electron .mjs/.cjs files found under dist/ — the guard has nothing to check, failing loudly.",
    );
    process.exit(1);
  }

  const sources = await Promise.all(
    scannedPaths.map(async (entryPath) => ({
      path: entryPath,
      content: await readFile(new URL(entryPath, distDir), "utf8"),
    })),
  );
  const offenders = findElectronImports(sources);
  if (offenders.length > 0) {
    console.error(
      `[electron-free-guard] main entry imports electron: ${offenders.join(", ")}\n` +
        `[electron-free-guard] electron imports belong in src/electron.ts (./electron subpath) only.`,
    );
    process.exit(1);
  }
  console.log(`[electron-free-guard] OK — ${scannedPaths.length} file(s) clean`);
}
