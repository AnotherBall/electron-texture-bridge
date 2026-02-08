/**
 * Preview window preload script (CJS).
 *
 * Sets up the shared texture receiver and exposes a minimal API
 * to the preview renderer via contextBridge.
 */
const { contextBridge, ipcRenderer, sharedTexture } = require("electron");

let textureCallback = null;

try {
  sharedTexture.setSharedTextureReceiver(async (data) => {
    const imported = data.importedSharedTexture;
    if (textureCallback && imported) {
      textureCallback(imported);
    }
  });
} catch {
  // sharedTexture may not be available in all contexts
}

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  onTextureFrame: (callback) => {
    textureCallback = callback;
  },
  previewReady: () => {
    ipcRenderer.send("preview-ready");
  },
});
