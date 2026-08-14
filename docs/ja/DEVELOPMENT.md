# 開発

コントリビューター向けのリポジトリ構成と CI についてまとめています。ビルド手順は [INSTALLATION.md](INSTALLATION.md#ソースからのビルド) を参照してください。

## プロジェクト構成

```
electron-texture-bridge/
├── packages/
│   ├── native/                # @napolab/texture-bridge (napi-rs)
│   │   ├── src/
│   │   │   ├── lib.rs         # napi-rs エントリポイント、TextureSender/Receiver API
│   │   │   ├── types.rs       # RawTextureHandle 型エイリアス
│   │   │   ├── mac/           # macOS: Syphon Metal センダー + レシーバー + FFI
│   │   │   └── win/           # Windows: Spout センダー + レシーバー + FFI
│   │   ├── cpp/
│   │   │   ├── mac/           # ObjC++ Syphon Metal ブリッジ（送信 + 受信 + 検出）
│   │   │   └── win/           # C++ Spout ブリッジ（送信 + 受信 + 検出）
│   │   ├── build.rs           # プラットフォーム固有のビルド設定
│   │   └── Cargo.toml
│   ├── core/                  # @napolab/texture-bridge-core (TypeScript)
│   │   └── src/
│   │       ├── index.ts       # sendTextureFromPaintEvent + 再エクスポート（sender + receiver）
│   │       └── types.ts       # TextureInfo, PaintTexture, SenderInfo, ReceivedFrame
│   ├── renderer/              # @napolab/texture-bridge-renderer (TypeScript)
│   │   └── src/
│   │       ├── index.ts       # createTextureBridge + createTextureReceiver + SenderDiscovery
│   │       ├── bridge.ts      # ファクトリ実装（EventEmitter）
│   │       ├── receiver.ts    # レシーバーファクトリ（ポーリング + FPS 計測）
│   │       ├── discovery.ts   # SenderDiscovery（ポーリング + 差分イベント）
│   │       ├── types.ts       # TextureBridgeOptions, TextureBridge
│   │       ├── preview-manager.ts  # プレビューウィンドウのライフサイクル管理
│   │       ├── fps-counter.ts # FPS 計測ユーティリティ
│   │       ├── client/        # レンダラープロセス用ヘルパー
│   │       │   ├── index.ts   # createWorkerRenderer
│   │       │   └── worker-protocol.ts  # Worker メッセージ型
│   │       └── assets/        # 静的ファイル（preview.html, preload）
│   └── example/               # Electron VJ デモアプリ（プライベート）
│       └── src/
│           ├── main/          # Electron メインプロセス（約 30 LOC）
│           └── renderer/      # Three.js + GLSL + Web Worker
├── vendor/                    # サードパーティ SDK（gitignore、ローカルでビルド）
│   ├── syphon-src/            # Syphon Framework ソース（git サブモジュール）
│   ├── Syphon.framework/     # ビルド済みフレームワーク（macOS）
│   └── Spout2/               # Spout SDK（Windows）— SpoutDirectX/ + SpoutGL/
├── specs/
│   └── ARCHITECTURE.md        # 詳細なアーキテクチャドキュメント
├── Cargo.toml                 # Rust ワークスペースルート
├── pnpm-workspace.yaml        # pnpm モノレポ設定
└── package.json               # ルートワークスペーススクリプト
```


## CI/CD

GitHub Actions が全対応プラットフォーム向けにネイティブバイナリをビルドします：

| ランナー | ターゲット | 出力 |
|--------|--------|--------|
| `macos-14` | `aarch64-apple-darwin` | `texture-bridge.darwin-arm64.node` |
| `macos-13` | `x86_64-apple-darwin` | `texture-bridge.darwin-x64.node` |
| `windows-latest` | `x86_64-pc-windows-msvc` | `texture-bridge.win32-x64-msvc.node` |

npm への公開はバージョンタグ（`v*`）で自動トリガーされます。
