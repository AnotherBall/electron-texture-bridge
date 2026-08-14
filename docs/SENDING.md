# Sending textures

Recipes beyond the [README Quick Start](../README.md#quick-start): capturing external pages, transparency, the low-level core API, DPI correctness, and electron-vite integration.

## Capturing an external page (`rendererUrl` + `webPreferences`)

`rendererUrl` is not limited to local HTML — pass any `http(s)://` URL to capture a live web page (e.g. a YouTube watch page) and forward it to Syphon/Spout. `webPreferences` is merged into the offscreen `BrowserWindow`, so you can set a `partition` (for an isolated/logged-in session), relax `autoplayPolicy`, or disable the sandbox as needed.

```typescript
const bridge = await createTextureBridge({
  name: "WebCapture",
  width: 1920,
  height: 1080,
  rendererUrl: "https://www.youtube.com/watch?v=...",
  preview: { enabled: true },            // open a preview window for instant eyeballing
  webPreferences: {
    partition: "persist:capture",        // isolated session (cookies/login persist here)
    autoplayPolicy: "no-user-gesture-required",
    sandbox: false,
  },
});
```

## Sending with transparency (`includeAlpha`)

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


## Low-Level: Core API

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

### Electron version note: the `paint` event shape

This library targets **Electron 40+** (the first version with `useSharedTexture` paint events). On current Electron (42+) the listener receives a single event object and the texture release method is **non-optional**:

```typescript
win.webContents.on("paint", (details) => {
  const texture = details.texture;
  if (texture === undefined) return;
  try {
    sendTextureFromPaintEvent(sender, texture.textureInfo);
  } finally {
    texture.release();   // Electron 42: non-optional. (Older typings exposed `release?`.)
  }
});
```

Older examples that destructure `(event, dirtyRect, image, texture)` are from a pre-40 API and will not type-check against current Electron. If you build against `electron@>=42` types, drop the optional chaining on `release`.

> ### macOS Retina and Windows DPI scaling
>
> ⚠️ **This is the #1 cause of a black or garbled output on Electron ≤ 40.** How the offscreen framebuffer relates to your requested `width × height` depends on the Electron version:
>
> - **Electron ≥ 41:** `createTextureBridge` pins `webPreferences.offscreen.deviceScaleFactor` to `1`, so the framebuffer is always exactly `width × height` pixels — display scaling does not affect the texture. (`Electron 42` changed the OSR default device scale factor to `1.0`; the bridge sets it explicitly from 41, where the option first appeared.) `pixelExact` is trivially satisfied and effectively a no-op. Verified on macOS; Windows display-scaling verification is pending (the investigation report lists it as an open item) — if you hit clamping on Windows, size down or verify with the [probe script](../packages/renderer/scripts/osr-scale-probe.cjs).
> - **Electron 40:** Chromium sizes the offscreen surface in **device-independent pixels (DIP)**, so the framebuffer delivered to the shared texture is `width × height × display.scaleFactor`. On a macOS Retina display (scaleFactor 2) a sender declared as `new TextureSender("X", 1280, 720)` ends up producing a **2560×1440** texture. Use `createTextureBridge({ pixelExact: true })` to absorb this, or handle DPR yourself on the low-level core path.
>
> **Low-level core** (manual `BrowserWindow` + `paint`) has no absorption on any version — on Electron ≥ 41 pass `offscreen: { useSharedTexture: true, deviceScaleFactor: 1 }` yourself; on Electron 40 keep the sender's declared size and the actual framebuffer size in agreement manually.

## Minimal sanity check (no Electron)

`TextureSender.sendRgbaBuffer()` does **not** require Electron — you can stand up a Syphon/Spout server from plain Node (e.g. via `tsx`) and push raw RGBA. This is the fastest way to isolate a problem: if this shows up in your VJ app, the native binding and Syphon/Spout publishing are healthy and the issue is on the Electron OSR side.

```typescript
// sanity.ts — run with: npx tsx sanity.ts
import { TextureSender, getPlatform } from "@napolab/texture-bridge-core";

const W = 512;
const H = 512;
const sender = new TextureSender("CHECK", W, H);
console.log(getPlatform(), sender.platform()); // e.g. "syphon-metal" "syphon-metal"

const buf = Buffer.alloc(W * H * 4);
let t = 0;
setInterval(() => {
  t += 1;
  for (let i = 0; i < W * H; i++) {
    buf[i * 4 + 0] = (i + t) & 0xff; // R
    buf[i * 4 + 1] = (i * 2 + t) & 0xff; // G
    buf[i * 4 + 2] = t & 0xff; // B
    buf[i * 4 + 3] = 0xff; // A
  }
  sender.sendRgbaBuffer(buf, W, H);
}, 1000 / 30);
```

Open your VJ app (or any Syphon/Spout monitor) and look for a sender named **CHECK** animating. `sendRgbaBuffer` involves a CPU→GPU copy, so it is a debugging/fallback path — not the zero-copy production path — but it is invaluable for splitting "is it Electron or is it the bridge?".

## Using with electron-vite (ESM)

If your app is ESM (`"type": "module"` in `package.json`) and built with **electron-vite**, a few integration details matter:

- **External-ize the native packages.** Add `externalizeDepsPlugin()` to both `main` and `preload` configs so the `.node` binary is never bundled:

  ```typescript
  // electron.vite.config.ts
  import { defineConfig, externalizeDepsPlugin } from "electron-vite";

  export default defineConfig({
    main: { plugins: [externalizeDepsPlugin()] },
    preload: { plugins: [externalizeDepsPlugin()] },
    renderer: {},
  });
  ```

- **Preload is emitted as `.mjs` in ESM mode.** electron-vite outputs the preload as `index.mjs` (not `index.js`), so reference it accordingly from main: `path.join(import.meta.dirname, "../preload/index.mjs")`. A stale `../preload/index.js` reference produces a "preload not found" failure.
- **`import.meta.dirname` is auto-injected** by electron-vite for ESM main, so you don't need a `__dirname` shim in your own main code.
- **Prebuilt binaries resolve via `optionalDependencies`.** With pnpm 10 you may need to approve the native package's build in `onlyBuiltDependencies` (`pnpm.onlyBuiltDependencies` / `allowBuilds`) the first time.
- **Preview works in ESM.** `createTextureBridge({ preview: { enabled: true } })`'s asset resolution is ESM-safe (the renderer package ships `__dirname` shims in its ESM build), so the preview window opens under `"type": "module"`.

