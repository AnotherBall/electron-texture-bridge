import { describe, expect, it, vi } from "vitest";

import { createMultiDispatcher } from "../client/multi-dispatcher";
import type { MultiDispatcherEvent } from "../client/multi-dispatcher";

describe("createMultiDispatcher", () => {
  // -- handler / register basics ---------------------------------------------

  it("size starts at 0 and tracks registrations", () => {
    const d = createMultiDispatcher<[], void>({ combine: () => {} });
    expect(d.size).toBe(0);

    const u1 = d.register(() => {});
    expect(d.size).toBe(1);

    const u2 = d.register(() => {});
    expect(d.size).toBe(2);

    u1();
    expect(d.size).toBe(1);

    u2();
    expect(d.size).toBe(0);
  });

  it("handler() fans out args to every registered callback", () => {
    const a = vi.fn();
    const b = vi.fn();
    const d = createMultiDispatcher<[number, string], void>({
      combine: () => {},
    });
    d.register(a);
    d.register(b);

    d.handler(7, "hi");

    expect(a).toHaveBeenCalledWith(7, "hi");
    expect(b).toHaveBeenCalledWith(7, "hi");
  });

  it("handler() returns the result of combine over per-callback results", () => {
    const d = createMultiDispatcher<[number], number>({
      combine: (results) => results.reduce((acc, x) => acc + x, 0),
    });
    d.register((x) => x * 2);
    d.register((x) => x + 100);

    expect(d.handler(5)).toBe(10 + 105); // 115
  });

  it("handler() with zero registrations returns combine([])", () => {
    const d = createMultiDispatcher<[], string>({
      combine: (results) => (results.length === 0 ? "empty" : results.join(",")),
    });
    expect(d.handler()).toBe("empty");
  });

  it("combine receives an array (never undefined)", () => {
    const combine = vi.fn((r: readonly number[]) => r.length);
    const d = createMultiDispatcher<[number], number>({ combine });
    d.handler(1);
    expect(combine).toHaveBeenCalledWith([]);
  });

  // -- register idempotency -------------------------------------------------

  it("registering the same callback twice creates two distinct entries", () => {
    const cb = vi.fn();
    const d = createMultiDispatcher<[], void>({ combine: () => {} });
    const u1 = d.register(cb);
    const u2 = d.register(cb);
    expect(d.size).toBe(2);

    d.handler();
    // Called once for each registration.
    expect(cb).toHaveBeenCalledTimes(2);

    u1();
    expect(d.size).toBe(1);
    u2();
    expect(d.size).toBe(0);
  });

  it("unregister is idempotent — calling twice is a no-op", () => {
    const cb = vi.fn();
    const d = createMultiDispatcher<[], void>({ combine: () => {} });
    const unregister = d.register(cb);
    expect(d.size).toBe(1);

    unregister();
    expect(d.size).toBe(0);
    unregister();
    expect(d.size).toBe(0);
    unregister();
    expect(d.size).toBe(0);

    d.handler();
    expect(cb).not.toHaveBeenCalled();
  });

  // -- subscribe: "register" ------------------------------------------------

  it("'register' event fires after every register with {type, size, previous}", () => {
    const events: MultiDispatcherEvent[] = [];
    const d = createMultiDispatcher<[], void>({ combine: () => {} });
    d.subscribe("register", (e) => events.push(e));

    d.register(() => {});
    d.register(() => {});
    d.register(() => {});

    expect(events).toEqual([
      { type: "register", size: 1, previous: 0 },
      { type: "register", size: 2, previous: 1 },
      { type: "register", size: 3, previous: 2 },
    ]);
  });

  it("'register' event does NOT fire for 'dispose' listeners", () => {
    const onDispose = vi.fn();
    const d = createMultiDispatcher<[], void>({ combine: () => {} });
    d.subscribe("dispose", onDispose);

    d.register(() => {});

    expect(onDispose).not.toHaveBeenCalled();
  });

  // -- subscribe: "dispose" -------------------------------------------------

  it("'dispose' event fires after every active unregister with {type, size, previous}", () => {
    const events: MultiDispatcherEvent[] = [];
    const d = createMultiDispatcher<[], void>({ combine: () => {} });
    d.subscribe("dispose", (e) => events.push(e));

    const u1 = d.register(() => {});
    const u2 = d.register(() => {});

    u1();
    u2();

    expect(events).toEqual([
      { type: "dispose", size: 1, previous: 2 },
      { type: "dispose", size: 0, previous: 1 },
    ]);
  });

  it("'dispose' event does NOT fire for idempotent unregister calls", () => {
    const onDispose = vi.fn();
    const d = createMultiDispatcher<[], void>({ combine: () => {} });
    d.subscribe("dispose", onDispose);

    const unregister = d.register(() => {});
    unregister();
    onDispose.mockClear();

    unregister();
    unregister();

    expect(onDispose).not.toHaveBeenCalled();
  });

  // -- listener management --------------------------------------------------

  it("subscribe returns an unsubscribe that stops delivery", () => {
    const listener = vi.fn();
    const d = createMultiDispatcher<[], void>({ combine: () => {} });
    const unsubscribe = d.subscribe("register", listener);

    d.register(() => {});
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    d.register(() => {});
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("supports multiple listeners on the same event", () => {
    const a = vi.fn();
    const b = vi.fn();
    const d = createMultiDispatcher<[], void>({ combine: () => {} });
    d.subscribe("register", a);
    d.subscribe("register", b);

    d.register(() => {});

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("unsubscribing during emit does not affect the current emit", () => {
    const order: string[] = [];
    const d = createMultiDispatcher<[], void>({ combine: () => {} });

    const unsubA = d.subscribe("register", () => {
      order.push("a");
      unsubA();
      unsubB();
    });
    const unsubB = d.subscribe("register", () => {
      order.push("b");
    });

    d.register(() => {});
    // Both fire this round (snapshot); next round neither fires.
    expect(order).toEqual(["a", "b"]);

    d.register(() => {});
    expect(order).toEqual(["a", "b"]);
  });

  it("caller can detect first-register / last-unregister edges from event metadata", () => {
    const firstEdges: number[] = [];
    const lastEdges: number[] = [];
    const d = createMultiDispatcher<[], void>({ combine: () => {} });
    d.subscribe("register", ({ size, previous }) => {
      if (previous === 0 && size > 0) firstEdges.push(size);
    });
    d.subscribe("dispose", ({ size, previous }) => {
      if (previous > 0 && size === 0) lastEdges.push(previous);
    });

    const u1 = d.register(() => {}); // 0 → 1  (first edge)
    const u2 = d.register(() => {}); // 1 → 2
    u1(); //                             2 → 1
    u2(); //                             1 → 0  (last edge, previous=1)
    d.register(() => {})(); //           0 → 1 → 0

    expect(firstEdges).toEqual([1, 1]);
    expect(lastEdges).toEqual([1, 1]);
  });

  // -- snapshot semantics (handler) -----------------------------------------

  it("unregistering during dispatch skips the entry for that dispatch too", () => {
    const order: string[] = [];
    const d = createMultiDispatcher<[], void>({ combine: () => {} });

    let uB: (() => void) | null = null;
    d.register(() => {
      order.push("a");
      uB?.();
    });
    uB = d.register(() => {
      order.push("b");
    });

    d.handler();
    expect(order).toEqual(["a"]);
  });

  it("registering during dispatch does not affect the current dispatch", () => {
    const calls: string[] = [];
    const d = createMultiDispatcher<[], void>({ combine: () => {} });

    d.register(() => {
      calls.push("a");
      d.register(() => calls.push("b-from-a"));
    });

    d.handler();
    expect(calls).toEqual(["a"]);

    calls.length = 0;
    d.handler();
    expect(calls).toEqual(["a", "b-from-a"]);
  });

  // -- reset ----------------------------------------------------------------

  it("reset() on a non-empty dispatcher fires one 'dispose' event with {size: 0, previous: <count>}", () => {
    const onDispose = vi.fn();
    const d = createMultiDispatcher<[], void>({ combine: () => {} });
    d.subscribe("dispose", onDispose);

    d.register(() => {});
    d.register(() => {});

    d.reset();

    expect(d.size).toBe(0);
    expect(onDispose).toHaveBeenCalledTimes(1);
    expect(onDispose).toHaveBeenCalledWith({ type: "dispose", size: 0, previous: 2 });
  });

  it("reset() on an empty dispatcher does not fire any event", () => {
    const onDispose = vi.fn();
    const d = createMultiDispatcher<[], void>({ combine: () => {} });
    d.subscribe("dispose", onDispose);

    d.reset();

    expect(onDispose).not.toHaveBeenCalled();
  });

  it("after reset(), previously-returned unregisters are safe no-ops", () => {
    const d = createMultiDispatcher<[], void>({ combine: () => {} });
    const unregister = d.register(() => {});
    d.reset();
    expect(() => unregister()).not.toThrow();
    expect(d.size).toBe(0);
  });

  it("after reset(), a new register still reports the 0 → 1 transition", () => {
    const events: MultiDispatcherEvent[] = [];
    const d = createMultiDispatcher<[], void>({ combine: () => {} });
    d.subscribe("register", (e) => events.push(e));
    d.register(() => {});
    d.reset();
    events.length = 0;

    d.register(() => {});

    expect(events).toEqual([{ type: "register", size: 1, previous: 0 }]);
  });

  // -- async R --------------------------------------------------------------

  // -- listener / callback isolation ----------------------------------------

  it("a subscriber that throws during emit does not prevent other subscribers from running", () => {
    const events: string[] = [];
    const d = createMultiDispatcher<[], void>({ combine: () => {} });

    d.subscribe("register", () => {
      events.push("a");
      throw new Error("a threw");
    });
    d.subscribe("register", () => {
      events.push("b");
    });
    d.subscribe("register", () => {
      events.push("c");
    });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => d.register(() => {})).not.toThrow();
    expect(events).toEqual(["a", "b", "c"]);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("a callback that throws during handler() does not prevent other callbacks from running", () => {
    const calls: string[] = [];
    const d = createMultiDispatcher<[], void>({ combine: () => {} });

    d.register(() => {
      calls.push("a");
      throw new Error("a threw");
    });
    d.register(() => {
      calls.push("b");
    });
    d.register(() => {
      calls.push("c");
    });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => d.handler()).not.toThrow();
    expect(calls).toEqual(["a", "b", "c"]);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("combine receives fewer results than callbacks when some throw", () => {
    const received: number[][] = [];
    const combine = vi.fn((results: readonly number[]) => {
      received.push([...results]);
      return results.reduce((acc, x) => acc + x, 0);
    });

    const d = createMultiDispatcher<[], number>({ combine });

    d.register(() => 1);
    d.register(() => {
      throw new Error("middle throws");
    });
    d.register(() => 3);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const total = d.handler();
    errSpy.mockRestore();

    expect(total).toBe(4); // 1 + 3 — the throwing callback contributed nothing
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual([1, 3]);
  });

  it("reset() called inside a handler callback still lets the current dispatch's snapshot complete", () => {
    const calls: string[] = [];
    const d = createMultiDispatcher<[], void>({ combine: () => {} });

    d.register(() => {
      calls.push("a");
      d.reset(); // wipe everything mid-dispatch
    });
    d.register(() => {
      calls.push("b");
    });
    d.register(() => {
      calls.push("c");
    });

    d.handler();

    // Snapshot semantics: `reset()` flips all entries' `active` flags, so the
    // re-check inside handler() short-circuits b and c — they were in the
    // snapshot but are now inactive.
    expect(calls).toEqual(["a"]);

    // Subsequent dispatch has no registrations left.
    d.handler();
    expect(calls).toEqual(["a"]);
  });

  it("works with Promise<void> as R via Promise.all combine", async () => {
    const d = createMultiDispatcher<[number], Promise<void>>({
      combine: async (results) => {
        await Promise.all(results);
      },
    });

    const order: number[] = [];
    d.register(async (x) => {
      await new Promise((r) => setTimeout(r, 0));
      order.push(x * 2);
    });
    d.register(async (x) => {
      await new Promise((r) => setTimeout(r, 0));
      order.push(x * 3);
    });

    await d.handler(5);
    expect(order.sort((a, b) => a - b)).toEqual([10, 15]);
  });
});
