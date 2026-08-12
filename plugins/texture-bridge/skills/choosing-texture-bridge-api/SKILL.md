---
name: choosing-texture-bridge-api
description: Use when deciding which @napolab/texture-bridge API tier to use for a feature — simple vs core, Syphon/Spout output vs in-app preview/monitor, forwardSharedTexture vs forwardFrames — when reviewing an integration plan that uses the library, or when unsure whether a texture-bridge function, method, or option actually exists.
---

# Choosing a texture-bridge API

## Overview

Three tiers, one decision rule: **who owns the offscreen window, and where do frames go?** All signatures below are the real, current API — do not improvise names.

## Decision Table

| You want | Use | Package |
|----------|-----|---------|
| One offscreen page → Syphon/Spout, library owns the window | `await createTextureBridge(options)` (async, call after `app.whenReady()`) | `@napolab/texture-bridge-renderer` |
| Your own BrowserWindow + paint loop, full send control | `new TextureSender(name, w, h)` + `sendTextureFromPaintEvent(sender, textureInfo)` | `@napolab/texture-bridge-core` |
| In-app monitor of a bridge's output (no Syphon hop) | `bridge.forwardFrames(target, { extraArgs })` | method on `TextureBridge` |
| Forward frames from your **own** paint loop to a renderer | `forwardSharedTexture(textureInfo, target, extraArgs?)` | `@napolab/texture-bridge-core/electron` |
| Receive external Syphon/Spout into your app (display only) | `createSharedTextureReceiver({ senderName, target })` + `.start()` | `@napolab/texture-bridge-renderer` |
| Receive external Syphon/Spout as pixels in JS (analysis/export) | `createTextureReceiver({ senderName })` + `.start()` | `@napolab/texture-bridge-renderer` |
| Raw RGBA push without Electron (sanity check / CI) | `sender.sendRgbaBuffer(buf, w, h)` | `@napolab/texture-bridge-core` |

Any window that consumes forwarded or received shared-texture frames uses the same receiving pair: `installSharedTextureReceiver()` + `consumeSharedTexture(handlers)` from `@napolab/texture-bridge-renderer/client` (see receiving-shared-textures skill).

## forwardFrames vs forwardSharedTexture

Same zero-copy path (`sharedTexture.importSharedTexture` → `sendSharedTexture`), different altitude:

- `bridge.forwardFrames(target, { extraArgs: [slot] })` — **driver**: registers a target for every subsequent paint frame of that bridge. Returns a `FrameForward`; `forward.dispose()` unregisters (idempotent; `bridge.dispose()` clears all). Best-effort: forward failures never surface on the bridge's `"error"` / `frameDropped`, and Syphon/Spout sending is completely independent of forwarding.
- `forwardSharedTexture(textureInfo, target, extraArgs?)` — **primitive** for manual paint loops. Async, never throws synchronously; resolves `undefined` on success or a `ForwardDefect` (`target-destroyed` / `import-failed` / `send-failed`). Lives on the `/electron` subpath so the core main entry stays importable without Electron.

```typescript
// manual paint loop: Syphon and renderer-forward are independent, per frame
win.webContents.on("paint", async (e) => {
  sendTextureFromPaintEvent(sender, e.texture?.textureInfo);              // → Syphon/Spout
  if (e.texture) await forwardSharedTexture(e.texture.textureInfo, monitorWC, [slot]); // → renderer
  e.texture?.release();
});
```

## Anti-Patterns

| Anti-pattern | Instead |
|--------------|---------|
| `capturePage()` polling for previews/monitors (GPU→CPU readback + bitmap IPC per frame) | `bridge.forwardFrames(previewWC, { extraArgs: [id] })` — see migrating-to-forward-frames skill |
| Syphon loopback for in-app preview (publish + receive your own output) | `forwardFrames` — no external dependency, works on both platforms |
| `receiveFrame()` RGBA readback when you only display the frames | `createSharedTextureReceiver` — zero-copy `VideoFrame` |
| Mixing `createTextureBridge` with your own `paint` handler on the same window | Pick one tier. The factory already consumes paint; double handling double-releases textures |
| Holding shared textures to build queues/backpressure buffers | Latest-frame-wins: hold at most one, release/close superseded frames immediately |
| Skipping `texture.release()` (manual loop) or `sender.stop()` / `bridge.dispose()` / `receiver.dispose()` at teardown | Resource lifecycle is deterministic — nothing is GC-cleaned |
| Unpacking `textureInfo.handle` yourself for platform branching | `sendTextureFromPaintEvent` / `forwardSharedTexture` already handle IOSurface vs NT-handle |

## APIs That Do Not Exist

Fabrications seen in the wild — if you find yourself writing these, stop and use the table above: `publishSharedTexture(win, opts)`, `forwardFrames({ sources, target })` as a free function, `receiveFrames()` / `subscribeFrames()`, `@napolab/texture-bridge/preload`, `sender.dispose()` (it's `stop()`), `new TextureSender({ name })` (it's positional `(name, width, height)`).
