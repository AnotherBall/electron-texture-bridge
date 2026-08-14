import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSend = vi.fn();
const mockSendSurface = vi.fn();
const mockStop = vi.fn();

vi.mock("@napolab/texture-bridge", () => ({
  TextureSender: class MockTextureSender {
    send = mockSend;
    sendSurface = mockSendSurface;
    stop = mockStop;
    constructor(_name?: string, _width?: number, _height?: number) {}
  },
  TextureReceiver: class MockTextureReceiver {
    constructor(_name?: string, _app?: string, _uuid?: string) {}
  },
  getPlatform: () => "mock-platform",
  listSenders: () => [{ name: "TestSender", appName: "TestApp", uuid: "test-uuid" }],
}));

describe("core re-exports", () => {
  it("re-exports TextureSender from native", async () => {
    const { TextureSender } = await import("../index");
    expect(TextureSender).toBeDefined();
  });

  it("re-exports TextureReceiver from native", async () => {
    const { TextureReceiver } = await import("../index");
    expect(TextureReceiver).toBeDefined();
  });

  it("re-exports listSenders from native", async () => {
    const { listSenders } = await import("../index");
    expect(listSenders).toBeDefined();
    expect(typeof listSenders).toBe("function");
  });

  it("re-exports getPlatform from native", async () => {
    const { getPlatform } = await import("../index");
    expect(getPlatform).toBeDefined();
    expect(typeof getPlatform).toBe("function");
  });

  it("re-exports sendTextureFromPaintEvent", async () => {
    const { sendTextureFromPaintEvent } = await import("../index");
    expect(sendTextureFromPaintEvent).toBeDefined();
    expect(typeof sendTextureFromPaintEvent).toBe("function");
  });

  it("exports SenderInfo type shape", async () => {
    const { listSenders } = await import("../index");
    const result = listSenders();
    expect(result[0]).toHaveProperty("name");
    expect(result[0]).toHaveProperty("appName");
    expect(result[0]).toHaveProperty("uuid");
  });
});

describe("sendTextureFromPaintEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    mockSendSurface.mockReset();
    mockStop.mockReset();
  });

  it("calls sender.sendSurface on darwin with valid ioSurface", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });

    try {
      const { sendTextureFromPaintEvent, TextureSender } = await import("../index");
      const sender = new TextureSender("Test", 1920, 1080);

      const textureInfo = {
        pixelFormat: "bgra" as const,
        codedSize: { width: 1920, height: 1080 },
        visibleRect: { x: 0, y: 0, width: 1920, height: 1080 },
        handle: { ioSurface: Buffer.alloc(8) },
      };

      sendTextureFromPaintEvent(sender, textureInfo);
      expect(mockSendSurface).toHaveBeenCalledWith(textureInfo.handle.ioSurface, 1920, 1080);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("returns a no-texture defect when textureInfo is undefined", async () => {
    const { sendTextureFromPaintEvent, TextureSender } = await import("../index");
    const sender = new TextureSender("Test", 1920, 1080);

    const defect = sendTextureFromPaintEvent(sender, undefined);
    expect(defect).toEqual({ reason: "no-texture" });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockSendSurface).not.toHaveBeenCalled();
  });

  it("returns undefined on successful darwin send", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });

    try {
      const { sendTextureFromPaintEvent, TextureSender } = await import("../index");
      const sender = new TextureSender("Test", 1920, 1080);

      const textureInfo = {
        pixelFormat: "bgra" as const,
        codedSize: { width: 1920, height: 1080 },
        visibleRect: { x: 0, y: 0, width: 1920, height: 1080 },
        handle: { ioSurface: Buffer.alloc(8) },
      };

      expect(sendTextureFromPaintEvent(sender, textureInfo)).toBeUndefined();
      expect(mockSendSurface).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("returns undefined on successful win32 send", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });

    try {
      const { sendTextureFromPaintEvent, TextureSender } = await import("../index");
      const sender = new TextureSender("Test", 1920, 1080);

      const textureInfo = {
        pixelFormat: "bgra" as const,
        codedSize: { width: 1920, height: 1080 },
        visibleRect: { x: 0, y: 0, width: 1920, height: 1080 },
        handle: { ntHandle: Buffer.alloc(8) },
      };

      expect(sendTextureFromPaintEvent(sender, textureInfo)).toBeUndefined();
      expect(mockSend).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("returns a no-io-surface defect on darwin when the handle lacks ioSurface", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });

    try {
      const { sendTextureFromPaintEvent, TextureSender } = await import("../index");
      const sender = new TextureSender("Test", 1920, 1080);

      const textureInfo = {
        pixelFormat: "bgra" as const,
        codedSize: { width: 1920, height: 1080 },
        visibleRect: { x: 0, y: 0, width: 1920, height: 1080 },
        handle: {},
      };

      expect(sendTextureFromPaintEvent(sender, textureInfo)).toEqual({ reason: "no-io-surface" });
      expect(mockSendSurface).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("returns a no-nt-handle defect on win32 when the handle lacks ntHandle", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });

    try {
      const { sendTextureFromPaintEvent, TextureSender } = await import("../index");
      const sender = new TextureSender("Test", 1920, 1080);

      const textureInfo = {
        pixelFormat: "bgra" as const,
        codedSize: { width: 1920, height: 1080 },
        visibleRect: { x: 0, y: 0, width: 1920, height: 1080 },
        handle: {},
      };

      expect(sendTextureFromPaintEvent(sender, textureInfo)).toEqual({ reason: "no-nt-handle" });
      expect(mockSend).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("returns an unsupported-platform defect on linux", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });

    try {
      const { sendTextureFromPaintEvent, TextureSender } = await import("../index");
      const sender = new TextureSender("Test", 1920, 1080);

      const textureInfo = {
        pixelFormat: "bgra" as const,
        codedSize: { width: 1920, height: 1080 },
        visibleRect: { x: 0, y: 0, width: 1920, height: 1080 },
        handle: { ioSurface: Buffer.alloc(8) },
      };

      expect(sendTextureFromPaintEvent(sender, textureInfo)).toEqual({
        reason: "unsupported-platform",
        platform: "linux",
      });
      expect(mockSend).not.toHaveBeenCalled();
      expect(mockSendSurface).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("surfaces stopped-sender error instead of swallowing it", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });

    try {
      const { sendTextureFromPaintEvent, TextureSendError, TextureSender } =
        await import("../index");
      const sender = new TextureSender("Test", 1920, 1080);

      // After stop(), sendSurface should throw
      const nativeError = new Error("TextureSender has been stopped");
      mockSendSurface.mockImplementation(() => {
        throw nativeError;
      });
      sender.stop();

      const textureInfo = {
        pixelFormat: "bgra" as const,
        codedSize: { width: 1920, height: 1080 },
        visibleRect: { x: 0, y: 0, width: 1920, height: 1080 },
        handle: { ioSurface: Buffer.alloc(8) },
      };

      try {
        sendTextureFromPaintEvent(sender, textureInfo);
        expect.unreachable("sendTextureFromPaintEvent should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(TextureSendError);
        expect((err as Error).message).toBe("TextureSender has been stopped");
        expect((err as Error).cause).toBe(nativeError);
      }
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("wraps non-Error thrown values with stringified message and cause", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });

    try {
      const { sendTextureFromPaintEvent, TextureSendError, TextureSender } =
        await import("../index");
      const sender = new TextureSender("Test", 1920, 1080);

      mockSendSurface.mockImplementation(() => {
        throw "native boom";
      });

      const textureInfo = {
        pixelFormat: "bgra" as const,
        codedSize: { width: 1920, height: 1080 },
        visibleRect: { x: 0, y: 0, width: 1920, height: 1080 },
        handle: { ioSurface: Buffer.alloc(8) },
      };

      try {
        sendTextureFromPaintEvent(sender, textureInfo);
        expect.unreachable("sendTextureFromPaintEvent should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(TextureSendError);
        expect((err as Error).message).toBe("native boom");
        expect((err as Error).cause).toBe("native boom");
      }
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});
