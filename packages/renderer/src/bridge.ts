import { EventEmitter } from "events";
import { app, BrowserWindow, screen, type Event } from "electron";
import {
  TextureSender,
  sendTextureFromPaintEvent,
  type PaintTexture,
  type PaintDefect,
} from "@napolab/texture-bridge-core";
import { PreviewManager } from "./preview-manager";
import { FpsCounter } from "./fps-counter";
import type { TextureBridgeOptions, TextureBridge } from "./types";

/**
 * Convert a pixel-space size to a device-independent (DIP) size for a given
 * display scaleFactor. Used when `pixelExact: true` is set so the offscreen
 * BrowserWindow's DIP size produces the requested framebuffer pixel count.
 *
 * Math.round (rather than floor / ceil) minimizes the rounding error when the
 * scaleFactor does not divide the pixel size evenly (e.g., 1920 / 1.75 =
 * 1097.14 → 1097 → 1097 × 1.75 = 1919.75, which Chromium typically rounds
 * back to 1920).
 */
export function computeDipSize(
  pixelWidth: number,
  pixelHeight: number,
  scaleFactor: number,
): { width: number; height: number } {
  if (scaleFactor <= 0) {
    return { width: Math.max(1, pixelWidth), height: Math.max(1, pixelHeight) };
  }
  return {
    width: Math.max(1, Math.round(pixelWidth / scaleFactor)),
    height: Math.max(1, Math.round(pixelHeight / scaleFactor)),
  };
}

/**
 * How the OSR compositor maps the window's DIP size to the shared-texture
 * pixel size.
 *
 * - `"device-scale"` (Electron ≤ 40): the paint framebuffer is
 *   `DIP × display.scaleFactor`, and `webPreferences.offscreen.deviceScaleFactor`
 *   is ignored — `pixelExact` must pre-divide the window size to hit an exact
 *   pixel count.
 * - `"unit-scale"` (Electron ≥ 41): `offscreen.deviceScaleFactor` is honored
 *   (and defaults to 1.0 from Electron 42), so we pin it to 1 and DIP == px
 *   holds deterministically — no DIP division, `pixelExact` is trivially
 *   satisfied.
 *
 * Empirical basis: reports/2026-08-11-pixelexact-osr-scale-investigation.md
 * (measured on Electron 40.2.1 / 41.10.4 / 42.4.0, macOS Retina scaleFactor 2).
 */
export type OsrScalePolicy = "device-scale" | "unit-scale";

/** Parse the Electron major version; 0 when missing or malformed. */
export const resolveElectronMajor = (versions: { electron?: string }): number => {
  const [major] = (versions.electron ?? "").split(".");
  const parsed = parseInt(major ?? "", 10);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** `offscreen.deviceScaleFactor` exists (and is honored) from Electron 41. */
export const resolveOsrScalePolicy = (electronMajor: number): OsrScalePolicy =>
  electronMajor >= 41 ? "unit-scale" : "device-scale";

/**
 * Window DIP size for the requested pixel size under the given policy.
 * Under unit-scale DIP == px, so the size passes through; under device-scale
 * only `pixelExact` pre-divides by the display scaleFactor (legacy behavior).
 */
export const resolveWindowDipSize = (
  options: Pick<TextureBridgeOptions, "width" | "height" | "pixelExact">,
  policy: OsrScalePolicy,
  scaleFactor: number,
): { width: number; height: number } => {
  if (policy === "unit-scale") return { width: options.width, height: options.height };
  if (options.pixelExact === true)
    return computeDipSize(options.width, options.height, scaleFactor);
  return { width: options.width, height: options.height };
};

interface PaintEvent extends Event {
  texture?: PaintTexture;
}

/**
 * Injectable constructors for {@link createTextureBridgeWith}. Lets tests and
 * embedders swap the BrowserWindow / native sender without faking Electron
 * globals (the pattern consumers previously built themselves as
 * `createDeckWith(createBridge)`).
 */
export interface TextureBridgeDeps {
  createWindow: (options: Electron.BrowserWindowConstructorOptions) => BrowserWindow;
  createSender: (name: string, width: number, height: number) => InstanceType<typeof TextureSender>;
}

/** Exported for unit tests — not part of the package's public entry point. */
export class TextureBridgeImpl extends EventEmitter implements TextureBridge {
  private _renderWindow: BrowserWindow;
  private sender: InstanceType<typeof TextureSender>;
  private previewManager: PreviewManager | null;
  private fpsCounter = new FpsCounter();
  private _disposed = false;
  private lastDropReason: PaintDefect["reason"] | null = null;
  private options: TextureBridgeOptions;
  private readonly policy: OsrScalePolicy;
  private readonly createSender: TextureBridgeDeps["createSender"];

  constructor(
    renderWindow: BrowserWindow,
    sender: InstanceType<typeof TextureSender>,
    previewManager: PreviewManager | null,
    options: TextureBridgeOptions,
    policy: OsrScalePolicy = resolveOsrScalePolicy(resolveElectronMajor(process.versions)),
    createSender: TextureBridgeDeps["createSender"] = (name, width, height) =>
      new TextureSender(name, width, height),
  ) {
    super();
    this._renderWindow = renderWindow;
    this.sender = sender;
    this.previewManager = previewManager;
    this.options = options;
    this.policy = policy;
    this.createSender = createSender;
  }

  get renderWindow(): BrowserWindow {
    return this._renderWindow;
  }

  get previewWindow(): BrowserWindow | null {
    return this.previewManager?.window ?? null;
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  get droppedReason(): PaintDefect["reason"] | null {
    return this.lastDropReason;
  }

  /** Emit `frameDropped`, deduping consecutive drops with the same reason. */
  private emitFrameDropped(defect: PaintDefect): void {
    if (defect.reason === this.lastDropReason) return;
    this.lastDropReason = defect.reason;
    this.emit("frameDropped", defect);
  }

  /** Handle a paint event from the offscreen BrowserWindow. */
  handlePaint(event: { texture?: PaintTexture }): void {
    const texture = event.texture;
    // If we've been disposed between the paint event and this callback, the
    // underlying sender has been stopped and calling into it would throw
    // "TextureSender has been stopped" for every in-flight paint. Drop the
    // texture cleanly instead of emitting a stream of teardown errors.
    if (this._disposed) {
      texture?.release?.();
      return;
    }

    if (!texture?.textureInfo) {
      texture?.release?.();
      this.emitFrameDropped({ reason: "no-texture" });
      return;
    }

    try {
      const defect = sendTextureFromPaintEvent(this.sender, texture.textureInfo);
      if (defect === undefined) {
        this.lastDropReason = null;
      } else {
        this.emitFrameDropped(defect);
      }
      this.previewManager?.sendFrame(texture);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
    } finally {
      texture.release?.();
    }

    if (this._disposed) return;
    const fps = this.fpsCounter.tick();
    if (fps !== null) {
      this.emit("fps", fps);
    }
  }

  openPreview(): void {
    if (this._disposed) return;
    if (!this.previewManager) {
      this.previewManager = new PreviewManager(
        this.options.width,
        this.options.height,
        this.options.preview,
      );
    }
    this.previewManager.open();
  }

  closePreview(): void {
    this.previewManager?.close();
  }

  resize(width: number, height: number): void {
    if (this._disposed) return;

    const prevOpts = this.options;
    this.options = { ...this.options, width, height };

    // 1. Resize offscreen BrowserWindow. Under `"unit-scale"` DIP == px, so the
    //    requested size passes through; under `"device-scale"` `pixelExact`
    //    pre-divides by the primary display's scaleFactor.
    const dip = resolveWindowDipSize(
      this.options,
      this.policy,
      screen.getPrimaryDisplay().scaleFactor,
    );
    this._renderWindow.setSize(dip.width, dip.height);

    // 2. Recreate native sender with new dimensions.
    //    Must stop the old sender first — Spout requires unique sender names.
    //    Sender always stays in pixel-space regardless of pixelExact.
    //    If the new sender fails, restore one with the original dimensions.
    this.sender.stop();
    try {
      this.sender = this.createSender(this.options.name, width, height);
    } catch (err) {
      this.options = prevOpts;
      const prevDip = resolveWindowDipSize(
        prevOpts,
        this.policy,
        screen.getPrimaryDisplay().scaleFactor,
      );
      this._renderWindow.setSize(prevDip.width, prevDip.height);
      this.sender = this.createSender(prevOpts.name, prevOpts.width, prevOpts.height);
      throw err;
    }

    // 3. Update preview canvas size
    this.previewManager?.updateSize(width, height);

    this.emit("resize", width, height);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    // Destroy the offscreen window synchronously. `close()` is async and
    // cancellable — it loses the race against `before-quit`, letting Chromium
    // SIGKILL the OSR renderer and pop a crash dialog. Both known consumers
    // independently worked around this by forcing `destroy()`; a hidden
    // offscreen window has no user-facing close semantics to honor.
    if (!this._renderWindow.isDestroyed()) {
      this._renderWindow.destroy();
    }

    this.sender.stop();
    this.previewManager?.dispose();
    this.previewManager = null;

    this.emit("disposed");
    this.removeAllListeners();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/**
 * Build the BrowserWindow constructor options for the offscreen renderer.
 *
 * Extracted as a pure function so it can be unit tested without touching
 * Electron's native module — the actual `new BrowserWindow(...)` call lives
 * in `createTextureBridge`.
 *
 * `options.includeAlpha` flips the OSR pipeline into alpha-preserving mode:
 * `transparent: true` plus `backgroundColor: "#00000000"` on the BrowserWindow
 * is the documented recipe for Chromium to emit per-pixel alpha into the
 * shared texture. The page itself must use a transparent background
 * (`html, body { background: transparent }`) for the alpha to mean anything.
 *
 * `policy` selects the `offscreen` prefs and `enableLargerThanScreen` gating:
 * under `"unit-scale"` `deviceScaleFactor` is pinned to 1 and
 * `enableLargerThanScreen` is always set (the DIP size equals the requested
 * pixel size, which may exceed the display's work area); under
 * `"device-scale"` behavior is unchanged from before this option existed.
 */
export function buildBrowserWindowOptions(
  options: TextureBridgeOptions,
  policy: OsrScalePolicy,
): Electron.BrowserWindowConstructorOptions {
  const { width, height, webPreferences, includeAlpha, pixelExact } = options;

  const offscreen =
    policy === "unit-scale"
      ? { useSharedTexture: true, deviceScaleFactor: 1 }
      : { useSharedTexture: true };
  const largerThanScreen = policy === "unit-scale" || pixelExact === true;

  return {
    width,
    height,
    show: false,
    // `enableLargerThanScreen` is documented as macOS-only but is harmless on
    // other platforms. Under unit-scale the DIP size equals the requested pixel
    // size — which may exceed the display work area — so it is always set;
    // under device-scale it is set only when `pixelExact` requests it.
    ...(largerThanScreen ? { enableLargerThanScreen: true } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      offscreen,
      ...webPreferences,
    },
    // Hex `#RRGGBBAA` with alpha=0x00 is the explicit "fully transparent
    // backdrop" signal Chromium honors on offscreen render surfaces. The
    // `transparent: true` flag alone leaves the compositor painting opaque,
    // so both keys must be applied together.
    ...(includeAlpha ? { transparent: true, backgroundColor: "#00000000" } : {}),
  };
}

/**
 * Create a fully-wired texture bridge: offscreen window, native sender,
 * optional preview, and FPS tracking.
 *
 * Must be called after `app.whenReady()`.
 */
export const createTextureBridgeWith =
  (deps: TextureBridgeDeps) =>
  async (options: TextureBridgeOptions): Promise<TextureBridge> => {
    if (!app.isReady()) {
      throw new Error("createTextureBridge() must be called after app.whenReady()");
    }

    const { name, width, height, frameRate = 60, rendererUrl, preview } = options;

    const policy = resolveOsrScalePolicy(resolveElectronMajor(process.versions));

    // ---- Offscreen BrowserWindow ----
    // Window DIP size per the OSR scale policy: under unit-scale DIP == px so the
    // requested size passes through; under device-scale (Electron ≤ 40) pixelExact
    // pre-divides by the primary display's scaleFactor. The sender below always
    // uses pixel-space dimensions.
    const dip = resolveWindowDipSize(options, policy, screen.getPrimaryDisplay().scaleFactor);
    const renderWindow = deps.createWindow(
      buildBrowserWindowOptions({ ...options, ...dip }, policy),
    );

    // ---- Native sender ----
    const sender = deps.createSender(name, width, height);

    // ---- Preview ----
    let previewManager: PreviewManager | null = null;
    if (preview?.enabled !== false && preview) {
      previewManager = new PreviewManager(width, height, preview);
      previewManager.open();
    }

    // ---- Bridge instance ----
    const bridge = new TextureBridgeImpl(
      renderWindow,
      sender,
      previewManager,
      options,
      policy,
      deps.createSender,
    );

    // ---- Paint handler (delegates to instance method, no private field access) ----
    renderWindow.webContents.on("paint", (event: PaintEvent) => {
      bridge.handlePaint(event);
    });

    renderWindow.webContents.setFrameRate(frameRate);

    // ---- Load renderer URL ----
    if (rendererUrl.startsWith("http://") || rendererUrl.startsWith("https://")) {
      await renderWindow.loadURL(rendererUrl);
    } else if (rendererUrl.startsWith("file://")) {
      await renderWindow.loadURL(rendererUrl);
    } else {
      await renderWindow.loadFile(rendererUrl);
    }

    bridge.emit("ready");

    return bridge;
  };

/** {@link createTextureBridgeWith} bound to the real BrowserWindow / TextureSender. */
export const createTextureBridge = createTextureBridgeWith({
  createWindow: (options) => new BrowserWindow(options),
  createSender: (name, width, height) => new TextureSender(name, width, height),
});
