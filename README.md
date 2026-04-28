# electron-texture-bridge

[![CI](https://github.com/naporin0624/electron-texture-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/naporin0624/electron-texture-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Bidirectional GPU texture sharing between Electron and VJ software via Spout / Syphon Metal.**

[日本語](lang/ja/README.md)

A napi-rs native addon for bidirectional GPU texture sharing with Electron. **Send** textures from Electron's offscreen rendering (`useSharedTexture`) to VJ software, or **receive** textures from external Syphon/Spout servers into your Electron app. Works with Resolume Arena, VDMX, OBS, TouchDesigner, and other Syphon/Spout-compatible applications.

## Architecture

### Sending (Electron → VJ Software)

```
[Web Worker]              [Chromium GPU Process]         [Native Addon]         [External Apps]
 Three.js / WebGL  ──→   Compositor (Metal / D3D11) ──→  texture-bridge  ──→   Resolume Arena
 OffscreenCanvas          Shared Texture (GPU)            Spout / Syphon        VDMX, OBS, etc.
```

The entire send pipeline stays on the GPU. No CPU readback. Sub-frame latency.

### Receiving (VJ Software → Electron)

Two paths are available depending on what you want to do with the frame:

**RGBA readback (works on both platforms):**

```
[External Apps]          [Native Addon]                  [Electron App]
 Resolume Arena   ──→    texture-bridge   ──→ RGBA buf ──→  Process frames
 VDMX, OBS, etc.         Syphon Client / Spout Receiver     Display, analyze, etc.
```

Involves a GPU→CPU readback (Metal blit / D3D11 staging) plus an ArrayBuffer IPC hop. Use when you need to inspect pixels in JS (analysis, save-to-disk, custom color pipelines).

**Zero-copy GPU shared texture (Windows + macOS):**

```
[External Apps]          [Native Addon]        [Electron main]         [Electron renderer]
 Resolume Arena   ──→   texture-bridge   ──→  importSharedTexture ──→  VideoFrame
 VDMX, OBS, etc.        Shared Handle /       + sendSharedTexture       drawImage / WebGPU
                        IOSurface             (zero-copy GPU)           importExternalTexture
```

The texture stays GPU-resident from the sender all the way to the consumer canvas or WebGPU device. No CPU readback, no IPC pixel copy — `drawImage(videoFrame, 0, 0)` is a GPU blit in Chromium when the source is a shared-texture-backed `VideoFrame`.

## Features

- **GPU Zero-Copy Sending**: Textures are shared directly on the GPU via IOSurface (macOS) or DXGI Shared Handle (Windows)
- **GPU Zero-Copy Receiving** (Windows + macOS): Pull textures from Syphon/Spout servers straight into a renderer `VideoFrame` via Electron's `importSharedTexture` — no CPU readback, no IPC pixel copy
- **Transparent Capture**: `includeAlpha: true` makes the offscreen window forward per-pixel alpha into the shared texture, so VJ software receives a layer with proper transparency for overlay / lower-third compositing
- **RGBA Readback Receiving**: `TextureReceiver.receiveFrame()` returns pixels as a `Buffer` on both platforms
- **Sender Discovery**: Enumerate available Syphon servers / Spout senders with real-time change events
- **Cross-Platform**: Syphon Metal on macOS, Spout on Windows
- **Electron Native**: Built for Electron 40+'s `useSharedTexture` paint events and `sharedTexture` module
- **WebGPU Preview**: Optional zero-copy preview window using `importExternalTexture`
- **Factory APIs**: `createTextureBridge()` for sending, `createTextureReceiver()` for RGBA readback, `createSharedTextureReceiver()` for zero-copy GPU delivery — handle all boilerplate
- **Low-Level API**: `sendTextureFromPaintEvent()`, `TextureReceiver`, and `closeNativeHandle()` for full control
- **napi-rs**: Type-safe Rust → Node.js bindings with prebuilt binaries

## Supported Platforms

| Platform | Protocol | GPU API | Target |
|----------|----------|---------|--------|
| macOS (Apple Silicon) | Syphon Metal | IOSurface + Metal | `aarch64-apple-darwin` |
| macOS (Intel) | Syphon Metal | IOSurface + Metal | `x86_64-apple-darwin` |
| Windows x64 | Spout | DXGI Shared Handle + D3D11 | `x86_64-pc-windows-msvc` |

### Feature support by platform

| Feature | Windows (Spout) | macOS (Syphon Metal) |
|---------|:---------------:|:--------------------:|
| Sender (Electron paint → external apps) | Yes | Yes |
| Receiver, RGBA readback (`receiveFrame()`) | Yes | Yes |
| Receiver, zero-copy GPU (`receiveSharedTexture()` + `createSharedTextureReceiver`) | Yes | Yes |
| Sender discovery (`listSenders()` / `SenderDiscovery`) | Yes | Yes |
| Transparent capture (`createTextureBridge({ includeAlpha: true })`) | Yes | Yes |

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

> **Detailed guide:** See [docs/INSTALLATION.md](docs/INSTALLATION.md) for step-by-step instructions covering prerequisites, building from source, integration, packaging, and troubleshooting.

### As a library (recommended)

```bash
npm install @napolab/texture-bridge-renderer
# or
pnpm add @napolab/texture-bridge-renderer
```

`@napolab/texture-bridge-renderer` is the high-level package for most users. It includes `@napolab/texture-bridge-core` and `@napolab/texture-bridge` as dependencies.

For advanced use cases that need direct control over the pipeline:

```bash
npm install @napolab/texture-bridge-core
```

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

The native addon compiles sources from both `SpoutDX/` (C++ wrapper) and
`SpoutGL/` (shared-memory + D3D helpers that `SpoutDX.h` relative-includes), so
preserve the Spout2 subdirectory layout under `vendor/Spout2/`:

```powershell
git clone --depth 1 https://github.com/leadedge/Spout2.git _spout2_tmp
New-Item -ItemType Directory -Force vendor/Spout2 | Out-Null
Copy-Item -Recurse _spout2_tmp/SPOUTSDK/SpoutDirectX vendor/Spout2/SpoutDirectX
Copy-Item -Recurse _spout2_tmp/SPOUTSDK/SpoutGL vendor/Spout2/SpoutGL
Remove-Item -Recurse -Force _spout2_tmp
```

#### Build

```bash
pnpm install
pnpm build          # Builds native addon + core + renderer packages
```

## Quick Start

### High-Level: Factory API (recommended)

The simplest way to use electron-texture-bridge. The factory handles offscreen window creation, paint event wiring, Syphon/Spout sender, and optional preview window — all in one call.

```typescript
// main process
import { app } from "electron";
import { createTextureBridge } from "@napolab/texture-bridge-renderer";

app.whenReady().then(async () => {
  const bridge = await createTextureBridge({
    name: "MyApp",
    width: 1920,
    height: 1080,
    frameRate: 60,
    rendererUrl: "path/to/index.html",  // Your renderer page with Web Worker
    preview: { enabled: true },
  });

  bridge.on("fps", (fps) => console.log(`FPS: ${fps.toFixed(1)}`));
  bridge.resize(3840, 2160);  // Resizes all layers automatically
  // bridge.dispose();         // Clean up when done
});
```

```html
<!-- renderer page (index.html) -->
<canvas id="canvas" width="1920" height="1080"></canvas>
<script type="module">
  import MyWorker from './my-worker?worker';
  const canvas = document.getElementById('canvas');
  const offscreen = canvas.transferControlToOffscreen();
  const worker = new MyWorker();
  worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen]);
</script>
```

### Sending with transparency (`includeAlpha`)

Pass `includeAlpha: true` to forward the page's per-pixel alpha into the shared BGRA texture. VJ software (Resolume, VDMX, etc.) will then receive the layer with its transparency mask intact, so it can be composited over other layers.

```typescript
const bridge = await createTextureBridge({
  name: "MyApp",
  width: 1920,
  height: 1080,
  rendererUrl: "path/to/index.html",
  includeAlpha: true,
});
```

The flag is opt-in (default `false`). When set, `createTextureBridge` builds the offscreen `BrowserWindow` with `transparent: true` and `backgroundColor: "#00000000"` — both keys are required for Chromium's compositor to emit a transparent backdrop into the shared texture. The page itself must also use a transparent background or the alpha will be overwritten:

```css
html, body { background: transparent; }
```

WebGL/Canvas content rendered with non-1.0 alpha (or pre-multiplied alpha disabled appropriately for your pipeline) will then flow through to the shared texture's alpha channel.

### Receiving: Factory API

Pull textures from external Syphon/Spout servers into your Electron app.

```typescript
// main process
import { app } from "electron";
import { createTextureReceiver, SenderDiscovery } from "@napolab/texture-bridge-renderer";

app.whenReady().then(() => {
  // Discover available servers
  const discovery = new SenderDiscovery();
  discovery.on("added", (senders) => {
    console.log("New senders:", senders);
  });
  discovery.start(1000); // Poll every second

  // Receive from a specific server
  const receiver = createTextureReceiver({
    senderName: "Resolume Arena",
  });

  receiver.on("frame", (frame) => {
    // frame: { data: Buffer, width: number, height: number }
    console.log(`Received ${frame.width}x${frame.height} frame`);
  });

  receiver.on("fps", (fps) => console.log(`Receive FPS: ${fps.toFixed(1)}`));
  receiver.start();

  // Clean up
  // receiver.dispose();
  // discovery.dispose();
});
```

### Low-Level: Core API

For full control over the pipeline, use `@napolab/texture-bridge-core` directly.

```typescript
import { BrowserWindow } from "electron";
import { TextureSender, sendTextureFromPaintEvent } from "@napolab/texture-bridge-core";

const win = new BrowserWindow({
  width: 1920,
  height: 1080,
  show: false,
  webPreferences: {
    offscreen: { useSharedTexture: true },
  },
});

const sender = new TextureSender("MyApp", 1920, 1080);

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

## Receiving textures from Spout/Syphon

There are two receive paths, and they solve different problems:

- **`TextureReceiver.receiveFrame()` / `createTextureReceiver()`** — RGBA readback. The native side performs a GPU→CPU blit (D3D11 staging / Metal blit), then hands you an `ArrayBuffer` via an IPC hop. Roughly ~8 MB per 1080p frame copied through IPC. Use it when you actually want pixel data in JavaScript (analysis, image export, custom color pipelines).
- **`TextureReceiver.receiveSharedTexture()` / `createSharedTextureReceiver()` / `consumeSharedTexture()`** — zero-copy GPU delivery. The native side mints a platform-native shared handle (DXGI NT handle on Windows, IOSurface pointer on macOS) per frame and passes it through Electron's `sharedTexture.importSharedTexture` + `sendSharedTexture` pair into the renderer as a `VideoFrame`. No CPU readback, no ArrayBuffer IPC copy. `ctx.drawImage(videoFrame, 0, 0)` stays on the GPU and `GPUDevice.importExternalTexture({ source: videoFrame })` exposes the same texture to WebGPU without a copy. Use it when you just want to display or GPU-process the incoming video.

Pick whichever matches what you will do with the frame.

> **Status.** The zero-copy GPU path is verified end-to-end on both Windows (Spout) and macOS (Syphon Metal). On macOS the receiver mints a fresh per-frame `IOSurfaceRef` backed by a per-receiver staging `MTLTexture` and Y-flips it through a tiny render pass so `drawImage(videoFrame)` / `importExternalTexture({ source: videoFrame })` render right-side-up. The same `closeNativeHandle()` ownership contract applies on both platforms.

### Main process: `createSharedTextureReceiver`

```typescript
// main process
import { app, BrowserWindow } from "electron";
import { createSharedTextureReceiver } from "@napolab/texture-bridge-renderer";

app.whenReady().then(() => {
  const receiverWindow = new BrowserWindow({
    width: 960,
    height: 540,
    webPreferences: {
      preload: /* path to preload that installs the consumer */ undefined,
    },
  });

  const bridge = createSharedTextureReceiver({
    senderName: "Resolume Arena",   // required
    target: receiverWindow.webContents,
    pollIntervalMs: 8,              // optional, defaults to 16
    appName: undefined,             // optional, macOS filter
    serverUuid: undefined,          // optional, macOS UUID
    extraArgs: [],                  // optional, forwarded to sendSharedTexture(..., ...args)
  });

  bridge.on("fps", (fps) => console.log(`[receiver] ${fps.toFixed(1)} fps`));
  bridge.on("error", (err) => console.error("[receiver]", err.message));
  bridge.on("disposed", () => console.log("[receiver] disposed"));

  bridge.start();

  receiverWindow.on("closed", () => {
    bridge.dispose();   // stops polling, releases the native receiver, emits "disposed"
  });
});
```

The bridge runs with a drop-latest policy: if a previous `sendSharedTexture` is still in flight when the next poll fires, the tick is skipped. This keeps at most one imported-texture reference alive on the main process and prevents frame pile-up when the renderer is slow.

### Renderer process: `installSharedTextureReceiver` + `consumeSharedTexture`

```typescript
// renderer process (or preload with nodeIntegration: true, contextIsolation: false)
import {
  installSharedTextureReceiver,
  consumeSharedTexture,
} from "@napolab/texture-bridge-renderer/client";

// Call once at startup. Binds Electron's single
// sharedTexture.setSharedTextureReceiver slot to an internal pool so multiple
// consumers can coexist. Idempotent.
installSharedTextureReceiver();

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

const registration = consumeSharedTexture({
  onFrame: ({ textureId, videoFrame }) => {
    if (canvas.width !== videoFrame.displayWidth) canvas.width = videoFrame.displayWidth;
    if (canvas.height !== videoFrame.displayHeight) canvas.height = videoFrame.displayHeight;
    // Zero-copy GPU blit in Chromium when the source is a shared-texture VideoFrame.
    ctx.drawImage(videoFrame, 0, 0);
  },
  onError: (err) => console.error("[consumer]", err),
});

// registration.dispose();  // optional — removes this consumer from the pool
```

`videoFrame` is a standard Web `VideoFrame`. For WebGPU, hand it to `device.importExternalTexture({ source: videoFrame })` instead of `drawImage` — that path is also zero-copy. You do **not** need to call `videoFrame.close()` yourself; the consumer wrapper closes it after your handler's returned promise settles.

### Optional: polling `TextureReceiver.receiveSharedTexture()` directly

If you want to drive the poll loop yourself (e.g. to integrate with a custom scheduler), use the low-level primitive and forward the handle to `sharedTexture.importSharedTexture` by hand:

```typescript
import { TextureReceiver, closeNativeHandle } from "@napolab/texture-bridge";
import { sharedTexture } from "electron";

const receiver = new TextureReceiver("Resolume Arena");
const frame = receiver.receiveSharedTexture();
if (frame) {
  const handle =
    process.platform === "win32" ? { ntHandle: frame.handle } : { ioSurface: frame.handle };
  try {
    const imported = sharedTexture.importSharedTexture({
      textureInfo: {
        codedSize: { width: frame.width, height: frame.height },
        handle,
        pixelFormat: frame.pixelFormat,   // "bgra" | "rgba" | "rgbaf16"
      },
    });
    // ... deliver `imported` via sendSharedTexture, then imported.release() ...
  } catch (err) {
    // importSharedTexture threw before taking ownership — release ourselves.
    closeNativeHandle(frame.handle);
    throw err;
  }
}
```

> **Ownership contract.** Every `SharedTextureFrame.handle` returned by `receiveSharedTexture()` is a freshly-minted native handle. On a successful `importSharedTexture` Electron takes ownership and releases it when the imported texture is released. On **any** path that does not feed the handle into `importSharedTexture` (unknown pixel format, target destroyed, `importSharedTexture` threw, you decided to skip the frame), you **must** call `closeNativeHandle(frame.handle)` or you will leak an NT HANDLE (Windows) / `IOSurfaceRef` (macOS) per frame.

### Discovering available senders

```typescript
import { listSenders } from "@napolab/texture-bridge-renderer";

for (const s of listSenders()) {
  console.log(s.name, s.appName ?? "", s.uuid ?? "");
}
// [{ name: "Resolume Arena", appName: "Resolume Arena", uuid: "..." }, ...]
```

For continuous change notifications, use `SenderDiscovery` (see [API Reference](#senderdiscovery)).

### Renderer context isolation

Electron's `sharedTexture` module is only accessible from the main and renderer processes that have `electron` resolvable at runtime. Importing `@napolab/texture-bridge-renderer/client` directly from a Vite-driven renderer can fail during dev pre-bundle (`path.join is not a function`), because Vite cannot pre-bundle the `electron` CJS module. Two ways out:

1. **Recommended for simple cases:** put `installSharedTextureReceiver()` and `consumeSharedTexture()` in a **preload script** (bundled by electron-vite / electron-builder with `externalizeDepsPlugin`), and run the receiver window with `nodeIntegration: true, contextIsolation: false`. The example app does this — see [`packages/example/src/preload/receiver.ts`](packages/example/src/preload/receiver.ts).
2. **Context-isolated setups:** bind the consumer in the preload, then forward each `VideoFrame` to the isolated renderer world via `window.postMessage(videoFrame, "*", [videoFrame])` (the `VideoFrame` is a transferable). Close it on the renderer side after use.

## API Reference

### `@napolab/texture-bridge-renderer`

#### `createTextureBridge(options): Promise<TextureBridge>`

Factory function that creates a fully-wired texture bridge. Must be called after `app.whenReady()`.

```typescript
interface TextureBridgeOptions {
  name: string;            // Syphon/Spout sender name
  width: number;           // Texture width in pixels
  height: number;          // Texture height in pixels
  frameRate?: number;      // Target frame rate (default: 60)
  rendererUrl: string;     // URL to load (file path, file://, or http://)
  preview?: PreviewOptions;
  webPreferences?: Electron.WebPreferences;
  includeAlpha?: boolean;  // Forward per-pixel alpha into the shared texture (default: false)
}

interface PreviewOptions {
  enabled?: boolean;       // Open preview window (default: false)
  width?: number;          // Preview window width
  height?: number;         // Preview window height
  title?: string;          // Preview window title
}
```

#### `TextureBridge`

The returned handle provides:

```typescript
interface TextureBridge {
  on(event: "fps", listener: (fps: number) => void): this;
  on(event: "ready", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "resize", listener: (width: number, height: number) => void): this;
  on(event: "disposed", listener: () => void): this;

  resize(width: number, height: number): void;  // Cascades to all layers + Worker
  openPreview(): void;
  closePreview(): void;
  dispose(): void;

  readonly renderWindow: BrowserWindow;
  readonly previewWindow: BrowserWindow | null;
  readonly isDisposed: boolean;
}
```

#### `createWorkerRenderer(options)` (from `renderer/client`)

Renderer-process helper for setting up a canvas-to-Worker pipeline with automatic resize propagation.

```typescript
import { createWorkerRenderer } from "@napolab/texture-bridge-renderer/client";

createWorkerRenderer({
  worker: new MyWorker(),
  width: 1920,
  height: 1080,
});
```

#### `installSharedTextureReceiver()` (from `renderer/client`)

```typescript
import { installSharedTextureReceiver } from "@napolab/texture-bridge-renderer/client";

installSharedTextureReceiver();
```

Binds Electron's single `sharedTexture.setSharedTextureReceiver` slot to an internal consumer pool so multiple `consumeSharedTexture` calls can coexist. Idempotent — call once at renderer startup before any `consumeSharedTexture` call. Requires Electron 40+.

#### `consumeSharedTexture(handlers)` (from `renderer/client`)

```typescript
import { consumeSharedTexture } from "@napolab/texture-bridge-renderer/client";

const registration = consumeSharedTexture({
  onFrame: ({ textureId, videoFrame }, ...extraArgs) => {
    // videoFrame is a Web VideoFrame backed by the shared texture.
    // drawImage(videoFrame) — zero-copy GPU blit
    // device.importExternalTexture({ source: videoFrame }) — WebGPU path
  },
  onError: (err) => console.error(err),
});

registration.dispose();   // remove this consumer from the pool (idempotent)
```

Registers a consumer in the pool bound by `installSharedTextureReceiver`. Each active consumer receives its own `VideoFrame` per incoming imported texture; the wrapper closes the `VideoFrame` after `onFrame` settles and releases the underlying imported texture exactly once after all consumers have finished.

#### `createMultiDispatcher(options)` (from `renderer/client`)

Low-level fan-out primitive: one `handler(...)` invokes all registered callbacks and reduces their results through a user-supplied `combine` function. `installSharedTextureReceiver` is built on top of it, but it is exported so you can build your own "one upstream slot, many downstream consumers" adapters (e.g. a preload-to-renderer bridge). See JSDoc in `packages/renderer/src/client/multi-dispatcher.ts` for the full API.

#### `createSharedTextureReceiver(options): SharedTextureReceiverBridge`

Factory function that creates a **zero-copy GPU** receiver bridge. Polls `TextureReceiver.receiveSharedTexture()` and delivers each frame to a target renderer via Electron's `sharedTexture.importSharedTexture` + `sendSharedTexture` pair. Verified end-to-end on both Windows (Spout) and macOS (Syphon Metal).

```typescript
interface SharedTextureReceiverOptions {
  senderName: string;                 // Syphon server / Spout sender name
  target: Electron.WebContents;       // Receiver window webContents
  pollIntervalMs?: number;            // default 16 (~60 fps); drop-latest applied
  appName?: string;                   // (macOS only) filter by application name
  serverUuid?: string;                // (macOS only) connect by server UUID
  extraArgs?: readonly unknown[];     // forwarded to sendSharedTexture(..., ...args)
}

interface SharedTextureReceiverBridge {
  on(event: "fps", listener: (fps: number) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "disposed", listener: () => void): this;

  start(): void;                      // begin polling
  stop(): void;                       // pause polling (bridge can be started again)
  dispose(): void;                    // terminal: stop + release native receiver
  [Symbol.dispose](): void;           // same as dispose()

  readonly isDisposed: boolean;
}
```

`dispose()` is terminal and idempotent. After 10 consecutive `"error"` events the bridge stops itself automatically (circuit breaker) and emits one final error describing the shutdown.

#### `createTextureReceiver(options): TextureReceiverBridge`

Factory function that creates a texture receiver with polling and FPS tracking.

```typescript
interface TextureReceiverBridgeOptions {
  senderName: string;      // Syphon server name / Spout sender name
  appName?: string;        // (macOS only) Filter by application name
  serverUuid?: string;     // (macOS only) Connect by server UUID
  pollIntervalMs?: number; // Frame polling interval in ms (default: 16)
}
```

#### `TextureReceiverBridge`

```typescript
interface TextureReceiverBridge {
  on(event: "frame", listener: (frame: ReceivedFrame) => void): this;
  on(event: "fps", listener: (fps: number) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "disposed", listener: () => void): this;

  start(): void;   // Begin polling for frames
  stop(): void;    // Pause polling
  dispose(): void; // Release all resources

  readonly isDisposed: boolean;
}

interface ReceivedFrame {
  data: Buffer;    // RGBA pixel data
  width: number;
  height: number;
}
```

#### `SenderDiscovery`

EventEmitter that polls for available Syphon servers / Spout senders and emits diff events.

```typescript
const discovery = new SenderDiscovery();
discovery.on("added", (senders: SenderInfo[]) => { /* new senders appeared */ });
discovery.on("removed", (senders: SenderInfo[]) => { /* senders disappeared */ });
discovery.on("updated", (senders: SenderInfo[]) => { /* full current list */ });
discovery.start(1000); // Poll interval in ms
discovery.getSenders(); // Current sender list
discovery.dispose();

interface SenderInfo {
  name: string;
  appName?: string;  // macOS only
  uuid?: string;     // macOS only
}
```

#### Worker Protocol Types (from `renderer/worker`)

```typescript
import type { WorkerMessage } from "@napolab/texture-bridge-renderer/worker";

// In your Worker:
self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  switch (e.data.type) {
    case "init":   /* e.data.canvas: OffscreenCanvas */ break;
    case "resize": /* e.data.width, e.data.height */   break;
    case "dispose": break;
  }
};
```

### `@napolab/texture-bridge-core`

#### `sendTextureFromPaintEvent(sender, textureInfo)`

Low-level convenience function that handles platform-specific texture handle extraction and forwarding.

- **macOS**: Reads `handle.ioSurface` buffer → calls `sender.sendSurface()`
- **Windows**: Reads `handle.ntHandle` buffer as BigInt64LE → calls `sender.send()`

#### `TextureSender`

Native class for sending textures to Syphon/Spout receivers.

```typescript
class TextureSender {
  constructor(name: string, width: number, height: number);
  send(handle: number, width: number, height: number): void;
  sendSurface(surfaceBuffer: Buffer, width: number, height: number): void;
  sendRgbaBuffer(data: Buffer, width: number, height: number, bytesPerRow?: number): void;
  platform(): string;
  stop(): void;  // Terminal — releases native resources immediately
}
```

#### `TextureReceiver`

Native class for receiving textures from Syphon/Spout senders.

```typescript
class TextureReceiver {
  constructor(senderName: string, appName?: string, serverUuid?: string);
  hasNewFrame(): boolean;
  receiveFrame(): ReceivedFrame | null;                  // RGBA readback
  receiveSharedTexture(): SharedTextureFrame | null;     // zero-copy GPU handle (Windows + macOS)
  isConnected(): boolean;
  getWidth(): number;
  getHeight(): number;
  platform(): string;
  stop(): void;  // Terminal — releases native resources immediately
}

interface SharedTextureFrame {
  width: number;
  height: number;
  pixelFormat: "bgra" | "rgba" | "rgbaf16";
  ownerPid: number;        // process ID that owns the handle (usually process.pid)
  handle: Buffer;          // 8-byte LE: NT HANDLE on Windows, IOSurfaceRef pointer on macOS
}
```

Each `handle` is a fresh, owning native reference. Either hand it to `sharedTexture.importSharedTexture` (Electron takes ownership) or call `closeNativeHandle(handle)` — otherwise you leak an NT HANDLE / IOSurface per frame.

#### `closeNativeHandle(handle)`

```typescript
function closeNativeHandle(handle: Buffer): void;
```

Releases a native shared-texture handle (NT HANDLE on Windows, `IOSurfaceRef` on macOS) that was minted by `receiveSharedTexture()` but never consumed by Electron's `importSharedTexture`. Only call this for handles you have **not** forwarded to Electron; Electron releases handles it has taken ownership of on its own.

#### Resource Lifecycle

Both `TextureSender` and `TextureReceiver` follow deterministic disposal semantics:

1. **`stop()` releases native resources immediately.** Do not rely on garbage collection for cleanup.
2. **`stop()` is terminal.** The instance cannot be reused afterward. Any operational method called after `stop()` will throw an error (sender) or return a safe terminal value (receiver).
3. **`stop()` is idempotent.** Repeated calls are safe and return without error.
4. **Higher-level `dispose()` methods** (on `TextureBridge`, `TextureReceiverBridge`) forward to native `stop()` and are also terminal.

```typescript
// Recommended pattern
const sender = new TextureSender("MyApp", 1920, 1080);
try {
  // ... use sender ...
} finally {
  sender.stop();
}

// Also supports Symbol.dispose for use with `using` declarations.
// Requires Node.js 22+ (or a runtime with Symbol.dispose support) and
// `"lib": ["ESNext.Disposable"]` in your tsconfig.json.
// Import from @napolab/texture-bridge-core for runtime Symbol.dispose patching.
using sender = new TextureSender("MyApp", 1920, 1080);
```

#### `listSenders()`

```typescript
function listSenders(): Array<{ name: string; appName?: string; uuid?: string }>;
```

#### `getPlatform()`

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

### Sending

| Path | GPU Copies | Latency | Memory |
|------|-----------|---------|--------|
| Syphon / Spout | 0 (zero-copy) | < 1 frame | Shared GPU memory |
| WebGPU Preview | 0 (zero-copy) | < 1 frame | Shared GPU memory |
| RGBA Buffer (fallback) | 1 (CPU → GPU) | 2-3 frames | CPU + GPU |

### Receiving

| Path | GPU Copies | IPC Copy | Latency | Notes |
|------|-----------|----------|---------|-------|
| Shared Texture (`createSharedTextureReceiver` / `receiveSharedTexture`) | 0 (zero-copy) | None (handle only) | < 1 frame | Windows + macOS. Frame delivered as `VideoFrame` — use `drawImage` or WebGPU `importExternalTexture` |
| RGBA Readback (`createTextureReceiver` / `receiveFrame`) | 1 (GPU → CPU staging) | ~8 MB per 1080p frame | 2–3 frames | Use when you actually need pixel data in JS |

Approx. readback bandwidth at 60 fps: ~500 MB/s at 1080p, ~2 GB/s at 4K — consider reducing poll rate or switching to the shared-texture path for display-only workloads.

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
pnpm --filter @napolab/texture-bridge-example run build:mac

# Windows
pnpm --filter @napolab/texture-bridge-example run build:win
```

## Project Structure

```
electron-texture-bridge/
├── packages/
│   ├── native/                # @napolab/texture-bridge (napi-rs)
│   │   ├── src/
│   │   │   ├── lib.rs         # napi-rs entry point, TextureSender/Receiver API
│   │   │   ├── types.rs       # RawTextureHandle type alias
│   │   │   ├── mac/           # macOS: Syphon Metal sender + receiver + FFI
│   │   │   └── win/           # Windows: Spout sender + receiver + FFI
│   │   ├── cpp/
│   │   │   ├── mac/           # ObjC++ Syphon Metal bridge (send + receive + discovery)
│   │   │   └── win/           # C++ Spout bridge (send + receive + discovery)
│   │   ├── build.rs           # Platform-specific build configuration
│   │   └── Cargo.toml
│   ├── core/                  # @napolab/texture-bridge-core (TypeScript)
│   │   └── src/
│   │       ├── index.ts       # sendTextureFromPaintEvent + re-exports (sender + receiver)
│   │       └── types.ts       # TextureInfo, PaintTexture, SenderInfo, ReceivedFrame
│   ├── renderer/              # @napolab/texture-bridge-renderer (TypeScript)
│   │   └── src/
│   │       ├── index.ts       # createTextureBridge + createTextureReceiver + SenderDiscovery
│   │       ├── bridge.ts      # Sender factory implementation (EventEmitter)
│   │       ├── receiver.ts    # Receiver factory (polling + FPS tracking)
│   │       ├── discovery.ts   # SenderDiscovery (polling + diff events)
│   │       ├── types.ts       # TextureBridgeOptions, TextureBridge
│   │       ├── preview-manager.ts  # Preview window lifecycle
│   │       ├── fps-counter.ts # FPS measurement utility
│   │       ├── client/        # Renderer-process helpers
│   │       │   ├── index.ts   # createWorkerRenderer
│   │       │   └── worker-protocol.ts  # Worker message types
│   │       └── assets/        # Static files (preview.html, preload)
│   └── example/               # Electron VJ demo app (private)
│       └── src/
│           ├── main/          # Electron main process (~30 LOC)
│           └── renderer/      # Three.js + GLSL + Web Worker
├── vendor/                    # Third-party SDKs (gitignored, built locally)
│   ├── syphon-src/            # Syphon Framework source (git submodule)
│   ├── Syphon.framework/     # Built framework (macOS)
│   └── Spout2/               # Spout SDK (Windows) — SpoutDirectX/ + SpoutGL/
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

### Zero-copy shared-texture receiver

- **Requires Electron 40+** — uses the `sharedTexture.importSharedTexture` / `sendSharedTexture` / `setSharedTextureReceiver` module. Older Electron will throw at import time.
- **`listSenders()` shows `<sender>_1` suffixes.** A previous sender process of the same name was killed uncleanly and its shared-memory directory entry is lingering. Start (or restart) the real sender — it will either reclaim the clean name or the stale suffix will go away on its own on the next publisher cycle.
- **Handle leak after the target window closes.** If you poll `receiveSharedTexture()` directly, always call `closeNativeHandle(frame.handle)` on any path that does not forward the handle to `sharedTexture.importSharedTexture` — including "target was destroyed", "unknown pixel format", and "I decided to drop this frame". `createSharedTextureReceiver` does this for you.
- **Windows staging texture.** The receiver creates its staging texture with `MISC_SHARED_NTHANDLE | MISC_SHARED` (no keyed mutex), so consumers do not need to `AcquireSync` per frame — Electron imports it directly.

### Freezing / paint events stop

- **Always call `texture.release()`** after processing. The texture pool is small (a few frames). Failing to release will exhaust the pool and stall the paint event pipeline.
- When using `createTextureBridge()`, this is handled automatically.
- When using the low-level core API, use `try/finally`:

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

## Migration: Explicit Disposal (v0.6+)

Starting from v0.6, `stop()` and `dispose()` are **terminal operations** that immediately release native GPU/IPC resources. Previously, resource cleanup depended on JavaScript garbage collection timing.

### What changed

| Behavior | Before (v0.5) | After (v0.6+) |
|----------|---------------|---------------|
| `sender.stop()` | No-op (GC handles cleanup) | Drops native resources immediately |
| `sender.send()` after `stop()` | Silently worked | Throws `"TextureSender has been stopped"` |
| `receiver.receiveFrame()` after `stop()` | Returned stale/null | Returns `null` |
| `receiver.hasNewFrame()` after `stop()` | Returned stale value | Returns `false` |
| `bridge.dispose()` | Stopped timers only | Fully tears down native sender + preview |

### How to migrate

**Sender** — always pair with explicit teardown:

```typescript
const sender = new TextureSender("MyApp", 1920, 1080);
try {
  sender.send(handle, w, h);
} finally {
  sender.stop(); // resources released immediately
}
```

**Receiver** — same pattern:

```typescript
const receiver = new TextureReceiver("MySender");
try {
  const frame = receiver.receiveFrame();
} finally {
  receiver.stop();
}
```

**High-level bridge** — no code changes needed if you already call `dispose()`:

```typescript
const bridge = await createTextureBridge({ ... });
// ... use bridge ...
bridge.dispose(); // now deterministic
```

**`using` declarations** (Node.js 22+, `"lib": ["ESNext.Disposable"]`):

```typescript
// Import from @napolab/texture-bridge-core for Symbol.dispose support
using sender = new TextureSender("MyApp", 1920, 1080);
// resources automatically released at end of scope
```

### Key rules

1. Once `stop()` or `dispose()` is called, the instance is permanently closed
2. Repeated `stop()` / `dispose()` calls are safe (idempotent)
3. Do not reuse stopped instances — create a new one instead
4. Do not rely on GC to release native resources

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
