import type { BrowserWindow } from "electron";
import type { PaintDefect } from "@napolab/texture-bridge-core";

/** Options for the preview window */
export interface PreviewOptions {
  enabled?: boolean;
  width?: number;
  height?: number;
  title?: string;
}

/** Options for createTextureBridge() */
export interface TextureBridgeOptions {
  /** Syphon/Spout sender name visible to VJ software */
  name: string;
  /** Texture width in pixels */
  width: number;
  /** Texture height in pixels */
  height: number;
  /** Target frame rate (default: 60) */
  frameRate?: number;
  /** URL to load in the offscreen renderer (file:// or http://) */
  rendererUrl: string;
  /** Preview window options */
  preview?: PreviewOptions;
  /** Additional webPreferences for the offscreen BrowserWindow */
  webPreferences?: Electron.WebPreferences;
  /**
   * Include the page's alpha channel in the captured texture (default: false).
   *
   * When true, the offscreen BrowserWindow is created with `transparent: true`
   * and a fully-transparent backgroundColor so Chromium's compositor preserves
   * per-pixel alpha into the BGRA shared texture. The page (or its body / root
   * elements) must use a transparent background — opaque CSS will overwrite
   * the alpha and produce a fully-opaque output regardless of this flag.
   *
   * VJ software (Resolume, VDMX, etc.) consumes the alpha channel as the
   * layer's transparency mask, enabling overlay / lower-third compositing.
   */
  includeAlpha?: boolean;
  /**
   * Pin the offscreen framebuffer to exactly `width × height` pixels regardless
   * of the host display's device pixel ratio (default: false).
   *
   * Chromium's offscreen render surface is normally sized as `width × height`
   * in DIP (device-independent pixels), so the framebuffer actually delivered
   * to the GPU shared-texture path is `DIP × display.scaleFactor`. On a
   * Windows host running at 150% / 175% display scaling, or on a macOS
   * Retina display, this means a sender declared with `width: 1920` ends up
   * producing a 2880-pixel-wide (or 3360, etc.) texture — and on Windows the
   * window can additionally be clamped to the display work area, producing
   * non-uniform scaling on both axes.
   *
   * When set to `true`:
   * - The BrowserWindow's DIP size is computed as
   *   `Math.round(width / scaleFactor) × Math.round(height / scaleFactor)`
   *   so the resulting framebuffer matches the requested pixel dimensions
   *   on the primary display.
   * - `enableLargerThanScreen: true` is applied so the window is not
   *   clamped to the display work area on macOS (Windows allows it by
   *   default, but the flag is harmless on other platforms).
   * - The Spout / Syphon sender is registered at the requested `width × height`
   *   pixel size — receivers always see the requested dimensions.
   *
   * Limitations:
   * - Computed DIP is rounded to integers. Non-divisible scaleFactor ratios
   *   (e.g., 1920 / 1.75 = 1097.14...) can produce a 1-pixel discrepancy
   *   between the sender's declared size and the actual framebuffer.
   * - Only the primary display's scaleFactor at construction time is honored.
   *   If the system DPI changes mid-session, callers must `resize()` (which
   *   re-applies the math) for the framebuffer to track the new scale.
   */
  pixelExact?: boolean;
}

/** Events emitted by TextureBridge */
export interface BridgeEvents {
  fps: [fps: number];
  ready: [];
  error: [error: Error];
  /**
   * A paint frame was dropped before reaching the sender (missing texture /
   * missing platform handle / unsupported platform). Not an error — but if
   * this fires persistently the output is black on the receiving side.
   * Consecutive drops with the same reason are deduped: the event fires on
   * the first occurrence and again only after a successful send or a reason
   * change.
   */
  frameDropped: [defect: PaintDefect];
  disposed: [];
  resize: [width: number, height: number];
}

/** High-level texture bridge handle */
export interface TextureBridge {
  on<K extends keyof BridgeEvents>(event: K, listener: (...args: BridgeEvents[K]) => void): this;
  off<K extends keyof BridgeEvents>(event: K, listener: (...args: BridgeEvents[K]) => void): this;
  once<K extends keyof BridgeEvents>(event: K, listener: (...args: BridgeEvents[K]) => void): this;

  /** Open the preview window (no-op if already open) */
  openPreview(): void;
  /** Close the preview window (no-op if already closed) */
  closePreview(): void;

  /** Resize all layers: offscreen window, sender, preview, and worker */
  resize(width: number, height: number): void;

  /** The offscreen BrowserWindow used for rendering */
  readonly renderWindow: BrowserWindow;
  /** The preview BrowserWindow, if open */
  readonly previewWindow: BrowserWindow | null;

  /** Whether the bridge has been disposed */
  readonly isDisposed: boolean;

  /** Tear down all resources. Terminal operation — the bridge cannot be reused afterward. */
  dispose(): void;

  /** Alias for dispose(), enabling `using bridge = await createTextureBridge(...)` */
  [Symbol.dispose](): void;
}
