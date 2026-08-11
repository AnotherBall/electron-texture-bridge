/**
 * Empirical probe: what pixel size does the OSR useSharedTexture paint event
 * actually deliver, as a function of window DIP size, display scaleFactor,
 * and force-device-scale-factor?
 *
 * Usage: electron osr-scale-probe.cjs <plain|dip> [--force-scale-1]
 *   plain = BrowserWindow sized 1920x1080 DIP
 *   dip   = BrowserWindow sized computeDipSize(1920,1080,scaleFactor) (pixelExact math)
 *
 * Findings recorded in reports/2026-08-11-pixelexact-osr-scale-investigation.md
 * (Electron 40: paints at display scale, deviceScaleFactor ignored;
 *  Electron 41: deviceScaleFactor honored, default = display scale;
 *  Electron 42: default flipped to 1.0).
 *
 * Re-run: <electron binary> packages/renderer/scripts/osr-scale-probe.cjs <plain|dip> [--dsf-1] [--force-scale-1]
 */
const { app, BrowserWindow, screen } = require("electron");

const mode = process.argv[2] ?? "plain";
const forceScale = process.argv.includes("--force-scale-1");
if (forceScale) app.commandLine.appendSwitch("force-device-scale-factor", "1");

const WIDTH = 1920;
const HEIGHT = 1080;

const computeDipSize = (w, h, scaleFactor) => ({
  width: Math.max(1, Math.round(w / scaleFactor)),
  height: Math.max(1, Math.round(h / scaleFactor)),
});

app.whenReady().then(() => {
  const scaleFactor = screen.getPrimaryDisplay().scaleFactor;
  const dip = mode === "dip" ? computeDipSize(WIDTH, HEIGHT, scaleFactor) : { width: WIDTH, height: HEIGHT };

  const dsf1 = process.argv.includes("--dsf-1");
  const offscreen = dsf1 ? { useSharedTexture: true, deviceScaleFactor: 1 } : { useSharedTexture: true };
  const win = new BrowserWindow({
    width: dip.width,
    height: dip.height,
    show: false,
    webPreferences: { offscreen },
  });

  let count = 0;
  win.webContents.on("paint", (event) => {
    const texture = event.texture;
    if (!texture) return;
    count += 1;
    const { codedSize, visibleRect, pixelFormat } = texture.textureInfo;
    console.log(
      JSON.stringify({ mode, forceScale, scaleFactor, windowDip: dip, codedSize, visibleRect, pixelFormat }),
    );
    texture.release();
    if (count >= 2) {
      win.destroy();
      app.quit();
    }
  });
  win.webContents.setFrameRate(10);
  win.loadURL("data:text/html,<body style='background:%23ff00ff'><h1>probe</h1></body>");
  setTimeout(() => {
    console.log(JSON.stringify({ mode, forceScale, error: "timeout without paint" }));
    win.destroy();
    app.quit();
  }, 10000);
});
