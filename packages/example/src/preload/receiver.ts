import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  onFrame: (callback: (frame: { data: Uint8Array; width: number; height: number }) => void) => {
    ipcRenderer.on("receiver-frame", (_event, frame) => {
      callback(frame);
    });
  },
  listSenders: () => ipcRenderer.invoke("list-senders"),
  connectReceiver: (senderName: string) => ipcRenderer.invoke("connect-receiver", senderName),
  disconnectReceiver: () => ipcRenderer.invoke("disconnect-receiver"),
});
