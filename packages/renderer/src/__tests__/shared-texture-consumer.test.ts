import { beforeEach, describe, expect, it, vi } from "vitest";

type RegisteredCallback = (
  data: Electron.ReceivedSharedTextureData,
  ...args: unknown[]
) => Promise<void>;

let registeredCallback: RegisteredCallback | null = null;

const mockSetSharedTextureReceiver = vi.fn(
  (cb: (data: Electron.ReceivedSharedTextureData, ...args: unknown[]) => Promise<void>) => {
    registeredCallback = cb;
  },
);

vi.mock("electron", () => ({
  sharedTexture: {
    setSharedTextureReceiver: (
      cb: (data: Electron.ReceivedSharedTextureData, ...args: unknown[]) => Promise<void>,
    ) => mockSetSharedTextureReceiver(cb),
  },
}));

import {
  _resetSharedTextureRegistryForTesting,
  consumeSharedTexture,
  installSharedTextureReceiver,
} from "../client/shared-texture-consumer";

// `installSharedTextureReceiver` defers `imported.release()` by one macrotask
// to avoid racing ahead of Electron's main-side tracker update (see
// implementation comment). Tests that assert on release side effects must
// flush the macrotask queue after invoking the registered callback.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const makeMockVideoFrame = () =>
  ({
    close: vi.fn(),
  }) as unknown as VideoFrame;

const makeMockImported = (videoFrameFactory?: () => VideoFrame) => {
  const getVideoFrame = vi.fn(videoFrameFactory ?? (() => makeMockVideoFrame()));
  return {
    textureId: "tex-abc",
    release: vi.fn(),
    getVideoFrame,
  };
};

const makeMockData = (
  imported?: ReturnType<typeof makeMockImported>,
): Electron.ReceivedSharedTextureData => ({
  importedSharedTexture: (imported ??
    makeMockImported()) as unknown as Electron.SharedTextureImported,
});

describe("installSharedTextureReceiver", () => {
  beforeEach(() => {
    _resetSharedTextureRegistryForTesting();
    vi.clearAllMocks();
    registeredCallback = null;
  });

  it("binds the Electron receiver slot on first call", () => {
    installSharedTextureReceiver();
    expect(mockSetSharedTextureReceiver).toHaveBeenCalledTimes(1);
    expect(registeredCallback).not.toBeNull();
  });

  it("is idempotent — subsequent calls do not re-bind the slot", () => {
    installSharedTextureReceiver();
    installSharedTextureReceiver();
    installSharedTextureReceiver();
    expect(mockSetSharedTextureReceiver).toHaveBeenCalledTimes(1);
  });

  it("consumeSharedTexture does not install — it is purely a pool registration", () => {
    // No install call. consumeSharedTexture must not touch the Electron slot.
    const reg = consumeSharedTexture({ onFrame: vi.fn() });
    expect(mockSetSharedTextureReceiver).not.toHaveBeenCalled();
    reg.dispose();
  });
});

describe("consumeSharedTexture — install pre-condition", () => {
  beforeEach(() => {
    _resetSharedTextureRegistryForTesting();
    vi.clearAllMocks();
    registeredCallback = null;
  });

  it("emits a console.warn the first time consumeSharedTexture is called before install", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const reg = consumeSharedTexture({ onFrame: vi.fn() });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/installSharedTextureReceiver/);

    reg.dispose();
    warnSpy.mockRestore();
  });

  it("only warns once per process even if multiple consumers are registered before install", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const reg1 = consumeSharedTexture({ onFrame: vi.fn() });
    const reg2 = consumeSharedTexture({ onFrame: vi.fn() });
    const reg3 = consumeSharedTexture({ onFrame: vi.fn() });

    expect(warnSpy).toHaveBeenCalledTimes(1);

    reg1.dispose();
    reg2.dispose();
    reg3.dispose();
    warnSpy.mockRestore();
  });

  it("does not warn once installSharedTextureReceiver has been called", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    installSharedTextureReceiver();
    const reg = consumeSharedTexture({ onFrame: vi.fn() });

    expect(warnSpy).not.toHaveBeenCalled();

    reg.dispose();
    warnSpy.mockRestore();
  });

  it("still returns a valid registration even when it warned (dispose is a no-op-safe)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const reg = consumeSharedTexture({ onFrame: vi.fn() });
    expect(typeof reg.dispose).toBe("function");
    expect(() => reg.dispose()).not.toThrow();
    expect(() => reg.dispose()).not.toThrow();

    warnSpy.mockRestore();
  });
});

describe("consumeSharedTexture", () => {
  beforeEach(() => {
    _resetSharedTextureRegistryForTesting();
    vi.clearAllMocks();
    registeredCallback = null;
    // Install is a pre-condition for consumer tests. Each test starts with
    // the slot bound so registeredCallback is available.
    installSharedTextureReceiver();
  });

  it("invokes a single consumer with { textureId, videoFrame } and forwards extra args", async () => {
    const onFrame = vi.fn();
    const reg = consumeSharedTexture({ onFrame });

    const videoFrame = makeMockVideoFrame();
    const imported = makeMockImported(() => videoFrame);
    await registeredCallback!(makeMockData(imported), "extra1", 7);

    expect(onFrame).toHaveBeenCalledTimes(1);
    const [frameArg, extra1, extra2] = onFrame.mock.calls[0];
    expect(frameArg).toMatchObject({ textureId: "tex-abc", videoFrame });
    expect(extra1).toBe("extra1");
    expect(extra2).toBe(7);
    await flush();
    expect(imported.release).toHaveBeenCalledTimes(1);

    reg.dispose();
  });

  it("defers imported.release() to the next macrotask so the release IPC cannot race ahead of main-side tracker registration", async () => {
    const reg = consumeSharedTexture({ onFrame: vi.fn() });

    const imported = makeMockImported();
    await registeredCallback!(makeMockData(imported));

    // The callback has resolved, the consumer has run, but release is
    // queued on the next macrotask — not fired yet.
    expect(imported.release).not.toHaveBeenCalled();

    await flush();
    expect(imported.release).toHaveBeenCalledTimes(1);

    reg.dispose();
  });

  it("delivers each frame to every active consumer with its own VideoFrame", async () => {
    const onFrameA = vi.fn();
    const onFrameB = vi.fn();
    const regA = consumeSharedTexture({ onFrame: onFrameA });
    const regB = consumeSharedTexture({ onFrame: onFrameB });

    const frameA = makeMockVideoFrame();
    const frameB = makeMockVideoFrame();
    const frames = [frameA, frameB];
    const imported = makeMockImported(() => frames.shift() ?? makeMockVideoFrame());

    await registeredCallback!(makeMockData(imported));

    expect(onFrameA).toHaveBeenCalledTimes(1);
    expect(onFrameB).toHaveBeenCalledTimes(1);
    expect(imported.getVideoFrame).toHaveBeenCalledTimes(2);
    // Each consumer got a distinct VideoFrame instance.
    expect((onFrameA.mock.calls[0][0] as SharedTextureConsumerFrameLike).videoFrame).toBe(frameA);
    expect((onFrameB.mock.calls[0][0] as SharedTextureConsumerFrameLike).videoFrame).toBe(frameB);
    expect(frameA.close).toHaveBeenCalledTimes(1);
    expect(frameB.close).toHaveBeenCalledTimes(1);
    // Imported texture is released exactly once after all consumers finish.
    await flush();
    expect(imported.release).toHaveBeenCalledTimes(1);

    regA.dispose();
    regB.dispose();
  });

  it("closes VideoFrame and releases the imported texture even when a handler throws", async () => {
    const videoFrame = makeMockVideoFrame();
    const imported = makeMockImported(() => videoFrame);
    const onError = vi.fn();
    const reg = consumeSharedTexture({
      onFrame: () => {
        throw new Error("handler boom");
      },
      onError,
    });

    await registeredCallback!(makeMockData(imported));
    await flush();

    expect(videoFrame.close).toHaveBeenCalledTimes(1);
    expect(imported.release).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe("handler boom");

    reg.dispose();
  });

  it("closes VideoFrame and releases when an async handler rejects", async () => {
    const videoFrame = makeMockVideoFrame();
    const imported = makeMockImported(() => videoFrame);
    const onError = vi.fn();
    const reg = consumeSharedTexture({
      onFrame: async () => {
        throw new Error("async boom");
      },
      onError,
    });

    await registeredCallback!(makeMockData(imported));
    await flush();

    expect(videoFrame.close).toHaveBeenCalledTimes(1);
    expect(imported.release).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe("async boom");

    reg.dispose();
  });

  it("tolerates a VideoFrame.close that throws (e.g. handler closed it first)", async () => {
    const videoFrame = makeMockVideoFrame();
    (videoFrame.close as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("already closed");
    });
    const imported = makeMockImported(() => videoFrame);
    const reg = consumeSharedTexture({ onFrame: vi.fn() });

    await expect(registeredCallback!(makeMockData(imported))).resolves.toBeUndefined();
    await flush();
    expect(imported.release).toHaveBeenCalledTimes(1);

    reg.dispose();
  });

  it("one handler throwing does not prevent others from running or leaking release", async () => {
    const onFrameBad = vi.fn(() => {
      throw new Error("bad");
    });
    const onFrameGood = vi.fn();
    const regBad = consumeSharedTexture({ onFrame: onFrameBad });
    const regGood = consumeSharedTexture({ onFrame: onFrameGood });

    const imported = makeMockImported();
    await registeredCallback!(makeMockData(imported));
    await flush();

    expect(onFrameBad).toHaveBeenCalledTimes(1);
    expect(onFrameGood).toHaveBeenCalledTimes(1);
    expect(imported.release).toHaveBeenCalledTimes(1);

    regBad.dispose();
    regGood.dispose();
  });

  it("disposing one consumer leaves others running", async () => {
    const onFrameA = vi.fn();
    const onFrameB = vi.fn();
    const regA = consumeSharedTexture({ onFrame: onFrameA });
    const regB = consumeSharedTexture({ onFrame: onFrameB });

    regA.dispose();

    const imported = makeMockImported();
    await registeredCallback!(makeMockData(imported));
    await flush();

    expect(onFrameA).not.toHaveBeenCalled();
    expect(onFrameB).toHaveBeenCalledTimes(1);
    expect(imported.release).toHaveBeenCalledTimes(1);

    regB.dispose();
  });

  it("keeps the Electron slot bound after the last consumer disposes", () => {
    const reg = consumeSharedTexture({ onFrame: vi.fn() });
    expect(mockSetSharedTextureReceiver).toHaveBeenCalledTimes(1);

    reg.dispose();

    // The slot stays bound for the lifetime of the renderer — no swap, no
    // uninstall. Only the dispatcher's internal entries are cleared.
    expect(mockSetSharedTextureReceiver).toHaveBeenCalledTimes(1);
  });

  it("with no active consumers the installed receiver still drains incoming frames", async () => {
    const onFrame = vi.fn();
    consumeSharedTexture({ onFrame }).dispose();

    const imported = makeMockImported();
    await registeredCallback!(makeMockData(imported));
    await flush();

    expect(onFrame).not.toHaveBeenCalled();
    expect(imported.release).toHaveBeenCalledTimes(1);
    expect(imported.getVideoFrame).not.toHaveBeenCalled();
  });

  it("does not re-install the receiver when a consumer returns after total dispose", () => {
    consumeSharedTexture({ onFrame: vi.fn() }).dispose();
    expect(mockSetSharedTextureReceiver).toHaveBeenCalledTimes(1);

    const reg = consumeSharedTexture({ onFrame: vi.fn() });
    // Still 1: the permanent slot is reused.
    expect(mockSetSharedTextureReceiver).toHaveBeenCalledTimes(1);
    reg.dispose();
  });

  it("dispose() is idempotent", () => {
    const reg = consumeSharedTexture({ onFrame: vi.fn() });
    reg.dispose();
    reg.dispose();
    reg.dispose();
    // One install ever; no dispose-triggered setSharedTextureReceiver churn.
    expect(mockSetSharedTextureReceiver).toHaveBeenCalledTimes(1);
  });

  it("a consumer calling imported.release() during onFrame does not crash the permanent slot", async () => {
    // Simulate a misbehaving consumer that double-releases on its own. The
    // outer finally block in `installSharedTextureReceiver` must tolerate
    // this so subsequent frames still reach healthy consumers.
    const healthyOnFrame = vi.fn();
    const misbehavingImported = makeMockImported();
    // When the first release() is called by the consumer, flag the imported so
    // the second release() (from the installed receiver's finally) throws.
    let firstCallHandled = false;
    misbehavingImported.release.mockImplementation(() => {
      if (firstCallHandled) {
        throw new Error("already released");
      }
      firstCallHandled = true;
    });

    const misbehaving = consumeSharedTexture({
      onFrame: (_frame) => {
        // Consumer does the bad thing: releases the imported texture itself.
        misbehavingImported.release();
      },
    });
    const healthy = consumeSharedTexture({ onFrame: healthyOnFrame });

    // First frame uses the misbehaving imported. The permanent slot's outer
    // release() will throw, but must be swallowed.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(registeredCallback!(makeMockData(misbehavingImported))).resolves.toBeUndefined();
    // The outer release is deferred by one macrotask; flush to let it (and its
    // swallowed throw) fire.
    await flush();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();

    // A subsequent frame with a well-behaved imported still reaches consumers.
    const cleanImported = makeMockImported();
    await registeredCallback!(makeMockData(cleanImported));
    await flush();
    expect(healthyOnFrame).toHaveBeenCalledTimes(2); // called on both frames
    expect(cleanImported.release).toHaveBeenCalledTimes(1);

    misbehaving.dispose();
    healthy.dispose();
  });

  it("an onError handler that throws does not break release or other consumers", async () => {
    const otherConsumer = vi.fn();
    const reg1 = consumeSharedTexture({
      onFrame: () => {
        throw new Error("first-consumer boom");
      },
      onError: () => {
        throw new Error("onError-itself-threw");
      },
    });
    const reg2 = consumeSharedTexture({ onFrame: otherConsumer });

    const videoFrame = makeMockVideoFrame();
    const imported = makeMockImported(() => videoFrame);

    // The onError throw must be swallowed so finally + outer release still run.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(registeredCallback!(makeMockData(imported))).resolves.toBeUndefined();
    await flush();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();

    // Other consumer still got its frame.
    expect(otherConsumer).toHaveBeenCalledTimes(1);
    // Release + close still ran.
    expect(imported.release).toHaveBeenCalledTimes(1);

    reg1.dispose();
    reg2.dispose();
  });

  it("a consumer disposed during its own onFrame is skipped on the next frame", async () => {
    const onFrameA = vi.fn();
    const onFrameB = vi.fn();
    let regA: { dispose(): void } | null = null;

    regA = consumeSharedTexture({
      onFrame: (frame, ...args) => {
        onFrameA(frame, ...args);
        regA?.dispose();
      },
    });
    const regB = consumeSharedTexture({ onFrame: onFrameB });

    await registeredCallback!(makeMockData(makeMockImported()));
    // Both fire on the first frame (A disposed itself at the end, but was
    // already in this frame's snapshot).
    expect(onFrameA).toHaveBeenCalledTimes(1);
    expect(onFrameB).toHaveBeenCalledTimes(1);

    onFrameA.mockClear();
    onFrameB.mockClear();
    await registeredCallback!(makeMockData(makeMockImported()));
    // Next frame: only B.
    expect(onFrameA).not.toHaveBeenCalled();
    expect(onFrameB).toHaveBeenCalledTimes(1);

    regB.dispose();
  });
});

type SharedTextureConsumerFrameLike = {
  textureId: string;
  videoFrame: VideoFrame;
};
