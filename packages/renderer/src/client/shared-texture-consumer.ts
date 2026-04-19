/**
 * Renderer-side helper for consuming shared textures sent by
 * `createSharedTextureReceiver` in the main process.
 *
 * The module has two orthogonal exports:
 *
 * - `installSharedTextureReceiver()` — binds Electron's single
 *   `sharedTexture.setSharedTextureReceiver` slot to an internal
 *   `createMultiDispatcher` pool. Idempotent; call once at app startup.
 * - `consumeSharedTexture(handlers)` — registers one consumer into the pool.
 *   Purely a registration; performs no other side effects. Requires
 *   `installSharedTextureReceiver()` to have been called first.
 *
 * Every active consumer receives its own `VideoFrame` per incoming imported
 * texture. When no consumers are registered, the installed receiver still
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
// Pool — one multi-dispatcher backing one Electron slot.
// ---------------------------------------------------------------------------

type DispatchArgs = readonly [Electron.ReceivedSharedTextureData, ...unknown[]];

const dispatcher = createMultiDispatcher<DispatchArgs, Promise<void>>({
  combine: async (results) => {
    await Promise.all(results);
  },
});

let receiverInstalled = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Bind Electron's `sharedTexture.setSharedTextureReceiver` slot to the internal
 * consumer pool. Idempotent — subsequent calls are no-ops. Call once at
 * renderer startup, before any `consumeSharedTexture` call.
 *
 * The bound receiver stays in place for the lifetime of the renderer process.
 * It always delegates to the pool's dispatcher (a no-op when no consumers are
 * registered) and unconditionally releases the imported texture afterwards.
 *
 * @experimental Requires Electron 40+ `sharedTexture` module.
 */
export const installSharedTextureReceiver = (): void => {
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

/**
 * Register a callback for imported shared textures delivered from the main
 * process via `createSharedTextureReceiver`.
 *
 * Multiple consumers may coexist. Each gets its own `VideoFrame` per incoming
 * imported texture; the underlying texture is released exactly once after all
 * consumers' `onFrame` callbacks have settled.
 *
 * Pre-condition: `installSharedTextureReceiver()` must have been called. This
 * function never touches the Electron receiver slot — its only job is to add
 * one entry to the consumer pool.
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
 * Clear the consumer pool AND the "receiver installed" flag. Used by vitest
 * suites to return the module to its pre-install state; not part of the
 * public API. Production code never resets — the slot is permanent.
 *
 * @internal
 */
export const _resetSharedTextureRegistryForTesting = (): void => {
  dispatcher.reset();
  receiverInstalled = false;
};
