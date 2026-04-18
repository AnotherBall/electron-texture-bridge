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
 * Release + VideoFrame-close logic extracted so both the active callback and
 * the post-dispose no-op can share it.
 */
const releaseFrame = (data: Electron.ReceivedSharedTextureData): void => {
  data.importedSharedTexture.release();
};

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
  // Hold the user's handlers behind a nullable ref so `dispose()` can drop the
  // reference and let any captured state (GPU device, React scope, etc.) become
  // GC-eligible, even though Electron retains _something_ in its internal
  // receiver slot.
  const state: {
    disposed: boolean;
    handlers: SharedTextureConsumerHandlers | null;
  } = { disposed: false, handlers };

  const callback = async (
    data: Electron.ReceivedSharedTextureData,
    ...args: unknown[]
  ): Promise<void> => {
    const h = state.handlers;
    if (state.disposed || h === null) {
      // Defensive: release the incoming texture even if the frame arrives
      // during the brief window between dispose() and the no-op re-register.
      releaseFrame(data);
      return;
    }

    const imported = data.importedSharedTexture;
    const videoFrame = imported.getVideoFrame();
    try {
      await h.onFrame({ textureId: imported.textureId, videoFrame }, ...args);
    } catch (err) {
      if (h.onError) {
        const error = err instanceof Error ? err : new Error(String(err));
        h.onError(error);
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
      if (state.disposed) return;
      state.disposed = true;
      // Drop the user handlers ref so anything they captured (WebGPU device,
      // React scope, large closures…) becomes GC-eligible immediately, even
      // though Electron's internal receiver slot still holds _something_.
      state.handlers = null;
      // Replace our retained callback with a free-standing no-op releaser.
      // Electron then holds only this tiny closure, not the richer one that
      // captured `state` and the original `handlers`. If the caller registers
      // a new consumer afterwards, their setSharedTextureReceiver() call
      // overrides this one cleanly.
      sharedTexture.setSharedTextureReceiver(async (data) => {
        releaseFrame(data);
      });
    },
  };
}
