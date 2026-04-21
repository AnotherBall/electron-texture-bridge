# macOS Metal Shared-Texture Receiver Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the just-landed Windows/Spout zero-copy receiver (`receiveSharedTexture()` → NT HANDLE → Electron `importSharedTexture({ ntHandle })`) to macOS Metal/Syphon, delivering an `IOSurfaceRef` per frame to Electron's `importSharedTexture({ ioSurface })`.

**Architecture:** `SyphonMetalClient` delivers `id<MTLTexture>` on a background queue. We blit each new frame into a persistent IOSurface-backed staging `MTLTexture` using a per-receiver `MTLCommandQueue`, `CFRetain` that staging texture's `IOSurfaceRef`, and hand the 8-byte LE pointer to Electron. Ownership transfers per frame; abandoned handles release through `closeNativeHandle` → `native_close_shared_iosurface` → `CFRelease`.

**Tech Stack:** Objective-C++/Metal/Syphon (Syphon.framework), Rust/napi-rs, Electron main process.

---

## Context: What the Windows path does (and why)

Landing commit `e1a29fa fix(native): rewrite Windows receiver without SpoutDX` dropped SpoutDX from the receive side because:

1. `spoutDX::ReceiveTexture(ID3D11Texture2D**)` required `*ppTexture` pre-allocated — bridge was passing `nullptr` and falling through `if (!pTexture) return false;`.
2. `D3D11_RESOURCE_MISC_SHARED_NTHANDLE` requires pairing with `MISC_SHARED` (or `MISC_SHARED_KEYEDMUTEX`) *and* a device built with `D3D11_CREATE_DEVICE_BGRA_SUPPORT`. `spoutDirectX::CreateDX11device` omitted the BGRA flag.

Windows now uses Spout primitives directly — `spoutSenderNames::CheckSender` + `spoutDirectX::OpenDX11shareHandle` + `spoutFrameCount` + an owned D3D11 device with a persistent NT-shared staging texture. Per-frame `DuplicateHandle` mints a fresh kernel handle whose ownership transfers to Electron. See `packages/native/cpp/win/spout_bridge.cpp:140-592` (receiver) and `packages/native/src/lib.rs:389-434` (`receive_shared_texture` napi branch).

## Context: Windows primitive → macOS analogue

| Windows | macOS Metal/Syphon |
|---|---|
| `spoutSenderNames::GetSenderNames` (MMF of names + HANDLE + format) | `[SyphonServerDirectory sharedDirectory].servers` (NSArray of `SyphonServerDescription*Key` dicts) |
| `spoutDirectX::OpenDX11shareHandle` + `CopyResource` | `SyphonMetalClient -newFrameImage` returns `id<MTLTexture>`; backing `IOSurfaceRef` exposed via `[texture iosurface]` |
| `IDXGIResource1::CreateSharedHandle` → NT HANDLE | The `IOSurfaceRef` of an IOSurface-backed `MTLTexture` is itself the cross-process shared handle. Transfer by CFRetain (same session) or `IOSurfaceCreateMachPort` (cross-session/sandbox). Electron consumes the `IOSurfaceRef` pointer directly. |
| 8-byte LE `ntHandle` Buffer | 8-byte LE `ioSurface` Buffer holding `IOSurfaceRef` as `u64`. Electron key is `ioSurface` (see `packages/renderer/src/shared-texture-receiver.ts:236`). |
| `spoutFrameCount` (semaphore + named mutex) | `SyphonMetalClient`'s `newFrameHandler` block. No reader-side mutex — Metal + IOSurface handle cross-process tracking. |
| `D3D11_CREATE_DEVICE_BGRA_SUPPORT` | `MTLCreateSystemDefaultDevice()` accepts BGRA8Unorm / RGBA16Float natively. IOSurface-backed textures require `newTextureWithDescriptor:iosurface:plane:`, and the descriptor's `storageMode` is dictated by the IOSurface (treat as `.shared`). |
| Per-frame `DuplicateHandle` | Per-frame `CFRetain` of the staging IOSurface before returning; `closeNativeHandle` → `native_close_shared_iosurface` → `CFRelease`. |

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/native/cpp/mac/syphon_bridge.mm` | Modify | Add persistent `MTLCommandQueue` + IOSurface-backed staging `MTLTexture`, per-frame blit + CFRetain; fix shared flag consumption (see Task 1 caveat) |
| `packages/native/cpp/mac/syphon_bridge.h` | Modify | Confirm `syphon_receiver_receive_shared_iosurface` return codes (`0/1/-1/-2`) and document them in lockstep with the Windows codes (add `2 = dimensions changed` if needed) |
| `packages/native/src/mac/receiver.rs` | Review / tighten | `receive_shared_iosurface` wrapper exists; verify error-code mapping matches refreshed C API |
| `packages/native/src/mac/ffi.rs` | Modify (if new codes added) | Update declarations to reflect any new FFI entry points |
| `packages/native/src/mac/mod.rs` | Verify | `close_shared_iosurface(raw_ptr)` already calls `native_close_shared_iosurface`; confirm CFRelease on an unimported handle matches the CFRetain in Task 4 |
| `packages/native/src/lib.rs` | Verify | `#[cfg(target_os = "macos")]` branch in `receive_shared_texture` packs `iosurface_ptr` as 8 LE bytes and uses `info.pixel_format_string()`. No changes expected, just validation. |
| `packages/example/src/main/index.ts` | No change | Already wires `createSharedTextureReceiver` — used as the end-to-end demo target on macOS |
| `packages/example/src/preload/receiver.ts` | No change | Same renderer consumes `VideoFrame` via `drawImage`; path is platform-agnostic |

---

## Current macOS status — audit before writing code

Read the mac files first (`syphon_bridge.mm`, `receiver.rs`, `mod.rs`, `lib.rs`) and confirm each of these before touching anything. Summary of what exists today:

- **Discovery** (`syphon_discovery_list_servers`, lines ~503–538): Fully working. Emits `[{"name":...,"appName":...,"uuid":...}]` via `NSJSONSerialization`. Matches the `SenderInfo` parser in `packages/native/src/lib.rs:211-231`.
- **Receiver create/destroy** (lines ~250–334): Works. `SyphonMetalClient` created with `newFrameHandler` that sets `std::atomic<bool> hasNewFrameFlag`.
- **RGBA readback path** (`syphon_receiver_receive_rgba`, ~342–422): Works. CPU-copy path via blit → `MTLBuffer` → memcpy with optional BGRA→RGBA swap.
- **Zero-copy IOSurface path** (`syphon_receiver_receive_shared_iosurface`, ~444–497): **Exists and mostly correct.** Returns `[texture iosurface]` after CFRetain, encodes pixel format as 0/1/2 → Rust maps to `"bgra"/"rgba"/"rgbaf16"`.
- **Close path** (`native_close_shared_iosurface`, ~573–581): CFReleases a raw `IOSurfaceRef`. Wired through `mac::close_shared_iosurface` (`mod.rs:80-89`) and `close_native_handle` (`lib.rs:520-551`).
- **Rust wrapper** (`packages/native/src/mac/receiver.rs:138-174`): `receive_shared_iosurface()` decodes the three return codes and builds a `SharedIoSurfaceInfo`. The pixel-format mapping (`SharedIoSurfaceInfo::pixel_format_string`) is unit-tested.

**Caveat the implementer MUST address first (Task 1):** `hasNewFrameFlag.exchange(false, acq_rel)` is called at the top of *both* `syphon_receiver_receive_rgba` (line ~352) and `syphon_receiver_receive_shared_iosurface` (line ~458). Whichever runs first consumes the flag; the other silently returns "no new frame". Today production only polls the zero-copy path, but leaving this fragile races with any future dual-path consumer or debug toggle.

**Gaps vs. the Windows receiver:**
- No persistent staging `MTLTexture` on the mac receiver — the current code just returns `[texture iosurface]` from the client's frame image. That works *only* if Syphon's vended texture has a stable lifetime across frames. If the client recycles the underlying IOSurface, the caller holds a stale retain. Windows solves this by copying into its own staging texture and handing the staging's handle out. Task 3 ports the same invariant to Metal.
- No dimension-change return code (Windows uses `2`). Not strictly required if the staging is re-created implicitly on size change, but mirror the codes for parity with the Rust wrapper's match arms.

---

### Task 1: Fix shared-flag consumption between RGBA and IOSurface paths

**Files:**
- Modify: `packages/native/cpp/mac/syphon_bridge.mm` (top of `syphon_receiver_receive_rgba` ~352 and `syphon_receiver_receive_shared_iosurface` ~458)

- [ ] **Step 1:** Pick one strategy and apply it consistently:
    - **A (recommended):** Replace `exchange(false)` in `syphon_receiver_receive_shared_iosurface` with a `load(acquire)` gate; only the RGBA path consumes the flag. Since production only calls the IOSurface path, flip the ownership — `syphon_receiver_receive_shared_iosurface` becomes the flag consumer, RGBA uses `load()`.
    - **B:** Keep both consuming, but document in the C header that only *one* path may be called per polling tick.
- [ ] **Step 2:** Add a regression comment above the chosen consumer referencing this plan (`2026-04-22-mac-metal-shared-texture-receiver.md`) so future readers know why the other path uses `load` not `exchange`.

---

### Task 2: Own the `SyphonMetalClient` frame texture safely across threads

**Files:**
- Modify: `packages/native/cpp/mac/syphon_bridge.mm` (struct `SyphonReceiverBridge` ~239 and `newFrameHandler` block ~305–311)

- [ ] **Step 1:** Decide whether to call `[bridge->client newFrameImage]` on the JS poll thread (current behaviour — safe per Syphon docs, returns the latest frame any time after `newFrameHandler` has fired) or cache the latest texture inside the `newFrameHandler` block. Prefer the current pull model — `newFrameImage` is documented as thread-safe.
- [ ] **Step 2:** Capture `bridgePtr` in the block as a raw pointer (already done, line ~305). Confirm the block is released before `delete bridge;` by nilling `bridge->client` before teardown (already done at line ~328, but add an assertion comment — releasing the client should invalidate any in-flight block invocations).

---

### Task 3: Add a persistent IOSurface-backed staging `MTLTexture`

**Files:**
- Modify: `packages/native/cpp/mac/syphon_bridge.mm`

**Rationale:** Mirror the Windows invariant — we hand Electron an IOSurface *we own*, not one owned by Syphon's client. This decouples Electron's imported-texture lifetime from Syphon's internal pool recycling.

- [ ] **Step 1:** Extend `SyphonReceiverBridge` with:
    - `id<MTLTexture> stagingTexture` (IOSurface-backed)
    - `IOSurfaceRef stagingIOSurface` (retained once on creation, CFReleased only in `syphon_receiver_destroy`)
    - `uint32_t stagingWidth, stagingHeight;`
    - `MTLPixelFormat stagingPixelFormat;`
- [ ] **Step 2:** Add a helper `ensure_staging(bridge, width, height, pixelFormat)` that (a) tears down and recreates the IOSurface + `MTLTexture` when any of width/height/pixelFormat changes, (b) builds the IOSurface with `IOSurfaceCreate` using the pixel format from the incoming sender texture (see `syphon_map_pixel_format` at line ~562 for the inverse mapping), (c) creates the `MTLTexture` via `-[MTLDevice newTextureWithDescriptor:iosurface:plane:]` with `MTLTextureUsageShaderRead | MTLTextureUsageRenderTarget` and `MTLStorageModeShared`.
- [ ] **Step 3:** In `syphon_receiver_receive_shared_iosurface`, after obtaining the client texture:
    1. Call `ensure_staging` with `texture.width / height / pixelFormat`.
    2. Encode a `MTLBlitCommandEncoder` `copyFromTexture:... toTexture:bridge->stagingTexture ...` on `bridge->commandQueue`.
    3. Commit and `waitUntilCompleted` (same pattern as RGBA readback path at lines ~385–398; a future optimisation is to use `addCompletedHandler` + `MTLSharedEvent` but that is out of scope).
    4. `CFRetain(bridge->stagingIOSurface);` and return the retained pointer. Do **not** CFRelease inside the function; ownership passes to the caller.
- [ ] **Step 4:** On dimension/format change return code `2` (to match Windows). Wire `case 2 => Ok(None)` through `packages/native/src/mac/receiver.rs` so the poller re-calls next tick.

---

### Task 4: Per-frame handle minting + lifetime contract

**Files:**
- Modify: `packages/native/cpp/mac/syphon_bridge.mm` (end of `syphon_receiver_receive_shared_iosurface`)
- Verify: `packages/native/src/mac/mod.rs:80-89` (`close_shared_iosurface`)

- [ ] **Step 1:** After the blit, `CFRetain(bridge->stagingIOSurface)` and write that retained pointer to `*out_iosurface`. Document that each successful `return 0` adds exactly one retain count, balanced by Electron's `importSharedTexture` release or by `native_close_shared_iosurface`.
- [ ] **Step 2:** Confirm `native_close_shared_iosurface` calls `CFRelease` exactly once per incoming pointer (line ~579). Already correct — no code change needed, just add a comment reference to this plan.
- [ ] **Step 3:** Verify `packages/native/src/lib.rs:416-433` packs `info.iosurface_ptr.to_le_bytes()` into an 8-byte Buffer. Unchanged from the current implementation.

---

### Task 5: Pixel format mapping parity

**Files:**
- Modify: `packages/native/cpp/mac/syphon_bridge.mm` (pixel-format switch ~478–485)
- Verify: `packages/native/src/mac/receiver.rs:22-31` (`SharedIoSurfaceInfo::pixel_format_string`)

- [ ] **Step 1:** Confirm the `switch (texture.pixelFormat)` in `syphon_receiver_receive_shared_iosurface` handles `MTLPixelFormatBGRA8Unorm` → 0, `MTLPixelFormatRGBA8Unorm` → 1, `MTLPixelFormatRGBA16Float` → 2. Any other format should log and fall back to 0 (matches the Windows `dxgi_format_to_pixel_format` error-on-unknown behaviour *except* the mac path currently silently defaults — decide whether to return an error code or keep the default; Windows returns `Err`, so align by returning `-3` "unsupported pixel format" and surfacing it as a Rust error).
- [ ] **Step 2:** Update `SharedIoSurfaceInfo::pixel_format_string`'s tests (`packages/native/src/mac/receiver.rs:261-269`) to match whichever decision Task 5.1 makes.

---

### Task 6: Discovery JSON shape parity

**Files:**
- Verify: `packages/native/cpp/mac/syphon_bridge.mm:503-538` (`syphon_discovery_list_servers`)
- Verify: `packages/native/src/lib.rs:211-231` (`parse_senders_json`)

- [ ] **Step 1:** No code changes expected. Confirm mac emits `name`, `appName`, `uuid` keys; Windows only emits `name`. `parse_senders_json` already tolerates missing `appName`/`uuid` (tests at `lib.rs:607-623` cover this).

---

### Task 7: C API return code table

**Files:**
- Modify: `packages/native/cpp/mac/syphon_bridge.h:86-99` (doc comment)
- Modify: `packages/native/src/mac/receiver.rs:159-173` (match arms)

- [ ] **Step 1:** Document the canonical set: `0 ok`, `1 no new frame`, `2 dimensions changed`, `-1 not connected`, `-2 not IOSurface-backed`, (new) `-3 unsupported pixel format`. Mirror in the Rust match.

---

### Task 8: Ownership contract doc-comment verification

**Files:**
- Verify: `packages/native/src/lib.rs:245-283` (`SharedTextureFrame` doc-comment)

- [ ] **Step 1:** Confirm the doc-comment already says "macOS: IOSurfaceRef pointer (retained by this call, released when the imported texture is released by Electron)" — it does. No change needed.
- [ ] **Step 2:** Confirm the renderer bridge at `packages/renderer/src/shared-texture-receiver.ts:236` uses `{ ioSurface: frame.handle }` for `process.platform === "darwin"` — it does.

---

### Task 9: End-to-end demo verification on macOS

**Files:**
- Verify: `packages/example/src/main/index.ts` (no changes expected)
- Verify: `packages/example/src/preload/receiver.ts` (no changes expected)

- [ ] **Step 1:** Build: `pnpm build:native` on macOS (builds the `.node` addon with Syphon.framework linkage — check `packages/native/build.rs` link line).
- [ ] **Step 2:** Start the example's own sender (`pnpm --filter example dev`) — it already runs a `SyphonMetalServer` via `createTextureBridge`. The receiver window connects to it.
- [ ] **Step 3:** Verify with a third-party sender (VDMX, Resolume, Simple Client) to catch assumptions that only hold for our own senders.

---

### Task 10: Tests

**Files:**
- Verify: `packages/native/src/mac/receiver.rs` tests at lines 221–373 (pixel format mapping, BGRA→RGBA conversion)
- Verify: `packages/renderer/src/__tests__/shared-texture-receiver.test.ts:162-199` (platform branch selects `ioSurface` on darwin)

- [ ] **Step 1:** `cargo test --manifest-path packages/native/Cargo.toml` — same policy as Windows: lifecycle tests are skipped at the Rust level (see `lib.rs:582-594` comment) and verified at TS integration level.
- [ ] **Step 2:** `pnpm test` at repo root — renderer's `shared-texture-receiver.test.ts` must pass unchanged on macOS.
- [ ] **Step 3:** No new Rust tests required. If Task 5 adds a `-3` unsupported-format error, add a mock-based TS test that surfaces it.

---

### Task 11: Build + verification

- [ ] **Step 1:** `pnpm build:native` (release build, macOS)
- [ ] **Step 2:** `cargo test --manifest-path packages/native/Cargo.toml --release` (skip linker tests if they fail on mac as they do on Windows — the existing skip-at-integration-level policy applies)
- [ ] **Step 3:** `pnpm test` (all workspaces)
- [ ] **Step 4:** Manual demo against a known Syphon sender (VDMX, Resolume, or the example's own sender). Confirm in DevTools of the receiver window that `videoFrame.displayWidth × displayHeight` matches the sender and that FPS reaches the expected cap (polling at 8 ms → ~120 fps ceiling).

---

## Out of scope

- `MTLSharedEvent`-based GPU→GPU synchronization between Syphon and our staging blit. Current design uses `waitUntilCompleted` per frame (matches the existing RGBA path) — acceptable for the first landing; a future optimisation.
- Keyed-mutex parity. macOS/IOSurface needs no reader-side mutex — Metal + IOSurface provide the ordering.
- Multi-device / eGPU + integrated handling. Use `MTLCreateSystemDefaultDevice()` exclusively for both Syphon client and our staging device, matching the existing sender side.
- H.264 / NV12 decode hooks. Scope is uncompressed BGRA/RGBA/RGBA16F only.
- Cross-session / sandboxed-process IOSurface transfer via `IOSurfaceCreateMachPort`. Not needed for Electron same-session GPU process.
