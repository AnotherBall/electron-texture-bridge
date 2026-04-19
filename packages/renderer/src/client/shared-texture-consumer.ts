/**
 * Renderer-side helper for consuming shared textures sent by
 * `createSharedTextureReceiver` in the main process.
 *
 * Electron's `sharedTexture.setSharedTextureReceiver` only allows one callback
 * per renderer. This module owns that single slot: the first call to
 * `consumeSharedTexture` lazily installs a permanent receiver that delegates
 * to a `createMultiDispatcher` pool. The slot is never swapped or released
 * afterwards — it stays bound for the lifetime of the renderer process.
 *
 * Every active consumer receives its own `VideoFrame` per incoming imported
 * texture. When no consumers are registered, the permanent receiver still
 * drains incoming frames (`dispatcher.handler` returns `Promise.all([])`) and
 * releases the imported texture exactly once.
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
// Pool — one multi-dispatcher backing one permanently-installed Electron slot.
// ---------------------------------------------------------------------------

type DispatchArgs = readonly [Electron.ReceivedSharedTextureData, ...unknown[]];

const dispatcher = createMultiDispatcher<DispatchArgs, Promise<void>>({
  combine: async (results) => {
    await Promise.all(results);
  },
});

// The Electron slot is bound at most once per renderer process, on the first
// `consumeSharedTexture` call. It stays bound forever: the permanent receiver
// always delegates to `dispatcher.handler` (a no-op when no consumers are
// registered) and unconditionally releases the imported texture afterwards.
let receiverInstalled = false;

const ensureReceiverInstalled = (): void => {
  if (receiverInstalled) return;
  receiverInstalled = true;
  sharedTexture.setSharedTextureReceiver(async (data, ...args) => {
    const imported = data.importedSharedTexture;
    try {
      await dispatcher.handler(data, ...args);
    } finally {
      imported.release();
    }
  });
};

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
  ensureReceiverInstalled();
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
 * Clear the consumer pool AND the "receiver installed" flag. Used by vitest
 * suites to return the module to its pre-first-call state; not part of the
 * public API. Production code never resets — the slot is permanent.
 *
 * @internal
 */
export const _resetSharedTextureRegistryForTesting = (): void => {
  dispatcher.reset();
  receiverInstalled = false;
};
