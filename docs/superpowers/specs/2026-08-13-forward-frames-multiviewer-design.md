# forwardFrames API + Multi-Receiver Grid Example — Design

- 日付: 2026-08-13
- ステータス: ユーザー承認済み design（brainstorming 完了）
- 関連: `reports/2026-08-10-simple-core-api-abstraction.md`（ローカルのみ）、Cannelloni の capturePage preview（384×216・CPU readback）置き換えニーズ

## 背景 / 目的

Cannelloni のように offscreen window（= Syphon sender）を複数持つアプリで、**main が描画させている内容を renderer に効率よく持ってきて監視（multiviewer）したい**。現状ライブラリには「OSR paint フレームを任意の renderer WebContents に転送する公開 API」が無く、Cannelloni は低品質な `capturePage` 縮小で代替している。一方、同等の機構は `PreviewManager.sendFrame`（import → sendSharedTexture の zero-copy 転送）として**内部に既存**。これを公開 API に昇格し、実証 example を作る。

## 成果物

1. **新公開 primitive（core）**: `forwardSharedTexture(textureInfo, target, extraArgs?)` — 新 subpath `@napolab/texture-bridge-core/electron`（feat/minor）
2. **新公開 API（renderer）**: `TextureBridge.forwardFrames(target, options?)` — 上記 primitive を消費する driver（feat/minor）
3. **新 example ウィンドウ**: Multi-Receiver Grid（`packages/example` に追加）— ローカル直接転送と Syphon 受信の両経路で最大 4 ソースを監視

## 0. core primitive 設計 — `forwardSharedTexture`

```ts
// @napolab/texture-bridge-core/electron — 新 subpath export
export type ForwardDefect =
  | { readonly reason: "target-destroyed" }
  | { readonly reason: "import-failed"; readonly cause: Error }
  | { readonly reason: "send-failed"; readonly cause: Error };

/** 1 フレームを importSharedTexture → sendSharedTexture で target renderer に転送。成功 = undefined */
export const forwardSharedTexture = async (
  textureInfo: TextureInfo,
  target: WebContents,
  extraArgs?: readonly unknown[],
): Promise<ForwardDefect | undefined>;
```

- **subpath に置く理由**: core メインエントリの「Electron 無しで動く」保護契約（`sendRgbaBuffer` の素 Node 切り分け）を守るため。`electron` の static import はこの subpath に隔離（package.json `exports["./electron"]` + tsdown entry 追加）
- **`sendTextureFromPaintEvent` と対称の契約**: L3 は吸収しない — 結果（`ForwardDefect | undefined`）を返して呼び出し側に委ねる。async 関数なので同期 throw は構造的に不可能。import に成功したら send の成否に関わらず release する（release-in-finally）
- 低レベルユーザーは自前 paint ループから直接呼ぶ。release は `finally` で行う（`sendTextureFromPaintEvent` の throw で release がスキップされるリークを避けるため）。`forwardSharedTexture` は同期 dispatch を保証するため await 不要で fire-and-forget できる:
  ```ts
  win.webContents.on("paint", (e) => {
    const texture = e.texture;
    if (!texture) return;
    try {
      void forwardSharedTexture(texture.textureInfo, monitorWC, [slot]); // → renderer(dispatch は同期)
      sendTextureFromPaintEvent(sender, texture.textureInfo);           // → Syphon/Spout(失敗は throw)
    } finally {
      texture.release();
    }
  });
  ```
- 実装は producer/driver 規約準拠（内部 Result、公開面は plain union）

## 1. API 設計 — `forwardFrames`

```ts
export interface FrameForwardOptions {
  /** consumeSharedTexture の handler に varargs で届くタグ（例: slot 番号） */
  readonly extraArgs?: readonly unknown[];
}

export interface FrameForward {
  /** 転送を解除する。冪等 */
  dispose(): void;
}

interface TextureBridge {
  // 既存メンバーに追加
  forwardFrames(target: WebContents, options?: FrameForwardOptions): FrameForward;
}
```

### 意味論

- 各 paint フレームで、登録済み target ごとに **core の `forwardSharedTexture` primitive を呼ぶ driver**。**pixel は動かない**（GPU 共有メモリのハンドル渡し）。primitive が返す `ForwardDefect` は破棄（best-effort 吸収は L1 の責務）
- **best-effort 契約**（preview と同一）: 転送失敗は握り潰し、bridge の `error` / `frameDropped` を汚さない。target が `isDestroyed()` なら skip
- Syphon 送出・preview とは独立・併用可。複数 target、同一 target への複数登録も可（登録は単純な `Set`。fan-out 先が固定引数なので multi-dispatcher は使わない）
- `bridge.dispose()` で全転送停止。`FrameForward.dispose()` は該当登録のみ解除
- renderer 側の受け口は**既存 API のまま**: `installSharedTextureReceiver()` + `consumeSharedTexture((frame, ...extraArgs) => ...)`
- 内部実装は producer/driver 規約（chaining-neverthrow-results）準拠
- JSDoc note: 同一ソース→複数 target のケースは「import 1 回/フレーム → 全 target へ send → 全 settle 後 release」に最適化できる余地がある。初版は preview と同じ per-target import（multiviewer は 1 source = 1 target で差が出ないため YAGNI）

## 2. Example 設計 — Multi-Receiver Grid

`packages/example` に新ウィンドウを追加（既存 electron-vite / preload パターン踏襲）。

### レイアウト（1 ウィンドウ）

```
+--------+--------+--------+--------+
|  P1    |  P2    |  P3    |  P4    |   デッキ: 各 canvas 480×270
| [cv]   | [cv]   | [cv]   | [cv]   |   + UI (source dropdown /
| [UI]   | [UI]   | [UI]   | [UI]   |     Connect / Disconnect /
+--------+--------+--------+--------+     到着fps・描画fps・エラー表示)
|      COMPOSITE PREVIEW (2×2)      |   合成 canvas 960×540。
|   受信フレームを象限に焼き込み      |   Syphon への再送出はしない
+-----------------------------------+
```

crop 機能は**作らない**（ユーザー裁定）。

### ソースの 2 経路（discriminated union）

```ts
type SlotSource =
  | { readonly kind: "local"; readonly id: string }   // 自プロセスの bridge → forwardFrames
  | { readonly kind: "syphon"; readonly senderName: string }; // Syphon ディレクトリ → createSharedTextureReceiver
```

- local: `bridge.forwardFrames(gridWindow.webContents, { extraArgs: [slot] })` — **新 API の実証**
- syphon: `createSharedTextureReceiver({ senderName, target: gridWindow.webContents, extraArgs: [slot], flipY })` — 外部 sender（CANNA-P* 等）用
- dropdown は `[local] <名前>` と Syphon ディレクトリの sender を両方列挙。**同じデモ bridge を両経路で割当可能**（往復あり/なしの比較検証がその場でできる）
- slot 差替時は旧ソースを `dispose()`（`FrameForward` / receiver は共通の `dispose()` を持つ union として保持）

### デモ供給源（単体で 4 slot 埋まる）

- 軽量 bridge 3 本: `Grid-Demo-A/B/C`、960×540・30fps、色相/パターン違いのアニメーション。ページは example renderer の実 HTML（`grid-demo.html?hue=<n>` — electron-vite の dev サーバー / パッケージ時は file で配信。bridge の URL 分岐は data: URL を扱えないため）
- 既存 `ElectronVJ-ThreeJS`（4K raymarching）が 4 本目

### renderer — rAF 合流（latest-frame coalescing）

```
onFrame(frame, slot):
  frames[slot] があれば close して差し替えるだけ（draw しない）
requestAnimationFrame ループ:
  各 slot の最新 frame を deck canvas（全面）+ 合成 canvas（象限）へ drawImage
  draw 済みフレームは次の差し替えまで保持（VideoFrame close は差し替え時）
```

- **draw コストはリフレッシュレートに固定** — slot 数・各ソース fps に比例しない
- 到着 fps（onFrame カウント）と描画 fps（rAF での実 draw）を slot ごとに分計して deck UI に表示
- DOM 取得は receiver-test の `getElement<T>` instanceof ガードパターンを流用

### main / IPC

receiver-test と同形の handler 群: `multi-list-sources`（local bridge 一覧 + `listSenders()`）/ `multi-connect(slot, source, flipY)` / `multi-disconnect(slot)`。syphon 経路の `fps` / `error` は slot 付きで renderer へ転送。窓 close で全 slot dispose + handler 撤去。

## 3. 性能設計判断（アトラス化はしない）

- slot ごとの per-frame コストは「import + IPC（ハンドル 1 個）+ VideoFrame ラップ + drawImage 発行 + close」の**定数のみ**。帯域は増えない（実測根拠: 本 repo example で 4K 1 ストリーム receiver 107.8fps を確認済み、2026-08-13）
- スケールで効くのは draw 回数 → 上記 rAF 合流で解決（フレーム到着ごとの draw をしない）
- **アトラス化を採用しない理由**: atlas が節約するのは import/IPC の定数回数だけで、代わりに main 側 GPU 合成パス（compositor 相当）と遅延 1 段が必要になり preview 用途には本末転倒。合成 canvas 自体が「renderer 側 atlas」。採用条件（数十ソース / 受け側が単一テクスチャ要求 / 非 Electron 受け）に該当しない — この判断を example コード内コメントにも残す

## 4. エラー / ライフサイクル

- forwardFrames: best-effort（上記）。example 側 local 経路のエラーは renderer で検知できない設計（意図的 — preview と同じ）
- syphon 経路: receiver の `error`（typed error classes）を slot UI に表示
- 窓 close / app quit: 全 `dispose()`（bridge 同期 destroy は #70 で担保済み）

## 5. テスト戦略

- **unit（core package）**: `forwardSharedTexture` — delivered（undefined）/ target-destroyed / import-failed（cause 保持）/ send-failed（cause 保持）/ extraArgs 透過 / import 成功後は send 失敗でも release される（electron mock）。TDD。加えて**メインエントリが electron を import しないこと**の surface 検査（dist の index に `from "electron"` が現れない）
- **unit（renderer package）**: `forwardFrames` — 登録/複数 target/dispose 冪等/destroyed skip/extraArgs 転送/bridge dispose で停止（既存 bridge.test.ts のモックパターン）。TDD
- **unit（example なし）**: example はテストスイート無し（既存方針）。demux/象限計算など純関数が生まれたら renderer package 側ではなく example 内に置くため lint/typecheck のみ
- **実機（CDP スモーク）**: 単体起動 → 4 slot を local×2 + syphon×2 で接続 → 各 deck canvas と合成 canvas 全象限の非黒判定 → 到着/描画 fps の表示確認 → slot 差替 → graceful quit

## スコープ外

- crop / zoom UI（ユーザー裁定で削除）
- 合成映像の Syphon 再送出
- atlas 化・import 1 回/フレーム最適化（JSDoc note のみ）
- preview-manager の `forwardSharedTexture` primitive への移行（将来の統一候補として note のみ）
