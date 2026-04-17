/**
 * Electron Main Process - GPU Zero-Copy Texture Bridge
 *
 * Uses @napolab/texture-bridge-renderer to handle all boilerplate:
 * offscreen window, paint events, Syphon/Spout sender, and preview.
 */

import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import path from "path";
import { createTextureBridge } from "@napolab/texture-bridge-renderer";
import { TextureReceiver, listSenders } from "@napolab/texture-bridge";

// GPU acceleration flags
app.commandLine.appendSwitch("enable-features", "SharedArrayBuffer");
app.commandLine.appendSwitch("force-device-scale-factor", "1");

function getRendererUrl(): string {
  if (process.env.ELECTRON_RENDERER_URL) {
    return `${process.env.ELECTRON_RENDERER_URL}/index.html`;
  }
  return path.join(__dirname, "../renderer/index.html");
}

app.whenReady().then(async () => {
  console.log("[example] app ready");
  console.log(`[example] Electron: ${process.versions.electron}`);

  globalShortcut.register("F12", () => {
    const focused = BrowserWindow.getFocusedWindow();
    if (!focused) return;
    focused.webContents.toggleDevTools();
  });

  const bridge = await createTextureBridge({
    name: "ElectronVJ-ThreeJS",
    width: 1920,
    height: 1080,
    frameRate: 120,
    rendererUrl: getRendererUrl(),
    preview: { enabled: true, width: 960, height: 540 },
  });

  bridge.on("fps", (fps) => {
    console.log(`[example] FPS: ${fps.toFixed(1)}`);
  });

  bridge.on("error", (err) => {
    console.error("[example] bridge error:", err.message);
  });

  bridge.renderWindow.webContents.on("did-fail-load", (_event, errorCode, errorDesc) => {
    console.error("[example] did-fail-load:", errorCode, errorDesc);
  });

  // ---- Receiver Test Window ----
  let activeReceiver: InstanceType<typeof TextureReceiver> | null = null;
  let activePollTimer: ReturnType<typeof setInterval> | null = null;

  const stopActiveReceiver = () => {
    if (activePollTimer !== null) {
      clearInterval(activePollTimer);
      activePollTimer = null;
    }
    if (activeReceiver) {
      activeReceiver.stop();
      activeReceiver = null;
    }
  };

  const receiverWindow = new BrowserWindow({
    width: 960,
    height: 600,
    title: "Receiver Test",
    webPreferences: {
      preload: path.join(__dirname, "../preload/receiver.js"),
      sandbox: false,
    },
  });

  const receiverUrl = process.env.ELECTRON_RENDERER_URL
    ? `${process.env.ELECTRON_RENDERER_URL}/receiver-test.html`
    : path.join(__dirname, "../renderer/receiver-test.html");
  if (receiverUrl.startsWith("http")) {
    receiverWindow.loadURL(receiverUrl);
  } else {
    receiverWindow.loadFile(receiverUrl);
  }

  ipcMain.handle("list-senders", () => {
    try {
      return listSenders();
    } catch (err) {
      console.error("[receiver-test] listSenders error:", err);
      return [];
    }
  });

  ipcMain.handle("connect-receiver", (_event, senderName: string) => {
    stopActiveReceiver();
    const receiver = new TextureReceiver(senderName);
    console.log(`[receiver-test] connecting to "${senderName}"`, receiver.isConnected());

    activePollTimer = setInterval(() => {
      const frame = receiver.receiveFrame();
      if (!frame) return;
      if (!receiverWindow.isDestroyed()) {
        receiverWindow.webContents.send("receiver-frame", {
          data: frame.data,
          width: frame.width,
          height: frame.height,
        });
      }
    }, 16);

    activeReceiver = receiver;
  });

  ipcMain.handle("disconnect-receiver", () => {
    if (activeReceiver) {
      stopActiveReceiver();
      console.log("[receiver-test] disconnected");
    }
  });

  receiverWindow.on("closed", () => {
    stopActiveReceiver();
    ipcMain.removeHandler("list-senders");
    ipcMain.removeHandler("connect-receiver");
    ipcMain.removeHandler("disconnect-receiver");
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  globalShortcut.unregisterAll();
});
