# electron-texture-bridge

Electron の `useSharedTexture` offscreen rendering から **Spout** (Windows) / **Syphon Metal** (macOS) へ GPU zero-copy でテクスチャを共有する napi-rs ネイティブアドオン。

## アーキテクチャ

```
[Worker Thread]           [Chromium GPU Process]      [Native Addon]        [VJ App]
 Three.js / WebGL  ──→   Compositor (Metal/D3D11) ──→  texture-bridge  ──→  Resolume
 OffscreenCanvas          Shared Texture                Spout / Syphon      VDMX 等
```

全パスが GPU 上で完結。CPU readback なし。

## セットアップ

### 前提条件

- Rust toolchain (`rustup`)
- Node.js 20+
- **Windows**: Visual Studio Build Tools, Windows SDK
- **macOS**: Xcode Command Line Tools

### vendor ライブラリの配置

#### Windows: Spout2 SDK

```bash
# Spout2 のソースを vendor/SpoutDX/ に配置
git clone https://github.com/leadedge/Spout2.git /tmp/Spout2
cp -r /tmp/Spout2/SPOUTSDK/SpoutDirectX/SpoutDX vendor/SpoutDX
# SpoutDX 内部が参照するファイルも必要
cp /tmp/Spout2/SPOUTSDK/SpoutDirectX/SpoutDirectX.cpp vendor/SpoutDX/
cp /tmp/Spout2/SPOUTSDK/SpoutDirectX/SpoutDirectX.h vendor/SpoutDX/
cp /tmp/Spout2/SPOUTSDK/SpoutGL/SpoutSenderNames.cpp vendor/SpoutDX/
cp /tmp/Spout2/SPOUTSDK/SpoutGL/SpoutSenderNames.h vendor/SpoutDX/
cp /tmp/Spout2/SPOUTSDK/SpoutGL/SpoutFrameCount.cpp vendor/SpoutDX/
cp /tmp/Spout2/SPOUTSDK/SpoutGL/SpoutFrameCount.h vendor/SpoutDX/
cp /tmp/Spout2/SPOUTSDK/SpoutGL/SpoutUtils.cpp vendor/SpoutDX/
cp /tmp/Spout2/SPOUTSDK/SpoutGL/SpoutUtils.h vendor/SpoutDX/
```

#### macOS: Syphon Framework

```bash
# Syphon の Release ビルドを vendor/ に配置
# GitHub Releases から .framework.zip をダウンロード
# https://github.com/Syphon/Syphon-Framework/releases
unzip Syphon.framework.zip -d vendor/
# vendor/Syphon.framework/ が存在することを確認
```

### ビルド

```bash
# ルートで依存インストール
npm install

# napi-rs でネイティブアドオンをビルド
npm run build

# → texture-bridge.darwin-arm64.node (Mac) または
#   texture-bridge.win32-x64-msvc.node (Win) が生成される
```

### 動作確認

```bash
cd example
npm install
npm start
```

Spout receiver (Windows) または Syphon client (macOS) で "ElectronVJ" が見えれば成功。

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

## handle の取得方法

Electron 39+ での `textureInfo.handle` の構造はプラットフォームにより異なる:

| Platform | Handle Property | Type | 意味 |
|----------|----------------|------|------|
| Windows  | `handle.dxgiHandle` | BigInt/number | DXGI Shared HANDLE |
| macOS    | `handle.ioSurfaceId` | number | IOSurfaceID |

※ Electron のバージョンによって property 名が変わる可能性あり。
  `example/main.js` のフォールバック処理を参照。

## トラブルシューティング

### paint イベントが発火しない
- `win.webContents.setFrameRate(60)` を設定しているか確認
- `show: false` でも paint は発火する
- Worker 内で `requestAnimationFrame` ループが動いているか確認

### テクスチャが真っ黒
- `preserveDrawingBuffer` は不要（Compositor が直接読む）
- ピクセルフォーマットの不一致: Chromium は BGRA、受信側も BGRA を期待しているか確認

### Syphon receiver に表示されない
- `vendor/Syphon.framework` が正しい場所にあるか
- macOS の Gatekeeper: `xattr -dr com.apple.quarantine vendor/Syphon.framework`
- Console.app でエラーログを確認

### release() を呼び忘れるとフリーズ
- テクスチャプールは数枚しかない。`release()` を呼ばないと枯渇して paint が止まる
- try/finally で確実に呼ぶこと

## ライセンス

MIT
