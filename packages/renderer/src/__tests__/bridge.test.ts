import { describe, expect, it, vi } from "vitest";

// Mock Electron and the native core so we can import bridge.ts in node tests.
// `buildBrowserWindowOptions` is a pure function, but the module-level
// `import { app, BrowserWindow } from "electron"` would otherwise pull the
// real native module.
const getPrimaryDisplayMock = vi.fn(() => ({ scaleFactor: 1 }));

vi.mock("electron", () => ({
  app: { isReady: () => true },
  BrowserWindow: class MockBrowserWindow {
    setSize = vi.fn();
    isDestroyed(): boolean {
      return false;
    }
    close(): void {}
  },
  screen: {
    getPrimaryDisplay: () => getPrimaryDisplayMock(),
  },
}));

vi.mock("@napolab/texture-bridge-core", () => ({
  TextureSender: class MockTextureSender {
    stop(): void {}
  },
  sendTextureFromPaintEvent: vi.fn(),
}));

import {
  buildBrowserWindowOptions,
  computeDipSize,
  resolveElectronMajor,
  resolveOsrScalePolicy,
  resolveWindowDipSize,
  TextureBridgeImpl,
} from "../bridge";
import { BrowserWindow } from "electron";
import { TextureSender, sendTextureFromPaintEvent } from "@napolab/texture-bridge-core";
import type { PaintDefect, PaintTexture } from "@napolab/texture-bridge-core";
import type { TextureBridgeOptions } from "../types";
import type { PreviewManager } from "../preview-manager";

const baseOpts: TextureBridgeOptions = {
  name: "test",
  width: 1920,
  height: 1080,
  rendererUrl: "file:///renderer.html",
};

describe("buildBrowserWindowOptions", () => {
  it("forwards width and height to the BrowserWindow constructor args", () => {
    const out = buildBrowserWindowOptions(
      { ...baseOpts, width: 1280, height: 720 },
      "device-scale",
    );
    expect(out.width).toBe(1280);
    expect(out.height).toBe(720);
  });

  it("creates a hidden offscreen window with sharedTexture by default", () => {
    const out = buildBrowserWindowOptions(baseOpts, "device-scale");
    expect(out.show).toBe(false);
    expect(out.webPreferences?.contextIsolation).toBe(true);
    expect(out.webPreferences?.nodeIntegration).toBe(false);
    // `offscreen.useSharedTexture` is the contract Electron 40+ requires
    // for the GPU zero-copy paint event path.
    expect(out.webPreferences?.offscreen).toEqual({ useSharedTexture: true });
  });

  it("does not enable transparent by default", () => {
    const out = buildBrowserWindowOptions(baseOpts, "device-scale");
    expect(out.transparent).toBeUndefined();
    expect(out.backgroundColor).toBeUndefined();
  });

  it("sets transparent + alpha-zero backgroundColor when includeAlpha: true", () => {
    // The compositor only emits per-pixel alpha into the OSR shared texture
    // when both flags are set on the BrowserWindow. transparent:true alone
    // leaves Chromium painting an opaque backdrop; backgroundColor with the
    // alpha byte zero is what flips the initial fill to fully-transparent.
    const out = buildBrowserWindowOptions({ ...baseOpts, includeAlpha: true }, "device-scale");
    expect(out.transparent).toBe(true);
    expect(out.backgroundColor).toBe("#00000000");
  });

  it("treats includeAlpha: false the same as omitted", () => {
    const out = buildBrowserWindowOptions({ ...baseOpts, includeAlpha: false }, "device-scale");
    expect(out.transparent).toBeUndefined();
    expect(out.backgroundColor).toBeUndefined();
  });

  it("preserves caller-supplied webPreferences (merge over the offscreen base)", () => {
    const out = buildBrowserWindowOptions(
      {
        ...baseOpts,
        webPreferences: { backgroundThrottling: false },
      },
      "device-scale",
    );
    expect(out.webPreferences?.backgroundThrottling).toBe(false);
    expect(out.webPreferences?.offscreen).toEqual({ useSharedTexture: true });
  });

  it("lets caller-supplied webPreferences override the base defaults", () => {
    // Documents the existing override behavior in createTextureBridge so we
    // do not silently regress when refactoring the helper.
    const out = buildBrowserWindowOptions(
      {
        ...baseOpts,
        webPreferences: { contextIsolation: false },
      },
      "device-scale",
    );
    expect(out.webPreferences?.contextIsolation).toBe(false);
  });

  it("does not set enableLargerThanScreen by default", () => {
    const out = buildBrowserWindowOptions(baseOpts, "device-scale");
    expect(out.enableLargerThanScreen).toBeUndefined();
  });

  it("sets enableLargerThanScreen when pixelExact: true", () => {
    // `enableLargerThanScreen` is the documented escape hatch for letting
    // an offscreen BrowserWindow render at a DIP size that may exceed the
    // host display's work area. This is required when the caller has
    // pre-translated a large pixel target into DIP via `computeDipSize`
    // and the resulting DIP is still larger than the display's available
    // area (rare, but possible on small / low-DPR monitors).
    const out = buildBrowserWindowOptions({ ...baseOpts, pixelExact: true }, "device-scale");
    expect(out.enableLargerThanScreen).toBe(true);
  });

  it("treats pixelExact: false the same as omitted", () => {
    const out = buildBrowserWindowOptions({ ...baseOpts, pixelExact: false }, "device-scale");
    expect(out.enableLargerThanScreen).toBeUndefined();
  });
});

describe("buildBrowserWindowOptions — OSR scale policy", () => {
  it("pins offscreen.deviceScaleFactor to 1 under unit-scale", () => {
    const out = buildBrowserWindowOptions(baseOpts, "unit-scale");
    expect(out.webPreferences?.offscreen).toEqual({ useSharedTexture: true, deviceScaleFactor: 1 });
  });

  it("does not set deviceScaleFactor under device-scale", () => {
    const out = buildBrowserWindowOptions(baseOpts, "device-scale");
    expect(out.webPreferences?.offscreen).toEqual({ useSharedTexture: true });
  });

  it("always enables enableLargerThanScreen under unit-scale", () => {
    const out = buildBrowserWindowOptions(baseOpts, "unit-scale");
    expect(out.enableLargerThanScreen).toBe(true);
  });

  it("keeps enableLargerThanScreen gated on pixelExact under device-scale", () => {
    expect(
      buildBrowserWindowOptions(baseOpts, "device-scale").enableLargerThanScreen,
    ).toBeUndefined();
    expect(
      buildBrowserWindowOptions({ ...baseOpts, pixelExact: true }, "device-scale")
        .enableLargerThanScreen,
    ).toBe(true);
  });

  it("lets a user-supplied webPreferences.offscreen win entirely", () => {
    // `deviceScaleFactor` was added to Electron's `Offscreen` type in 41; the
    // workspace's installed Electron types are 40.x, so a fresh object
    // literal directly in the `offscreen` position would fail the excess
    // property check (TS2353) even though it is a valid runtime value on
    // Electron >= 41. Binding it to a named const first sidesteps the
    // literal-only excess property check without weakening the assertion.
    const userOffscreen = { useSharedTexture: true, deviceScaleFactor: 2 };
    const out = buildBrowserWindowOptions(
      {
        ...baseOpts,
        webPreferences: { offscreen: userOffscreen },
      },
      "unit-scale",
    );
    expect(out.webPreferences?.offscreen).toEqual({ useSharedTexture: true, deviceScaleFactor: 2 });
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

describe("TextureBridgeImpl.handlePaint — frameDropped", () => {
  const sendMock = vi.mocked(sendTextureFromPaintEvent);

  const makeBridge = () =>
    new TextureBridgeImpl(new BrowserWindow(), new TextureSender("t", 16, 9), null, baseOpts);

  const makeTexture = () => ({
    textureInfo: {
      pixelFormat: "bgra" as const,
      codedSize: { width: 16, height: 9 },
      visibleRect: { x: 0, y: 0, width: 16, height: 9 },
      handle: {},
    },
    release: vi.fn(),
  });

  const collectDropped = (bridge: TextureBridgeImpl) => {
    const dropped: PaintDefect[] = [];
    bridge.on("frameDropped", (defect) => {
      dropped.push(defect);
    });
    return dropped;
  };

  it("emits a no-texture defect when the paint event has no texture", () => {
    sendMock.mockReset();
    const bridge = makeBridge();
    const dropped = collectDropped(bridge);

    bridge.handlePaint({ texture: undefined });

    expect(dropped).toEqual([{ reason: "no-texture" }]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("emits the defect returned by sendTextureFromPaintEvent and still releases the texture", () => {
    sendMock.mockReset();
    sendMock.mockReturnValue({ reason: "no-nt-handle" });
    const bridge = makeBridge();
    const dropped = collectDropped(bridge);
    const texture = makeTexture();

    bridge.handlePaint({ texture });

    expect(dropped).toEqual([{ reason: "no-nt-handle" }]);
    expect(texture.release).toHaveBeenCalledTimes(1);
  });

  it("dedupes consecutive defects with the same reason", () => {
    sendMock.mockReset();
    sendMock.mockReturnValue({ reason: "no-nt-handle" });
    const bridge = makeBridge();
    const dropped = collectDropped(bridge);

    bridge.handlePaint({ texture: makeTexture() });
    bridge.handlePaint({ texture: makeTexture() });
    bridge.handlePaint({ texture: makeTexture() });

    expect(dropped).toEqual([{ reason: "no-nt-handle" }]);
  });

  it("re-emits after a successful send resets the dedupe state", () => {
    sendMock.mockReset();
    const bridge = makeBridge();
    const dropped = collectDropped(bridge);

    sendMock.mockReturnValue({ reason: "no-nt-handle" });
    bridge.handlePaint({ texture: makeTexture() });

    sendMock.mockReturnValue(undefined);
    bridge.handlePaint({ texture: makeTexture() });

    sendMock.mockReturnValue({ reason: "no-nt-handle" });
    bridge.handlePaint({ texture: makeTexture() });

    expect(dropped).toEqual([{ reason: "no-nt-handle" }, { reason: "no-nt-handle" }]);
  });

  it("emits immediately when the defect reason changes", () => {
    sendMock.mockReset();
    const bridge = makeBridge();
    const dropped = collectDropped(bridge);

    sendMock.mockReturnValue({ reason: "no-nt-handle" });
    bridge.handlePaint({ texture: makeTexture() });

    sendMock.mockReturnValue({ reason: "no-io-surface" });
    bridge.handlePaint({ texture: makeTexture() });

    expect(dropped).toEqual([{ reason: "no-nt-handle" }, { reason: "no-io-surface" }]);
  });

  it("does not emit frameDropped on a successful send", () => {
    sendMock.mockReset();
    sendMock.mockReturnValue(undefined);
    const bridge = makeBridge();
    const dropped = collectDropped(bridge);
    const texture = makeTexture();

    bridge.handlePaint({ texture });

    expect(dropped).toEqual([]);
    expect(texture.release).toHaveBeenCalledTimes(1);
  });

  it("exposes the latched drop reason via droppedReason", () => {
    sendMock.mockReset();
    const bridge = makeBridge();
    expect(bridge.droppedReason).toBeNull();

    sendMock.mockReturnValue({ reason: "no-nt-handle" });
    bridge.handlePaint({ texture: makeTexture() });
    expect(bridge.droppedReason).toBe("no-nt-handle");

    sendMock.mockReturnValue(undefined);
    bridge.handlePaint({ texture: makeTexture() });
    expect(bridge.droppedReason).toBeNull();
  });

  it("releases a texture that arrives without textureInfo", () => {
    sendMock.mockReset();
    const bridge = makeBridge();
    const dropped = collectDropped(bridge);
    const release = vi.fn();
    // The runtime guard exists precisely because Electron can deliver a
    // texture without textureInfo — a state PaintTexture's type cannot
    // express, hence the two-step cast.
    const defective: unknown = { release };
    bridge.handlePaint({ texture: defective as PaintTexture });

    expect(release).toHaveBeenCalledTimes(1);
    expect(dropped).toEqual([{ reason: "no-texture" }]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("drops a post-dispose paint without emitting frameDropped or mutating droppedReason", () => {
    // Once disposed, the underlying sender has been stopped — calling into it
    // would throw for every in-flight paint. The guard must run before the
    // no-texture branch too, since a post-dispose paint can still arrive
    // without a texture and would otherwise latch a spurious drop reason.
    sendMock.mockReset();
    const bridge = makeBridge();
    bridge.dispose();
    // Attach the listener after dispose() — dispose() calls
    // removeAllListeners(), so a listener added beforehand would not observe
    // any (incorrect) emission and the assertion would be a false negative.
    const dropped = collectDropped(bridge);
    const texture = makeTexture();

    bridge.handlePaint({ texture });

    expect(dropped).toEqual([]);
    expect(bridge.droppedReason).toBeNull();
    expect(texture.release).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("still forwards the frame to the preview manager on a defect", () => {
    sendMock.mockReset();
    sendMock.mockReturnValue({ reason: "no-nt-handle" });
    const sendFrame = vi.fn();
    // PreviewManager has private fields, so a structural stub cannot satisfy
    // its class type — the two-step cast injects the test double.
    const previewStub: unknown = { sendFrame };
    const bridge = new TextureBridgeImpl(
      new BrowserWindow(),
      new TextureSender("t", 16, 9),
      previewStub as PreviewManager,
      baseOpts,
    );
    const texture = makeTexture();

    bridge.handlePaint({ texture });

    expect(sendFrame).toHaveBeenCalledTimes(1);
    expect(sendFrame).toHaveBeenCalledWith(texture);
  });
});

describe("resolveElectronMajor", () => {
  it("parses the major version from a semver string", () => {
    expect(resolveElectronMajor({ electron: "42.4.0" })).toBe(42);
    expect(resolveElectronMajor({ electron: "40.2.1" })).toBe(40);
  });

  it("returns 0 when the electron version is missing or malformed", () => {
    expect(resolveElectronMajor({})).toBe(0);
    expect(resolveElectronMajor({ electron: "garbage" })).toBe(0);
  });
});

describe("resolveOsrScalePolicy", () => {
  it("selects device-scale for Electron 40 and below", () => {
    expect(resolveOsrScalePolicy(40)).toBe("device-scale");
    expect(resolveOsrScalePolicy(0)).toBe("device-scale");
  });

  it("selects unit-scale for Electron 41 and above", () => {
    expect(resolveOsrScalePolicy(41)).toBe("unit-scale");
    expect(resolveOsrScalePolicy(42)).toBe("unit-scale");
  });
});

describe("resolveWindowDipSize", () => {
  it("returns width/height untouched under unit-scale, even with pixelExact", () => {
    const size = resolveWindowDipSize(
      { width: 1920, height: 1080, pixelExact: true },
      "unit-scale",
      2,
    );
    expect(size).toEqual({ width: 1920, height: 1080 });
  });

  it("divides by scaleFactor under device-scale when pixelExact is set", () => {
    const size = resolveWindowDipSize(
      { width: 1920, height: 1080, pixelExact: true },
      "device-scale",
      2,
    );
    expect(size).toEqual({ width: 960, height: 540 });
  });

  it("returns width/height untouched under device-scale without pixelExact", () => {
    const size = resolveWindowDipSize({ width: 1920, height: 1080 }, "device-scale", 2);
    expect(size).toEqual({ width: 1920, height: 1080 });
  });
});

describe("TextureBridgeImpl.resize — OSR scale policy", () => {
  const makeBridgeWithPolicy = (
    policy: "device-scale" | "unit-scale",
    opts: TextureBridgeOptions,
  ) =>
    new TextureBridgeImpl(new BrowserWindow(), new TextureSender("t", 16, 9), null, opts, policy);

  it("sets the window to the raw pixel size under unit-scale even with pixelExact", () => {
    getPrimaryDisplayMock.mockReturnValue({ scaleFactor: 2 });
    const bridge = makeBridgeWithPolicy("unit-scale", { ...baseOpts, pixelExact: true });

    bridge.resize(1280, 720);

    expect(bridge.renderWindow.setSize).toHaveBeenCalledWith(1280, 720);
  });

  it("divides the window size by scaleFactor under device-scale with pixelExact", () => {
    getPrimaryDisplayMock.mockReturnValue({ scaleFactor: 2 });
    const bridge = makeBridgeWithPolicy("device-scale", { ...baseOpts, pixelExact: true });

    bridge.resize(1280, 720);

    expect(bridge.renderWindow.setSize).toHaveBeenCalledWith(640, 360);
  });
});
