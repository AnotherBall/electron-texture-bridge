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
} from "../client/shared-texture-consumer";

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

describe("consumeSharedTexture", () => {
  beforeEach(() => {
    // Reset first so the "receiver installed" flag is cleared, then wipe
    // mocks and registeredCallback so each test starts from a pristine state
    // where the first `consumeSharedTexture` call triggers an install.
    _resetSharedTextureRegistryForTesting();
    vi.clearAllMocks();
    registeredCallback = null;
  });

  it("installs the permanent receiver on the first register", () => {
    const reg = consumeSharedTexture({ onFrame: vi.fn() });
    expect(mockSetSharedTextureReceiver).toHaveBeenCalledTimes(1);
    expect(registeredCallback).not.toBeNull();
    reg.dispose();
  });

  it("does not re-install when a second consumer registers", () => {
    const a = consumeSharedTexture({ onFrame: vi.fn() });
    const b = consumeSharedTexture({ onFrame: vi.fn() });
    expect(mockSetSharedTextureReceiver).toHaveBeenCalledTimes(1);
    a.dispose();
    b.dispose();
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
