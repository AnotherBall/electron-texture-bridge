import { describe, expect, it } from "vitest";

import { findElectronImports } from "../../scripts/electron-free-guard.mjs";

const BARE_ESM_IMPORT = `
import { sharedTexture } from "electron";
export const forwardSharedTexture = async () => undefined;
`;

const BARE_CJS_REQUIRE = `
"use strict";
const electron = require("electron");
module.exports.forwardSharedTexture = async () => undefined;
`;

const SUBPATH_ESM_IMPORT = `
import { app } from "electron/main";
export const ready = () => app.whenReady();
`;

const RELATIVE_ONLY = `
import { TextureSendError } from "./errors.mjs";
export const sendRgbaBuffer = () => {};
`;

// N6: negative cases pinning that package names merely PREFIXED or SCOPED
// with "electron" — not the bare specifier itself — don't false-positive.
const UNRELATED_PACKAGE_ELECTRON_STORE = `
import Store from "electron-store";
export const store = new Store();
`;

const UNRELATED_PACKAGE_ELECTRON_LOG = `
import log from "electron-log";
export const logInfo = (msg) => log.info(msg);
`;

const UNRELATED_SCOPED_PACKAGE = `
import { thing } from "@scope/electron";
export const useThing = () => thing;
`;

const RELATIVE_ELECTRON_DOT_MJS = `
import { helper } from "./electron.mjs";
export const useHelper = () => helper();
`;

const MINIFIED_FROM_IMPORT = `import{sharedTexture as s}from"electron";export const f=async()=>s;`;

const BARE_SIDE_EFFECT_IMPORT = `
import "electron";
export const forwardSharedTexture = async () => undefined;
`;

const DYNAMIC_IMPORT = `
export const lazyElectron = async () => import("electron");
`;

describe("findElectronImports", () => {
  it('flags a bare ESM `from "electron"` import', () => {
    const result = findElectronImports([{ path: "index.mjs", content: BARE_ESM_IMPORT }]);
    expect(result).toEqual(["index.mjs"]);
  });

  it('flags a minified `from"electron"` import with no whitespace', () => {
    const result = findElectronImports([{ path: "index.mjs", content: MINIFIED_FROM_IMPORT }]);
    expect(result).toEqual(["index.mjs"]);
  });

  it('flags a bare side-effect `import "electron"` with no bindings', () => {
    const result = findElectronImports([{ path: "index.mjs", content: BARE_SIDE_EFFECT_IMPORT }]);
    expect(result).toEqual(["index.mjs"]);
  });

  it('flags a dynamic `import("electron")` call', () => {
    const result = findElectronImports([{ path: "index.mjs", content: DYNAMIC_IMPORT }]);
    expect(result).toEqual(["index.mjs"]);
  });

  it('flags a bare CJS `require("electron")` call', () => {
    const result = findElectronImports([{ path: "index.cjs", content: BARE_CJS_REQUIRE }]);
    expect(result).toEqual(["index.cjs"]);
  });

  it('flags a subpath import like `from "electron/main"`', () => {
    const result = findElectronImports([{ path: "index.mjs", content: SUBPATH_ESM_IMPORT }]);
    expect(result).toEqual(["index.mjs"]);
  });

  it("passes a file with only relative imports", () => {
    const result = findElectronImports([{ path: "index.mjs", content: RELATIVE_ONLY }]);
    expect(result).toEqual([]);
  });

  it('does not flag an unrelated package prefixed with "electron" (electron-store)', () => {
    const result = findElectronImports([
      { path: "index.mjs", content: UNRELATED_PACKAGE_ELECTRON_STORE },
    ]);
    expect(result).toEqual([]);
  });

  it('does not flag an unrelated package prefixed with "electron" (electron-log)', () => {
    const result = findElectronImports([
      { path: "index.mjs", content: UNRELATED_PACKAGE_ELECTRON_LOG },
    ]);
    expect(result).toEqual([]);
  });

  it('does not flag an unrelated scoped package ("@scope/electron")', () => {
    const result = findElectronImports([{ path: "index.mjs", content: UNRELATED_SCOPED_PACKAGE }]);
    expect(result).toEqual([]);
  });

  it('does not flag a relative import of "./electron.mjs"', () => {
    const result = findElectronImports([{ path: "index.mjs", content: RELATIVE_ELECTRON_DOT_MJS }]);
    expect(result).toEqual([]);
  });

  it("reports only the offending files among a mixed set", () => {
    const result = findElectronImports([
      { path: "clean.mjs", content: RELATIVE_ONLY },
      { path: "bare.mjs", content: BARE_ESM_IMPORT },
      { path: "subpath.mjs", content: SUBPATH_ESM_IMPORT },
      { path: "require.cjs", content: BARE_CJS_REQUIRE },
    ]);
    expect(result).toEqual(["bare.mjs", "subpath.mjs", "require.cjs"]);
  });
});
