# texture-bridge plugin

Claude Code skills for using [`@napolab/texture-bridge`](https://github.com/naporin0624/electron-texture-bridge) — zero-copy GPU texture sharing between Electron offscreen windows and VJ software (Syphon / Spout), plus renderer-to-renderer frame forwarding.

## Install

```
/plugin marketplace add naporin0624/electron-texture-bridge
/plugin install texture-bridge
```

## Skills

Skills activate automatically from conversation context — no commands to learn.

| Skill | Fires when you ask about |
|-------|--------------------------|
| `setting-up-texture-bridge` | Installing the library, adding Syphon/Spout output to an Electron app, electron-vite config, black/garbled output right after setup |
| `choosing-texture-bridge-api` | Which API tier to use — simple vs core, `forwardSharedTexture` vs `forwardFrames`, send vs receive paths — and integration-plan review |
| `migrating-to-forward-frames` | Replacing `capturePage` polling / bitmap-IPC previews / Syphon loopbacks with zero-copy forwarding |
| `receiving-shared-textures` | The receiving side: consuming forwarded frames, multiviewer grids, `VideoFrame` lifecycle, frames reappearing after disconnect |
| `managing-frame-forward-lifecycle` | Registering and tearing down `forwardFrames` targets: monitor windows that close and reopen, repeated connect/disconnect, `MaxListenersExceededWarning`, leaks around forwarding |
| `delivering-imported-textures` | Delivering a texture to a renderer from main: `importSharedTexture` / `sendSharedTexture` / `release()` by hand, where `release()` belongs, `sendImportedTexture` vs `forwardSharedTexture` |
| `handling-texture-bridge-failures` | Error handling and telemetry: which calls throw, reject, model a defect, or emit — what to wrap with `Result.fromThrowable`, silently black output, a main-process crash from a bridge call |

## Why these skills exist

Models asked to integrate this library without them consistently fabricate plausible-looking APIs (`publishSharedTexture`, `subscribeFrames`, options objects that don't exist). Each skill was written test-first against those observed failures and verified to make an agent produce the real API surface.

## Requirements

- Electron 40+ (`useSharedTexture` paint events)
- `@napolab/texture-bridge-renderer` (high-level) or `@napolab/texture-bridge-core` (low-level)
