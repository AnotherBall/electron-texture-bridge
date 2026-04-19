/**
 * Generic fan-out dispatcher: a single `handler` that invokes all registered
 * callbacks with the same arguments, and `register` that returns an idempotent
 * unregister function.
 *
 * Used by `shared-texture-consumer` to multiplex Electron's single-receiver
 * `sharedTexture.setSharedTextureReceiver` slot across multiple consumers.
 * Reusable for any "one upstream slot, many downstream consumers" pattern.
 */

export interface MultiDispatcher<Args extends readonly unknown[], R> {
  /**
   * Invoke every registered callback with the given args. Calls take a
   * snapshot of the current registrations, so unregister during dispatch
   * affects the next call, not the one already in flight. The per-callback
   * return values are reduced through `combine` into a single value.
   */
  handler(...args: Args): R;
  /**
   * Register a callback. The returned function unregisters it, is idempotent,
   * and is the only way to remove it. Each call to `register` creates a
   * distinct entry even if the same callback is registered multiple times.
   */
  register(callback: (...args: Args) => R): () => void;
  /** Number of currently registered callbacks. */
  readonly size: number;
  /**
   * Remove every registered callback. Fires `onLastUnregister` once if there
   * were any registered callbacks, so the "size transitioned from >0 to 0"
   * invariant holds regardless of mechanism (unregister vs. reset).
   */
  reset(): void;
}

export interface CreateMultiDispatcherOptions<Args extends readonly unknown[], R> {
  /**
   * Reducer from per-callback results to the single return value of
   * `handler(...)`. Required because the dispatcher cannot infer what it
   * means to "combine" an arbitrary R (e.g. `Promise.all` for `Promise<void>`,
   * logical AND for `boolean`, summation for `number`).
   */
  combine: (results: readonly R[]) => R;
  /**
   * Fired synchronously when `size` transitions from 0 to 1. Typical use:
   * install an upstream listener that feeds `handler`.
   */
  onFirstRegister?: () => void;
  /**
   * Fired synchronously when `size` transitions from non-zero to 0, either via
   * the final unregister call or via `reset()` when the dispatcher had entries.
   * Typical use: detach the upstream listener.
   */
  onLastUnregister?: () => void;
}

export const createMultiDispatcher = <Args extends readonly unknown[], R>(
  options: CreateMultiDispatcherOptions<Args, R>,
): MultiDispatcher<Args, R> => {
  // Per-registration wrapper so callers can register the same callback
  // multiple times without Set deduplicating; each wrapper is identity-unique.
  type Entry = { active: boolean; callback: (...args: Args) => R };
  const entries = new Set<Entry>();

  return {
    get size(): number {
      return entries.size;
    },
    handler(...args: Args): R {
      // Snapshot first so mutations to `entries` during dispatch (register /
      // unregister called synchronously from within a callback) only affect
      // subsequent dispatches.
      const snapshot: Entry[] = [];
      for (const entry of entries) {
        if (entry.active) snapshot.push(entry);
      }
      const results: R[] = [];
      for (const entry of snapshot) {
        // Re-check active on each iteration so a callback that unregisters
        // an earlier-iterated sibling has a chance to skip it.
        if (!entry.active) continue;
        results.push(entry.callback(...args));
      }
      return options.combine(results);
    },
    register(callback: (...args: Args) => R): () => void {
      const entry: Entry = { active: true, callback };
      const wasEmpty = entries.size === 0;
      entries.add(entry);
      if (wasEmpty) options.onFirstRegister?.();

      return () => {
        if (!entry.active) return;
        entry.active = false;
        entries.delete(entry);
        if (entries.size === 0) options.onLastUnregister?.();
      };
    },
    reset(): void {
      const hadEntries = entries.size > 0;
      for (const entry of entries) {
        entry.active = false;
      }
      entries.clear();
      if (hadEntries) options.onLastUnregister?.();
    },
  };
};
