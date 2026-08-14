# Migration guides

Breaking changes and how to move across them, newest first.

## Migration: Electron 42 / OSR device scale

Electron 42 changed offscreen rendering's default device scale factor to `1.0`
([breaking change](https://www.electronjs.org/docs/latest/breaking-changes)).
From the texture-bridge release that includes this change (see CHANGELOG),
`createTextureBridge` pins `offscreen.deviceScaleFactor: 1` on Electron ≥ 41,
making `width`/`height` mean exact pixels on every display.

- **If you used `pixelExact: true`** (e.g. on Electron 40): keep it — it is a
  no-op on Electron ≥ 41 and still required on 40.
- **If you worked around scaling yourself** (`force-device-scale-factor=1`,
  manual DIP math, removing `pixelExact` after a quarter-resolution output on
  Electron 42): those workarounds are no longer needed once you upgrade.
- **If you intentionally want a scaled framebuffer**, pass your own
  `webPreferences: { offscreen: { useSharedTexture: true, deviceScaleFactor: <n> } }` —
  a user-supplied `offscreen` block always wins.

Empirical background: `reports/2026-08-11-pixelexact-osr-scale-investigation.md`.

## Migration: Synchronous dispose (v0.14+)

Starting from v0.14, `dispose()` also `destroy()`s the offscreen
`renderWindow` synchronously instead of `close()`-ing it — see the
`dispose()` notes under [`TextureBridge`](API.md#texturebridge) above for the two
consumer-visible changes this brings (disposed-time window access, missing
close/beforeunload events).

If you previously worked around the old async `close()` by calling
`bridge.dispose()` and then your own `bridge.renderWindow.destroy()`,
**remove that external `destroy()` call** — calling it after `dispose()` now
targets an already-destroyed window, and Electron does not guarantee a second
`destroy()` is safe. Guard it or move it before `dispose()` if you can't
remove it right away
(`if (!bridge.renderWindow.isDestroyed()) bridge.renderWindow.destroy();`, or
call it **before** `dispose()`, not after).

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

