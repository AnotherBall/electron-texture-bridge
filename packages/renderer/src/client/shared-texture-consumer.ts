/**
 * Renderer-side helper for consuming shared textures sent by
 * `createSharedTextureReceiver` in the main process.
 *
 * Renderer process only.
 */

import { sharedTexture } from "electron";

export interface SharedTextureConsumerFrame {
  /** The imported shared texture's unique identifier (stable within process). */
  readonly textureId: string;
  /**
   * A `VideoFrame` backed by the shared texture. Call `.close()` when done —
   * `consumeSharedTexture` does this automatically after your handler returns.
   * Pass it to `GPUDevice.importExternalTexture({ source: videoFrame })` for a
   * zero-copy path to WebGPU.
   */
  readonly videoFrame: VideoFrame;
}

export interface SharedTextureConsumerHandlers {
  /**
   * Called once per delivered frame. Receive `frame.videoFrame` and either use
   * it synchronously or `await` async work before returning. The VideoFrame is
   * closed and the imported texture released as soon as the handler's returned
   * promise settles.
   *
   * Extra args passed by the main process's `sendSharedTexture(..., ...args)`
   * are forwarded verbatim.
   */
  onFrame(frame: SharedTextureConsumerFrame, ...args: unknown[]): void | Promise<void>;
  onError?(error: Error): void;
}

export interface SharedTextureConsumerRegistration {
  /**
   * Detach the underlying `sharedTexture.setSharedTextureReceiver` callback.
   * Electron currently allows only one receiver per renderer; call this before
   * re-registering.
   */
  dispose(): void;
}

/**
 * Register a callback for imported shared textures delivered from the main
 * process via `createSharedTextureReceiver`.
 *
 * Handles VideoFrame close + imported-texture release automatically in a
 * `try/finally`, so a throwing handler cannot leak GPU resources.
 *
 * @experimental Requires Electron 40+ `sharedTexture` module.
 */
export function consumeSharedTexture(
  handlers: SharedTextureConsumerHandlers,
): SharedTextureConsumerRegistration {
  let disposed = false;

  const callback = async (
    data: Electron.ReceivedSharedTextureData,
    ...args: unknown[]
  ): Promise<void> => {
    if (disposed) {
      data.importedSharedTexture.release();
      return;
    }

    const imported = data.importedSharedTexture;
    const videoFrame = imported.getVideoFrame();
    try {
      await handlers.onFrame({ textureId: imported.textureId, videoFrame }, ...args);
    } catch (err) {
      if (handlers.onError) {
        const error = err instanceof Error ? err : new Error(String(err));
        handlers.onError(error);
      }
    } finally {
      // VideoFrame must be closed before the imported texture is released so
      // the underlying GPU resource finalization ordering is correct.
      try {
        videoFrame.close();
      } catch {
        // VideoFrame may have been closed by the handler already — ignore.
      }
      imported.release();
    }
  };

  sharedTexture.setSharedTextureReceiver(callback);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      // Electron does not expose an unregister API on setSharedTextureReceiver;
      // once disposed, our wrapper releases incoming textures without invoking
      // the user handler. Future frames from main are therefore no-ops.
    },
  };
}
