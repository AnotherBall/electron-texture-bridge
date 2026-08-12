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
