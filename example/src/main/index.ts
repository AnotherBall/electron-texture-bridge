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
} from "electron";
import path from "path";

import { createRequire } from "module";
const require = createRequire(import.meta.url);

// Native addon (CommonJS)
const { TextureSender, getPlatform } = require("electron-texture-bridge");

let renderWin: BrowserWindow | null = null;
let previewWin: BrowserWindow | null = null;
let sender: InstanceType<typeof TextureSender> | null = null;
let previewReady = false;

const SHOW_PREVIEW = true;

// Helper to load renderer pages (works in both dev and production)
function loadRendererPage(win: BrowserWindow, page: string) {
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page}`);
  } else {
    win.loadFile(path.join(__dirname, `../renderer/${page}`));
  }
}

// GPU acceleration flags
app.commandLine.appendSwitch("enable-features", "SharedArrayBuffer");
// Force 1x scale factor for exact pixel output (no Retina scaling)
app.commandLine.appendSwitch("force-device-scale-factor", "1");

app.whenReady().then(() => {
  console.log("[texture-bridge] app ready");
  console.log(`[texture-bridge] platform: ${getPlatform()}`);
  console.log(`[texture-bridge] Electron: ${process.versions.electron}`);

  // ---- Offscreen BrowserWindow (rendering source) ----
  console.log(
    "[texture-bridge] creating offscreen window with useSharedTexture..."
  );
  try {
    renderWin = new BrowserWindow({
      width: 1920,
      height: 1080,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        offscreen: {
          useSharedTexture: true,
        },
      },
    });
    console.log("[texture-bridge] offscreen window created");
  } catch (err) {
    console.error("[texture-bridge] offscreen window creation failed:", err);
    return;
  }

  // ---- Preview Window (WebGPU display) ----
  if (SHOW_PREVIEW) {
    console.log("[texture-bridge] creating preview window...");

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

    console.log("[texture-bridge] preview window created");
  }

  // Handle preview ready signal
  ipcMain.on("preview-ready", () => {
    console.log("[texture-bridge] preview window ready");
    previewReady = true;
  });

  // F12 to toggle DevTools
  globalShortcut.register("F12", () => {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused) {
      focused.webContents.toggleDevTools();
    }
  });

  // ---- Texture Sender (Syphon/Spout) ----
  sender = new TextureSender("ElectronVJ-ThreeJS", 1920, 1080);
  console.log(`[texture-bridge] sender created (${sender.platform()})`);

  // ---- FPS tracking ----
  let lastTime = Date.now();
  let frameCount = 0;

  // ---- Paint event handler: GPU texture → Syphon + Preview ----
  renderWin.webContents.on("paint", (event) => {
    frameCount++;
    const now = Date.now();
    if (now - lastTime >= 1000) {
      const currentFps = (frameCount * 1000) / (now - lastTime);
      frameCount = 0;
      lastTime = now;
      console.log(`[texture-bridge] FPS: ${currentFps.toFixed(1)}`);
    }

    const texture = (event as any).texture;
    if (!texture?.textureInfo) return;

    const { textureInfo } = texture;
    const { handle, codedSize } = textureInfo;

    try {
      // 1. Send to Syphon/Spout (GPU zero-copy)
      if (sender) {
        if (process.platform === "win32") {
          if (handle?.dxgiHandle) {
            sender.send(handle.dxgiHandle, codedSize.width, codedSize.height);
          }
        } else {
          if (handle?.ioSurface) {
            sender.sendSurface(
              handle.ioSurface,
              codedSize.width,
              codedSize.height
            );
          }
        }
      }

      // 2. Send texture to Preview window (GPU zero-copy via sharedTexture)
      if (previewWin && !previewWin.isDestroyed() && previewReady) {
        try {
          const imported = sharedTexture.importSharedTexture({ textureInfo });
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
    } catch (err: any) {
      console.error("[texture-bridge] send error:", err.message);
    } finally {
      if (texture.release) {
        texture.release();
      }
    }
  });

  // ---- Set frame rate and load content ----
  renderWin.webContents.setFrameRate(60);

  loadRendererPage(renderWin, "index.html");

  renderWin.webContents.on("did-finish-load", () => {
    console.log("[texture-bridge] content loaded");
  });

  renderWin.webContents.on("did-fail-load", (_event, errorCode, errorDesc) => {
    console.error("[texture-bridge] did-fail-load:", errorCode, errorDesc);
  });

  console.log("[texture-bridge] started");
});

app.on("window-all-closed", () => {
  if (renderWin && !renderWin.isDestroyed()) {
    return;
  }
  if (sender) {
    sender.stop();
    sender = null;
  }
  app.quit();
});

app.on("before-quit", () => {
  globalShortcut.unregisterAll();
  if (sender) {
    sender.stop();
    sender = null;
  }
});
