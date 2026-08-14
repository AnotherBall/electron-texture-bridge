# 移行ガイド

破壊的変更とその対応方法を、新しいものから順に紹介します。

## 移行ガイド: Electron 42 / OSR デバイススケール

Electron 42 でオフスクリーンレンダリングのデフォルトデバイススケールファクターが `1.0` に変更されました（[breaking change](https://www.electronjs.org/docs/latest/breaking-changes)）。この変更を含む texture-bridge のリリース以降（CHANGELOG 参照）、`createTextureBridge` は Electron ≥ 41 で `offscreen.deviceScaleFactor: 1` を固定するため、`width`/`height` はどのディスプレイでも正確なピクセル数を意味するようになります。

- **`pixelExact: true` を使っていた場合**（Electron 40 など）: そのままで問題ありません — Electron ≥ 41 では no-op であり、40 では引き続き必要です。
- **自分でスケーリングを回避していた場合**（`force-device-scale-factor=1`、手動の DIP 計算、Electron 42 で 1/4 解像度になった後に `pixelExact` を外す、など）: アップグレード後はこれらの回避策は不要になります。
- **意図的にスケーリングされたフレームバッファが欲しい場合**は、自分で `webPreferences: { offscreen: { useSharedTexture: true, deviceScaleFactor: <n> } }` を渡してください — ユーザー指定の `offscreen` ブロックは常に優先されます。

実測データの背景: `reports/2026-08-11-pixelexact-osr-scale-investigation.md`。

## 移行ガイド: 同期 dispose（v0.14+）

v0.14 以降、`dispose()` はオフスクリーンの `renderWindow` を `close()` するのではなく、同期的に `destroy()` するようになりました。これによって利用者から見える変化が 2 点あります（disposed 後のウィンドウアクセス、close/beforeunload イベントが発火しなくなる点）— 詳細は [`TextureBridge`](API.md#texturebridge) の `dispose()` の説明を参照してください。

以前、非同期だった旧 `close()` の挙動を回避するために `bridge.dispose()` の後で自前の `bridge.renderWindow.destroy()` を呼んでいた場合は、**その外部からの `destroy()` 呼び出しを削除してください**。`dispose()` の後にこれを呼ぶと、すでに破棄済みのウィンドウを対象にすることになり、Electron は 2 回目の `destroy()` が安全であることを保証していません。すぐに削除できない場合は、ガードするか `dispose()` より前に移動してください
（`if (!bridge.renderWindow.isDestroyed()) bridge.renderWindow.destroy();` とするか、`dispose()` の**前**に呼ぶ、後には呼ばない）。

## 移行ガイド: 明示的な解放（v0.6+）

v0.6 以降、`stop()` と `dispose()` は**終端操作**となり、呼び出すと即座にネイティブの GPU / IPC リソースを解放します。以前はリソースの解放タイミングが JavaScript のガベージコレクションに依存していました。

### 変更点

| 挙動 | 変更前（v0.5） | 変更後（v0.6+） |
|----------|---------------|---------------|
| `sender.stop()` | no-op（GC が解放を担当） | native リソースを即座に drop する |
| `stop()` 後の `sender.send()` | 黙って動いていた | `"TextureSender has been stopped"` を throw する |
| `stop()` 後の `receiver.receiveFrame()` | 古い値または null を返していた | `null` を返す |
| `stop()` 後の `receiver.hasNewFrame()` | 古い値を返していた | `false` を返す |
| `bridge.dispose()` | タイマーの停止のみ | native sender + preview を完全に teardown する |

### 移行方法

**Sender** — 常に明示的な teardown とペアで使う：

```typescript
const sender = new TextureSender("MyApp", 1920, 1080);
try {
  sender.send(handle, w, h);
} finally {
  sender.stop(); // resources released immediately
}
```

**Receiver** — 同じパターン：

```typescript
const receiver = new TextureReceiver("MySender");
try {
  const frame = receiver.receiveFrame();
} finally {
  receiver.stop();
}
```

**高レベルの bridge** — すでに `dispose()` を呼んでいるならコード変更は不要：

```typescript
const bridge = await createTextureBridge({ ... });
// ... use bridge ...
bridge.dispose(); // now deterministic
```

**`using` 宣言**（Node.js 22+、`"lib": ["ESNext.Disposable"]`）：

```typescript
// Import from @napolab/texture-bridge-core for Symbol.dispose support
using sender = new TextureSender("MyApp", 1920, 1080);
// resources automatically released at end of scope
```

### 主なルール

1. `stop()` または `dispose()` を呼んだら、そのインスタンスは永続的に closed 状態になる
2. `stop()` / `dispose()` の複数回呼び出しは安全（idempotent）
3. 停止済みインスタンスを再利用せず、新しく作り直す
4. native リソースの解放を GC に依存しない
