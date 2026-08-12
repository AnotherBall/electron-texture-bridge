import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";

const mockImportSharedTexture = vi.fn();
const mockSendSharedTexture = vi.fn();

vi.mock("electron", () => ({
  sharedTexture: {
    importSharedTexture: (...args: unknown[]) => mockImportSharedTexture(...args),
    sendSharedTexture: (...args: unknown[]) => mockSendSharedTexture(...args),
  },
}));

import { forwardSharedTexture } from "../electron";

const textureInfo = {
  pixelFormat: "bgra" as const,
  codedSize: { width: 16, height: 9 },
  visibleRect: { x: 0, y: 0, width: 16, height: 9 },
  handle: { ioSurface: Buffer.alloc(8) },
};

const makeTarget = (overrides?: { destroyed?: boolean; mainFrame?: unknown }) => {
  const stub: unknown = {
    isDestroyed: () => overrides?.destroyed ?? false,
    mainFrame: "mainFrame" in (overrides ?? {}) ? overrides?.mainFrame : { id: 1 },
  };
  // WebContents はクラス型のため構造的スタブは two-step cast で注入（既存テストの確立パターン）
  return stub as WebContents;
};

const makeImported = () => ({ release: vi.fn(), textureId: "t1" });

describe("forwardSharedTexture", () => {
  beforeEach(() => {
    mockImportSharedTexture.mockReset();
    mockSendSharedTexture.mockReset();
  });

  it("returns undefined and releases the import on success", async () => {
    const imported = makeImported();
    mockImportSharedTexture.mockReturnValue(imported);
    mockSendSharedTexture.mockResolvedValue(undefined);
    const target = makeTarget();

    const result = await forwardSharedTexture(textureInfo, target, ["tag", 3]);

    expect(result).toBeUndefined();
    expect(mockImportSharedTexture).toHaveBeenCalledWith({ textureInfo });
    expect(mockSendSharedTexture).toHaveBeenCalledWith(
      { frame: { id: 1 }, importedSharedTexture: imported },
      "tag",
      3,
    );
    expect(imported.release).toHaveBeenCalledTimes(1);
  });

  it("returns target-destroyed without importing when the target is destroyed", async () => {
    const result = await forwardSharedTexture(textureInfo, makeTarget({ destroyed: true }));
    expect(result).toEqual({ reason: "target-destroyed" });
    expect(mockImportSharedTexture).not.toHaveBeenCalled();
  });

  it("returns target-destroyed when mainFrame is missing", async () => {
    const result = await forwardSharedTexture(textureInfo, makeTarget({ mainFrame: null }));
    expect(result).toEqual({ reason: "target-destroyed" });
    expect(mockImportSharedTexture).not.toHaveBeenCalled();
  });

  it("returns import-failed with a normalized Error cause", async () => {
    mockImportSharedTexture.mockImplementation(() => {
      throw "raw string failure";
    });
    const result = await forwardSharedTexture(textureInfo, makeTarget());
    expect(result?.reason).toBe("import-failed");
    if (result?.reason !== "import-failed") throw new Error("unreachable");
    expect(result.cause).toBeInstanceOf(Error);
    expect(result.cause.message).toBe("raw string failure");
    expect(mockSendSharedTexture).not.toHaveBeenCalled();
  });

  it("returns send-failed and still releases the import", async () => {
    const imported = makeImported();
    mockImportSharedTexture.mockReturnValue(imported);
    mockSendSharedTexture.mockRejectedValue(new Error("ipc gone"));
    const result = await forwardSharedTexture(textureInfo, makeTarget());
    expect(result?.reason).toBe("send-failed");
    if (result?.reason !== "send-failed") throw new Error("unreachable");
    expect(result.cause.message).toBe("ipc gone");
    expect(imported.release).toHaveBeenCalledTimes(1);
  });

  it("never throws synchronously even when import throws", () => {
    mockImportSharedTexture.mockImplementation(() => {
      throw new Error("sync boom");
    });
    expect(() => {
      void forwardSharedTexture(textureInfo, makeTarget());
    }).not.toThrow();
  });
});
