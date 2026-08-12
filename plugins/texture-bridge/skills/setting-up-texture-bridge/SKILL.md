---
name: setting-up-texture-bridge
description: Use when installing or bootstrapping @napolab/texture-bridge in an Electron app — adding Syphon/Spout output, wiring an offscreen window with useSharedTexture, configuring electron-vite for the native addon, or debugging black/garbled output right after setup.
---

# Setting Up texture-bridge

## Overview

`@napolab/texture-bridge` publishes Electron offscreen-rendered frames to Syphon (macOS) / Spout (Windows) as zero-copy GPU textures. Setup is almost entirely main-process; the renderer just draws.

**Install the right package.** The code ships as a dependency chain — you normally depend on exactly one:

| Package | Use |
|---------|-----|
| `@napolab/texture-bridge-renderer` | **High-level (start here):** `createTextureBridge()`, receivers, discovery |
| `@napolab/texture-bridge-core` | Low-level: `TextureSender`, `sendTextureFromPaintEvent` (root); `forwardSharedTexture` (`/electron` subpath only) |
| `@napolab/texture-bridge` | Raw napi-rs binding — never install directly for app work |

```bash
pnpm add @napolab/texture-bridge-renderer
```

Requires Electron 40+ (first version with `useSharedTexture` paint events).

## Recommended Setup: `createTextureBridge`

The factory **owns the offscreen BrowserWindow** — do not create one yourself, pass a `rendererUrl` instead:

```typescript
// main process
import { app } from "electron";
import { createTextureBridge } from "@napolab/texture-bridge-renderer";

app.whenReady().then(async () => {
  const bridge = await createTextureBridge({
    name: "MyApp",              // Syphon/Spout sender name
    width: 1920,
    height: 1080,
    frameRate: 60,
    rendererUrl: "path/to/index.html",  // file path, file://, or http(s)://
    preview: { enabled: true },         // optional preview window
    // includeAlpha: true,              // forward per-pixel alpha (transparency)
    // pixelExact: true,                // REQUIRED on Electron 40 + scaled displays
  });
  bridge.on("fps", (fps) => console.log(fps));
  bridge.on("error", (err) => console.error(err));
  // bridge.dispose() on teardown — destroys the offscreen window synchronously
});
```

Renderer page: draw continuously (rAF loop); a static page stops producing paint frames. For worker-based rendering use `createWorkerRenderer` from `@napolab/texture-bridge-renderer/client` with `canvas.transferControlToOffscreen()`.

## Electron 40 Retina/DPI Warning

The #1 cause of black or garbled receiver output on Electron 40: the offscreen framebuffer is sized in DIP × display scaleFactor, so a 1920×1080 bridge on Retina produces a 3840×2160 texture that mismatches the declared sender size. Fix: `pixelExact: true`. On Electron ≥ 41 the bridge pins `deviceScaleFactor: 1` automatically and this is a non-issue.

## electron-vite (ESM)

- Add `externalizeDepsPlugin()` to **both** `main` and `preload` configs so the `.node` binary is never bundled.
- ESM mode emits preload as `index.mjs` — reference it as `../preload/index.mjs`, not `.js`.
- pnpm 10 may need the native package approved in `pnpm.onlyBuiltDependencies`.
- Packaging: keep `**/*.node` and `@napolab/texture-bridge*` out of asar (`asarUnpack`).

## Manual (core) Path

Only when you own the window and paint loop yourself:

```typescript
import { TextureSender, sendTextureFromPaintEvent } from "@napolab/texture-bridge-core";

const win = new BrowserWindow({
  show: false,
  webPreferences: { offscreen: { useSharedTexture: true } },  // object form, not `offscreen: true`
});
const sender = new TextureSender("MyApp", 1920, 1080);

win.webContents.on("paint", (details) => {
  const texture = details.texture;
  if (texture === undefined) return;
  try {
    sendTextureFromPaintEvent(sender, texture.textureInfo);
  } finally {
    texture.release();   // always — leaking stalls the shared-texture pool
  }
});
win.webContents.setFrameRate(60);
// teardown: sender.stop()
```

On this path YOU own DPR correctness: Electron ≥ 41 pass `offscreen: { useSharedTexture: true, deviceScaleFactor: 1 }`; Electron 40 reconcile declared size with DIP×scaleFactor yourself.

## Common Mistakes

| Mistake | Reality |
|---------|---------|
| `pnpm add @napolab/texture-bridge` for app work | That's the raw binding. Install `@napolab/texture-bridge-renderer`. |
| Inventing a setup API like `publishSharedTexture(win, ...)` / `forwardSharedTexture(win.webContents, { name })` | No such setup API. High-level setup is `createTextureBridge(options)` and it creates the window itself. `forwardSharedTexture` is a per-frame forwarding primitive (see choosing-texture-bridge-api skill), not a Syphon publisher. |
| `new TextureSender({ name })` / `sender.sendSurface(textureInfo)` / `sender.dispose()` | Real API: `new TextureSender(name, width, height)`; per-paint sends go through `sendTextureFromPaintEvent(sender, textureInfo)`; teardown is `sender.stop()` (terminal, idempotent). |
| `offscreen: true` | CPU path — `details.texture` never arrives. Use `offscreen: { useSharedTexture: true }`. |
| Ignoring display scaling on Electron 40 | Black/garbled output on Retina / Windows 150%. Use `pixelExact: true` or upgrade to Electron ≥ 41. |
| `app.disableHardwareAcceleration()` anywhere | Shared textures require GPU compositing. |

## Verify

`sendRgbaBuffer` needs no Electron — fastest way to split "Electron problem vs bridge problem":

```typescript
// npx tsx sanity.ts — look for sender "CHECK" in your VJ app
import { TextureSender } from "@napolab/texture-bridge-core";
const s = new TextureSender("CHECK", 512, 512);
setInterval(() => s.sendRgbaBuffer(Buffer.alloc(512 * 512 * 4, 0x80), 512, 512), 33);
```
