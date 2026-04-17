import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const mockReceiver = {
  hasNewFrame: vi.fn().mockReturnValue(false),
  receiveFrame: vi.fn().mockReturnValue(null),
  isConnected: vi.fn().mockReturnValue(true),
  getWidth: vi.fn().mockReturnValue(1920),
  getHeight: vi.fn().mockReturnValue(1080),
  stop: vi.fn(),
  platform: vi.fn().mockReturnValue("mock"),
  startListening: vi.fn(),
};

const mockGetPlatform = vi.fn().mockReturnValue("syphon-metal");

vi.mock("@napolab/texture-bridge-core", () => ({
  TextureReceiver: class MockTextureReceiver {
    hasNewFrame = mockReceiver.hasNewFrame;
    receiveFrame = mockReceiver.receiveFrame;
    isConnected = mockReceiver.isConnected;
    getWidth = mockReceiver.getWidth;
    getHeight = mockReceiver.getHeight;
    stop = mockReceiver.stop;
    platform = mockReceiver.platform;
    startListening = mockReceiver.startListening;
  },
  getPlatform: (...args: unknown[]) => mockGetPlatform(...args),
  listSenders: vi.fn().mockReturnValue([]),
}));

import { createTextureReceiver } from "../receiver";

describe("TextureReceiverBridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockReceiver.receiveFrame.mockReturnValue(null);
    mockReceiver.isConnected.mockReturnValue(true);
    mockGetPlatform.mockReturnValue("unknown");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("createTextureReceiver returns a bridge object", () => {
    const bridge = createTextureReceiver({ senderName: "TestSender" });
    expect(bridge).toBeDefined();
    expect(bridge.isDisposed).toBe(false);
    bridge.dispose();
  });

  it("start() begins polling for frames", () => {
    const bridge = createTextureReceiver({ senderName: "TestSender" });
    bridge.start();

    vi.advanceTimersByTime(20);
    expect(mockReceiver.receiveFrame).toHaveBeenCalled();

    bridge.dispose();
  });

  it("emits 'frame' when a new frame is available", () => {
    const handler = vi.fn();
    const bridge = createTextureReceiver({ senderName: "TestSender" });
    bridge.on("frame", handler);
    bridge.start();

    mockReceiver.receiveFrame.mockReturnValue({
      data: Buffer.from([1, 2, 3, 4]),
      width: 100,
      height: 100,
    });

    vi.advanceTimersByTime(20);

    expect(handler).toHaveBeenCalledWith({
      data: Buffer.from([1, 2, 3, 4]),
      width: 100,
      height: 100,
    });

    bridge.dispose();
  });

  it("emits 'fps' event periodically", () => {
    const handler = vi.fn();
    const bridge = createTextureReceiver({ senderName: "TestSender" });
    bridge.on("fps", handler);
    bridge.start();

    // Simulate frames for > 1 second
    mockReceiver.receiveFrame.mockReturnValue({
      data: Buffer.from([0]),
      width: 1,
      height: 1,
    });

    // Advance 1100ms (at ~16ms interval, about 68 frames)
    vi.advanceTimersByTime(1100);

    expect(handler).toHaveBeenCalled();
    const fps = handler.mock.calls[0][0];
    expect(typeof fps).toBe("number");
    expect(fps).toBeGreaterThan(0);

    bridge.dispose();
  });

  it("dispose() stops polling and calls receiver.stop()", () => {
    const bridge = createTextureReceiver({ senderName: "TestSender" });
    bridge.start();

    bridge.dispose();

    expect(mockReceiver.stop).toHaveBeenCalled();
    expect(bridge.isDisposed).toBe(true);

    // No more polling after dispose
    const callCount = mockReceiver.receiveFrame.mock.calls.length;
    vi.advanceTimersByTime(100);
    expect(mockReceiver.receiveFrame.mock.calls.length).toBe(callCount);
  });

  it("dispose() is idempotent", () => {
    const bridge = createTextureReceiver({ senderName: "TestSender" });
    bridge.dispose();
    bridge.dispose(); // should not throw
    expect(mockReceiver.stop).toHaveBeenCalledTimes(1);
  });

  it("stop() then start() does not emit bogus FPS from paused interval", () => {
    const fpsHandler = vi.fn();
    const bridge = createTextureReceiver({ senderName: "TestSender" });
    bridge.on("fps", fpsHandler);

    mockReceiver.receiveFrame.mockReturnValue({
      data: Buffer.from([0]),
      width: 1,
      height: 1,
    });

    // Run for 500ms (accumulate some frames but not enough for FPS report)
    bridge.start();
    vi.advanceTimersByTime(500);

    // Pause for 5 seconds
    bridge.stop();
    vi.advanceTimersByTime(5000);

    // Restart — FPS counter should be reset, no bogus near-zero reading
    fpsHandler.mockClear();
    bridge.start();
    vi.advanceTimersByTime(1100);

    // FPS should reflect actual frame rate after restart, not near-zero
    expect(fpsHandler).toHaveBeenCalled();
    const fps = fpsHandler.mock.calls[0][0];
    // At 16ms polling, expect ~60 FPS, not near-zero from the 5s pause
    expect(fps).toBeGreaterThan(30);

    bridge.dispose();
  });

  it("dispose() emits 'disposed' event", () => {
    const handler = vi.fn();
    const bridge = createTextureReceiver({ senderName: "TestSender" });
    bridge.on("disposed", handler);

    bridge.dispose();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("start() is a no-op after dispose()", () => {
    const bridge = createTextureReceiver({ senderName: "TestSender" });
    bridge.dispose();

    // start() after dispose should not begin polling
    bridge.start();
    mockReceiver.receiveFrame.mockReturnValue({ data: Buffer.from([0]), width: 1, height: 1 });
    vi.advanceTimersByTime(100);
    expect(mockReceiver.receiveFrame).not.toHaveBeenCalled();
  });

  it("emits 'error' when stopped receiver throws during poll", () => {
    const handler = vi.fn();
    const bridge = createTextureReceiver({ senderName: "TestSender" });
    bridge.on("error", handler);
    bridge.start();

    // Simulate a stopped receiver that throws on receiveFrame
    mockReceiver.receiveFrame.mockImplementation(() => {
      throw new Error("TextureReceiver has been stopped");
    });

    vi.advanceTimersByTime(20);

    expect(handler).toHaveBeenCalled();
    expect(handler.mock.calls[0][0].message).toBe("TextureReceiver has been stopped");

    bridge.dispose();
  });

  it("[Symbol.dispose]() delegates to dispose()", () => {
    const bridge = createTextureReceiver({ senderName: "TestSender" });
    bridge.start();

    bridge[Symbol.dispose]();

    expect(bridge.isDisposed).toBe(true);
    expect(mockReceiver.stop).toHaveBeenCalledTimes(1);
  });

  it("[Symbol.dispose]() followed by explicit dispose() is safe", () => {
    const bridge = createTextureReceiver({ senderName: "TestSender" });

    bridge[Symbol.dispose]();
    bridge.dispose(); // should not throw

    expect(mockReceiver.stop).toHaveBeenCalledTimes(1);
  });

  it("explicit dispose() followed by [Symbol.dispose]() is safe", () => {
    const bridge = createTextureReceiver({ senderName: "TestSender" });

    bridge.dispose();
    bridge[Symbol.dispose](); // should not throw

    expect(mockReceiver.stop).toHaveBeenCalledTimes(1);
  });

  it("emits 'frame' even when hasNewFrame returns false", () => {
    const handler = vi.fn();
    const bridge = createTextureReceiver({ senderName: "TestSender" });
    bridge.on("frame", handler);
    bridge.start();

    // hasNewFrame returns false, but receiveFrame returns a valid frame
    mockReceiver.hasNewFrame.mockReturnValue(false);
    mockReceiver.receiveFrame.mockReturnValue({
      data: Buffer.from([10, 20, 30]),
      width: 64,
      height: 64,
    });

    vi.advanceTimersByTime(20);

    expect(handler).toHaveBeenCalledWith({
      data: Buffer.from([10, 20, 30]),
      width: 64,
      height: 64,
    });

    bridge.dispose();
  });

  it("does not emit 'frame' when receiveFrame returns null", () => {
    const handler = vi.fn();
    const bridge = createTextureReceiver({ senderName: "TestSender" });
    bridge.on("frame", handler);
    bridge.start();

    mockReceiver.receiveFrame.mockReturnValue(null);

    vi.advanceTimersByTime(20);

    expect(handler).not.toHaveBeenCalled();

    bridge.dispose();
  });

  it("emits 'error' when receiveFrame throws", () => {
    const handler = vi.fn();
    const bridge = createTextureReceiver({ senderName: "TestSender" });
    bridge.on("error", handler);
    bridge.start();

    mockReceiver.receiveFrame.mockImplementation(() => {
      throw new Error("GPU error");
    });

    vi.advanceTimersByTime(20);

    expect(handler).toHaveBeenCalled();
    expect(handler.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(handler.mock.calls[0][0].message).toBe("GPU error");

    bridge.dispose();
  });

  // ---- Event-driven (Spout/Windows) tests ----

  describe("event-driven mode", () => {
    beforeEach(() => {
      mockGetPlatform.mockReturnValue("spout");
    });

    it("uses event-driven for syphon-metal platform", () => {
      mockGetPlatform.mockReturnValue("syphon-metal");
      const bridge = createTextureReceiver({ senderName: "TestSender" });
      bridge.start();

      expect(mockReceiver.startListening).toHaveBeenCalledTimes(1);
      expect(mockReceiver.startListening).toHaveBeenCalledWith(expect.any(Function));
      vi.advanceTimersByTime(100);
      expect(mockReceiver.receiveFrame).not.toHaveBeenCalled();

      bridge.dispose();
    });

    it("start() calls startListening instead of setInterval", () => {
      const bridge = createTextureReceiver({ senderName: "TestSender" });
      bridge.start();

      expect(mockReceiver.startListening).toHaveBeenCalledTimes(1);
      expect(mockReceiver.startListening).toHaveBeenCalledWith(expect.any(Function));
      // receiveFrame should NOT be called (no polling)
      vi.advanceTimersByTime(100);
      expect(mockReceiver.receiveFrame).not.toHaveBeenCalled();

      bridge.dispose();
    });

    it("emits 'frame' when native callback delivers a frame", () => {
      const handler = vi.fn();
      const bridge = createTextureReceiver({ senderName: "TestSender" });
      bridge.on("frame", handler);
      bridge.start();

      // Get the callback that was passed to startListening
      const nativeCallback = mockReceiver.startListening.mock.calls[0][0];

      // Simulate native thread delivering a frame
      nativeCallback({
        data: Buffer.from([10, 20, 30, 40]),
        width: 640,
        height: 480,
      });

      expect(handler).toHaveBeenCalledWith({
        data: Buffer.from([10, 20, 30, 40]),
        width: 640,
        height: 480,
      });

      bridge.dispose();
    });

    it("does not emit frames after dispose", () => {
      const handler = vi.fn();
      const bridge = createTextureReceiver({ senderName: "TestSender" });
      bridge.on("frame", handler);
      bridge.start();

      const nativeCallback = mockReceiver.startListening.mock.calls[0][0];

      bridge.dispose();

      // Simulate native callback firing after dispose (queued tsfn)
      nativeCallback({
        data: Buffer.from([1, 2, 3]),
        width: 100,
        height: 100,
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it("emits 'fps' from event-driven frames", () => {
      vi.useRealTimers();
      const fpsHandler = vi.fn();
      const bridge = createTextureReceiver({ senderName: "TestSender" });
      bridge.on("fps", fpsHandler);
      bridge.start();

      const nativeCallback = mockReceiver.startListening.mock.calls[0][0];
      const frame = { data: Buffer.from([0]), width: 1, height: 1 };

      // Deliver enough frames over > 1 second for FPS to report
      const start = Date.now();
      const interval = setInterval(() => {
        nativeCallback(frame);
        if (Date.now() - start > 1100) {
          clearInterval(interval);
        }
      }, 10);

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(fpsHandler).toHaveBeenCalled();
          const fps = fpsHandler.mock.calls[0][0];
          expect(fps).toBeGreaterThan(0);
          bridge.dispose();
          resolve();
        }, 1200);
      });
    });

    it("emits 'error' when callback throws", () => {
      const handler = vi.fn();
      const bridge = createTextureReceiver({ senderName: "TestSender" });
      bridge.on("error", handler);
      bridge.on("frame", () => {
        throw new Error("handler error");
      });
      bridge.start();

      const nativeCallback = mockReceiver.startListening.mock.calls[0][0];
      nativeCallback({ data: Buffer.from([0]), width: 1, height: 1 });

      expect(handler).toHaveBeenCalled();
      expect(handler.mock.calls[0][0].message).toBe("handler error");

      bridge.dispose();
    });

    it("start() is idempotent", () => {
      const bridge = createTextureReceiver({ senderName: "TestSender" });
      bridge.start();
      bridge.start(); // second call should be no-op

      expect(mockReceiver.startListening).toHaveBeenCalledTimes(1);

      bridge.dispose();
    });

    it("dispose() calls receiver.stop() to terminate listener thread", () => {
      const bridge = createTextureReceiver({ senderName: "TestSender" });
      bridge.start();
      bridge.dispose();

      expect(mockReceiver.stop).toHaveBeenCalledTimes(1);
    });
  });

  // ---- Platform fallback test ----

  it("uses polling when platform is unsupported", () => {
    mockGetPlatform.mockReturnValue("unknown");
    const bridge = createTextureReceiver({ senderName: "TestSender" });
    bridge.start();

    expect(mockReceiver.startListening).not.toHaveBeenCalled();
    // Should use setInterval polling
    mockReceiver.receiveFrame.mockReturnValue({
      data: Buffer.from([1]),
      width: 1,
      height: 1,
    });
    vi.advanceTimersByTime(20);
    expect(mockReceiver.receiveFrame).toHaveBeenCalled();

    bridge.dispose();
  });
});
