/**
 * Build guard: the MAIN entry must stay importable without Electron (the
 * plain-Node sendRgbaBuffer sanity check depends on it). Only the ./electron
 * subpath may import electron.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const findElectronImports = (sources) =>
  sources
    .filter(({ content }) => /require\(["']electron["']\)|from\s+["']electron["']/.test(content))
    .map(({ path }) => path);

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  const mainEntryFiles = ["../dist/index.mjs", "../dist/index.cjs"];
  const sources = await Promise.all(
    mainEntryFiles.map(async (rel) => ({
      path: rel,
      content: await readFile(new URL(rel, import.meta.url), "utf8"),
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
  console.log(`[electron-free-guard] OK — ${mainEntryFiles.length} main-entry file(s) clean`);
}
