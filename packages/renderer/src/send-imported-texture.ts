import { sharedTexture } from "electron";

/**
 * Deliver an imported shared texture to a frame, releasing the import in all
 * outcomes. Declared at module scope so its dependencies are explicit
 * arguments — no inner function declarations. Invoking an async function
 * never throws synchronously (a throw inside becomes a promise rejection
 * instead), so callers can hand `sendImportedTexture(...)` straight to
 * `ResultAsync.fromPromise` and both sync throws and rejections from
 * `sendSharedTexture` funnel into the error channel.
 */
export const sendImportedTexture = async (
  frame: Electron.WebFrameMain,
  imported: Electron.SharedTextureImported,
  extraArgs: readonly unknown[] = [],
): Promise<void> => {
  try {
    await sharedTexture.sendSharedTexture({ frame, importedSharedTexture: imported }, ...extraArgs);
  } finally {
    imported.release();
  }
};
