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

const ELECTRON_IMPORT_PATTERN =
  /require\(["']electron(\/[^"']*)?["']\)|from\s+["']electron(\/[^"']*)?["']/;

export const findElectronImports = (sources) =>
  sources.filter(({ content }) => ELECTRON_IMPORT_PATTERN.test(content)).map(({ path }) => path);

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  const distDir = new URL("../dist/", import.meta.url);
  const electronEntryFile = new URL("../dist/electron.mjs", import.meta.url);
  const electronEntryExists = await stat(electronEntryFile)
    .then(() => true)
    .catch(() => false);
  if (!electronEntryExists) {
    console.error(
      `[electron-free-guard] dist/electron.mjs is missing — the ./electron export in package.json ` +
        `would dangle. Did the electron.ts build entry fail or get dropped?`,
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
