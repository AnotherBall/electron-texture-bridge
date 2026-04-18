import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockFrame = {
  readonly width: number;
  readonly height: number;
  readonly pixelFormat: string;
  readonly ownerPid: number;
  readonly handle: Buffer;
};

const mockReceiver = {
  receiveSharedTexture: vi.fn<() => MockFrame | null>().mockReturnValue(null),
  stop: vi.fn(),
};

const mockImported = {
  release: vi.fn(),
  textureId: "mock-texture-id",
  getVideoFrame: vi.fn(),
};

const mockImportSharedTexture = vi.fn().mockReturnValue(mockImported);
const mockSendSharedTexture = vi
  .fn<(opts: unknown, ...args: unknown[]) => Promise<void>>()
  .mockResolvedValue(undefined);

const mockMainFrame = {};
const makeMockTarget = () => ({
  isDestroyed: vi.fn().mockReturnValue(false),
  mainFrame: mockMainFrame as unknown as Electron.WebFrameMain,
});

vi.mock("electron", () => ({
  sharedTexture: {
    importSharedTexture: (opts: unknown) => mockImportSharedTexture(opts),
    sendSharedTexture: (opts: unknown, ...args: unknown[]) => mockSendSharedTexture(opts, ...args),
  },
}));

vi.mock("@napolab/texture-bridge-core", () => ({
  TextureReceiver: class MockTextureReceiver {
    receiveSharedTexture = mockReceiver.receiveSharedTexture;
    stop = mockReceiver.stop;
  },
}));

import { createSharedTextureReceiver } from "../shared-texture-receiver";

const makeFrame = (overrides: Partial<MockFrame> = {}): MockFrame => ({
  width: 1920,
  height: 1080,
  pixelFormat: "bgra",
  ownerPid: 1234,
  handle: Buffer.alloc(8),
  ...overrides,
});

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("createSharedTextureReceiver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockReceiver.receiveSharedTexture.mockReturnValue(null);
    mockImportSharedTexture.mockReturnValue(mockImported);
    mockSendSharedTexture.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a bridge that is initially not disposed", () => {
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
    });
    expect(bridge.isDisposed).toBe(false);
    bridge.dispose();
  });

  it("polls receiveSharedTexture at pollIntervalMs after start()", () => {
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 20,
    });
    bridge.start();

    vi.advanceTimersByTime(25);
    expect(mockReceiver.receiveSharedTexture).toHaveBeenCalled();

    bridge.dispose();
  });

  it("does not poll before start()", () => {
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
    });
    vi.advanceTimersByTime(100);
    expect(mockReceiver.receiveSharedTexture).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it("does not re-schedule on repeated start()", () => {
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.start();
    bridge.start();

    vi.advanceTimersByTime(30);
    // 3 ticks at 10ms interval across a single timer; second start() should be a no-op
    expect(mockReceiver.receiveSharedTexture.mock.calls.length).toBeLessThanOrEqual(4);

    bridge.dispose();
  });

  it("imports and sends a shared texture when a frame is received", async () => {
    const target = makeMockTarget();
    mockReceiver.receiveSharedTexture.mockReturnValue(makeFrame());

    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: target as unknown as Electron.WebContents,
      pollIntervalMs: 16,
    });
    bridge.start();

    vi.advanceTimersByTime(20);

    expect(mockImportSharedTexture).toHaveBeenCalledTimes(1);
    const importArg = mockImportSharedTexture.mock.calls[0][0] as {
      textureInfo: Electron.SharedTextureImportTextureInfo;
    };
    expect(importArg.textureInfo.codedSize).toEqual({ width: 1920, height: 1080 });
    expect(importArg.textureInfo.pixelFormat).toBe("bgra");

    expect(mockSendSharedTexture).toHaveBeenCalledTimes(1);
    const sendArg = mockSendSharedTexture.mock.calls[0][0] as {
      frame: unknown;
      importedSharedTexture: unknown;
    };
    expect(sendArg.frame).toBe(mockMainFrame);
    expect(sendArg.importedSharedTexture).toBe(mockImported);

    await flushPromises();
    expect(mockImported.release).toHaveBeenCalledTimes(1);

    bridge.dispose();
  });

  it("wraps handle under ntHandle on win32 and ioSurface on darwin", () => {
    const originalPlatform = process.platform;
    const setPlatform = (p: NodeJS.Platform) => {
      Object.defineProperty(process, "platform", { value: p, configurable: true });
    };

    try {
      setPlatform("win32");
      mockReceiver.receiveSharedTexture.mockReturnValue(makeFrame());
      const bridgeWin = createSharedTextureReceiver({
        senderName: "w",
        target: makeMockTarget() as unknown as Electron.WebContents,
        pollIntervalMs: 10,
      });
      bridgeWin.start();
      vi.advanceTimersByTime(15);
      const winArg = mockImportSharedTexture.mock.calls[0][0] as {
        textureInfo: { handle: { ntHandle?: Buffer; ioSurface?: Buffer } };
      };
      expect(winArg.textureInfo.handle.ntHandle).toBeInstanceOf(Buffer);
      expect(winArg.textureInfo.handle.ioSurface).toBeUndefined();
      bridgeWin.dispose();

      mockImportSharedTexture.mockClear();
      mockReceiver.receiveSharedTexture.mockReturnValue(makeFrame());
      setPlatform("darwin");
      const bridgeMac = createSharedTextureReceiver({
        senderName: "m",
        target: makeMockTarget() as unknown as Electron.WebContents,
        pollIntervalMs: 10,
      });
      bridgeMac.start();
      vi.advanceTimersByTime(15);
      const macArg = mockImportSharedTexture.mock.calls[0][0] as {
        textureInfo: { handle: { ntHandle?: Buffer; ioSurface?: Buffer } };
      };
      expect(macArg.textureInfo.handle.ioSurface).toBeInstanceOf(Buffer);
      expect(macArg.textureInfo.handle.ntHandle).toBeUndefined();
      bridgeMac.dispose();
    } finally {
      setPlatform(originalPlatform);
    }
  });

  it("emits 'error' when receiveSharedTexture throws", () => {
    const handler = vi.fn();
    mockReceiver.receiveSharedTexture.mockImplementation(() => {
      throw new Error("native boom");
    });

    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.on("error", handler);
    bridge.start();
    vi.advanceTimersByTime(15);

    expect(handler).toHaveBeenCalled();
    expect(handler.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((handler.mock.calls[0][0] as Error).message).toBe("native boom");

    bridge.dispose();
  });

  it("emits 'error' when importSharedTexture throws and does not call sendSharedTexture", () => {
    const handler = vi.fn();
    mockReceiver.receiveSharedTexture.mockReturnValue(makeFrame());
    mockImportSharedTexture.mockImplementation(() => {
      throw new Error("import failed");
    });

    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.on("error", handler);
    bridge.start();
    vi.advanceTimersByTime(15);

    expect(handler).toHaveBeenCalled();
    expect(mockSendSharedTexture).not.toHaveBeenCalled();

    bridge.dispose();
  });

  it("releases the imported texture even when sendSharedTexture rejects", async () => {
    mockReceiver.receiveSharedTexture.mockReturnValue(makeFrame());
    mockSendSharedTexture.mockRejectedValueOnce(new Error("send failed"));

    const handler = vi.fn();
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.on("error", handler);
    bridge.start();
    vi.advanceTimersByTime(15);

    await flushPromises();
    expect(mockImported.release).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalled();

    bridge.dispose();
  });

  it("skips import when the target webContents is destroyed", () => {
    const target = makeMockTarget();
    target.isDestroyed.mockReturnValue(true);
    mockReceiver.receiveSharedTexture.mockReturnValue(makeFrame());

    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: target as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.start();
    vi.advanceTimersByTime(15);

    expect(mockImportSharedTexture).not.toHaveBeenCalled();
    expect(mockSendSharedTexture).not.toHaveBeenCalled();

    bridge.dispose();
  });

  it("forwards extraArgs to sendSharedTexture varargs", () => {
    mockReceiver.receiveSharedTexture.mockReturnValue(makeFrame());
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 10,
      extraArgs: ["a", 42],
    });
    bridge.start();
    vi.advanceTimersByTime(15);

    const call = mockSendSharedTexture.mock.calls[0];
    expect(call[1]).toBe("a");
    expect(call[2]).toBe(42);

    bridge.dispose();
  });

  it("emits 'fps' after accumulating enough frames", async () => {
    const fpsHandler = vi.fn();
    mockReceiver.receiveSharedTexture.mockReturnValue(makeFrame());

    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.on("fps", fpsHandler);
    bridge.start();

    // async tick body + awaited sendSharedTexture require microtasks to flush
    // between timer fires. advanceTimersByTimeAsync interleaves both.
    await vi.advanceTimersByTimeAsync(1100);

    expect(fpsHandler).toHaveBeenCalled();
    const fps = fpsHandler.mock.calls[0][0];
    expect(typeof fps).toBe("number");
    expect(fps).toBeGreaterThan(0);

    bridge.dispose();
  });

  it("drops overlapping ticks while a send is in flight (drop-latest)", async () => {
    mockReceiver.receiveSharedTexture.mockReturnValue(makeFrame());
    // Never-resolving send keeps _inFlight true forever until we resolve it
    // explicitly via the ref below.
    const pendingResolve: { current: (() => void) | null } = { current: null };
    mockSendSharedTexture.mockImplementation(
      () =>
        new Promise<void>((res) => {
          pendingResolve.current = () => res();
        }),
    );

    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.start();

    await vi.advanceTimersByTimeAsync(100);

    // Even with 10+ ticks in the window, only one import/send pair should be
    // dispatched because subsequent ticks hit the _inFlight guard.
    expect(mockImportSharedTexture).toHaveBeenCalledTimes(1);
    expect(mockSendSharedTexture).toHaveBeenCalledTimes(1);
    expect(mockImported.release).not.toHaveBeenCalled();

    // Let the send resolve; a later tick should now be free to dispatch again.
    pendingResolve.current?.();
    await vi.advanceTimersByTimeAsync(30);
    expect(mockImportSharedTexture.mock.calls.length).toBeGreaterThanOrEqual(2);

    bridge.dispose();
  });

  it("dispose() stops polling, stops the receiver, and emits 'disposed'", () => {
    const disposedHandler = vi.fn();
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.on("disposed", disposedHandler);
    bridge.start();

    bridge.dispose();

    expect(bridge.isDisposed).toBe(true);
    expect(mockReceiver.stop).toHaveBeenCalledTimes(1);
    expect(disposedHandler).toHaveBeenCalledTimes(1);

    const before = mockReceiver.receiveSharedTexture.mock.calls.length;
    vi.advanceTimersByTime(100);
    expect(mockReceiver.receiveSharedTexture.mock.calls.length).toBe(before);
  });

  it("dispose() is idempotent", () => {
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
    });
    bridge.dispose();
    bridge.dispose();
    expect(mockReceiver.stop).toHaveBeenCalledTimes(1);
  });

  it("[Symbol.dispose]() delegates to dispose()", () => {
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
    });
    bridge[Symbol.dispose]();
    expect(bridge.isDisposed).toBe(true);
    expect(mockReceiver.stop).toHaveBeenCalledTimes(1);
  });
});
