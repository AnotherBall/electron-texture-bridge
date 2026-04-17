/**
 * Dogfooding test: Spout Receiver (Polling)
 *
 * Tests:
 * 1. listSenders() — discovers available Spout senders
 * 2. TextureReceiver.receiveFrame() — polling-based frame reception
 *
 * Requires an active Spout sender on the system (e.g. OBS, Resolume, Vizion).
 *
 * Usage: node dogfood-receiver.mjs [sender-name]
 */

import { TextureReceiver, listSenders } from "./packages/native/index.js";

// --- Step 1: List existing senders ---
console.log("[dogfood] === Test 1: listSenders() ===");
const senders = listSenders();
console.log("[dogfood] found", senders.length, "sender(s):");
for (const s of senders) {
  console.log(`  - "${s.name}"${s.appName ? ` (app: ${s.appName})` : ""}`);
}

if (senders.length === 0) {
  console.log("[dogfood] SKIP: no Spout senders available. Start one and try again.");
  process.exit(0);
}

// Use CLI arg or first available sender
const targetName = process.argv[2] || senders[0].name;
console.log(`\n[dogfood] === Test 2: polling receiveFrame("${targetName}") ===`);

// --- Step 2: Create receiver ---
const receiver = new TextureReceiver(targetName);
console.log("[dogfood] platform:", receiver.platform());

// --- Step 3: Polling-based frame reception ---
console.log("[dogfood] starting polling loop...");

let frameCount = 0;
let firstFrameTime = null;
let stopped = false;
const startTime = Date.now();
const TARGET_FRAMES = 30;

const done = new Promise((resolve) => {
  const timer = setInterval(() => {
    if (stopped) {
      clearInterval(timer);
      return;
    }

    const frame = receiver.receiveFrame();
    if (!frame) return;

    frameCount++;

    if (frameCount === 1) {
      firstFrameTime = Date.now() - startTime;
      console.log(`[dogfood] first frame in ${firstFrameTime}ms`);
    }

    if (frameCount <= 3 || frameCount % 10 === 0) {
      const nonZero = frame.data.some((b) => b !== 0);
      console.log(
        `[dogfood] frame #${frameCount}: ${frame.width}x${frame.height}, ` +
        `${frame.data.length} bytes, nonZero=${nonZero}`
      );
    }

    if (frameCount >= TARGET_FRAMES) {
      clearInterval(timer);
      resolve();
    }
  }, 16);
});

// Timeout after 10 seconds
const timeout = setTimeout(() => {
  console.log(`[dogfood] TIMEOUT: only received ${frameCount} frames in 10s`);
  process.exit(1);
}, 10_000);

await done;
clearTimeout(timeout);

// --- Step 4: Results ---
const elapsed = Date.now() - startTime;
const fps = ((frameCount / elapsed) * 1000).toFixed(1);

console.log("\n[dogfood] === Results ===");
console.log(`[dogfood] PASS: received ${frameCount} frames in ${elapsed}ms (~${fps} fps)`);
console.log(`[dogfood] first frame latency: ${firstFrameTime}ms`);

// --- Cleanup ---
console.log("\n[dogfood] cleaning up...");
stopped = true;
receiver.stop();
console.log("[dogfood] done.");
