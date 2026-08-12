// Multiviewer window bootstrap — see docs/superpowers/specs/2026-08-13-forward-frames-multiviewer-design.md §2.
//
// Same execution-scope rationale as receiver.ts: this window runs with
// `nodeIntegration: true, contextIsolation: false`, so preload code shares
// the page's global scope and can import
// `@napolab/texture-bridge-renderer/client` directly at runtime, which
// Vite's dev server cannot pre-bundle for a plain renderer HTML page.

import { ipcRenderer } from "electron";
import {
  installSharedTextureReceiver,
  consumeSharedTexture,
} from "@napolab/texture-bridge-renderer/client";
import type { SharedTextureConsumerFrame } from "@napolab/texture-bridge-renderer/client";

installSharedTextureReceiver();

const SLOT_COUNT = 4;
const SLOTS = [0, 1, 2, 3] as const;
const DECK_WIDTH = 480;
const DECK_HEIGHT = 270;

/** Mirrors the main-process `SlotSourceDescriptor` union (packages/example/src/main/index.ts) structurally over IPC. */
type SlotSourceDescriptor = { kind: "local"; id: string } | { kind: "syphon"; senderName: string };

type SourceEntry = { id: string; label: string };
type SenderEntry = { name: string; appName?: string };
type SourceListing = { local: SourceEntry[]; syphon: SenderEntry[] };

interface DeckUI {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  source: HTMLSelectElement;
  connectBtn: HTMLButtonElement;
  disconnectBtn: HTMLButtonElement;
  status: HTMLSpanElement;
}

interface MultiviewerUI {
  decks: readonly DeckUI[];
  composite: HTMLCanvasElement;
  compositeCtx: CanvasRenderingContext2D;
  flipY: HTMLInputElement;
  refreshBtn: HTMLButtonElement;
}

let ui: MultiviewerUI | null = null;

interface SlotStats {
  arrivalCount: number;
  drawCount: number;
  arrivalFps: number;
  drawFps: number;
  connState: string;
  /** Latest `multi-slot-status` push (e.g. syphon fps ticks) — kept separate from `connState` so a push doesn't clobber the "connected: ..." text. */
  pushText: string;
}

const createSlotStats = (): SlotStats => ({
  arrivalCount: 0,
  drawCount: 0,
  arrivalFps: 0,
  drawFps: 0,
  connState: "idle",
  pushText: "",
});

const slotStats: readonly SlotStats[] = [
  createSlotStats(),
  createSlotStats(),
  createSlotStats(),
  createSlotStats(),
];

// One held VideoFrame per slot ("latest-frame coalescing" per spec §2).
// `onFrame` below replaces the held frame (closing the previous one first);
// the rAF loop draws whatever's held without ever closing it, so decks keep
// showing the last frame between arrivals instead of flickering to black.
// This is also what keeps draw cost fixed to the refresh rate regardless of
// how many slots are connected or how fast each source produces frames.
const latestFrames: (SharedTextureConsumerFrame | undefined)[] = Array.from({
  length: SLOT_COUNT,
});

// `forwardFrames`/receiver `dispose()` don't cancel deliveries already
// in-flight when `multi-disconnect` runs, so a stray tagged frame can still
// arrive for a slot just disconnected. Track connection state here so
// `onFrame` can drop those late frames instead of resurrecting the slot.
const connectedSlots: boolean[] = [false, false, false, false];

const getElement = <T extends HTMLElement>(id: string, ctor: new () => T): T | null => {
  const element = document.getElementById(id);
  return element instanceof ctor ? element : null;
};

const formatStatus = (slot: number, stats: SlotStats): string => {
  const base = `P${slot} | arrival ${stats.arrivalFps.toFixed(1)} fps | draw ${stats.drawFps.toFixed(1)} fps | ${stats.connState}`;
  if (!stats.pushText) return base;
  return `${base} | ${stats.pushText}`;
};

const updateStatusText = (slot: number): void => {
  const deckStatus = ui?.decks[slot]?.status;
  const stats = slotStats[slot];
  if (!deckStatus || !stats) return;
  deckStatus.textContent = formatStatus(slot, stats);
};

const tickFpsWindow = (): void => {
  for (const slot of SLOTS) {
    const stats = slotStats[slot];
    if (!stats) continue;
    // 1s tick interval means the raw per-tick count already reads as fps.
    stats.arrivalFps = stats.arrivalCount;
    stats.drawFps = stats.drawCount;
    stats.arrivalCount = 0;
    stats.drawCount = 0;
    updateStatusText(slot);
  }
};

// Composite canvas is the "renderer-side atlas" the design doc's §3 talks
// about — no main-process GPU compositing pass, no atlas texture. Each held
// frame is blitted straight into its quadrant here on every rAF tick.
const drawSlot = (deck: DeckUI, compositeCtx: CanvasRenderingContext2D, slot: number): void => {
  const frame = latestFrames[slot];
  if (!frame) return;

  deck.ctx.drawImage(frame.videoFrame, 0, 0, DECK_WIDTH, DECK_HEIGHT);

  const quadX = (slot % 2) * DECK_WIDTH;
  const quadY = Math.floor(slot / 2) * DECK_HEIGHT;
  compositeCtx.drawImage(frame.videoFrame, quadX, quadY, DECK_WIDTH, DECK_HEIGHT);

  const stats = slotStats[slot];
  if (stats) stats.drawCount += 1;
};

const drawFrame = (): void => {
  if (ui) {
    for (const [slot, deck] of ui.decks.entries()) {
      drawSlot(deck, ui.compositeCtx, slot);
    }
  }
  requestAnimationFrame(drawFrame);
};

const parseSourceValue = (value: string): SlotSourceDescriptor | null => {
  if (value.startsWith("local:")) {
    return { kind: "local", id: value.slice("local:".length) };
  }
  if (value.startsWith("syphon:")) {
    return { kind: "syphon", senderName: value.slice("syphon:".length) };
  }
  return null;
};

const disconnectSlot = async (
  deck: DeckUI,
  compositeCtx: CanvasRenderingContext2D,
  slot: number,
): Promise<void> => {
  connectedSlots[slot] = false;
  await ipcRenderer.invoke("multi-disconnect", slot);
  deck.connectBtn.disabled = !deck.source.value;
  deck.disconnectBtn.disabled = true;
  deck.source.disabled = false;
  latestFrames[slot]?.videoFrame.close();
  latestFrames[slot] = undefined;
  deck.ctx.clearRect(0, 0, DECK_WIDTH, DECK_HEIGHT);

  const quadX = (slot % 2) * DECK_WIDTH;
  const quadY = Math.floor(slot / 2) * DECK_HEIGHT;
  compositeCtx.clearRect(quadX, quadY, DECK_WIDTH, DECK_HEIGHT);
};

const wireDeck = (multiviewer: MultiviewerUI, slot: number): void => {
  const deck = multiviewer.decks[slot];
  if (!deck) return;

  deck.source.addEventListener("change", () => {
    deck.connectBtn.disabled = !deck.source.value;
  });

  deck.connectBtn.addEventListener("click", async () => {
    const descriptor = parseSourceValue(deck.source.value);
    if (!descriptor) return;
    try {
      await ipcRenderer.invoke("multi-connect", slot, descriptor, multiviewer.flipY.checked);
      connectedSlots[slot] = true;
      deck.connectBtn.disabled = true;
      deck.disconnectBtn.disabled = false;
      deck.source.disabled = true;
    } catch (err) {
      const stats = slotStats[slot];
      if (stats) stats.connState = `error: ${err instanceof Error ? err.message : `${err}`}`;
      updateStatusText(slot);
    }
  });

  deck.disconnectBtn.addEventListener("click", async () => {
    await disconnectSlot(deck, multiviewer.compositeCtx, slot);
  });
};

const populateSourceSelect = (select: HTMLSelectElement, listing: SourceListing): void => {
  const previousValue = select.value;
  select.innerHTML = '<option value="">-- Select Source --</option>';

  const localGroup = document.createElement("optgroup");
  localGroup.label = "[local]";
  for (const entry of listing.local) {
    const opt = document.createElement("option");
    opt.value = `local:${entry.id}`;
    opt.textContent = entry.label;
    localGroup.appendChild(opt);
  }
  select.appendChild(localGroup);

  const syphonGroup = document.createElement("optgroup");
  syphonGroup.label = "[syphon]";
  for (const sender of listing.syphon) {
    const opt = document.createElement("option");
    opt.value = `syphon:${sender.name}`;
    opt.textContent = sender.appName ? `${sender.name} (${sender.appName})` : sender.name;
    syphonGroup.appendChild(opt);
  }
  select.appendChild(syphonGroup);

  select.value = previousValue;
};

const refreshSources = async (): Promise<void> => {
  if (!ui) return;
  const listing: SourceListing = await ipcRenderer.invoke("multi-list-sources");
  for (const deck of ui.decks) {
    populateSourceSelect(deck.source, listing);
  }
};

const buildDeckUI = (slot: number): DeckUI | null => {
  const canvas = getElement(`deck-${slot}`, HTMLCanvasElement);
  const ctx = canvas?.getContext("2d");
  const source = getElement(`source-${slot}`, HTMLSelectElement);
  const connectBtn = getElement(`connect-${slot}`, HTMLButtonElement);
  const disconnectBtn = getElement(`disconnect-${slot}`, HTMLButtonElement);
  const status = getElement(`status-${slot}`, HTMLSpanElement);
  if (!canvas || !ctx || !source || !connectBtn || !disconnectBtn || !status) return null;
  return { canvas, ctx, source, connectBtn, disconnectBtn, status };
};

// Start the consumer pool immediately, mirroring receiver.ts. onFrame is a
// no-op for a slot until the DOM is ready and its deck is wired below — the
// guard just drops frames for out-of-range/untagged slots.
consumeSharedTexture({
  onFrame: (frame, ...args) => {
    const slot = args[0];
    if (typeof slot !== "number" || slot < 0 || slot > 3) return;
    // Drop frames for slots that aren't (or are no longer) connected —
    // `dispose()` on the main side doesn't cancel deliveries already
    // in-flight, so a stray tagged frame can arrive just after disconnect.
    // Leave the original un-cloned; the consumer pool closes it below.
    if (!connectedSlots[slot]) return;

    // The consumer pool closes `frame.videoFrame` itself once this handler
    // returns, so we must clone to hold the frame past that point for the
    // rAF loop to draw later.
    latestFrames[slot]?.videoFrame.close();
    latestFrames[slot] = { textureId: frame.textureId, videoFrame: frame.videoFrame.clone() };

    const stats = slotStats[slot];
    if (stats) stats.arrivalCount += 1;
  },
  onError: (err) => {
    console.error("[multiviewer] consume error:", err);
  },
});

requestAnimationFrame(drawFrame);
setInterval(tickFpsWindow, 1000);

ipcRenderer.on("multi-slot-status", (_event, slot: number, text: string) => {
  const stats = slotStats[slot];
  if (!stats) return;
  stats.pushText = text;
  updateStatusText(slot);
});

window.addEventListener("beforeunload", () => {
  for (const slot of SLOTS) {
    latestFrames[slot]?.videoFrame.close();
    latestFrames[slot] = undefined;
  }
});

window.addEventListener("DOMContentLoaded", () => {
  const deck0 = buildDeckUI(0);
  const deck1 = buildDeckUI(1);
  const deck2 = buildDeckUI(2);
  const deck3 = buildDeckUI(3);
  const composite = getElement("composite", HTMLCanvasElement);
  const compositeCtx = composite?.getContext("2d");
  const flipY = getElement("flipY", HTMLInputElement);
  const refreshBtn = getElement("refreshBtn", HTMLButtonElement);

  if (
    !deck0 ||
    !deck1 ||
    !deck2 ||
    !deck3 ||
    !composite ||
    !compositeCtx ||
    !flipY ||
    !refreshBtn
  ) {
    console.error("[multiviewer] required DOM elements missing");
    return;
  }

  const decks: readonly DeckUI[] = [deck0, deck1, deck2, deck3];
  ui = { decks, composite, compositeCtx, flipY, refreshBtn };

  for (const slot of SLOTS) {
    wireDeck(ui, slot);
  }

  refreshBtn.addEventListener("click", () => {
    void refreshSources();
  });

  void refreshSources();
});
