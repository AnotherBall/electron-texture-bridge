/**
 * Shared-texture (zero-copy GPU) receiver bridge.
 *
 * Polls the native addon's `receiveSharedTexture()` and forwards each frame to
 * a target renderer via Electron's `sharedTexture.importSharedTexture` +
 * `sendSharedTexture` pair (available in Electron 40+).
 *
 * Main process only.
 */

import { EventEmitter } from "events";
import { sharedTexture } from "electron";
import type { WebContents } from "electron";
import { TextureReceiver } from "@napolab/texture-bridge-core";
import type { SharedTextureFrame } from "@napolab/texture-bridge-core";
import { FpsCounter } from "./fps-counter";

export interface SharedTextureReceiverOptions {
  readonly senderName: string;
  readonly appName?: string;
  readonly serverUuid?: string;
  /** Polling interval in ms. Defaults to 16 (~60 fps). */
  readonly pollIntervalMs?: number;
  /**
   * Target WebContents to deliver frames to. The bridge forwards to
   * `target.mainFrame` via `sharedTexture.sendSharedTexture`.
   */
  readonly target: WebContents;
  /**
   * Optional extra positional arguments that are forwarded to the renderer
   * process's `setSharedTextureReceiver` callback alongside the imported
   * texture (via Electron's `sendSharedTexture(..., ...args)` varargs).
   */
  readonly extraArgs?: readonly unknown[];
}

export interface SharedTextureReceiverBridgeEvents {
  fps: [fps: number];
  error: [error: Error];
  disposed: [];
}

export interface SharedTextureReceiverBridge {
  on<K extends keyof SharedTextureReceiverBridgeEvents>(
    event: K,
    listener: (...args: SharedTextureReceiverBridgeEvents[K]) => void,
  ): this;
  off<K extends keyof SharedTextureReceiverBridgeEvents>(
    event: K,
    listener: (...args: SharedTextureReceiverBridgeEvents[K]) => void,
  ): this;
  once<K extends keyof SharedTextureReceiverBridgeEvents>(
    event: K,
    listener: (...args: SharedTextureReceiverBridgeEvents[K]) => void,
  ): this;

  start(): void;
  stop(): void;
  dispose(): void;
  [Symbol.dispose](): void;
  readonly isDisposed: boolean;
}

class SharedTextureReceiverBridgeImpl extends EventEmitter implements SharedTextureReceiverBridge {
  private receiver: InstanceType<typeof TextureReceiver>;
  private target: WebContents;
  private extraArgs: readonly unknown[];
  private fpsCounter = new FpsCounter();
  private _disposed = false;
  private _started = false;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _inFlight = false;
  private pollIntervalMs: number;

  constructor(
    receiver: InstanceType<typeof TextureReceiver>,
    target: WebContents,
    extraArgs: readonly unknown[],
    pollIntervalMs: number,
  ) {
    super();
    this.receiver = receiver;
    this.target = target;
    this.extraArgs = extraArgs;
    this.pollIntervalMs = pollIntervalMs;
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  start(): void {
    if (this._disposed || this._started) return;
    this._started = true;
    this.fpsCounter.reset();
    this._timer = setInterval(() => {
      void this._tick();
    }, this.pollIntervalMs);
  }

  stop(): void {
    this._started = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.stop();
    this.receiver.stop();
    this.emit("disposed");
    this.removeAllListeners();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  /**
   * One poll tick. Drop-latest: if a previous send is still in flight (the
   * Electron `sendSharedTexture` Promise has not resolved yet), this tick is a
   * no-op. That keeps at most one imported-texture reference alive on the main
   * process at any time and prevents frame pile-up when the renderer is slow.
   */
  private async _tick(): Promise<void> {
    if (this._disposed || this._inFlight) return;

    let frame: SharedTextureFrame | null;
    try {
      frame = this.receiver.receiveSharedTexture();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
      return;
    }
    if (!frame) return;

    this._inFlight = true;
    try {
      await this._send(frame);
    } finally {
      this._inFlight = false;
    }

    const fps = this.fpsCounter.tick();
    if (fps !== null) this.emit("fps", fps);
  }

  private async _send(frame: SharedTextureFrame): Promise<void> {
    if (this.target.isDestroyed()) return;

    // Wrap the raw handle under the platform-specific key that Electron's
    // SharedTextureHandle expects.
    const handle =
      process.platform === "win32" ? { ntHandle: frame.handle } : { ioSurface: frame.handle };

    const textureInfo: Electron.SharedTextureImportTextureInfo = {
      codedSize: { width: frame.width, height: frame.height },
      handle,
      pixelFormat: frame.pixelFormat as "bgra" | "rgba" | "rgbaf16" | "nv12",
    };

    let imported: Electron.SharedTextureImported;
    try {
      imported = sharedTexture.importSharedTexture({ textureInfo });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
      return;
    }

    const targetFrame = this.target.mainFrame;
    if (!targetFrame) {
      imported.release();
      return;
    }

    try {
      await sharedTexture.sendSharedTexture(
        { frame: targetFrame, importedSharedTexture: imported },
        ...this.extraArgs,
      );
    } catch (err) {
      if (this._disposed) return;
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
    } finally {
      imported.release();
    }
  }
}

/**
 * Create a shared-texture receiver bridge.
 *
 * The returned bridge polls Spout/Syphon at `pollIntervalMs` and delivers each
 * frame as a GPU-shared texture to `options.target`'s renderer. The renderer
 * must register a handler via `consumeSharedTexture` from
 * `@napolab/texture-bridge-renderer/client`.
 *
 * @experimental Requires Electron 40+ `sharedTexture` module.
 */
export function createSharedTextureReceiver(
  options: SharedTextureReceiverOptions,
): SharedTextureReceiverBridge {
  const { senderName, appName, serverUuid, pollIntervalMs = 16, target, extraArgs = [] } = options;
  const receiver = new TextureReceiver(senderName, appName, serverUuid);
  return new SharedTextureReceiverBridgeImpl(receiver, target, extraArgs, pollIntervalMs);
}
