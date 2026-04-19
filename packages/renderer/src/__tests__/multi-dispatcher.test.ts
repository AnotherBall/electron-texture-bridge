import { describe, expect, it, vi } from "vitest";

import { createMultiDispatcher } from "../client/multi-dispatcher";

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

  // -- onSizeChange ---------------------------------------------------------

  it("onSizeChange fires after every register with {size, previous}", () => {
    const changes: Array<{ size: number; previous: number }> = [];
    const d = createMultiDispatcher<[], void>({
      combine: () => {},
      onSizeChange: (c) => changes.push({ size: c.size, previous: c.previous }),
    });

    d.register(() => {});
    d.register(() => {});
    d.register(() => {});

    expect(changes).toEqual([
      { size: 1, previous: 0 },
      { size: 2, previous: 1 },
      { size: 3, previous: 2 },
    ]);
  });

  it("onSizeChange fires after every active unregister with {size, previous}", () => {
    const changes: Array<{ size: number; previous: number }> = [];
    const d = createMultiDispatcher<[], void>({
      combine: () => {},
      onSizeChange: (c) => changes.push({ size: c.size, previous: c.previous }),
    });

    const u1 = d.register(() => {});
    const u2 = d.register(() => {});
    changes.length = 0;

    u1();
    u2();

    expect(changes).toEqual([
      { size: 1, previous: 2 },
      { size: 0, previous: 1 },
    ]);
  });

  it("onSizeChange does NOT fire on idempotent unregister calls", () => {
    const onChange = vi.fn();
    const d = createMultiDispatcher<[], void>({
      combine: () => {},
      onSizeChange: onChange,
    });

    const unregister = d.register(() => {});
    onChange.mockClear();

    unregister();
    unregister();
    unregister();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("caller can detect first-register / last-unregister edges from the metadata", () => {
    const firstEdges: number[] = [];
    const lastEdges: number[] = [];
    const d = createMultiDispatcher<[], void>({
      combine: () => {},
      onSizeChange: ({ size, previous }) => {
        if (previous === 0 && size > 0) firstEdges.push(size);
        if (previous > 0 && size === 0) lastEdges.push(previous);
      },
    });

    const u1 = d.register(() => {}); // 0 → 1  (first edge, size=1)
    const u2 = d.register(() => {}); // 1 → 2
    u1(); //                             2 → 1
    u2(); //                             1 → 0  (last edge, previous=1)
    d.register(() => {})(); //           0 → 1 → 0 (first + last edges)

    expect(firstEdges).toEqual([1, 1]);
    expect(lastEdges).toEqual([1, 1]);
  });

  // -- snapshot semantics ---------------------------------------------------

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

  it("reset() on a non-empty dispatcher fires onSizeChange once with {size: 0, previous: <count>}", () => {
    const onChange = vi.fn();
    const d = createMultiDispatcher<[], void>({
      combine: () => {},
      onSizeChange: onChange,
    });

    d.register(() => {});
    d.register(() => {});
    onChange.mockClear();

    d.reset();

    expect(d.size).toBe(0);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ size: 0, previous: 2 });
  });

  it("reset() on an empty dispatcher does not fire onSizeChange", () => {
    const onChange = vi.fn();
    const d = createMultiDispatcher<[], void>({
      combine: () => {},
      onSizeChange: onChange,
    });

    d.reset();

    expect(onChange).not.toHaveBeenCalled();
  });

  it("after reset(), previously-returned unregisters are safe no-ops", () => {
    const d = createMultiDispatcher<[], void>({ combine: () => {} });
    const unregister = d.register(() => {});
    d.reset();
    expect(() => unregister()).not.toThrow();
    expect(d.size).toBe(0);
  });

  it("after reset(), a new register still reports the 0 → 1 transition via onSizeChange", () => {
    const changes: Array<{ size: number; previous: number }> = [];
    const d = createMultiDispatcher<[], void>({
      combine: () => {},
      onSizeChange: (c) => changes.push({ size: c.size, previous: c.previous }),
    });
    d.register(() => {});
    d.reset();
    changes.length = 0;

    d.register(() => {});

    expect(changes).toEqual([{ size: 1, previous: 0 }]);
  });

  // -- async R --------------------------------------------------------------

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
