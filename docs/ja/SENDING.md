# テクスチャの送信

[README のクイックスタート](../../lang/ja/README.md#クイックスタート)の先にあるレシピ集です: 外部ページのキャプチャ、透過、低レベル Core API、DPI の正しさ、electron-vite との統合を扱います。

## 外部ページのキャプチャ（`rendererUrl` + `webPreferences`）

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

## 透過での送信（`includeAlpha`）

`includeAlpha: true` を渡すと、ページのピクセル単位のアルファが共有 BGRA テクスチャへ転送されます。VJ ソフトウェア（Resolume、VDMX など）はそのレイヤーを透過マスク付きのまま受け取れるため、他のレイヤーに重ねて合成できます。

```typescript
const bridge = await createTextureBridge({
  name: "MyApp",
  width: 1920,
  height: 1080,
  rendererUrl: "path/to/index.html",
  includeAlpha: true,
});
```

このフラグはオプトイン（デフォルト `false`）です。設定すると、`createTextureBridge` はオフスクリーン `BrowserWindow` を `transparent: true` と `backgroundColor: "#00000000"` 付きで構築します — Chromium のコンポジターが共有テクスチャへ透明な背景を出力するには、この 2 つのキーの両方が必要です。ページ自体も背景を透明にする必要があります。そうしないとアルファが上書きされます:

```css
html, body { background: transparent; }
```

1.0 以外のアルファで描画された WebGL/Canvas コンテンツ（あるいはパイプラインに応じて適切に無効化された premultiplied alpha）は、そのまま共有テクスチャのアルファチャンネルへ反映されます。


## 低レベル: Core API

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

### Electron バージョン別の `paint` イベント形

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

> ### macOS Retina と Windows DPI スケーリング (macOS Retina and Windows DPI scaling)
>
> ⚠️ **Electron 40 以下では黒画面・崩れた出力の最大の原因です。** オフスクリーンフレームバッファが要求した `width × height` とどう対応するかは Electron のバージョンによって変わります:
>
> - **Electron ≥ 41:** `createTextureBridge` が `webPreferences.offscreen.deviceScaleFactor` を `1` に固定するため、フレームバッファは常に厳密に `width × height` ピクセルになります — ディスプレイのスケーリングはテクスチャに影響しません。（`Electron 42` は OSR のデフォルトデバイススケールファクターを `1.0` に変更しました。このオプションが初めて存在する 41 から、ブリッジが明示的に設定しています。）`pixelExact` は自明に満たされ、実質的に no-op になります。macOS では検証済みですが、Windows のディスプレイスケーリングでの検証は未実施です（調査レポートに未解決項目として記載）— Windows でクランプが発生した場合はサイズを小さくするか、[プローブスクリプト](../../packages/renderer/scripts/osr-scale-probe.cjs)で検証してください。
> - **Electron 40:** Chromium はオフスクリーン面を **DIP（デバイス非依存ピクセル）** でサイズ指定するため、共有テクスチャに渡されるフレームバッファは `width × height × display.scaleFactor` になります。macOS Retina ディスプレイ（scaleFactor 2）では `new TextureSender("X", 1280, 720)` と宣言したつもりが **2560×1440** のテクスチャを生成してしまいます。これを吸収するには `createTextureBridge({ pixelExact: true })` を使うか、低レベル core 経路で自分で DPR を処理してください。
>
> **低レベル core**（手動 `BrowserWindow` + `paint`）はどのバージョンでも吸収機構がありません — Electron ≥ 41 では自分で `offscreen: { useSharedTexture: true, deviceScaleFactor: 1 }` を渡し、Electron 40 ではセンダーの宣言サイズと実フレームバッファサイズの整合を自分で取ってください。

## Electron 無しの最小サニティチェック

`TextureSender.sendRgbaBuffer()` は Electron を**必要としません** — plain Node（例: `tsx`）から Syphon/Spout サーバを立てて生 RGBA を流せます。問題の切り分けに最速です。これが VJ アプリに映れば、ネイティブバインディングと Syphon/Spout の発行は健全で、問題は Electron OSR 側に確定できます。

```typescript
// sanity.ts — run with: npx tsx sanity.ts
import { TextureSender, getPlatform } from "@napolab/texture-bridge-core";

const W = 512;
const H = 512;
const sender = new TextureSender("CHECK", W, H);
console.log(getPlatform(), sender.platform()); // e.g. "syphon-metal" "syphon-metal"

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
