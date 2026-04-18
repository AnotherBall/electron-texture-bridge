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

import { consumeSharedTexture } from "../client/shared-texture-consumer";

const makeMockVideoFrame = () =>
  ({
    close: vi.fn(),
  }) as unknown as VideoFrame;

const makeMockImported = (videoFrame?: VideoFrame) => {
  const frame = videoFrame ?? makeMockVideoFrame();
  return {
    textureId: "tex-abc",
    release: vi.fn(),
    getVideoFrame: vi.fn().mockReturnValue(frame),
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
    vi.clearAllMocks();
    registeredCallback = null;
  });

  it("registers the callback exactly once on call", () => {
    consumeSharedTexture({ onFrame: vi.fn() });
    expect(mockSetSharedTextureReceiver).toHaveBeenCalledTimes(1);
    expect(registeredCallback).not.toBeNull();
  });

  it("invokes onFrame with { textureId, videoFrame } and forwards extra args", async () => {
    const onFrame = vi.fn();
    consumeSharedTexture({ onFrame });

    const videoFrame = makeMockVideoFrame();
    const imported = makeMockImported(videoFrame);
    await registeredCallback!(makeMockData(imported), "extra1", 7);

    expect(onFrame).toHaveBeenCalledTimes(1);
    const [frameArg, extra1, extra2] = onFrame.mock.calls[0];
    expect(frameArg).toMatchObject({ textureId: "tex-abc", videoFrame });
    expect(extra1).toBe("extra1");
    expect(extra2).toBe(7);
  });

  it("closes VideoFrame and releases the imported texture after onFrame resolves", async () => {
    const videoFrame = makeMockVideoFrame();
    const imported = makeMockImported(videoFrame);
    consumeSharedTexture({ onFrame: vi.fn().mockResolvedValue(undefined) });

    await registeredCallback!(makeMockData(imported));

    expect(videoFrame.close).toHaveBeenCalledTimes(1);
    expect(imported.release).toHaveBeenCalledTimes(1);
  });

  it("closes VideoFrame and releases the imported texture even when onFrame throws", async () => {
    const videoFrame = makeMockVideoFrame();
    const imported = makeMockImported(videoFrame);
    const onError = vi.fn();
    consumeSharedTexture({
      onFrame: () => {
        throw new Error("handler boom");
      },
      onError,
    });

    await registeredCallback!(makeMockData(imported));

    expect(videoFrame.close).toHaveBeenCalledTimes(1);
    expect(imported.release).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0][0] as Error).message).toBe("handler boom");
  });

  it("closes VideoFrame and releases the imported texture when an async handler rejects", async () => {
    const videoFrame = makeMockVideoFrame();
    const imported = makeMockImported(videoFrame);
    const onError = vi.fn();
    consumeSharedTexture({
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
  });

  it("does not throw if the handler closed the VideoFrame itself", async () => {
    const videoFrame = makeMockVideoFrame();
    (videoFrame.close as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("already closed");
    });
    const imported = makeMockImported(videoFrame);
    consumeSharedTexture({ onFrame: vi.fn() });

    await expect(registeredCallback!(makeMockData(imported))).resolves.toBeUndefined();
    expect(imported.release).toHaveBeenCalledTimes(1);
  });

  it("after dispose(), incoming frames release the imported texture without invoking onFrame", async () => {
    const onFrame = vi.fn();
    const registration = consumeSharedTexture({ onFrame });

    registration.dispose();

    const imported = makeMockImported();
    await registeredCallback!(makeMockData(imported));

    expect(onFrame).not.toHaveBeenCalled();
    expect(imported.release).toHaveBeenCalledTimes(1);
  });

  it("dispose() is idempotent", () => {
    const registration = consumeSharedTexture({ onFrame: vi.fn() });
    registration.dispose();
    registration.dispose();
    // No assertion beyond "does not throw" — but we verify state by sending one more
    expect(() => registration.dispose()).not.toThrow();
  });
});
