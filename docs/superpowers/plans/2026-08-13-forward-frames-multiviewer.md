# forwardSharedTexture + forwardFrames + Multi-Receiver Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** spec `docs/superpowers/specs/2026-08-13-forward-frames-multiviewer-design.md` の実装 — (0) core 新 subpath `@napolab/texture-bridge-core/electron` の `forwardSharedTexture` primitive、(1) renderer `TextureBridge.forwardFrames`、(2) example の Multi-Receiver Grid ウィンドウ（両経路 4 slot + 2×2 焼き込み preview + rAF 合流）。

**Architecture:** core primitive（L3、`ForwardDefect | undefined` を返し吸収しない）→ renderer driver（L1、best-effort 吸収 + registry）→ example（両経路 union で slot 管理、renderer は latest-frame coalescing）。spec が正で、本計画は手順化。

**Tech Stack:** 既存どおり（pnpm / vitest / tsgo / oxlint / tsdown / electron-vite）。

## Global Constraints

- ブランチ: **feat/forward-frames-multiviewer**（作成済み、spec コミット済み。main ベース）
- spec の契約に従う。特に: core メインエントリに `electron` の import を混入させない（subpath 隔離 + build ガード）。公開面に neverthrow Result を出さない。producer/driver 規約・orTee・mapper 純粋・inner 宣言禁止（chaining-neverthrow-results / memory 準拠）
- 各タスク完了時 `pnpm lint && pnpm typecheck`（tsc 直接実行禁止）。コミットに CLAUDE.md / tasks.md / AGENTS.md を含めない。push は指示待ち
- core の型変更後は `pnpm --filter @napolab/texture-bridge-core build`（下流 typecheck は dist 型を見る）
- 実装完了後 difit → ユーザー OK → push + PR（1 本）

## File Structure

| ファイル | 役割 |
|---|---|
| `packages/core/src/electron.ts` | 新規。subpath entry: `forwardSharedTexture` + `ForwardDefect` |
| `packages/core/src/__tests__/electron.test.ts` | 新規。primitive の TDD |
| `packages/core/scripts/electron-free-guard.mjs` | 新規。メインエントリ dist に electron import が無いことの build ガード |
| `packages/core/package.json` | exports に `./electron` 追加、build script 拡張（第 2 entry + guard） |
| `packages/renderer/src/bridge.ts` / `types.ts` / `index.ts` | `forwardFrames` driver + 型 + export |
| `packages/renderer/src/__tests__/bridge.test.ts` | forwardFrames の TDD |
| `packages/example/electron.vite.config.ts` | preload `multiviewer` / renderer `multiviewer`・`grid-demo` 入力追加 |
| `packages/example/src/main/index.ts` | デモ bridge ×3、multiviewer 窓、slot 管理 + IPC |
| `packages/example/src/renderer/grid-demo.html` | 色相パラメトリックな軽量アニメページ |
| `packages/example/src/renderer/multiviewer.html` | 4 デッキ + 合成 preview の UI |
| `packages/example/src/preload/multiviewer.ts` | 受信 demux + rAF 合流 + UI 配線 |
| `README.md` / `lang/ja/README.md` | API リファレンス + example 節 |

---

### Task 1: core — `forwardSharedTexture` primitive + electron-free ガード

**Files:**
- Create: `packages/core/src/electron.ts`, `packages/core/src/__tests__/electron.test.ts`, `packages/core/scripts/electron-free-guard.mjs`
- Modify: `packages/core/package.json`

**Interfaces (Produces):**
- `export type ForwardDefect = { readonly reason: "target-destroyed" } | { readonly reason: "import-failed"; readonly cause: Error } | { readonly reason: "send-failed"; readonly cause: Error }`
- `export const forwardSharedTexture: (textureInfo: TextureInfo, target: WebContents, extraArgs?: readonly unknown[]) => Promise<ForwardDefect | undefined>` — 成功 = `undefined`。`target.isDestroyed()` または `mainFrame` 欠落 → `target-destroyed`。import 成功後は send の成否に関わらず release

- [ ] **Step 1: 失敗するテストを書く**

`packages/core/src/__tests__/electron.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";

const mockImportSharedTexture = vi.fn();
const mockSendSharedTexture = vi.fn();

vi.mock("electron", () => ({
  sharedTexture: {
    importSharedTexture: (...args: unknown[]) => mockImportSharedTexture(...args),
    sendSharedTexture: (...args: unknown[]) => mockSendSharedTexture(...args),
  },
}));

import { forwardSharedTexture } from "../electron";

const textureInfo = {
  pixelFormat: "bgra" as const,
  codedSize: { width: 16, height: 9 },
  visibleRect: { x: 0, y: 0, width: 16, height: 9 },
  handle: { ioSurface: Buffer.alloc(8) },
};

const makeTarget = (overrides?: { destroyed?: boolean; mainFrame?: unknown }) => {
  const stub: unknown = {
    isDestroyed: () => overrides?.destroyed ?? false,
    mainFrame: "mainFrame" in (overrides ?? {}) ? overrides?.mainFrame : { id: 1 },
  };
  // WebContents はクラス型のため構造的スタブは two-step cast で注入（既存テストの確立パターン）
  return stub as WebContents;
};

const makeImported = () => ({ release: vi.fn(), textureId: "t1" });

describe("forwardSharedTexture", () => {
  beforeEach(() => {
    mockImportSharedTexture.mockReset();
    mockSendSharedTexture.mockReset();
  });

  it("returns undefined and releases the import on success", async () => {
    const imported = makeImported();
    mockImportSharedTexture.mockReturnValue(imported);
    mockSendSharedTexture.mockResolvedValue(undefined);
    const target = makeTarget();

    const result = await forwardSharedTexture(textureInfo, target, ["tag", 3]);

    expect(result).toBeUndefined();
    expect(mockImportSharedTexture).toHaveBeenCalledWith({ textureInfo });
    expect(mockSendSharedTexture).toHaveBeenCalledWith(
      { frame: { id: 1 }, importedSharedTexture: imported },
      "tag",
      3,
    );
    expect(imported.release).toHaveBeenCalledTimes(1);
  });

  it("returns target-destroyed without importing when the target is destroyed", async () => {
    const result = await forwardSharedTexture(textureInfo, makeTarget({ destroyed: true }));
    expect(result).toEqual({ reason: "target-destroyed" });
    expect(mockImportSharedTexture).not.toHaveBeenCalled();
  });

  it("returns target-destroyed when mainFrame is missing", async () => {
    const result = await forwardSharedTexture(textureInfo, makeTarget({ mainFrame: null }));
    expect(result).toEqual({ reason: "target-destroyed" });
    expect(mockImportSharedTexture).not.toHaveBeenCalled();
  });

  it("returns import-failed with a normalized Error cause", async () => {
    mockImportSharedTexture.mockImplementation(() => {
      throw "raw string failure";
    });
    const result = await forwardSharedTexture(textureInfo, makeTarget());
    expect(result?.reason).toBe("import-failed");
    if (result?.reason !== "import-failed") throw new Error("unreachable");
    expect(result.cause).toBeInstanceOf(Error);
    expect(result.cause.message).toBe("raw string failure");
    expect(mockSendSharedTexture).not.toHaveBeenCalled();
  });

  it("returns send-failed and still releases the import", async () => {
    const imported = makeImported();
    mockImportSharedTexture.mockReturnValue(imported);
    mockSendSharedTexture.mockRejectedValue(new Error("ipc gone"));
    const result = await forwardSharedTexture(textureInfo, makeTarget());
    expect(result?.reason).toBe("send-failed");
    if (result?.reason !== "send-failed") throw new Error("unreachable");
    expect(result.cause.message).toBe("ipc gone");
    expect(imported.release).toHaveBeenCalledTimes(1);
  });

  it("never throws synchronously even when import throws", () => {
    mockImportSharedTexture.mockImplementation(() => {
      throw new Error("sync boom");
    });
    expect(() => {
      void forwardSharedTexture(textureInfo, makeTarget());
    }).not.toThrow();
  });
});
```

- [ ] **Step 2: 失敗確認** — `pnpm --filter @napolab/texture-bridge-core test`。Expected: FAIL（`../electron` 不在）

- [ ] **Step 3: 実装** — `packages/core/src/electron.ts`:

```typescript
/**
 * Electron-coupled forwarding primitive — deliberately a SEPARATE subpath
 * (`@napolab/texture-bridge-core/electron`). The package's main entry must
 * stay importable without Electron (the plain-Node `sendRgbaBuffer` sanity
 * check depends on it); the static `electron` import below is quarantined
 * here and enforced by scripts/electron-free-guard.mjs at build time.
 */
import { sharedTexture, type WebContents } from "electron";
import { Result, ResultAsync } from "neverthrow";
import type { TextureInfo } from "./types";

/**
 * Why a frame could not be forwarded. A modeled outcome, not an error —
 * mirrors `sendTextureFromPaintEvent`'s `PaintDefect | undefined` contract:
 * the low-level tier reports, the caller decides.
 */
export type ForwardDefect =
  | { readonly reason: "target-destroyed" }
  | { readonly reason: "import-failed"; readonly cause: Error }
  | { readonly reason: "send-failed"; readonly cause: Error };

const toCauseError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(`${value}`);

const safeImportSharedTexture = Result.fromThrowable(
  (textureInfo: TextureInfo) => sharedTexture.importSharedTexture({ textureInfo }),
  toCauseError,
);

/** Deliver + release in all outcomes. Module scope so deps are explicit args. */
const deliver = async (
  frame: NonNullable<WebContents["mainFrame"]>,
  imported: ReturnType<typeof sharedTexture.importSharedTexture>,
  extraArgs: readonly unknown[],
): Promise<void> => {
  try {
    await sharedTexture.sendSharedTexture({ frame, importedSharedTexture: imported }, ...extraArgs);
  } finally {
    imported.release();
  }
};

/**
 * Forward one paint frame to a renderer `WebContents` via Electron's
 * shared-texture channel (`importSharedTexture` → `sendSharedTexture`).
 * Zero-copy: only a GPU handle crosses process boundaries.
 *
 * Returns `undefined` when the frame was handed to Electron for delivery, or
 * a {@link ForwardDefect} describing why it was not. Never throws
 * synchronously (async function), and never swallows: callers own the
 * decision to log, count, or ignore. The renderer receives the frame through
 * `installSharedTextureReceiver` / `consumeSharedTexture` (from
 * `@napolab/texture-bridge-renderer/client`), with `extraArgs` forwarded
 * verbatim to the consumer handler.
 */
export const forwardSharedTexture = async (
  textureInfo: TextureInfo,
  target: WebContents,
  extraArgs: readonly unknown[] = [],
): Promise<ForwardDefect | undefined> => {
  if (target.isDestroyed()) return { reason: "target-destroyed" };
  const frame = target.mainFrame;
  if (!frame) return { reason: "target-destroyed" };

  return safeImportSharedTexture(textureInfo)
    .mapErr((cause): ForwardDefect => ({ reason: "import-failed", cause }))
    .asyncAndThen((imported) =>
      ResultAsync.fromPromise(
        deliver(frame, imported, extraArgs),
        (cause): ForwardDefect => ({ reason: "send-failed", cause: toCauseError(cause) }),
      ),
    )
    .match(
      () => undefined,
      (defect) => defect,
    );
};
```

- [ ] **Step 4: build 配線** — `packages/core/package.json`:

```diff
   "exports": {
     ".": {
       "import": "./dist/index.mjs",
       "require": "./dist/index.cjs"
     },
+    "./electron": {
+      "import": "./dist/electron.mjs",
+      "require": "./dist/electron.cjs"
+    },
     "./package.json": "./package.json"
   },
-    "build": "tsdown src/index.ts --format cjs,esm --dts --exports",
+    "build": "tsdown src/index.ts src/electron.ts --format cjs,esm --dts && node scripts/electron-free-guard.mjs",
```

注: `--exports` フラグは package.json の exports を自動生成する。2 entry で意図どおりの exports（`.` と `./electron`）を生成するか実機確認し、生成が壊れる場合は上記のように手書き exports + フラグ削除にする（どちらでも可、結果の exports 形が上記と一致すること）。

`packages/core/scripts/electron-free-guard.mjs`（renderer の esm-shim-guard と同パターン）:

```javascript
/**
 * Build guard: the MAIN entry must stay importable without Electron (the
 * plain-Node sendRgbaBuffer sanity check depends on it). Only the ./electron
 * subpath may import electron.
 */
import { readFile } from "node:fs/promises";

export const findElectronImports = (sources) =>
  sources
    .filter(({ content }) => /require\(["']electron["']\)|from\s+["']electron["']/.test(content))
    .map(({ path }) => path);

const invokedAsScript =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedAsScript) {
  const mainEntryFiles = ["../dist/index.mjs", "../dist/index.cjs"];
  const sources = await Promise.all(
    mainEntryFiles.map(async (rel) => ({
      path: rel,
      content: await readFile(new URL(rel, import.meta.url), "utf8"),
    })),
  );
  const offenders = findElectronImports(sources);
  if (offenders.length > 0) {
    console.error(
      `[electron-free-guard] main entry imports electron: ${offenders.join(", ")}\n` +
        `[electron-free-guard] electron imports belong in src/electron.ts (./electron subpath) only.`,
    );
    process.exit(1);
  }
  console.log(`[electron-free-guard] OK — ${mainEntryFiles.length} main-entry file(s) clean`);
}
```

（`pathToFileURL` 相当の比較が macOS で怪しければ renderer の esm-shim-guard と同じ `pathToFileURL(process.argv[1]).href` 形にすること）

- [ ] **Step 5: green 確認** — `pnpm --filter @napolab/texture-bridge-core test`（全 pass）→ `pnpm --filter @napolab/texture-bridge-core build`（`[electron-free-guard] OK` を確認）
- [ ] **Step 6: `pnpm lint && pnpm typecheck`**
- [ ] **Step 7: Commit** — `git add packages/core/src/electron.ts packages/core/src/__tests__/electron.test.ts packages/core/scripts/electron-free-guard.mjs packages/core/package.json && git commit -m "feat(core): forwardSharedTexture primitive on a new electron subpath"`（trailer 付き）

---

### Task 2: renderer — `TextureBridge.forwardFrames`

**Files:**
- Modify: `packages/renderer/src/types.ts` / `bridge.ts` / `index.ts`
- Test: `packages/renderer/src/__tests__/bridge.test.ts`

**Interfaces:**
- Consumes: Task 1 の `forwardSharedTexture`（`@napolab/texture-bridge-core/electron`）
- Produces（types.ts、export）:

```typescript
export interface FrameForwardOptions {
  /** consumeSharedTexture の handler に varargs で届くタグ（例: slot 番号） */
  readonly extraArgs?: readonly unknown[];
}
export interface FrameForward {
  /** 転送登録を解除する。冪等 */
  dispose(): void;
}
```

- `TextureBridge` interface に `forwardFrames(target: WebContents, options?: FrameForwardOptions): FrameForward;` を追加（JSDoc: preview と同じ best-effort 契約 — 転送失敗は握り潰す。ForwardDefect は driver が破棄。受け口は renderer/client の consumeSharedTexture）
- `index.ts` に `export type { FrameForwardOptions, FrameForward } from "./types";`

- [ ] **Step 1: 失敗するテストを書く** — bridge.test.ts に mock 追加:

```typescript
const forwardSharedTextureMock = vi.fn(async () => undefined);
vi.mock("@napolab/texture-bridge-core/electron", () => ({
  forwardSharedTexture: (...args: unknown[]) => forwardSharedTextureMock(...args),
}));
```

（file-level `afterEach` に `forwardSharedTextureMock.mockClear();` を追加）

describe 追加:

```typescript
describe("TextureBridgeImpl.forwardFrames", () => {
  const makeTexture = () => ({
    textureInfo: {
      pixelFormat: "bgra" as const,
      codedSize: { width: 16, height: 9 },
      visibleRect: { x: 0, y: 0, width: 16, height: 9 },
      handle: {},
    },
    release: vi.fn(),
  });

  it("forwards each paint frame to every registered target with its extraArgs", () => {
    sendMock.mockReturnValue(undefined);
    const bridge = new TextureBridgeImpl(new BrowserWindow(), new TextureSender("t", 16, 9), null, baseOpts);
    // WebContents はクラス型のため構造スタブは two-step cast で注入（確立パターン）
    const wcA: unknown = { id: "a" };
    const wcB: unknown = { id: "b" };
    bridge.forwardFrames(wcA as Electron.WebContents, { extraArgs: [0] });
    bridge.forwardFrames(wcB as Electron.WebContents, { extraArgs: [1] });

    const texture = makeTexture();
    bridge.handlePaint({ texture });

    expect(forwardSharedTextureMock).toHaveBeenCalledTimes(2);
    expect(forwardSharedTextureMock).toHaveBeenCalledWith(texture.textureInfo, wcA, [0]);
    expect(forwardSharedTextureMock).toHaveBeenCalledWith(texture.textureInfo, wcB, [1]);
  });

  it("stops forwarding after FrameForward.dispose(), idempotently", () => {
    sendMock.mockReturnValue(undefined);
    const bridge = new TextureBridgeImpl(new BrowserWindow(), new TextureSender("t", 16, 9), null, baseOpts);
    const wc: unknown = { id: "a" };
    const forward = bridge.forwardFrames(wc as Electron.WebContents);
    forward.dispose();
    forward.dispose();

    bridge.handlePaint({ texture: makeTexture() });
    expect(forwardSharedTextureMock).not.toHaveBeenCalled();
  });

  it("defaults extraArgs to [] and keeps forwarding on defect results (best-effort)", async () => {
    sendMock.mockReturnValue(undefined);
    forwardSharedTextureMock.mockResolvedValueOnce({ reason: "send-failed", cause: new Error("x") });
    const bridge = new TextureBridgeImpl(new BrowserWindow(), new TextureSender("t", 16, 9), null, baseOpts);
    const wc: unknown = { id: "a" };
    bridge.forwardFrames(wc as Electron.WebContents);
    const errors: Error[] = [];
    bridge.on("error", (e) => {
      errors.push(e);
    });

    bridge.handlePaint({ texture: makeTexture() });
    bridge.handlePaint({ texture: makeTexture() });
    await Promise.resolve();

    expect(forwardSharedTextureMock).toHaveBeenCalledTimes(2);
    expect(forwardSharedTextureMock).toHaveBeenNthCalledWith(1, expect.anything(), wc, []);
    expect(errors).toEqual([]); // defect は error イベントを汚さない
  });

  it("stops all forwards when the bridge is disposed", () => {
    sendMock.mockReturnValue(undefined);
    const win = new BrowserWindow();
    const bridge = new TextureBridgeImpl(win, new TextureSender("t", 16, 9), null, baseOpts);
    const wc: unknown = { id: "a" };
    bridge.forwardFrames(wc as Electron.WebContents);
    bridge.dispose();

    bridge.handlePaint({ texture: makeTexture() });
    expect(forwardSharedTextureMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 失敗確認** — Expected: FAIL（forwardFrames 未実装）
- [ ] **Step 3: 実装** — bridge.ts:

(a) import: `import { forwardSharedTexture } from "@napolab/texture-bridge-core/electron";` と `type { FrameForward, FrameForwardOptions }` を types から
(b) `TextureBridgeImpl` にフィールド:

```typescript
  private readonly forwardEntries = new Set<{
    readonly target: WebContents;
    readonly extraArgs: readonly unknown[];
  }>();
```

(c) メソッド（class メソッド shorthand）:

```typescript
  forwardFrames(target: WebContents, options?: FrameForwardOptions): FrameForward {
    const entry = { target, extraArgs: options?.extraArgs ?? [] };
    this.forwardEntries.add(entry);
    return {
      dispose: () => {
        this.forwardEntries.delete(entry);
      },
    };
  }
```

（`Set.delete` は冪等なので active フラグ不要）
(d) `handlePaint` の try 内・`previewManager?.sendFrame(texture)` の直後に:

```typescript
      // Best-effort monitors: the primitive reports defects, this driver
      // discards them by contract (same stance as the preview path).
      for (const entry of this.forwardEntries) {
        void forwardSharedTexture(texture.textureInfo, entry.target, entry.extraArgs);
      }
```

(e) `dispose()` に `this.forwardEntries.clear();`（`sender.stop()` の前）
(f) types.ts に interface 2 つ + `TextureBridge.forwardFrames` メンバー（JSDoc 付き）、index.ts に type export

- [ ] **Step 4: green 確認** — `pnpm --filter @napolab/texture-bridge-renderer test`
- [ ] **Step 5: `pnpm lint && pnpm typecheck`**（core は Task 1 で build 済み）
- [ ] **Step 6: Commit** — `git add packages/renderer/src/bridge.ts packages/renderer/src/types.ts packages/renderer/src/index.ts packages/renderer/src/__tests__/bridge.test.ts && git commit -m "feat(renderer): TextureBridge.forwardFrames zero-copy monitor driver"`（trailer 付き）

---

### Task 3: example — デモ供給源 + multiviewer 窓 + IPC（main 側）

**Files:**
- Modify: `packages/example/electron.vite.config.ts`（preload input `multiviewer`、renderer input `multiviewer`・`grid-demo`）
- Create: `packages/example/src/renderer/grid-demo.html`
- Modify: `packages/example/src/main/index.ts`

**Interfaces (Produces — Task 4 が消費):**
- IPC `multi-list-sources` → `{ local: { id: string; label: string }[]; syphon: SenderInfo[] }`
- IPC `multi-connect(slot: number, source: SlotSourceDescriptor, flipY: boolean)` / `multi-disconnect(slot: number)`
  - `type SlotSourceDescriptor = { kind: "local"; id: string } | { kind: "syphon"; senderName: string }`
- renderer への push: `multi-slot-status`（`slot, text` — syphon fps/error と接続状態）。フレーム自体は shared-texture 経路（extraArgs = `[slot]`）
- ウィンドウ: `multiviewer.html`、preload `multiviewer.js`、`nodeIntegration: true / contextIsolation: false`（receiver-test と同じ理由コメント付き）

- [ ] **Step 1: grid-demo.html** — クエリ `hue`（0-360）で色が変わる 960×540 の 2D canvas アニメ（回転する矩形群 + hue ベース背景、`requestAnimationFrame`）。~40 行の self-contained ページ。`<title>Grid Demo</title>`
- [ ] **Step 2: main/index.ts** — `bootstrap` 内に追加:
  - デモ bridge 3 本: `for hue of [0, 120, 240]` → `createTextureBridge({ name: \`Grid-Demo-\${label}\`, width: 960, height: 540, frameRate: 30, rendererUrl: \`\${base}/grid-demo.html?hue=\${hue}\` })`（`base` は `ELECTRON_RENDERER_URL` / file フォールバック — 既存 receiver 窓と同じ分岐）。preview は付けない
  - `const localBridges = new Map<string, { label: string; bridge: TextureBridge }>()` — `ElectronVJ-ThreeJS`（既存 bridge）+ デモ 3 本を登録
  - multiviewer 窓（960×~1200、receiver-test と同 webPreferences パターン、`multiviewer.html` をロード）
  - slot 管理: `const slots = new Map<number, { dispose(): void }>()` — `multi-connect` は既存 slot を dispose してから、descriptor の kind で分岐:
    - local → `localBridges.get(id).bridge.forwardFrames(multiWindow.webContents, { extraArgs: [slot] })`
    - syphon → `createSharedTextureReceiver({ senderName, target: multiWindow.webContents, extraArgs: [slot], pollIntervalMs: 8, flipY })`、`fps`/`error` を `multi-slot-status` で転送、返り値を `{ dispose: () => receiver.dispose() }` に包む
  - `multi-list-sources` は `localBridges` と `listSenders()` を返す。`multi-disconnect` は slot dispose。窓 `closed` で全 slot dispose + handler 撤去（receiver-test の後始末パターン踏襲）
  - 既存 `activeBridge` の before-quit dispose に、デモ bridge 3 本の dispose も追加
- [ ] **Step 3: electron.vite.config.ts** — preload input に `multiviewer: resolve("src/preload/multiviewer.ts")`、renderer input に `multiviewer` と `"grid-demo"` を追加（Task 4 のファイルがまだ無いのでこの Step は Task 4 と同コミットでも可 — typecheck を壊さない順序で）
- [ ] **Step 4: `pnpm lint && pnpm typecheck`**（multiviewer.ts が未作成の場合は config 追加を Task 4 に送って green を保つ）
- [ ] **Step 5: Commit** — `git commit -m "feat(example): demo sender bridges and multiviewer window wiring"`（trailer 付き。対象: main/index.ts, grid-demo.html,（config は Task 4 送りなら除外））

---

### Task 4: example — multiviewer renderer（デッキ UI + rAF 合流 + 合成）

**Files:**
- Create: `packages/example/src/renderer/multiviewer.html`, `packages/example/src/preload/multiviewer.ts`
- Modify: `packages/example/electron.vite.config.ts`（Task 3 Step 3 を持ち越した場合）

**要件（spec §2 の忠実な実装）:**
- multiviewer.html: 4 デッキ（`<canvas id="deck-N" width="480" height="270">` + `<select id="source-N">` + Connect/Disconnect ボタン + `<span id="status-N">`（到着fps/描画fps/状態））+ `<canvas id="composite" width="960" height="540">` + 全体 Refresh ボタン。スタイルは receiver-test.html の簡素なダーク系を踏襲
- preload/multiviewer.ts:
  - `installSharedTextureReceiver()` を冒頭で 1 回
  - `consumeSharedTexture({ onFrame(frame, ...args) })` **1 個**: `const slot = args[0]`（`typeof slot === "number" && slot >= 0 && slot < 4` ガード）→ **rAF 合流**: `latest[slot]` を close して差し替え、`arrivalCounts[slot] += 1`。**draw はしない**
  - `requestAnimationFrame` ループ: 各 slot の `latest[i]` があれば deck canvas 全面 + composite の象限 `(i % 2) * 480, Math.floor(i / 2) * 270` に drawImage、`drawCounts[i] += 1`。**draw 後も close しない**（次の差し替えまで保持 — spec どおり）
  - 1 秒毎に status 更新（到着fps / 描画fps を分計表示）
  - UI 配線: `getElement<T>` instanceof ガードパターン（receiver.ts から流用 or 複製 — example 内複製で可、no-barrel）。source dropdown は `multi-list-sources` の local（`[local] ` prefix）と syphon（`[syphon] `）を optgroup で列挙。Connect → `multi-connect(slot, descriptor, flipYChecked)`。`multi-slot-status` push を status 表示にマージ
  - 窓 unload 時に latest を全 close
- [ ] **Step 1: 実装**（example にテスト無し方針 — lint/typecheck が gate）
- [ ] **Step 2: `pnpm lint && pnpm typecheck`**
- [ ] **Step 3: 起動スモーク（実装者が実施）** — `pnpm exec electron-vite dev`（packages/example 内）で multiviewer 窓が開き、slot 0 に `[local] Grid-Demo-A` を接続してデッキと合成象限が動くこと。**確認後 example プロセスを必ず全 kill**（親 Electron プロセスまで）
- [ ] **Step 4: Commit** — `git commit -m "feat(example): multiviewer deck UI with rAF-coalesced compositing"`（trailer 付き）

---

### Task 5: docs + 検証 + difit

- [ ] **Step 1: README EN** — API Reference: `createTextureBridge` 系の並びに `forwardFrames` エントリ、core 側に `forwardSharedTexture`（subpath・ForwardDefect・electron-free メインエントリの説明）。Example セクションに Multi-Receiver Grid の段落（両経路・rAF 合流・アトラス不採用の一行理由）
- [ ] **Step 2: lang/ja/README.md** — 対応箇所をミラー
- [ ] **Step 3: フル検証** — `pnpm --filter @napolab/texture-bridge-core build && pnpm --filter @napolab/texture-bridge-renderer build && pnpm lint && pnpm typecheck && pnpm --filter @napolab/texture-bridge-core test && pnpm --filter @napolab/texture-bridge-renderer test`（両ガード OK 出力を確認）
- [ ] **Step 4: Commit** — `git commit -m "docs: forwardSharedTexture / forwardFrames reference and multiviewer example"`（trailer 付き）
- [ ] **Step 5: CDP スモーク（コントローラ実施）** — `pnpm --filter @napolab/texture-bridge-example exec electron-vite dev --remoteDebuggingPort 9222` → multiviewer に local×2 + syphon×2 を接続 → デッキ 4 面 + 合成 4 象限の非黒判定 → slot 差替 → graceful quit → プロセス全 kill
- [ ] **Step 6: difit** — `pnpm dlx difit HEAD main`。**push / PR はユーザー OK 待ち**

## 実装しないこと（spec のスコープ外に同じ）

- crop / zoom、合成の Syphon 再送出、atlas 化、import 1 回/フレーム最適化、preview-manager の primitive 移行
