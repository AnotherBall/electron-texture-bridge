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
- **高レベル API**: `sendTextureFromPaintEvent()` がプラットフォーム固有の処理をすべて抽象化
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

### ライブラリとして使用

```bash
npm install @electron-texture-bridge/core
# または
pnpm add @electron-texture-bridge/core
```

`@electron-texture-bridge/core` パッケージが高レベル TypeScript API を提供します。プラットフォーム固有のネイティブバイナリ（`@electron-texture-bridge/native-*`）はオプショナル依存関係として自動的にインストールされます。

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

```powershell
git clone --depth 1 https://github.com/leadedge/Spout2.git _spout2_tmp
Copy-Item -Recurse _spout2_tmp/SPOUTSDK/SpoutDirectX/SpoutDX vendor/SpoutDX
Remove-Item -Recurse -Force _spout2_tmp
```

#### ビルド

```bash
pnpm install
pnpm build          # ネイティブアドオン + core TypeScript パッケージをビルド
```

## クイックスタート

```typescript
import { BrowserWindow, sharedTexture } from "electron";
import { TextureSender, sendTextureFromPaintEvent } from "@electron-texture-bridge/core";

// 1. 共有テクスチャを有効にしたオフスクリーンウィンドウを作成
const win = new BrowserWindow({
  width: 1920,
  height: 1080,
  show: false,
  webPreferences: {
    offscreen: { useSharedTexture: true },
  },
});

// 2. テクスチャセンダーを作成（Syphon/Spout レシーバーに表示される名前）
const sender = new TextureSender("MyApp", 1920, 1080);

// 3. paint イベントのテクスチャを Syphon/Spout に転送
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

### `@electron-texture-bridge/core`

#### `sendTextureFromPaintEvent(sender, textureInfo)`

プラットフォーム固有のテクスチャハンドルの取得と転送を自動的に処理する高レベル関数です。

- **macOS**: `handle.ioSurface` バッファを読み取り → `sender.sendSurface()` を呼び出し
- **Windows**: `handle.ntHandle` バッファを BigInt64LE として読み取り → `sender.send()` を呼び出し

```typescript
function sendTextureFromPaintEvent(
  sender: TextureSender,
  textureInfo: TextureInfo,
): void;
```

#### `TextureSender`

Syphon/Spout レシーバーにテクスチャを送信するネイティブクラスです。

```typescript
class TextureSender {
  // 指定した名前でセンダーを作成（レシーバーアプリに表示される）
  constructor(name: string, width: number, height: number);

  // DXGI ハンドル（Windows）または IOSurfaceID（macOS）を送信 - GPU ゼロコピー
  send(handle: number, width: number, height: number): void;

  // IOSurfaceRef ポインタを直接送信（macOS のみ）- GPU ゼロコピー
  sendSurface(surfaceBuffer: Buffer, width: number, height: number): void;

  // 生の RGBA ピクセルデータを送信（フォールバック、CPU コピーを伴う）
  sendRgbaBuffer(data: Buffer, width: number, height: number, bytesPerRow?: number): void;

  // プラットフォームプロトコル名を取得（"spout" | "syphon-metal"）
  platform(): string;

  // リソースを解放
  stop(): void;
}
```

#### `getPlatform()`

現在のプラットフォームのテクスチャ共有プロトコルを返します。

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

## WebGPU プレビューウィンドウ

Electron の `sharedTexture` API と WebGPU の `importExternalTexture` を使用したオプションの GPU ゼロコピープレビューパスをサポートしています：

```typescript
// メインプロセス: プレビューウィンドウにテクスチャを転送
const imported = sharedTexture.importSharedTexture({ textureInfo });
sharedTexture.sendSharedTexture({
  frame: previewWin.webContents.mainFrame,
  importedSharedTexture: imported,
});

// レンダラープロセス（プレビューウィンドウ）: WebGPU で受信・描画
sharedTexture.setSharedTextureReceiver((data) => {
  const videoFrame = data.importedSharedTexture.getVideoFrame();
  const externalTexture = device.importExternalTexture({ source: videoFrame });
  // ゼロコピー GPU テクスチャで描画...
});
```

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
pnpm --filter @electron-texture-bridge/example run build:mac

# Windows
pnpm --filter @electron-texture-bridge/example run build:win
```

## プロジェクト構成

```
electron-texture-bridge/
├── packages/
│   ├── native/                # @electron-texture-bridge/native (napi-rs)
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
│   ├── core/                  # @electron-texture-bridge/core (TypeScript)
│   │   └── src/
│   │       ├── index.ts       # sendTextureFromPaintEvent + 再エクスポート
│   │       └── types.ts       # TextureInfo, PaintTexture 型定義
│   └── example/               # Electron VJ デモアプリ（プライベート）
│       └── src/
│           ├── main/          # Electron メインプロセス
│           ├── preload/       # sharedTexture レシーバー設定
│           └── renderer/      # Three.js + GLSL + WebGPU プレビュー
├── vendor/                    # サードパーティ SDK（gitignore、ローカルでビルド）
│   ├── syphon-src/            # Syphon Framework ソース（git サブモジュール）
│   ├── Syphon.framework/     # ビルド済みフレームワーク（macOS）
│   └── SpoutDX/              # Spout SDK（Windows）
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
- `try/finally` で確実に release を呼ぶ：

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
