import { describe, expect, it, vi } from "vitest";

// Mock Electron and the native core so we can import bridge.ts in node tests.
// `buildBrowserWindowOptions` is a pure function, but the module-level
// `import { app, BrowserWindow } from "electron"` would otherwise pull the
// real native module.
vi.mock("electron", () => ({
  app: { isReady: () => true },
  BrowserWindow: class MockBrowserWindow {},
}));

vi.mock("@napolab/texture-bridge-core", () => ({
  TextureSender: class MockTextureSender {},
  sendTextureFromPaintEvent: vi.fn(),
}));

import { buildBrowserWindowOptions } from "../bridge";
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
});
