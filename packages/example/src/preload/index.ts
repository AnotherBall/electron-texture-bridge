/**
 * Unified preload script for all windows
 * - Offscreen render window: uses platform only
 * - Preview window: uses sharedTexture receiver + IPC
 */

import {
  contextBridge,
  ipcRenderer,
  sharedTexture,
  ReceivedSharedTextureData,
} from "electron";

type TextureCallback = (imported: any) => void;
let textureCallback: TextureCallback | null = null;

// Set up shared texture receiver (for preview window)
// This is safe to call in all windows - it only activates when sharedTexture.sendSharedTexture is called
try {
  sharedTexture.setSharedTextureReceiver(async (data: ReceivedSharedTextureData) => {
    const imported = data.importedSharedTexture;
    if (textureCallback && imported) {
      textureCallback(imported);
    }
  });
} catch {
  // Ignore - sharedTexture may not be available in all contexts
}

// Expose unified API to renderer process
contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  onTextureFrame: (callback: TextureCallback) => {
    textureCallback = callback;
  },
  previewReady: () => {
    ipcRenderer.send("preview-ready");
  },
});

