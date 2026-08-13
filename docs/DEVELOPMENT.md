# Development

Repository layout and CI for contributors. Build instructions live in [INSTALLATION.md](INSTALLATION.md#building-from-source).

## Project Structure

```
electron-texture-bridge/
├── packages/
│   ├── native/                # @napolab/texture-bridge (napi-rs)
│   │   ├── src/
│   │   │   ├── lib.rs         # napi-rs entry point, TextureSender/Receiver API
│   │   │   ├── types.rs       # RawTextureHandle type alias
│   │   │   ├── mac/           # macOS: Syphon Metal sender + receiver + FFI
│   │   │   └── win/           # Windows: Spout sender + receiver + FFI
│   │   ├── cpp/
│   │   │   ├── mac/           # ObjC++ Syphon Metal bridge (send + receive + discovery)
│   │   │   └── win/           # C++ Spout bridge (send + receive + discovery)
│   │   ├── build.rs           # Platform-specific build configuration
│   │   └── Cargo.toml
│   ├── core/                  # @napolab/texture-bridge-core (TypeScript)
│   │   └── src/
│   │       ├── index.ts       # sendTextureFromPaintEvent + re-exports (sender + receiver)
│   │       └── types.ts       # TextureInfo, PaintTexture, SenderInfo, ReceivedFrame
│   ├── renderer/              # @napolab/texture-bridge-renderer (TypeScript)
│   │   └── src/
│   │       ├── index.ts       # createTextureBridge + createTextureReceiver + SenderDiscovery
│   │       ├── bridge.ts      # Sender factory implementation (EventEmitter)
│   │       ├── receiver.ts    # Receiver factory (polling + FPS tracking)
│   │       ├── discovery.ts   # SenderDiscovery (polling + diff events)
│   │       ├── types.ts       # TextureBridgeOptions, TextureBridge
│   │       ├── preview-manager.ts  # Preview window lifecycle
│   │       ├── fps-counter.ts # FPS measurement utility
│   │       ├── client/        # Renderer-process helpers
│   │       │   ├── index.ts   # createWorkerRenderer
│   │       │   └── worker-protocol.ts  # Worker message types
│   │       └── assets/        # Static files (preview.html, preload)
│   └── example/               # Electron VJ demo app (private)
│       └── src/
│           ├── main/          # Electron main process (~30 LOC)
│           └── renderer/      # Three.js + GLSL + Web Worker
├── vendor/                    # Third-party SDKs (gitignored, built locally)
│   ├── syphon-src/            # Syphon Framework source (git submodule)
│   ├── Syphon.framework/     # Built framework (macOS)
│   └── Spout2/               # Spout SDK (Windows) — SpoutDirectX/ + SpoutGL/
├── specs/
│   └── ARCHITECTURE.md        # Detailed architecture documentation
├── Cargo.toml                 # Rust workspace root
├── pnpm-workspace.yaml        # pnpm monorepo config
└── package.json               # Root workspace scripts
```


## CI/CD

GitHub Actions builds native binaries for all supported platforms:

| Runner | Target | Output |
|--------|--------|--------|
| `macos-14` | `aarch64-apple-darwin` | `texture-bridge.darwin-arm64.node` |
| `macos-13` | `x86_64-apple-darwin` | `texture-bridge.darwin-x64.node` |
| `windows-latest` | `x86_64-pc-windows-msvc` | `texture-bridge.win32-x64-msvc.node` |

Publishing to npm is triggered by version tags (`v*`).

