/**
 * Generic fan-out dispatcher: a single `handler` that invokes all registered
 * callbacks with the same arguments, and `register` that returns an idempotent
 * unregister function.
 *
 * Emits lifecycle events via `subscribe("register" | "dispose", ...)`
 * so callers can observe size transitions (e.g., install an upstream listener
 * on the first register, detach on the last dispose).
 *
 * Reusable for any "one upstream slot, many downstream consumers" pattern.
 */

export type MultiDispatcherEventType = "register" | "dispose";

export interface MultiDispatcherEvent {
  /** Which lifecycle event this is. */
  readonly type: MultiDispatcherEventType;
  /** Entry count after the change. */
  readonly size: number;
  /** Entry count immediately before the change. */
  readonly previous: number;
}

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
   * Remove every registered callback. If the dispatcher had any entries,
   * fires one `"dispose"` event with `{ size: 0, previous: <count> }`.
   */
  reset(): void;
  /**
   * Subscribe to lifecycle events. Returns an unsubscribe function — the only
   * way to stop delivery. Mirrors the `register()` contract.
   *
   * - `"register"` — fires after each successful register call.
   *   Detect first-register with `previous === 0 && size > 0`.
   * - `"dispose"` — fires after each active unregister or non-empty reset.
   *   Detect last-unregister with `previous > 0 && size === 0`.
   *
   * Does NOT fire on idempotent unregister calls or reset on an empty
   * dispatcher (size did not change, so there is nothing to report).
   */
  subscribe(
    type: MultiDispatcherEventType,
    listener: (event: MultiDispatcherEvent) => void,
  ): () => void;
}

export interface CreateMultiDispatcherOptions<Args extends readonly unknown[], R> {
  /**
   * Reducer from per-callback results to the single return value of
   * `handler(...)`. Required because the dispatcher cannot infer what it
   * means to "combine" an arbitrary R (e.g. `Promise.all` for `Promise<void>`,
   * logical AND for `boolean`, summation for `number`).
   */
  combine: (results: readonly R[]) => R;
}

export const createMultiDispatcher = <Args extends readonly unknown[], R>(
  options: CreateMultiDispatcherOptions<Args, R>,
): MultiDispatcher<Args, R> => {
  // Per-registration wrapper so callers can register the same callback
  // multiple times without Set deduplicating; each wrapper is identity-unique.
  type Entry = { active: boolean; callback: (...args: Args) => R };
  const entries = new Set<Entry>();

  type Listener = (event: MultiDispatcherEvent) => void;
  const listeners: Record<MultiDispatcherEventType, Set<Listener>> = {
    register: new Set(),
    dispose: new Set(),
  };

  const emit = (type: MultiDispatcherEventType, size: number, previous: number): void => {
    const event: MultiDispatcherEvent = { type, size, previous };
    // Snapshot so a listener that unsubscribes during dispatch does not
    // perturb iteration of the current emit.
    for (const listener of [...listeners[type]]) {
      // One throwing listener must not block its siblings.
      try {
        listener(event);
      } catch (err) {
        console.error(`[multi-dispatcher] subscriber for "${type}" threw:`, err);
      }
    }
  };

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
        // One throwing callback must not starve its siblings. The failing
        // callback contributes no result to `combine` — callers must
        // therefore accept that `results.length <= snapshot.length`.
        try {
          results.push(entry.callback(...args));
        } catch (err) {
          console.error("[multi-dispatcher] handler callback threw:", err);
        }
      }
      return options.combine(results);
    },
    register(callback: (...args: Args) => R): () => void {
      const entry: Entry = { active: true, callback };
      const previous = entries.size;
      entries.add(entry);
      emit("register", entries.size, previous);

      return () => {
        if (!entry.active) return;
        entry.active = false;
        const previous = entries.size;
        entries.delete(entry);
        emit("dispose", entries.size, previous);
      };
    },
    reset(): void {
      const previous = entries.size;
      for (const entry of entries) {
        entry.active = false;
      }
      entries.clear();
      if (previous > 0) emit("dispose", 0, previous);
    },
    subscribe(type, listener) {
      listeners[type].add(listener);
      return () => {
        listeners[type].delete(listener);
      };
    },
  };
};
