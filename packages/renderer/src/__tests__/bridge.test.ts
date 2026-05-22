import { describe, expect, it, vi } from "vitest";

// Mock Electron and the native core so we can import bridge.ts in node tests.
// `buildBrowserWindowOptions` is a pure function, but the module-level
// `import { app, BrowserWindow } from "electron"` would otherwise pull the
// real native module.
vi.mock("electron", () => ({
  app: { isReady: () => true },
  BrowserWindow: class MockBrowserWindow {},
  screen: {
    getPrimaryDisplay: () => ({ scaleFactor: 1 }),
  },
}));

vi.mock("@napolab/texture-bridge-core", () => ({
  TextureSender: class MockTextureSender {},
  sendTextureFromPaintEvent: vi.fn(),
}));

import { buildBrowserWindowOptions, computeDipSize } from "../bridge";
import type { TextureBridgeOptions } from "../types";

const baseOpts: TextureBridgeOptions = {
  name: "test",
  width: 1920,
  height: 1080,
  rendererUrl: "file:///renderer.html",
};

describe("buildBrowserWindowOptions", () => {
  it("forwards width and height to the BrowserWindow constructor args", () => {
    const out = buildBrowserWindowOptions({ ...baseOpts, width: 1280, height: 720 });
    expect(out.width).toBe(1280);
    expect(out.height).toBe(720);
  });

  it("creates a hidden offscreen window with sharedTexture by default", () => {
    const out = buildBrowserWindowOptions(baseOpts);
    expect(out.show).toBe(false);
    expect(out.webPreferences?.contextIsolation).toBe(true);
    expect(out.webPreferences?.nodeIntegration).toBe(false);
    // `offscreen.useSharedTexture` is the contract Electron 40+ requires
    // for the GPU zero-copy paint event path.
    expect(out.webPreferences?.offscreen).toEqual({ useSharedTexture: true });
  });

  it("does not enable transparent by default", () => {
    const out = buildBrowserWindowOptions(baseOpts);
    expect(out.transparent).toBeUndefined();
    expect(out.backgroundColor).toBeUndefined();
  });

  it("sets transparent + alpha-zero backgroundColor when includeAlpha: true", () => {
    // The compositor only emits per-pixel alpha into the OSR shared texture
    // when both flags are set on the BrowserWindow. transparent:true alone
    // leaves Chromium painting an opaque backdrop; backgroundColor with the
    // alpha byte zero is what flips the initial fill to fully-transparent.
    const out = buildBrowserWindowOptions({ ...baseOpts, includeAlpha: true });
    expect(out.transparent).toBe(true);
    expect(out.backgroundColor).toBe("#00000000");
  });

  it("treats includeAlpha: false the same as omitted", () => {
    const out = buildBrowserWindowOptions({ ...baseOpts, includeAlpha: false });
    expect(out.transparent).toBeUndefined();
    expect(out.backgroundColor).toBeUndefined();
  });

  it("preserves caller-supplied webPreferences (merge over the offscreen base)", () => {
    const out = buildBrowserWindowOptions({
      ...baseOpts,
      webPreferences: { backgroundThrottling: false },
    });
    expect(out.webPreferences?.backgroundThrottling).toBe(false);
    expect(out.webPreferences?.offscreen).toEqual({ useSharedTexture: true });
  });

  it("lets caller-supplied webPreferences override the base defaults", () => {
    // Documents the existing override behavior in createTextureBridge so we
    // do not silently regress when refactoring the helper.
    const out = buildBrowserWindowOptions({
      ...baseOpts,
      webPreferences: { contextIsolation: false },
    });
    expect(out.webPreferences?.contextIsolation).toBe(false);
  });

  it("does not set enableLargerThanScreen by default", () => {
    const out = buildBrowserWindowOptions(baseOpts);
    expect(out.enableLargerThanScreen).toBeUndefined();
  });

  it("sets enableLargerThanScreen when pixelExact: true", () => {
    // `enableLargerThanScreen` is the documented escape hatch for letting
    // an offscreen BrowserWindow render at a DIP size that may exceed the
    // host display's work area. This is required when the caller has
    // pre-translated a large pixel target into DIP via `computeDipSize`
    // and the resulting DIP is still larger than the display's available
    // area (rare, but possible on small / low-DPR monitors).
    const out = buildBrowserWindowOptions({ ...baseOpts, pixelExact: true });
    expect(out.enableLargerThanScreen).toBe(true);
  });

  it("treats pixelExact: false the same as omitted", () => {
    const out = buildBrowserWindowOptions({ ...baseOpts, pixelExact: false });
    expect(out.enableLargerThanScreen).toBeUndefined();
  });
});

describe("computeDipSize", () => {
  it("returns the input unchanged when scaleFactor is 1", () => {
    expect(computeDipSize(1920, 1080, 1)).toEqual({ width: 1920, height: 1080 });
  });

  it("halves the input at scaleFactor 2 (e.g., macOS Retina)", () => {
    expect(computeDipSize(1920, 1080, 2)).toEqual({ width: 960, height: 540 });
  });

  it("rounds to the nearest integer for non-divisible ratios", () => {
    // 1920 / 1.75 = 1097.142857... → round to 1097
    // 1080 / 1.75 =  617.142857... → round to 617
    // Chromium typically computes framebuffer = round(DIP × scaleFactor),
    // so 1097 × 1.75 = 1919.75 → 1920 px, which matches the requested target.
    expect(computeDipSize(1920, 1080, 1.75)).toEqual({ width: 1097, height: 617 });
  });

  it("handles fractional scaleFactor 1.5 with no rounding loss", () => {
    // 1920 / 1.5 = 1280 exactly; 1080 / 1.5 = 720 exactly.
    expect(computeDipSize(1920, 1080, 1.5)).toEqual({ width: 1280, height: 720 });
  });

  it("clamps minimum DIP to 1 to prevent zero-sized windows", () => {
    // A 4 × 4 pixel target on a hypothetical 5x display would round to 0
    // without the floor — passing 0 to BrowserWindow's width/height would
    // trigger a runtime error rather than silently producing a usable
    // window.
    expect(computeDipSize(4, 4, 5)).toEqual({ width: 1, height: 1 });
  });

  it("falls back to pixel size when scaleFactor is zero or negative", () => {
    // Defensive — Electron should never return a non-positive scaleFactor
    // from `screen.getPrimaryDisplay()`, but division by zero would produce
    // Infinity and crash the BrowserWindow constructor.
    expect(computeDipSize(1920, 1080, 0)).toEqual({ width: 1920, height: 1080 });
    expect(computeDipSize(1920, 1080, -1)).toEqual({ width: 1920, height: 1080 });
  });
});
