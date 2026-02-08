# electron-texture-bridge

[![CI](https://github.com/naporin0624/electron-texture-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/naporin0624/electron-texture-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**GPU zero-copy texture sharing from Electron to VJ software via Spout / Syphon Metal.**

[日本語](lang/ja/README.md)

A napi-rs native addon that captures GPU textures from Electron's offscreen rendering (`useSharedTexture`) and shares them with external applications like Resolume Arena, VDMX, OBS, TouchDesigner, and other Syphon/Spout-compatible receivers — all without CPU readback.

## Architecture

```
[Web Worker]              [Chromium GPU Process]         [Native Addon]         [External Apps]
 Three.js / WebGL  ──→   Compositor (Metal / D3D11) ──→  texture-bridge  ──→   Resolume Arena
 OffscreenCanvas          Shared Texture (GPU)            Spout / Syphon        VDMX, OBS, etc.
```

The entire pipeline stays on the GPU. No CPU readback. Sub-frame latency.

## Features

- **GPU Zero-Copy**: Textures are shared directly on the GPU via IOSurface (macOS) or DXGI Shared Handle (Windows)
- **Cross-Platform**: Syphon Metal on macOS, Spout on Windows
- **Electron Native**: Built for Electron 40+'s `useSharedTexture` paint event API
- **WebGPU Preview**: Optional zero-copy preview window using `importExternalTexture`
- **High-Level API**: `sendTextureFromPaintEvent()` handles all platform-specific details
- **napi-rs**: Type-safe Rust → Node.js bindings with prebuilt binaries

## Supported Platforms

| Platform | Protocol | GPU API | Target |
|----------|----------|---------|--------|
| macOS (Apple Silicon) | Syphon Metal | IOSurface + Metal | `aarch64-apple-darwin` |
| macOS (Intel) | Syphon Metal | IOSurface + Metal | `x86_64-apple-darwin` |
| Windows x64 | Spout | DXGI Shared Handle + D3D11 | `x86_64-pc-windows-msvc` |

## Requirements

- **Node.js** 20+
- **pnpm** 10+
- **Rust** toolchain (via [rustup](https://rustup.rs/))
- **Electron** 40.0.0+

### macOS

- Xcode Command Line Tools
- macOS 11.0+ (Metal support)

### Windows

- Visual Studio Build Tools 2019+ with "Desktop development with C++" workload
- Windows SDK 10.0.19041.0+
- DirectX 11 compatible GPU

## Installation

### As a library

```bash
npm install @electron-texture-bridge/core
# or
pnpm add @electron-texture-bridge/core
```

The `@electron-texture-bridge/core` package provides the high-level TypeScript API. Platform-specific native binaries (`@electron-texture-bridge/native-*`) are installed automatically as optional dependencies.

### Building from source

```bash
# Clone with submodules (Syphon source)
git clone --recursive https://github.com/naporin0624/electron-texture-bridge.git
cd electron-texture-bridge
```

#### macOS: Build Syphon Framework

```bash
cd vendor/syphon-src
xcodebuild -project Syphon.xcodeproj \
  -scheme Syphon \
  -configuration Release \
  -derivedDataPath build \
  ONLY_ACTIVE_ARCH=NO \
  BUILD_LIBRARY_FOR_DISTRIBUTION=YES
cp -R build/Build/Products/Release/Syphon.framework ../Syphon.framework
cd ../..
```

#### Windows: Fetch Spout2 SDK

```powershell
git clone --depth 1 https://github.com/leadedge/Spout2.git _spout2_tmp
Copy-Item -Recurse _spout2_tmp/SPOUTSDK/SpoutDirectX/SpoutDX vendor/SpoutDX
Remove-Item -Recurse -Force _spout2_tmp
```

#### Build

```bash
pnpm install
pnpm build          # Builds native addon + core TypeScript package
```

## Quick Start

```typescript
import { BrowserWindow, sharedTexture } from "electron";
import { TextureSender, sendTextureFromPaintEvent } from "@electron-texture-bridge/core";

// 1. Create an offscreen window with shared texture enabled
const win = new BrowserWindow({
  width: 1920,
  height: 1080,
  show: false,
  webPreferences: {
    offscreen: { useSharedTexture: true },
  },
});

// 2. Create a texture sender (visible in Syphon/Spout receivers)
const sender = new TextureSender("MyApp", 1920, 1080);

// 3. Forward paint event textures to Syphon/Spout
win.webContents.on("paint", (event) => {
  const texture = event.texture;
  if (!texture) return;

  try {
    sendTextureFromPaintEvent(sender, texture.textureInfo);
  } finally {
    texture.release?.(); // IMPORTANT: Always release to prevent GPU memory leaks
  }
});

win.webContents.setFrameRate(60);
```

## API Reference

### `@electron-texture-bridge/core`

#### `sendTextureFromPaintEvent(sender, textureInfo)`

High-level convenience function that handles platform-specific texture handle extraction and forwarding.

- **macOS**: Reads `handle.ioSurface` buffer → calls `sender.sendSurface()`
- **Windows**: Reads `handle.ntHandle` buffer as BigInt64LE → calls `sender.send()`

```typescript
function sendTextureFromPaintEvent(
  sender: TextureSender,
  textureInfo: TextureInfo,
): void;
```

#### `TextureSender`

Native class for sending textures to Syphon/Spout receivers.

```typescript
class TextureSender {
  // Create a sender with the given name (visible in receiver apps)
  constructor(name: string, width: number, height: number);

  // Send DXGI handle (Windows) or IOSurfaceID (macOS) - GPU zero-copy
  send(handle: number, width: number, height: number): void;

  // Send IOSurfaceRef pointer directly (macOS only) - GPU zero-copy
  sendSurface(surfaceBuffer: Buffer, width: number, height: number): void;

  // Send raw RGBA pixel data (fallback, involves CPU copy)
  sendRgbaBuffer(data: Buffer, width: number, height: number, bytesPerRow?: number): void;

  // Get the platform protocol name ("spout" | "syphon-metal")
  platform(): string;

  // Release resources
  stop(): void;
}
```

#### `getPlatform()`

Returns the current platform's texture sharing protocol.

```typescript
function getPlatform(): "spout" | "syphon-metal" | "unsupported";
```

#### Types

```typescript
type PixelFormat = "bgra" | "nv12" | "rgba" | "rgbaf16";

interface TextureInfo {
  pixelFormat: PixelFormat;
  codedSize: { width: number; height: number };
  visibleRect: { x: number; y: number; width: number; height: number };
  handle: {
    ntHandle?: Buffer;   // Windows (Electron 40+)
    ioSurface?: Buffer;  // macOS
  };
}

interface PaintTexture {
  textureInfo: TextureInfo;
  release?: () => void;
}

type Platform = "spout" | "syphon-metal" | "unsupported";
```

## Performance

| Path | GPU Copies | Latency | Memory |
|------|-----------|---------|--------|
| Syphon / Spout | 0 (zero-copy) | < 1 frame | Shared GPU memory |
| WebGPU Preview | 0 (zero-copy) | < 1 frame | Shared GPU memory |
| RGBA Buffer (fallback) | 1 (CPU → GPU) | 2-3 frames | CPU + GPU |

## WebGPU Preview Window

The library supports an optional GPU zero-copy preview path using Electron's `sharedTexture` API and WebGPU's `importExternalTexture`:

```typescript
// Main process: forward texture to preview window
const imported = sharedTexture.importSharedTexture({ textureInfo });
sharedTexture.sendSharedTexture({
  frame: previewWin.webContents.mainFrame,
  importedSharedTexture: imported,
});

// Renderer process (preview window): receive and render with WebGPU
sharedTexture.setSharedTextureReceiver((data) => {
  const videoFrame = data.importedSharedTexture.getVideoFrame();
  const externalTexture = device.importExternalTexture({ source: videoFrame });
  // Render with zero-copy GPU texture...
});
```

## Example Application

The `packages/example/` directory contains a full VJ application demonstrating:

- **Three.js + GLSL raymarching** in an OffscreenCanvas Web Worker
- **SDF-based 3D visuals** with audio-reactive parameters
- **WebGPU preview window** with GPU zero-copy texture display
- **Syphon/Spout output** for integration with professional VJ software

```bash
# Run the example
pnpm dev:example
```

Look for "ElectronVJ-ThreeJS" in your Syphon/Spout receiver application.

### Packaging the example

```bash
# macOS
pnpm --filter @electron-texture-bridge/example run build:mac

# Windows
pnpm --filter @electron-texture-bridge/example run build:win
```

## Project Structure

```
electron-texture-bridge/
├── packages/
│   ├── native/                # @electron-texture-bridge/native (napi-rs)
│   │   ├── src/
│   │   │   ├── lib.rs         # napi-rs entry point, TextureSender API
│   │   │   ├── types.rs       # RawTextureHandle type alias
│   │   │   ├── mac/           # macOS: Syphon Metal sender + FFI
│   │   │   └── win/           # Windows: Spout sender + FFI
│   │   ├── cpp/
│   │   │   ├── mac/           # ObjC++ Syphon Metal bridge
│   │   │   └── win/           # C++ Spout bridge
│   │   ├── build.rs           # Platform-specific build configuration
│   │   └── Cargo.toml
│   ├── core/                  # @electron-texture-bridge/core (TypeScript)
│   │   └── src/
│   │       ├── index.ts       # sendTextureFromPaintEvent + re-exports
│   │       └── types.ts       # TextureInfo, PaintTexture types
│   └── example/               # Electron VJ demo app (private)
│       └── src/
│           ├── main/          # Electron main process
│           ├── preload/       # sharedTexture receiver setup
│           └── renderer/      # Three.js + GLSL + WebGPU preview
├── vendor/                    # Third-party SDKs (gitignored, built locally)
│   ├── syphon-src/            # Syphon Framework source (git submodule)
│   ├── Syphon.framework/     # Built framework (macOS)
│   └── SpoutDX/              # Spout SDK (Windows)
├── specs/
│   └── ARCHITECTURE.md        # Detailed architecture documentation
├── Cargo.toml                 # Rust workspace root
├── pnpm-workspace.yaml        # pnpm monorepo config
└── package.json               # Root workspace scripts
```

## Troubleshooting

### Paint event not firing

- Ensure `win.webContents.setFrameRate(60)` is set
- Paint events fire even with `show: false`
- Verify that a `requestAnimationFrame` loop is running in the renderer/worker

### Black texture output

- `preserveDrawingBuffer` is not needed (Chromium compositor reads directly)
- Check pixel format mismatch: Chromium outputs BGRA, ensure the receiver expects BGRA

### Syphon receiver not showing output (macOS)

- Verify `vendor/Syphon.framework` exists and was built correctly
- Clear Gatekeeper quarantine: `xattr -dr com.apple.quarantine vendor/Syphon.framework`
- Check Console.app for error logs

### Spout receiver not showing output (Windows)

- Verify Spout2 is installed on the system
- Ensure GPU drivers are up to date
- DirectX 11 compatible GPU is required

### Freezing / paint events stop

- **Always call `texture.release()`** after processing. The texture pool is small (a few frames). Failing to release will exhaust the pool and stall the paint event pipeline.
- Use `try/finally` to guarantee release:

```typescript
win.webContents.on("paint", (event) => {
  const texture = event.texture;
  if (!texture) return;
  try {
    sendTextureFromPaintEvent(sender, texture.textureInfo);
  } finally {
    texture.release?.();
  }
});
```

## CI/CD

GitHub Actions builds native binaries for all supported platforms:

| Runner | Target | Output |
|--------|--------|--------|
| `macos-14` | `aarch64-apple-darwin` | `texture-bridge.darwin-arm64.node` |
| `macos-13` | `x86_64-apple-darwin` | `texture-bridge.darwin-x64.node` |
| `windows-latest` | `x86_64-pc-windows-msvc` | `texture-bridge.win32-x64-msvc.node` |

Publishing to npm is triggered by version tags (`v*`).

## License

[MIT](LICENSE)
