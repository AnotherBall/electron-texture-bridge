/** Electron paint event texture info */
export interface TextureInfo {
  pixelFormat: string;
  codedSize: { width: number; height: number };
  visibleRect: { x: number; y: number; width: number; height: number };
  handle: {
    ntHandle?: Buffer; // Windows (Electron 40+)
    ioSurface?: Buffer; // macOS
  };
}

/** Electron paint event texture with release callback */
export interface PaintTexture {
  textureInfo: TextureInfo;
  release?: () => void;
}

/** Platform-specific texture sharing protocol */
export type Platform = "spout" | "syphon-metal" | "unsupported";
