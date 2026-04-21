# electron-texture-bridge

[![CI](https://github.com/naporin0624/electron-texture-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/naporin0624/electron-texture-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../../LICENSE)

**Electron から VJ ソフトウェアへ GPU ゼロコピーでテクスチャを共有する Spout / Syphon Metal ブリッジ**

[English](../../README.md)

Electron のオフスクリーンレンダリング（`useSharedTexture`）から GPU テクスチャをキャプチャし、Resolume Arena、VDMX、OBS、TouchDesigner などの Syphon/Spout 対応アプリケーションへ CPU リードバックなしで共有する napi-rs ネイティブアドオンです。

## アーキテクチャ

```
[Web Worker]              [Chromium GPU Process]         [Native Addon]         [外部アプリ]
 Three.js / WebGL  ──→   Compositor (Metal / D3D11) ──→  texture-bridge  ──→   Resolume Arena
 OffscreenCanvas          Shared Texture (GPU)            Spout / Syphon        VDMX, OBS 等
```

全パイプラインが GPU 上で完結。CPU リードバックなし。サブフレームレイテンシ。

## 特徴

- **GPU ゼロコピー**: IOSurface（macOS）または DXGI Shared Handle（Windows）を介して GPU 上で直接テクスチャを共有
- **クロスプラットフォーム**: macOS は Syphon Metal、Windows は Spout
- **Electron ネイティブ対応**: Electron 40+ の `useSharedTexture` paint イベント API 向けに設計
- **WebGPU プレビュー**: `importExternalTexture` を使用したゼロコピープレビューウィンドウ（オプション）
- **ファクトリ API**: `createTextureBridge()` がオフスクリーンウィンドウ・paint イベント・プレビュー・FPS 計測をすべて自動化
- **低レベル API**: `sendTextureFromPaintEvent()` でパイプラインの完全な制御も可能
- **napi-rs**: 型安全な Rust → Node.js バインディング（プリビルドバイナリ付き）

## 対応プラットフォーム

| プラットフォーム | プロトコル | GPU API | ターゲット |
|----------|----------|---------|--------|
| macOS (Apple Silicon) | Syphon Metal | IOSurface + Metal | `aarch64-apple-darwin` |
| macOS (Intel) | Syphon Metal | IOSurface + Metal | `x86_64-apple-darwin` |
| Windows x64 | Spout | DXGI Shared Handle + D3D11 | `x86_64-pc-windows-msvc` |

## 必要要件

- **Node.js** 20+
- **pnpm** 10+
- **Rust** ツールチェーン（[rustup](https://rustup.rs/) 経由）
- **Electron** 40.0.0+

### macOS

- Xcode Command Line Tools
- macOS 11.0+（Metal サポート）

### Windows

- Visual Studio Build Tools 2019+（「C++ によるデスクトップ開発」ワークロード）
- Windows SDK 10.0.19041.0+
- DirectX 11 対応 GPU

## インストール

> **詳細ガイド:** 前提条件、ソースからのビルド、プロジェクト統合、パッケージング、トラブルシューティングの詳細は [docs/ja/INSTALLATION.md](../../docs/ja/INSTALLATION.md) を参照してください。

### ライブラリとして使用（推奨）

```bash
npm install @napolab/texture-bridge-renderer
# または
pnpm add @napolab/texture-bridge-renderer
```

`@napolab/texture-bridge-renderer` がほとんどのユーザー向けの高レベルパッケージです。`@napolab/texture-bridge-core` と `@napolab/texture-bridge` を依存関係として含みます。

パイプラインを直接制御したい場合：

```bash
npm install @napolab/texture-bridge-core
```

### ソースからビルド

```bash
# サブモジュール（Syphon ソース）を含めてクローン
git clone --recursive https://github.com/naporin0624/electron-texture-bridge.git
cd electron-texture-bridge
```

#### macOS: Syphon Framework のビルド

```bash
cd vendor/syphon-src
xcodebuild -project Syphon.xcodeproj \
  -scheme Syphon \
  -configuration Release \
  -derivedDataPath build \
  ONLY_ACTIVE_ARCH=NO \
  BUILD_LIBRARY_FOR_DISTRIBUTION=YES
cp -R build/Build/Products/Release/Syphon.framework ../Syphon.framework
cd ../..
```

#### Windows: Spout2 SDK の取得

ネイティブアドオンは `SpoutDX/`（C++ ラッパー）と `SpoutGL/`（`SpoutDX.h` が相対
include する共有メモリ/D3D ヘルパー）の両方をビルドするため、Spout2 のサブディレクトリ
構造を `vendor/Spout2/` 配下にそのまま保持してください：

```powershell
git clone --depth 1 https://github.com/leadedge/Spout2.git _spout2_tmp
New-Item -ItemType Directory -Force vendor/Spout2 | Out-Null
Copy-Item -Recurse _spout2_tmp/SPOUTSDK/SpoutDirectX vendor/Spout2/SpoutDirectX
Copy-Item -Recurse _spout2_tmp/SPOUTSDK/SpoutGL vendor/Spout2/SpoutGL
Remove-Item -Recurse -Force _spout2_tmp
```

#### ビルド

```bash
pnpm install
pnpm build          # ネイティブアドオン + core + renderer パッケージをビルド
```

## クイックスタート

### 高レベル: ファクトリ API（推奨）

electron-texture-bridge を最も簡単に使う方法です。ファクトリがオフスクリーンウィンドウの作成、paint イベントの接続、Syphon/Spout センダー、オプションのプレビューウィンドウをすべて1回の呼び出しで処理します。

```typescript
// メインプロセス
import { app } from "electron";
import { createTextureBridge } from "@napolab/texture-bridge-renderer";

app.whenReady().then(async () => {
  const bridge = await createTextureBridge({
    name: "MyApp",
    width: 1920,
    height: 1080,
    frameRate: 60,
    rendererUrl: "path/to/index.html",  // Web Worker を含むレンダラーページ
    preview: { enabled: true },
  });

  bridge.on("fps", (fps) => console.log(`FPS: ${fps.toFixed(1)}`));
  bridge.resize(3840, 2160);  // 全レイヤーを自動リサイズ
  // bridge.dispose();         // 終了時にクリーンアップ
});
```

```html
<!-- レンダラーページ (index.html) -->
<canvas id="canvas" width="1920" height="1080"></canvas>
<script type="module">
  import MyWorker from './my-worker?worker';
  const canvas = document.getElementById('canvas');
  const offscreen = canvas.transferControlToOffscreen();
  const worker = new MyWorker();
  worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen]);
</script>
```

### 低レベル: Core API

パイプラインを完全に制御する場合は `@napolab/texture-bridge-core` を直接使用します。

```typescript
import { BrowserWindow } from "electron";
import { TextureSender, sendTextureFromPaintEvent } from "@napolab/texture-bridge-core";

const win = new BrowserWindow({
  width: 1920,
  height: 1080,
  show: false,
  webPreferences: {
    offscreen: { useSharedTexture: true },
  },
});

const sender = new TextureSender("MyApp", 1920, 1080);

win.webContents.on("paint", (event) => {
  const texture = event.texture;
  if (!texture) return;
  try {
    sendTextureFromPaintEvent(sender, texture.textureInfo);
  } finally {
    texture.release?.(); // 重要: GPU メモリリークを防ぐため必ず release を呼ぶ
  }
});

win.webContents.setFrameRate(60);
```

## API リファレンス

### `@napolab/texture-bridge-renderer`

#### `createTextureBridge(options): Promise<TextureBridge>`

完全に接続されたテクスチャブリッジを作成するファクトリ関数。`app.whenReady()` の後に呼び出す必要があります。

```typescript
interface TextureBridgeOptions {
  name: string;            // Syphon/Spout センダー名
  width: number;           // テクスチャ幅（ピクセル）
  height: number;          // テクスチャ高さ（ピクセル）
  frameRate?: number;      // 目標フレームレート（デフォルト: 60）
  rendererUrl: string;     // 読み込む URL（ファイルパス、file://、http://）
  preview?: PreviewOptions;
  webPreferences?: Electron.WebPreferences;
}

interface PreviewOptions {
  enabled?: boolean;       // プレビューウィンドウを開く（デフォルト: false）
  width?: number;          // プレビューウィンドウ幅
  height?: number;         // プレビューウィンドウ高さ
  title?: string;          // プレビューウィンドウタイトル
}
```

#### `TextureBridge`

返されるハンドル：

```typescript
interface TextureBridge {
  on(event: "fps", listener: (fps: number) => void): this;
  on(event: "ready", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "resize", listener: (width: number, height: number) => void): this;
  on(event: "disposed", listener: () => void): this;

  resize(width: number, height: number): void;  // 全レイヤー + Worker にカスケード
  openPreview(): void;
  closePreview(): void;
  dispose(): void;

  readonly renderWindow: BrowserWindow;
  readonly previewWindow: BrowserWindow | null;
  readonly isDisposed: boolean;
}
```

#### `createWorkerRenderer(options)`（`renderer/client` から）

キャンバスから Worker へのパイプラインを設定するレンダラープロセス用ヘルパー。ResizeObserver による自動リサイズ伝播付き。

```typescript
import { createWorkerRenderer } from "@napolab/texture-bridge-renderer/client";

createWorkerRenderer({
  worker: new MyWorker(),
  width: 1920,
  height: 1080,
});
```

#### Worker プロトコル型（`renderer/worker` から）

```typescript
import type { WorkerMessage } from "@napolab/texture-bridge-renderer/worker";

// Worker 内:
self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  switch (e.data.type) {
    case "init":   /* e.data.canvas: OffscreenCanvas */ break;
    case "resize": /* e.data.width, e.data.height */   break;
    case "dispose": break;
  }
};
```

### `@napolab/texture-bridge-core`

#### `sendTextureFromPaintEvent(sender, textureInfo)`

プラットフォーム固有のテクスチャハンドルの取得と転送を自動的に処理する低レベル関数です。

- **macOS**: `handle.ioSurface` バッファを読み取り → `sender.sendSurface()` を呼び出し
- **Windows**: `handle.ntHandle` バッファを BigInt64LE として読み取り → `sender.send()` を呼び出し

#### `TextureSender`

Syphon/Spout レシーバーにテクスチャを送信するネイティブクラスです。

```typescript
class TextureSender {
  constructor(name: string, width: number, height: number);
  send(handle: number, width: number, height: number): void;
  sendSurface(surfaceBuffer: Buffer, width: number, height: number): void;
  sendRgbaBuffer(data: Buffer, width: number, height: number, bytesPerRow?: number): void;
  platform(): string;
  stop(): void;
}
```

#### `getPlatform()`

```typescript
function getPlatform(): "spout" | "syphon-metal" | "unsupported";
```

#### 型定義

```typescript
type PixelFormat = "bgra" | "nv12" | "rgba" | "rgbaf16";

interface TextureInfo {
  pixelFormat: PixelFormat;
  codedSize: { width: number; height: number };
  visibleRect: { x: number; y: number; width: number; height: number };
  handle: {
    ntHandle?: Buffer;   // Windows (Electron 40+)
    ioSurface?: Buffer;  // macOS
  };
}

interface PaintTexture {
  textureInfo: TextureInfo;
  release?: () => void;
}

type Platform = "spout" | "syphon-metal" | "unsupported";
```

## パフォーマンス

| パス | GPU コピー | レイテンシ | メモリ |
|------|-----------|---------|--------|
| Syphon / Spout | 0（ゼロコピー） | 1 フレーム未満 | 共有 GPU メモリ |
| WebGPU プレビュー | 0（ゼロコピー） | 1 フレーム未満 | 共有 GPU メモリ |
| RGBA バッファ（フォールバック） | 1（CPU → GPU） | 2-3 フレーム | CPU + GPU |

## サンプルアプリケーション

`packages/example/` ディレクトリに以下を実装した VJ アプリケーションが含まれています：

- **Three.js + GLSL レイマーチング**: OffscreenCanvas Web Worker 内でのレンダリング
- **SDF ベースの 3D ビジュアル**: オーディオリアクティブなパラメータ制御
- **WebGPU プレビューウィンドウ**: GPU ゼロコピーテクスチャ表示
- **Syphon/Spout 出力**: プロフェッショナル VJ ソフトウェアとの統合

```bash
# サンプルアプリの実行
pnpm dev:example
```

Syphon/Spout レシーバーアプリで「ElectronVJ-ThreeJS」が表示されれば成功です。

### サンプルアプリのパッケージング

```bash
# macOS
pnpm --filter @napolab/texture-bridge-example run build:mac

# Windows
pnpm --filter @napolab/texture-bridge-example run build:win
```

## プロジェクト構成

```
electron-texture-bridge/
├── packages/
│   ├── native/                # @napolab/texture-bridge (napi-rs)
│   │   ├── src/
│   │   │   ├── lib.rs         # napi-rs エントリポイント、TextureSender API
│   │   │   ├── types.rs       # RawTextureHandle 型エイリアス
│   │   │   ├── mac/           # macOS: Syphon Metal センダー + FFI
│   │   │   └── win/           # Windows: Spout センダー + FFI
│   │   ├── cpp/
│   │   │   ├── mac/           # ObjC++ Syphon Metal ブリッジ
│   │   │   └── win/           # C++ Spout ブリッジ
│   │   ├── build.rs           # プラットフォーム固有のビルド設定
│   │   └── Cargo.toml
│   ├── core/                  # @napolab/texture-bridge-core (TypeScript)
│   │   └── src/
│   │       ├── index.ts       # sendTextureFromPaintEvent + 再エクスポート
│   │       └── types.ts       # TextureInfo, PaintTexture 型定義
│   ├── renderer/              # @napolab/texture-bridge-renderer (TypeScript)
│   │   └── src/
│   │       ├── index.ts       # createTextureBridge ファクトリ
│   │       ├── bridge.ts      # ファクトリ実装（EventEmitter）
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

## トラブルシューティング

### paint イベントが発火しない

- `win.webContents.setFrameRate(60)` を設定しているか確認
- `show: false` でも paint イベントは発火する
- レンダラー/ワーカー内で `requestAnimationFrame` ループが動いているか確認

### テクスチャが真っ黒

- `preserveDrawingBuffer` は不要（Chromium のコンポジターが直接読み取る）
- ピクセルフォーマットの不一致を確認：Chromium は BGRA を出力するので、レシーバー側も BGRA を期待しているか確認

### Syphon レシーバーに表示されない（macOS）

- `vendor/Syphon.framework` が正しい場所にあるか確認
- Gatekeeper の隔離属性をクリア：`xattr -dr com.apple.quarantine vendor/Syphon.framework`
- Console.app でエラーログを確認

### Spout レシーバーに表示されない（Windows）

- Spout2 がシステムにインストールされているか確認
- GPU ドライバが最新か確認
- DirectX 11 対応 GPU が必要

### フリーズ / paint イベントが停止する

- **テクスチャ処理後は必ず `texture.release()` を呼ぶこと。** テクスチャプールは数フレーム分しかありません。release を呼ばないとプールが枯渇し、paint イベントパイプラインが停止します。
- `createTextureBridge()` 使用時は自動的に処理されます。
- 低レベルの core API 使用時は `try/finally` で確実に release を呼ぶ：

```typescript
win.webContents.on("paint", (event) => {
  const texture = event.texture;
  if (!texture) return;
  try {
    sendTextureFromPaintEvent(sender, texture.textureInfo);
  } finally {
    texture.release?.();
  }
});
```

## CI/CD

GitHub Actions が全対応プラットフォーム向けにネイティブバイナリをビルドします：

| ランナー | ターゲット | 出力 |
|--------|--------|--------|
| `macos-14` | `aarch64-apple-darwin` | `texture-bridge.darwin-arm64.node` |
| `macos-13` | `x86_64-apple-darwin` | `texture-bridge.darwin-x64.node` |
| `windows-latest` | `x86_64-pc-windows-msvc` | `texture-bridge.win32-x64-msvc.node` |

npm への公開はバージョンタグ（`v*`）で自動トリガーされます。

## ライセンス

[MIT](../../LICENSE)
