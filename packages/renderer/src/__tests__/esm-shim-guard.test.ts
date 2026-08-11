import { describe, expect, it } from "vitest";

import { findUnshimmedSources } from "../../scripts/esm-shim-guard.mjs";

const SHIMMED = `
import path from "node:path";
import { fileURLToPath } from "node:url";
const getFilename = () => fileURLToPath(import.meta.url);
const getDirname = () => path.dirname(getFilename());
const __dirname = /* @__PURE__ */ getDirname();
const asset = path.join(__dirname, "assets", "preview.html");
`;

const UNSHIMMED = `
import path from "path";
const asset = path.join(__dirname, "assets", "preview.html");
`;

const NO_DIRNAME = `
export const add = (a, b) => a + b;
`;

describe("findUnshimmedSources", () => {
  it("flags a source that references __dirname without defining it", () => {
    const result = findUnshimmedSources([{ path: "index.mjs", content: UNSHIMMED }]);
    expect(result).toEqual(["index.mjs"]);
  });

  it("passes a source whose __dirname reference is backed by a shim definition", () => {
    const result = findUnshimmedSources([{ path: "index.mjs", content: SHIMMED }]);
    expect(result).toEqual([]);
  });

  it("passes a source that never references __dirname", () => {
    const result = findUnshimmedSources([{ path: "util.mjs", content: NO_DIRNAME }]);
    expect(result).toEqual([]);
  });

  it("reports only the offending files among a mixed set", () => {
    const result = findUnshimmedSources([
      { path: "a.mjs", content: SHIMMED },
      { path: "b.mjs", content: UNSHIMMED },
      { path: "c.mjs", content: NO_DIRNAME },
    ]);
    expect(result).toEqual(["b.mjs"]);
  });
});
