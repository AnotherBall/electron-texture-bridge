# electron-texture-bridge

Electron の `useSharedTexture` offscreen rendering から **Spout** (Windows) / **Syphon Metal** (macOS) へ GPU zero-copy でテクスチャを共有する napi-rs ネイティブアドオン。

## アーキテクチャ

```
[Worker Thread]           [Chromium GPU Process]      [Native Addon]        [VJ App]
 Three.js / WebGL  ──→   Compositor (Metal/D3D11) ──→  texture-bridge  ──→  Resolume
 OffscreenCanvas          Shared Texture                Spout / Syphon      VDMX 等
```

全パスが GPU 上で完結。CPU readback なし。

## 必要要件

### 共通
- Node.js 20+
- pnpm 10+
- Rust toolchain (`rustup`)

### macOS
- Xcode Command Line Tools
- macOS 11.0+

### Windows
- Visual Studio Build Tools 2019+
- Windows SDK 10.0.19041.0+

## macOS でのビルド

### 1. Rust と Node.js のセットアップ

```bash
# Rust のインストール
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env

# pnpm のインストール (未インストールの場合)
npm install -g pnpm
```

### 2. Syphon Framework のビルド

```bash
# リポジトリをクローン
git clone --recursive https://github.com/naporin0624/electron-texture-bridge.git
cd electron-texture-bridge

# Syphon Framework をビルド
cd vendor/syphon-src
xcodebuild -project Syphon.xcodeproj -scheme Syphon -configuration Release

# ビルドされたフレームワークを vendor/ にコピー
cp -r build/Build/Products/Release/Syphon.framework ../
cd ../..
```

### 3. ネイティブアドオンのビルド

```bash
# 依存関係のインストール
pnpm install

# ネイティブアドオンのビルド
pnpm run build
# → index.darwin-arm64.node (Apple Silicon)
# → index.darwin-x64.node (Intel Mac)
```

### 4. Example アプリの実行

```bash
cd example
pnpm install
pnpm run dev
```

Syphon Simple Client などで "TextureBridgeExample" が表示されれば成功。

### 5. アプリケーションのパッケージング

```bash
cd example
pnpm run build:mac
# → dist/texture-bridge-example-x.x.x.dmg
```

## Windows でのビルド

### 1. 前提条件のインストール

```powershell
# Rust のインストール
# https://rustup.rs/ からインストーラをダウンロードして実行

# Visual Studio Build Tools のインストール
# https://visualstudio.microsoft.com/downloads/ から
# "Build Tools for Visual Studio" をダウンロード
# インストール時に以下を選択:
# - "Desktop development with C++"
# - Windows 10/11 SDK
```

### 2. Spout2 SDK のセットアップ

```powershell
# リポジトリをクローン
git clone --recursive https://github.com/naporin0624/electron-texture-bridge.git
cd electron-texture-bridge

# Spout2 SDK をダウンロード
git clone https://github.com/leadedge/Spout2.git temp_spout

# 必要なファイルを vendor/SpoutDX/ にコピー
mkdir -p vendor/SpoutDX
Copy-Item temp_spout/SPOUTSDK/SpoutDirectX/SpoutDX/* vendor/SpoutDX/ -Recurse
Copy-Item temp_spout/SPOUTSDK/SpoutDirectX/SpoutDirectX.cpp vendor/SpoutDX/
Copy-Item temp_spout/SPOUTSDK/SpoutDirectX/SpoutDirectX.h vendor/SpoutDX/
Copy-Item temp_spout/SPOUTSDK/SpoutGL/SpoutSenderNames.cpp vendor/SpoutDX/
Copy-Item temp_spout/SPOUTSDK/SpoutGL/SpoutSenderNames.h vendor/SpoutDX/
Copy-Item temp_spout/SPOUTSDK/SpoutGL/SpoutFrameCount.cpp vendor/SpoutDX/
Copy-Item temp_spout/SPOUTSDK/SpoutGL/SpoutFrameCount.h vendor/SpoutDX/
Copy-Item temp_spout/SPOUTSDK/SpoutGL/SpoutUtils.cpp vendor/SpoutDX/
Copy-Item temp_spout/SPOUTSDK/SpoutGL/SpoutUtils.h vendor/SpoutDX/

# 一時ディレクトリを削除
Remove-Item -Recurse -Force temp_spout
```

### 3. ネイティブアドオンのビルド

```powershell
# 依存関係のインストール
pnpm install

# ネイティブアドオンのビルド
pnpm run build
# → index.win32-x64-msvc.node
```

### 4. Example アプリの実行

```powershell
cd example
pnpm install
pnpm run dev
```

Spout Receiver などで "TextureBridgeExample" が表示されれば成功。

### 5. アプリケーションのパッケージング

```powershell
cd example
pnpm run build:win
# → dist/texture-bridge-example-x.x.x-setup.exe
```

## JS API

```js
const { TextureSender, getPlatform } = require('electron-texture-bridge');

// 初期化
const sender = new TextureSender('MyVJApp', 1920, 1080);
console.log(sender.platform()); // "spout" or "syphon-metal"

// Electron の paint イベントで使用
win.webContents.on('paint', (_event, _dirty, texture) => {
  const { textureInfo, release } = texture;
  const handle = extractHandle(textureInfo); // プラットフォーム別の handle 取得
  sender.send(handle, textureInfo.codedSize.width, textureInfo.codedSize.height);
  release(); // 必ず呼ぶ
});

// 終了
sender.stop();
```

## Handle の取得方法

Electron 39+ での `textureInfo.handle` の構造はプラットフォームにより異なる:

| Platform | Handle Property | Type | 意味 |
|----------|----------------|------|------|
| Windows  | `handle.dxgiHandle` | BigInt/number | DXGI Shared HANDLE |
| macOS    | `handle.ioSurfaceId` | number | IOSurfaceID |

## Example アプリケーション

`example/` ディレクトリに Three.js を使った raymarching シェーダーの VJ アプリケーションが含まれています。

- OffscreenCanvas + WebWorker での Three.js レンダリング
- GLSL raymarching シェーダー（SDF ベースの 3D ビジュアル）
- オーディオリアクティブなパラメータ制御
- WebGPU プレビューウィンドウ

## トラブルシューティング

### paint イベントが発火しない
- `win.webContents.setFrameRate(60)` を設定しているか確認
- `show: false` でも paint は発火する
- Worker 内で `requestAnimationFrame` ループが動いているか確認

### テクスチャが真っ黒
- `preserveDrawingBuffer` は不要（Compositor が直接読む）
- ピクセルフォーマットの不一致: Chromium は BGRA、受信側も BGRA を期待しているか確認

### Syphon receiver に表示されない (macOS)
- `vendor/Syphon.framework` が正しい場所にあるか
- macOS の Gatekeeper: `xattr -dr com.apple.quarantine vendor/Syphon.framework`
- Console.app でエラーログを確認

### Spout receiver に表示されない (Windows)
- Spout2 がシステムにインストールされているか確認
- GPU ドライバが最新か確認
- DirectX 11 対応の GPU が必要

### release() を呼び忘れるとフリーズ
- テクスチャプールは数枚しかない。`release()` を呼ばないと枯渇して paint が止まる
- try/finally で確実に呼ぶこと

## ディレクトリ構成

```
electron-texture-bridge/
├── src/                    # Rust ソースコード
│   ├── lib.rs             # NAPI エントリポイント
│   ├── types.rs           # 共通型定義
│   ├── mac/               # macOS (Syphon) 実装
│   └── win/               # Windows (Spout) 実装
├── cpp/                    # C++/ObjC++ ブリッジ
│   ├── mac/               # Syphon ObjC++ ラッパー
│   └── win/               # Spout C++ ラッパー
├── vendor/                 # サードパーティライブラリ
│   ├── syphon-src/        # Syphon Framework ソース (submodule)
│   ├── Syphon.framework/  # ビルド済み Framework (gitignore)
│   └── SpoutDX/           # Spout SDK (gitignore)
├── example/                # サンプルアプリケーション
│   ├── src/
│   │   ├── main/          # Electron メインプロセス
│   │   ├── preload/       # プリロードスクリプト
│   │   └── renderer/      # レンダラー (Three.js + Worker)
│   └── build/             # アプリアイコン等
├── build.rs               # Rust ビルドスクリプト
├── Cargo.toml             # Rust 依存関係
└── package.json           # Node.js 依存関係
```

## ライセンス

MIT
