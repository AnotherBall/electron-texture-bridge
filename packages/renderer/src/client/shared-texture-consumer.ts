/**
 * Renderer-side helper for consuming shared textures sent by
 * `createSharedTextureReceiver` in the main process.
 *
 * Electron's `sharedTexture.setSharedTextureReceiver` only allows one callback
 * per renderer. This module owns that single slot via a `createMultiDispatcher`
 * pool: the Electron slot is bound when the first consumer registers, and
 * replaced with a lean no-op releaser when the last consumer disposes. Every
 * active consumer receives its own `VideoFrame` per incoming imported texture.
 *
 * Renderer process only.
 */

import { sharedTexture } from "electron";
import { createMultiDispatcher } from "./multi-dispatcher";

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
   * closed as soon as the handler's returned promise settles.
   *
   * Extra args passed by the main process's `sendSharedTexture(..., ...args)`
   * are forwarded verbatim.
   */
  onFrame(frame: SharedTextureConsumerFrame, ...args: unknown[]): void | Promise<void>;
  onError?(error: Error): void;
}

export interface SharedTextureConsumerRegistration {
  /** Remove this consumer from the pool. Idempotent. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Pool — one multi-dispatcher backing one Electron slot.
//
// The dispatcher itself does the register/unregister idempotency. The
// onFirstRegister / onLastUnregister hooks flip Electron's single receiver
// slot between the pool's own `handler` and a tiny releaser.
// ---------------------------------------------------------------------------

type DispatchArgs = readonly [Electron.ReceivedSharedTextureData, ...unknown[]];

const noopReceiver = async (data: Electron.ReceivedSharedTextureData): Promise<void> => {
  data.importedSharedTexture.release();
};

const dispatcher = createMultiDispatcher<DispatchArgs, Promise<void>>({
  combine: async (results) => {
    await Promise.all(results);
  },
  onFirstRegister: () => {
    // Wrap dispatcher.handler so the per-frame `imported.release()` runs
    // exactly once, after every registered consumer finishes. The dispatcher
    // itself never owns the imported texture — consumers only get a VideoFrame.
    sharedTexture.setSharedTextureReceiver(async (data, ...args) => {
      const imported = data.importedSharedTexture;
      try {
        await dispatcher.handler(data, ...args);
      } finally {
        imported.release();
      }
    });
  },
  onLastUnregister: () => {
    sharedTexture.setSharedTextureReceiver(noopReceiver);
  },
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a callback for imported shared textures delivered from the main
 * process via `createSharedTextureReceiver`.
 *
 * Multiple consumers may coexist. Each gets its own `VideoFrame` per incoming
 * imported texture; the underlying texture is released exactly once after all
 * consumers' `onFrame` callbacks have settled.
 *
 * @experimental Requires Electron 40+ `sharedTexture` module.
 */
export const consumeSharedTexture = (
  handlers: SharedTextureConsumerHandlers,
): SharedTextureConsumerRegistration => {
  const unregister = dispatcher.register(async (data, ...args) => {
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
      try {
        videoFrame.close();
      } catch {
        // Consumer closed it already — ignore.
      }
    }
  });

  return { dispose: unregister };
};

// ---------------------------------------------------------------------------
// Test-only helpers.
// ---------------------------------------------------------------------------

/**
 * Clear the consumer pool. Used by vitest suites; not part of the public API.
 * Does not fire `onLastUnregister`, so Electron's slot is left bound to
 * whichever receiver was last installed — tests that care should clear their
 * mocks after calling this.
 *
 * @internal
 */
export const _resetSharedTextureRegistryForTesting = (): void => {
  dispatcher.reset();
};
