# electron-texture-bridge

[![CI](https://github.com/naporin0624/electron-texture-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/naporin0624/electron-texture-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../../LICENSE)

**Electron から VJ ソフトウェアへ GPU ゼロコピーでテクスチャを共有する Spout / Syphon Metal ブリッジ**

[English](../../README.md)

Electron のオフスクリーンレンダリング（`useSharedTexture`）から GPU テクスチャをキャプチャし、Resolume Arena、VDMX、OBS、TouchDesigner などの Syphon/Spout 対応アプリケーションへ CPU リードバックなしで共有する napi-rs ネイティブアドオンです。

## インストール

```bash
npm i @napolab/texture-bridge-renderer
```

実体は複数の `@napolab/*` パッケージとして公開されています：

| 用途 | パッケージ | 提供するもの |
|------|-----------|-------------|
| **高レベル（推奨）** | [`@napolab/texture-bridge-renderer`](https://www.npmjs.com/package/@napolab/texture-bridge-renderer) | `createTextureBridge()` — ウィンドウ・paint・センダー・プレビューを全配線 |
| 低レベル（手動 paint ループ） | [`@napolab/texture-bridge-core`](https://www.npmjs.com/package/@napolab/texture-bridge-core) | `TextureSender` + `sendTextureFromPaintEvent()` |
| ネイティブバインディング | [`@napolab/texture-bridge`](https://www.npmjs.com/package/@napolab/texture-bridge) | napi-rs の生クラス（`TextureSender`, `TextureReceiver`） |
| プリビルドバイナリ | `@napolab/texture-bridge-darwin-arm64` 他 | プラットフォーム別 `.node`。`optionalDependencies` で自動解決 |

依存方向: `texture-bridge-renderer` → `texture-bridge-core` → `texture-bridge` → `texture-bridge-<platform>`。`-renderer` を入れれば連鎖がすべて入るので、通常は1パッケージに依存するだけで済みます。

## どの API を使うべきか

```
OSR(useSharedTexture) を Syphon/Spout に出したいだけで、ウィンドウ管理もライブラリに任せたい？
  YES → createTextureBridge()  (@napolab/texture-bridge-renderer)
        BrowserWindow・paint 配線・DPR/pixelExact・プレビュー・FPS まで面倒を見る。まずここから。

自前の BrowserWindow / paint ループに後付けで送信だけ足したい？
  YES → TextureSender + sendTextureFromPaintEvent()  (@napolab/texture-bridge-core)
        DPR の整合は自分で担保する（後述の「macOS Retina / Windows DPI」警告を参照）。

Electron 無しで生 RGBA を流したい（テスト / CI / サニティチェック）？
  YES → new TextureSender(...).sendRgbaBuffer()  (@napolab/texture-bridge-core)
        後述の「Electron 無しの最小サニティチェック」を参照。
```

### パッケージの役割と依存方向

```
@napolab/texture-bridge-renderer   高レベルファクトリ API（推奨）: createTextureBridge、
        │                          レシーバー、ディスカバリ、プレビュー
        ▼
@napolab/texture-bridge-core       低レベルプリミティブ: TextureSender / TextureReceiver、
        │                          sendTextureFromPaintEvent — Electron はオプション
        ▼
@napolab/texture-bridge            ネイティブアドオン（napi-rs バインディング）
        │
        ▼
@napolab/texture-bridge-darwin-arm64 / -darwin-x64 / -win32-x64-msvc
                                   プリビルド済みプラットフォームバイナリ（自動インストール）
```

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

### 外部ページのキャプチャ（`rendererUrl` + `webPreferences`）

`rendererUrl` はローカル HTML に限りません。`http(s)://` の URL を渡せば、稼働中の Web ページ（例: YouTube の視聴ページ）をキャプチャして Syphon/Spout へ流せます。`webPreferences` はオフスクリーン `BrowserWindow` にマージされるので、`partition`（隔離済み/ログイン済みセッション）の指定、`autoplayPolicy` の緩和、サンドボックスの無効化などが可能です。

```typescript
const bridge = await createTextureBridge({
  name: "WebCapture",
  width: 1920,
  height: 1080,
  rendererUrl: "https://www.youtube.com/watch?v=...",
  preview: { enabled: true },            // プレビューウィンドウで即座に目視確認
  webPreferences: {
    partition: "persist:capture",        // 隔離セッション（Cookie/ログインがここに永続化）
    autoplayPolicy: "no-user-gesture-required",
    sandbox: false,
  },
});
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

#### Electron バージョン別の `paint` イベント形

本ライブラリは **Electron 40+**（`useSharedTexture` paint イベントが入った最初のバージョン）を対象とします。現行 Electron（42+）ではリスナの引数は単一のイベントオブジェクトで、テクスチャの release メソッドは **非 optional** です：

```typescript
win.webContents.on("paint", (details) => {
  const texture = details.texture;
  if (texture === undefined) return;
  try {
    sendTextureFromPaintEvent(sender, texture.textureInfo);
  } finally {
    texture.release();   // Electron 42: 非 optional（古い型定義では `release?` だった）
  }
});
```

古い例にある `(event, dirtyRect, image, texture)` の分割代入は 40 以前の API で、現行 Electron の型に対しては型エラーになります。`electron@>=42` の型でビルドする場合は `release` のオプショナルチェーンを外してください。

> ### macOS Retina と Windows DPI スケーリング
>
> ⚠️ **Electron 40 以下では黒画面・崩れた出力の最大の原因です。** オフスクリーンフレームバッファが要求した `width × height` とどう対応するかは Electron のバージョンによって変わります:
>
> - **Electron ≥ 41:** `createTextureBridge` が `webPreferences.offscreen.deviceScaleFactor` を `1` に固定するため、フレームバッファは常に厳密に `width × height` ピクセルになります — ディスプレイのスケーリングはテクスチャに影響しません。（`Electron 42` は OSR のデフォルトデバイススケールファクターを `1.0` に変更しました。このオプションが初めて存在する 41 から、ブリッジが明示的に設定しています。）`pixelExact` は自明に満たされ、実質的に no-op になります。macOS では検証済みですが、Windows のディスプレイスケーリングでの検証は未実施です（調査レポートに未解決項目として記載）— Windows でクランプが発生した場合はサイズを小さくするか、[プローブスクリプト](../../packages/renderer/scripts/osr-scale-probe.cjs)で検証してください。
> - **Electron 40:** Chromium はオフスクリーン面を **DIP（デバイス非依存ピクセル）** でサイズ指定するため、共有テクスチャに渡されるフレームバッファは `width × height × display.scaleFactor` になります。macOS Retina ディスプレイ（scaleFactor 2）では `new TextureSender("X", 1280, 720)` と宣言したつもりが **2560×1440** のテクスチャを生成してしまいます。これを吸収するには `createTextureBridge({ pixelExact: true })` を使うか、低レベル core 経路で自分で DPR を処理してください。
>
> **低レベル core**（手動 `BrowserWindow` + `paint`）はどのバージョンでも吸収機構がありません — Electron ≥ 41 では自分で `offscreen: { useSharedTexture: true, deviceScaleFactor: 1 }` を渡し、Electron 40 ではセンダーの宣言サイズと実フレームバッファサイズの整合を自分で取ってください。

### Electron 無しの最小サニティチェック

`TextureSender.sendRgbaBuffer()` は Electron を**必要としません** — plain Node（例: `tsx`）から Syphon/Spout サーバを立てて生 RGBA を流せます。問題の切り分けに最速です。これが VJ アプリに映れば、ネイティブバインディングと Syphon/Spout の発行は健全で、問題は Electron OSR 側に確定できます。

```typescript
// sanity.ts — 実行: npx tsx sanity.ts
import { TextureSender, getPlatform } from "@napolab/texture-bridge-core";

const W = 512;
const H = 512;
const sender = new TextureSender("CHECK", W, H);
console.log(getPlatform(), sender.platform()); // 例: "syphon-metal" "syphon-metal"

const buf = Buffer.alloc(W * H * 4);
let t = 0;
setInterval(() => {
  t += 1;
  for (let i = 0; i < W * H; i++) {
    buf[i * 4 + 0] = (i + t) & 0xff; // R
    buf[i * 4 + 1] = (i * 2 + t) & 0xff; // G
    buf[i * 4 + 2] = t & 0xff; // B
    buf[i * 4 + 3] = 0xff; // A
  }
  sender.sendRgbaBuffer(buf, W, H);
}, 1000 / 30);
```

VJ アプリ（または任意の Syphon/Spout モニタ）を開き、**CHECK** という名前のセンダーがアニメーションしているか確認します。`sendRgbaBuffer` は CPU→GPU コピーを伴うのでデバッグ/フォールバック用途であり、ゼロコピーの本番経路ではありませんが、「Electron が悪いのかブリッジが悪いのか」の切り分けに非常に有効です。

## electron-vite（ESM）との統合

アプリが ESM（`package.json` の `"type": "module"`）で **electron-vite** ビルドの場合、いくつかの統合上の注意点があります：

- **ネイティブパッケージを external 化する。** `main` と `preload` の両方に `externalizeDepsPlugin()` を入れ、`.node` バイナリが bundle されないようにします：

  ```typescript
  // electron.vite.config.ts
  import { defineConfig, externalizeDepsPlugin } from "electron-vite";

  export default defineConfig({
    main: { plugins: [externalizeDepsPlugin()] },
    preload: { plugins: [externalizeDepsPlugin()] },
    renderer: {},
  });
  ```

- **ESM モードでは preload は `.mjs` で排出される。** electron-vite は preload を `index.mjs`（`index.js` ではない）として出力するため、main からは `path.join(import.meta.dirname, "../preload/index.mjs")` のように参照します。古い `../preload/index.js` 参照は「preload not found」系の失敗になります。
- **`import.meta.dirname` は electron-vite が自動注入**するので、自分の main コードに `__dirname` シムは不要です。
- **プリビルドバイナリは `optionalDependencies` で解決される。** pnpm 10 では初回にネイティブパッケージのビルドを `onlyBuiltDependencies`（`pnpm.onlyBuiltDependencies` / `allowBuilds`）で承認する必要がある場合があります。
- **プレビューは ESM でも動作する。** `createTextureBridge({ preview: { enabled: true } })` のアセット解決は ESM セーフです（renderer パッケージは ESM ビルドに `__dirname` シムを同梱）。`"type": "module"` 下でもプレビューウィンドウが開きます。

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
  pixelExact?: boolean;    // ディスプレイ DPR に関係なくフレームバッファを正確に width×height に固定（デフォルト: false）
}

interface PreviewOptions {
  enabled?: boolean;       // プレビューウィンドウを開く（デフォルト: false）
  width?: number;          // プレビューウィンドウ幅
  height?: number;         // プレビューウィンドウ高さ
  title?: string;          // プレビューウィンドウタイトル
}
```

**`pixelExact`** — `true` のとき、ホストディスプレイの DPR に関係なくオフスクリーンフレームバッファを正確に `width × height` ピクセルに固定します。**Electron ≥ 41:** 自明に満たされ実質的に no-op です — `createTextureBridge` がすでに `offscreen.deviceScaleFactor: 1` を固定しているため、このオプションの有無に関わらずフレームバッファは常に正確です。**Electron 40:** 指定しないと Retina（scaleFactor 2）や Windows スケーリング（150% / 175%）のディスプレイでは宣言したセンダーサイズより大きいフレームバッファが生成され、多くの場合レシーバーで黒画面/崩れになります（[Retina/DPI 警告](#macos-retina-と-windows-dpi-スケーリング)参照）。センダーは常に要求ピクセルサイズで登録されるため、レシーバーは指定どおりの寸法を受け取ります。注意: 割り切れないスケール比（例: `1920 / 1.75`）では 1 ピクセルの誤差が残ることがあり、構築時のプライマリディスプレイの scaleFactor のみが反映されます — DPI 変更後は `resize()` で再適用してください。

#### `createTextureBridgeWith(deps)`（上級者向け）

```typescript
interface TextureBridgeDeps {
  createWindow: (options: Electron.BrowserWindowConstructorOptions) => BrowserWindow;
  createSender: (name: string, width: number, height: number) => TextureSender;
}

function createTextureBridgeWith(
  deps: TextureBridgeDeps,
): (options: TextureBridgeOptions) => Promise<TextureBridge>;
```

注入されたコンストラクタに束縛された `createTextureBridge` を返します —
テストや組み込み側が `BrowserWindow` の構築や、ネイティブ `TextureSender` の
構築をテストダブルに差し替えられるようにするためのものです。
`createTextureBridge` 自体も、実際の `BrowserWindow` / `TextureSender` に束縛した
`createTextureBridgeWith` にすぎません。ファクトリは Electron の `app` / `screen`
グローバルを引き続き直接参照し、プレビューウィンドウも自前で構築します
（`PreviewManager`）— このシームはウィンドウ / センダーの構築のみを注入可能にし、
ファクトリ全体を Electron 非依存にするものではありません。完全に Electron 無しの
テスト環境が必要な場合は、`app` / `screen` を別途モックしてください。

#### `TextureBridge`

返されるハンドル：

```typescript
interface TextureBridge {
  on(event: "fps", listener: (fps: number) => void): this;
  on(event: "ready", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "frameDropped", listener: (defect: PaintDefect) => void): this;
  on(event: "resize", listener: (width: number, height: number) => void): this;
  on(event: "disposed", listener: () => void): this;

  resize(width: number, height: number): void;  // 全レイヤー + Worker にカスケード
  openPreview(): void;
  closePreview(): void;
  dispose(): void;

  readonly renderWindow: BrowserWindow;
  readonly previewWindow: BrowserWindow | null;
  readonly isDisposed: boolean;
  readonly droppedReason: PaintDefect["reason"] | null;
}
```

`frameDropped` は、paint フレームがセンダーに届く前にドロップされたときに発火します
（`reason`: `"no-texture" | "no-nt-handle" | "no-io-surface" | "unsupported-platform"`）。
エラーではありませんが、継続的に発火する場合はレシーバー側で黒画面になります。
同じ理由が連続する場合はデデュープされます：イベントは最初の発生時に一度発火し、
成功した送信または理由の変化があった後に再び発火します。リスナーをアタッチする前に
ドロップが確定していた場合（例: レンダラーページがまだロード中の場合）は、
`bridge.droppedReason` を読んでください — 最新のドロップ理由、または成功した送信の後は
`null` を保持します。

`dispose()` は、オフスクリーンの `renderWindow` を `close()` ではなく
`destroy()` で同期的に破棄します。これにより、Electron の `before-quit` との
競合でクラッシュダイアログが出るリスクがなくなります。ここから 2 点が
帰結します:

- **`disposed` リスナーで `bridge.renderWindow.webContents` に触れてはいけません** —
  `disposed` が発火する時点で、オフスクリーンウィンドウはすでに破棄済みです。
- **レンダーウィンドウの `close` イベントと、ページの `beforeunload`/`unload`
  ハンドラはもう発火しません** — これは `destroy()` の仕様どおりの挙動です。
  `closed` イベントは引き続き発火します。

プレビューウィンドウは影響を受けません: 実在する可視ウィンドウであり、
引き続き `close()` により通常のクローズセマンティクスで閉じます。以前、
旧来の非同期な `close()` を避けるため `bridge.dispose()` の後に自前で
`bridge.renderWindow.destroy()` を呼ぶワークアラウンドをしていた場合は、
**その外部からの `destroy()` 呼び出しを削除してください** — `dispose()` が
今はそれを内部で行うため、`dispose()` の後に呼ぶとすでに破棄済みのウィンドウ
に対して呼び出すことになり、Electron は二重の `destroy()` が安全であることを
保証していません（"Object has been destroyed" で例外になり得ます）。ライブラリ
側のガードは `dispose()` 内部の呼び出しのみを保護するものであり、`dispose()`
呼び出し後に外部から呼ばれる `destroy()` までは保護しません。すぐに削除できない
場合は、自分でガードする
（`if (!bridge.renderWindow.isDestroyed()) bridge.renderWindow.destroy();`）か、
`dispose()` より前に呼び出すようにしてください。

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

フレームがセンダーに渡された場合は `undefined` を返し、フレームがドロップされた場合は
`PaintDefect`（`{ reason: "no-texture" | "no-nt-handle" | "no-io-surface" | "unsupported-platform" }`；
`unsupported-platform` バリアントには該当する `platform` も含まれます）を返します。
ドロップは通常のノーオペレーションであり、エラーではありません — `createTextureBridge` が
`frameDropped` イベントで行っているのと同様に、自前の paint ループでも表面化させてください。
ネイティブの送信失敗は `TextureSendError`（両パッケージからエクスポートされます）として
throw されます — メッセージはそのまま保持され、元の throw 値は `error.cause` から参照できます。
`createTextureBridge` を使っている場合、これらはブリッジの `error` イベントとして表面化するため、
`instanceof TextureSendError` で判別できます。

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

`getPlatform()` とインスタンスメソッド `sender.platform()` / `receiver.platform()` は同じ文字列集合を返します：

| 値 | 意味 |
|----|------|
| `"syphon-metal"` | macOS — Syphon Metal バックエンド有効 |
| `"spout"` | Windows — Spout バックエンド有効 |
| `"unsupported"` | バックエンドのないプラットフォーム（送受信は no-op） |

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

> **自分のアプリのパッケージング。** ネイティブ `.node` アドオンは ASAR アーカイブ内からロードできないため、electron-builder 設定に `asarUnpack: "node_modules/@napolab/texture-bridge*"` を追加し、macOS では `Syphon.framework` を `Frameworks/` に同梱して codesign してください。コピペできる electron-builder / electron-forge のスニペットは [docs/ja/INSTALLATION.md](../../docs/ja/INSTALLATION.md) にあります。

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

- **DPR / Retina のサイズ不一致（最も多い）。** **Electron ≤ 40:** Retina ディスプレイや Windows のディスプレイスケーリング下では実フレームバッファが `width × height × scaleFactor` になり、論理サイズで宣言したセンダーと食い違ってレシーバーが黒/崩れになります。`createTextureBridge({ pixelExact: true })` を使うか、低レベル core 経路ではセンダーを実フレームバッファサイズで宣言するか自分で DPR を打ち消してください。**Electron ≥ 41:** `createTextureBridge` が OSR のデバイススケールファクターを `1` に固定するため、この不一致は発生しません — [移行ガイド: Electron 42 / OSR デバイススケール](#移行ガイド-electron-42--osr-デバイススケール)を参照してください。低レベル core 経路では自分で `offscreen: { useSharedTexture: true, deviceScaleFactor: 1 }` を渡してください。（[Retina/DPI 警告](#macos-retina-と-windows-dpi-スケーリング)参照）。
- **Electron とブリッジの切り分け**には[Electron 無しの最小サニティチェック](#electron-無しの最小サニティチェック)を使ってください — `sendRgbaBuffer` が VJ アプリに映ればネイティブ側は健全で、問題は Electron OSR 経路にあります。
- `preserveDrawingBuffer` は不要（Chromium のコンポジターが直接読み取る）
- ピクセルフォーマットの不一致を確認：Chromium は BGRA を出力するので、レシーバー側も BGRA を期待しているか確認
- `bridge.on("frameDropped", ...)` を購読する（または `sendTextureFromPaintEvent` の
  戻り値を確認する）— `no-nt-handle` / `no-io-surface` の理由が継続する場合、
  Chromium が共有可能な GPU ハンドルを配信していないことを意味し、
  それ以外では黒画面としてのみ現れます。

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

## 移行ガイド: Electron 42 / OSR デバイススケール

Electron 42 でオフスクリーンレンダリングのデフォルトデバイススケールファクターが `1.0` に変更されました（[breaking change](https://www.electronjs.org/docs/latest/breaking-changes)）。この変更を含む texture-bridge のリリース以降（CHANGELOG 参照）、`createTextureBridge` は Electron ≥ 41 で `offscreen.deviceScaleFactor: 1` を固定するため、`width`/`height` はどのディスプレイでも正確なピクセル数を意味するようになります。

- **`pixelExact: true` を使っていた場合**（Electron 40 など）: そのままで問題ありません — Electron ≥ 41 では no-op であり、40 では引き続き必要です。
- **自分でスケーリングを回避していた場合**（`force-device-scale-factor=1`、手動の DIP 計算、Electron 42 で 1/4 解像度になった後に `pixelExact` を外す、など）: アップグレード後はこれらの回避策は不要になります。
- **意図的にスケーリングされたフレームバッファが欲しい場合**は、自分で `webPreferences: { offscreen: { useSharedTexture: true, deviceScaleFactor: <n> } }` を渡してください — ユーザー指定の `offscreen` ブロックは常に優先されます。

実測データの背景: `reports/2026-08-11-pixelexact-osr-scale-investigation.md`。

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
