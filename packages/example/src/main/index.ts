/**
 * Electron Main Process - GPU Zero-Copy Texture Bridge
 *
 * Architecture:
 *   BrowserWindow (offscreen, useSharedTexture: true)
 *          ↓ paint event
 *   textureInfo (IOSurfaceID / DXGI Handle)
 *          │
 *          ├──→ IPC to Preview Window → sharedTexture.import() → WebGPU
 *          │
 *          └──→ Native addon → IOSurfaceLookup() → Metal → Syphon
 */

import {
  app,
  BrowserWindow,
  ipcMain,
  sharedTexture,
  globalShortcut,
  type Event,
} from "electron";
import path from "path";
import {
  TextureSender,
  getPlatform,
  type PaintTexture,
} from "@electron-texture-bridge/core";

interface PaintEvent extends Event {
  texture?: PaintTexture;
}

let renderWin: BrowserWindow | null = null;
let previewWin: BrowserWindow | null = null;
let sender: InstanceType<typeof TextureSender> | null = null;
let previewReady = false;

const SHOW_PREVIEW = true;

function loadRendererPage(win: BrowserWindow, page: string) {
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page}`);
    return;
  }
  win.loadFile(path.join(__dirname, `../renderer/${page}`));
}

// GPU acceleration flags
app.commandLine.appendSwitch("enable-features", "SharedArrayBuffer");
app.commandLine.appendSwitch("force-device-scale-factor", "1");

app.whenReady().then(() => {
  console.log("[texture-bridge] app ready");
  console.log(`[texture-bridge] platform: ${getPlatform()}`);
  console.log(`[texture-bridge] Electron: ${process.versions.electron}`);

  // ---- Offscreen BrowserWindow (rendering source) ----
  try {
    renderWin = new BrowserWindow({
      width: 1920,
      height: 1080,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        offscreen: { useSharedTexture: true },
      },
    });
  } catch (err) {
    console.error("[texture-bridge] offscreen window creation failed:", err);
    return;
  }

  // ---- Preview Window (WebGPU display) ----
  if (SHOW_PREVIEW) {
    previewWin = new BrowserWindow({
      width: 960,
      height: 540,
      title: "Preview (GPU Zero-Copy)",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        preload: path.join(__dirname, "../preload/index.js"),
      },
    });

    loadRendererPage(previewWin, "preview.html");

    previewWin.on("closed", () => {
      previewWin = null;
      previewReady = false;
    });
  }

  ipcMain.on("preview-ready", () => {
    previewReady = true;
  });

  globalShortcut.register("F12", () => {
    const focused = BrowserWindow.getFocusedWindow();
    if (!focused) return;
    focused.webContents.toggleDevTools();
  });

  // ---- Texture Sender (Syphon/Spout) ----
  sender = new TextureSender("ElectronVJ-ThreeJS", 1920, 1080);
  console.log(`[texture-bridge] sender created (${sender.platform()})`);

  // ---- FPS tracking ----
  let lastTime = Date.now();
  let frameCount = 0;

  // ---- Paint event handler: GPU texture → Syphon + Preview ----
  renderWin.webContents.on("paint", (event: PaintEvent) => {
    frameCount++;
    const now = Date.now();
    if (now - lastTime >= 1000) {
      console.log(
        `[texture-bridge] FPS: ${((frameCount * 1000) / (now - lastTime)).toFixed(1)}`,
      );
      frameCount = 0;
      lastTime = now;
    }

    const texture = event.texture;
    if (!texture) return;

    try {
      sendToNative(texture);
      sendToPreview(texture);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[texture-bridge] send error:", message);
    } finally {
      texture.release?.();
    }
  });

  renderWin.webContents.setFrameRate(60);
  loadRendererPage(renderWin, "index.html");

  renderWin.webContents.on("did-fail-load", (_event, errorCode, errorDesc) => {
    console.error("[texture-bridge] did-fail-load:", errorCode, errorDesc);
  });
});

function sendToNative(texture: PaintTexture) {
  if (!sender) return;

  const { handle, codedSize } = texture.textureInfo;

  if (process.platform === "win32") {
    const ntHandle = handle.ntHandle;
    if (!ntHandle || !Buffer.isBuffer(ntHandle)) return;
    const handleValue = Number(ntHandle.readBigInt64LE(0));
    sender.send(handleValue, codedSize.width, codedSize.height);
    return;
  }

  if (process.platform === "darwin") {
    const ioSurface = handle.ioSurface;
    if (!ioSurface) return;
    sender.sendSurface(ioSurface, codedSize.width, codedSize.height);
  }
}

function sendToPreview(texture: PaintTexture) {
  if (!previewWin || previewWin.isDestroyed() || !previewReady) return;

  try {
    const imported = sharedTexture.importSharedTexture({
      textureInfo: texture.textureInfo,
    });
    if (!imported) return;

    sharedTexture
      .sendSharedTexture({
        frame: previewWin.webContents.mainFrame,
        importedSharedTexture: imported,
      })
      .catch(() => {});
  } catch {
    // Ignore preview errors
  }
}

app.on("window-all-closed", () => {
  if (renderWin && !renderWin.isDestroyed()) return;
  if (sender) {
    sender.stop();
    sender = null;
  }
  app.quit();
});

app.on("before-quit", () => {
  globalShortcut.unregisterAll();
  if (!sender) return;
  sender.stop();
  sender = null;
});
