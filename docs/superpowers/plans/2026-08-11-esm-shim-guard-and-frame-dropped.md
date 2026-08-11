# ESM Shim Guard + frameDropped Event Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (a) ESM ビルドの `__dirname` shim が消えたらビルドが落ちる回帰ガードを追加し、(b) paint フレームの silent drop を `PaintDefect` union + `frameDropped` イベントとして観測可能にする。

**Architecture:** ガードは「dist の `.mjs` に `__dirname` 参照があるなら同ファイル内に shim 定義（`const __dirname =`）が必ずある」という不変条件を build スクリプト最終段で検査する純関数 + CLI。#2 は core の `sendTextureFromPaintEvent` の返り値を `void → PaintDefect | undefined` に変え（呼び出し側後方互換）、renderer の `handlePaint` が defect を受けて連続同一 reason をデデュープしつつ `frameDropped` を emit する。公開 API に neverthrow Result は出さない（プレーンな tagged union のみ）。

**Tech Stack:** pnpm workspace / vitest / tsdown（`shims: true` 済み）/ tsgo（`pnpm typecheck`）/ oxlint+oxfmt（`pnpm lint` / `pnpm fmt`）

## Global Constraints

- ベースは **main**。開始前に `git fetch origin main && git pull --ff-only origin main`（`.claude/rules/git-workflow.md`）
- ブランチ名: `feat/frame-dropped-event`
- **未マージ stacked PR #58–#64 が `packages/core/src/index.ts` の同関数を触っている。** 衝突を最小化するため、`sendTextureFromPaintEvent` の diff は必要最小限にし、既存の `function` 宣言スタイル・`Number(...)`・`String(err)` 等の既存行は**変更しない**（スタイル移行は PR #58/#64 の領分）
- **neverthrow をこの作業で導入しない**（PR #64 の領分）。defect は素の tagged union で表現
- 公開 API から neverthrow `Result` を返さない（memory: neverthrow-api-boundary）
- 各タスク完了時に `pnpm lint && pnpm typecheck` を通すこと（`.claude/rules/coding-rules.md`）。`npx tsc` 直接実行は禁止
- コミットは本計画に書かれたステップでのみ行う。main への直接コミット禁止。マージ・push は指示があるまで行わない
- 実装完了後は difit を起動してユーザーにレビュー依頼する（Task 5）

## File Structure

| ファイル | 役割 |
|---|---|
| `packages/renderer/scripts/esm-shim-guard.mjs` | 新規。純関数 `findUnshimmedSources` + CLI（build 最終段で実行） |
| `packages/renderer/scripts/esm-shim-guard.d.mts` | 新規。上記の型宣言（tsgo 用） |
| `packages/renderer/src/__tests__/esm-shim-guard.test.ts` | 新規。純関数のユニットテスト |
| `packages/renderer/package.json` | 変更。`build` スクリプトにガード実行を追加 |
| `packages/core/src/types.ts` | 変更。`PaintDefect` union を追加 |
| `packages/core/src/index.ts` | 変更。`sendTextureFromPaintEvent` が defect を返す。`PaintDefect` を re-export |
| `packages/core/src/__tests__/index.test.ts` | 変更。返り値のテストを追加 |
| `packages/renderer/src/types.ts` | 変更。`BridgeEvents` に `frameDropped` を追加 |
| `packages/renderer/src/bridge.ts` | 変更。`TextureBridgeImpl` を export（テスト seam）、`handlePaint` の defect 配線 + デデュープ |
| `packages/renderer/src/__tests__/bridge.test.ts` | 変更。`handlePaint` の frameDropped テストを追加 |
| `packages/renderer/src/index.ts` | 変更。`PaintDefect` 型を re-export |
| `README.md` | 変更。`frameDropped` / 返り値のドキュメント |

---

### Task 1: ブランチ準備 + ESM shim 回帰ガード

**Files:**
- Create: `packages/renderer/scripts/esm-shim-guard.mjs`
- Create: `packages/renderer/scripts/esm-shim-guard.d.mts`
- Test: `packages/renderer/src/__tests__/esm-shim-guard.test.ts`
- Modify: `packages/renderer/package.json`（`scripts.build`）

**Interfaces:**
- Produces: `findUnshimmedSources(sources: readonly { path: string; content: string }[]): string[]` — `__dirname` を参照するのに `const __dirname =` 定義を持たない source の path 一覧を返す

- [ ] **Step 1: main を最新化してブランチ作成**

```bash
git fetch origin main
git checkout main
git pull --ff-only origin main
git switch -c feat/frame-dropped-event
```

- [ ] **Step 2: 失敗するテストを書く**

`packages/renderer/src/__tests__/esm-shim-guard.test.ts` を新規作成:

```typescript
import { describe, expect, it } from "vitest";

import { findUnshimmedSources } from "../../scripts/esm-shim-guard.mjs";

const SHIMMED = `
import path from "node:path";
import { fileURLToPath } from "node:url";
const getFilename = () => fileURLToPath(import.meta.url);
const getDirname = () => path.dirname(getFilename());
const __dirname = /* @__PURE__ */ getDirname();
const asset = path.join(__dirname, "assets", "preview.html");
`;

const UNSHIMMED = `
import path from "path";
const asset = path.join(__dirname, "assets", "preview.html");
`;

const NO_DIRNAME = `
export const add = (a, b) => a + b;
`;

describe("findUnshimmedSources", () => {
  it("flags a source that references __dirname without defining it", () => {
    const result = findUnshimmedSources([{ path: "index.mjs", content: UNSHIMMED }]);
    expect(result).toEqual(["index.mjs"]);
  });

  it("passes a source whose __dirname reference is backed by a shim definition", () => {
    const result = findUnshimmedSources([{ path: "index.mjs", content: SHIMMED }]);
    expect(result).toEqual([]);
  });

  it("passes a source that never references __dirname", () => {
    const result = findUnshimmedSources([{ path: "util.mjs", content: NO_DIRNAME }]);
    expect(result).toEqual([]);
  });

  it("reports only the offending files among a mixed set", () => {
    const result = findUnshimmedSources([
      { path: "a.mjs", content: SHIMMED },
      { path: "b.mjs", content: UNSHIMMED },
      { path: "c.mjs", content: NO_DIRNAME },
    ]);
    expect(result).toEqual(["b.mjs"]);
  });
});
```

- [ ] **Step 3: テストが失敗することを確認**

```bash
pnpm --filter @napolab/texture-bridge-renderer test -- esm-shim-guard
```

Expected: FAIL — `Cannot find module '../../scripts/esm-shim-guard.mjs'`

- [ ] **Step 4: ガード本体を実装**

`packages/renderer/scripts/esm-shim-guard.mjs` を新規作成:

```javascript
/**
 * Regression guard for the ESM `__dirname` shim (renderer 0.13.1 fix).
 *
 * PreviewManager resolves bundled assets via `__dirname`, which only exists in
 * the ESM output because tsdown injects a shim (`shims: true` in
 * tsdown.config.mts). If that flag is ever dropped, the .mjs build throws
 * `ReferenceError: __dirname is not defined` at import time under an ESM
 * Electron main — exactly the 0.13.0 bug consumers had to patch around.
 *
 * Invariant checked here: every dist .mjs that references `__dirname` must
 * also define it (`const __dirname = ...` — the shape of tsdown's shim).
 */
import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const findUnshimmedSources = (sources) =>
  sources
    .filter(({ content }) => /\b__dirname\b/.test(content) && !/const __dirname\s*=/.test(content))
    .map(({ path }) => path);

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  const distDir = new URL("../dist/", import.meta.url);
  const entries = await readdir(distDir, { recursive: true });
  const mjsPaths = entries.filter((entry) => entry.endsWith(".mjs"));
  const sources = await Promise.all(
    mjsPaths.map(async (entryPath) => ({
      path: entryPath,
      content: await readFile(new URL(entryPath, distDir), "utf8"),
    })),
  );
  const offenders = findUnshimmedSources(sources);
  if (offenders.length > 0) {
    console.error(
      `[esm-shim-guard] ESM output references __dirname without a shim: ${offenders.join(", ")}\n` +
        `[esm-shim-guard] Check that tsdown.config.mts still sets \`shims: true\`.`,
    );
    process.exit(1);
  }
  console.log(`[esm-shim-guard] OK — ${mjsPaths.length} .mjs file(s) checked`);
}
```

`packages/renderer/scripts/esm-shim-guard.d.mts` を新規作成:

```typescript
export declare const findUnshimmedSources: (
  sources: readonly { readonly path: string; readonly content: string }[],
) => string[];
```

- [ ] **Step 5: テストが通ることを確認**

```bash
pnpm --filter @napolab/texture-bridge-renderer test -- esm-shim-guard
```

Expected: PASS（4 件）

- [ ] **Step 6: build スクリプトに配線**

`packages/renderer/package.json` の `scripts.build` を変更:

```diff
-    "build": "tsdown && cp -r src/assets dist/assets",
+    "build": "tsdown && cp -r src/assets dist/assets && node scripts/esm-shim-guard.mjs",
```

- [ ] **Step 7: 実ビルドでガードが green になることを確認**

```bash
pnpm --filter @napolab/texture-bridge-renderer build
```

Expected: ビルド成功、最後に `[esm-shim-guard] OK — N .mjs file(s) checked` が出力される

- [ ] **Step 8: lint / typecheck**

```bash
pnpm lint && pnpm typecheck
```

Expected: どちらも成功

- [ ] **Step 9: Commit**

```bash
git add packages/renderer/scripts/esm-shim-guard.mjs packages/renderer/scripts/esm-shim-guard.d.mts packages/renderer/src/__tests__/esm-shim-guard.test.ts packages/renderer/package.json
git commit -m "test(renderer): guard ESM __dirname shim in build output"
```

---

### Task 2: core — `PaintDefect` union と `sendTextureFromPaintEvent` の返り値

**Files:**
- Modify: `packages/core/src/types.ts`（末尾に追加）
- Modify: `packages/core/src/index.ts:42-67`
- Test: `packages/core/src/__tests__/index.test.ts`

**Interfaces:**
- Produces:
  - `type PaintDefect = { readonly reason: "no-texture" } | { readonly reason: "no-nt-handle" } | { readonly reason: "no-io-surface" } | { readonly reason: "unsupported-platform"; readonly platform: NodeJS.Platform }`（`packages/core/src/types.ts` から export、`packages/core/src/index.ts` で re-export）
  - `sendTextureFromPaintEvent(sender, textureInfo): PaintDefect | undefined` — 送出成功時は `undefined`、drop 時は defect を返す。**throw の挙動（sender 停止後の native throw など）は従来どおり変更しない**

- [ ] **Step 1: 失敗するテストを書く**

`packages/core/src/__tests__/index.test.ts` の `describe("sendTextureFromPaintEvent", ...)` 内に追加。既存の `it("does nothing when textureInfo is undefined", ...)` は返り値の assert を足して次の内容に**置き換える**:

```typescript
  it("returns a no-texture defect when textureInfo is undefined", async () => {
    const { sendTextureFromPaintEvent, TextureSender } = await import("../index");
    const sender = new TextureSender("Test", 1920, 1080);

    const defect = sendTextureFromPaintEvent(sender, undefined);
    expect(defect).toEqual({ reason: "no-texture" });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockSendSurface).not.toHaveBeenCalled();
  });
```

同じ describe 内に以下 4 件を追加（platform の差し替えは既存テストと同じ `Object.defineProperty` + `try/finally` パターン）:

```typescript
  it("returns undefined on successful darwin send", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });

    try {
      const { sendTextureFromPaintEvent, TextureSender } = await import("../index");
      const sender = new TextureSender("Test", 1920, 1080);

      const textureInfo = {
        pixelFormat: "bgra" as const,
        codedSize: { width: 1920, height: 1080 },
        visibleRect: { x: 0, y: 0, width: 1920, height: 1080 },
        handle: { ioSurface: Buffer.alloc(8) },
      };

      expect(sendTextureFromPaintEvent(sender, textureInfo)).toBeUndefined();
      expect(mockSendSurface).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("returns a no-io-surface defect on darwin when the handle lacks ioSurface", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });

    try {
      const { sendTextureFromPaintEvent, TextureSender } = await import("../index");
      const sender = new TextureSender("Test", 1920, 1080);

      const textureInfo = {
        pixelFormat: "bgra" as const,
        codedSize: { width: 1920, height: 1080 },
        visibleRect: { x: 0, y: 0, width: 1920, height: 1080 },
        handle: {},
      };

      expect(sendTextureFromPaintEvent(sender, textureInfo)).toEqual({ reason: "no-io-surface" });
      expect(mockSendSurface).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("returns a no-nt-handle defect on win32 when the handle lacks ntHandle", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });

    try {
      const { sendTextureFromPaintEvent, TextureSender } = await import("../index");
      const sender = new TextureSender("Test", 1920, 1080);

      const textureInfo = {
        pixelFormat: "bgra" as const,
        codedSize: { width: 1920, height: 1080 },
        visibleRect: { x: 0, y: 0, width: 1920, height: 1080 },
        handle: {},
      };

      expect(sendTextureFromPaintEvent(sender, textureInfo)).toEqual({ reason: "no-nt-handle" });
      expect(mockSend).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("returns an unsupported-platform defect on linux", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });

    try {
      const { sendTextureFromPaintEvent, TextureSender } = await import("../index");
      const sender = new TextureSender("Test", 1920, 1080);

      const textureInfo = {
        pixelFormat: "bgra" as const,
        codedSize: { width: 1920, height: 1080 },
        visibleRect: { x: 0, y: 0, width: 1920, height: 1080 },
        handle: { ioSurface: Buffer.alloc(8) },
      };

      expect(sendTextureFromPaintEvent(sender, textureInfo)).toEqual({
        reason: "unsupported-platform",
        platform: "linux",
      });
      expect(mockSend).not.toHaveBeenCalled();
      expect(mockSendSurface).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
pnpm --filter @napolab/texture-bridge-core test
```

Expected: FAIL — 新テスト 5 件が `expected undefined to deeply equal { reason: ... }` で落ちる（既存テストは green のまま）

- [ ] **Step 3: `PaintDefect` を types.ts に追加**

`packages/core/src/types.ts` の末尾に追加:

```typescript
/**
 * Reason a paint event could not be forwarded to the sender.
 *
 * This is a modeled no-op, not an error: the paint pipeline continues, but the
 * frame was dropped. Callers may surface it (e.g. the high-level bridge emits
 * it as a `frameDropped` event) instead of the drop being silent.
 */
export type PaintDefect =
  | { readonly reason: "no-texture" }
  | { readonly reason: "no-nt-handle" }
  | { readonly reason: "no-io-surface" }
  | { readonly reason: "unsupported-platform"; readonly platform: NodeJS.Platform };
```

- [ ] **Step 4: `sendTextureFromPaintEvent` を変更**

`packages/core/src/index.ts` — import type に `PaintDefect` を追加し、type re-export（39 行目）にも追加:

```typescript
import type {
  TextureInfo,
  PaintTexture,
  Platform,
  PixelFormat,
  SenderInfo,
  ReceivedFrame,
  PaintDefect,
} from "./types";
```

```typescript
export type { TextureInfo, PaintTexture, Platform, PixelFormat, SenderInfo, ReceivedFrame, PaintDefect };
```

関数本体（42–67 行目）を次に置き換える。**既存の行はガードの return 値と JSDoc 以外変更しない**（`function` 宣言・`Number(...)` は据え置き — 未マージ PR #58/#64 との衝突最小化）:

```typescript
/**
 * Send a texture from an Electron paint event to Syphon/Spout.
 *
 * Handles platform detection and buffer extraction automatically.
 *
 * @returns `undefined` when the texture was handed to the sender, or a
 * {@link PaintDefect} describing why the frame was dropped. Drops are normal
 * no-ops (e.g. Chromium delivered a paint without a shareable handle), not
 * errors — but callers should surface them instead of letting output go
 * silently black. Native send failures still throw as before.
 */
export function sendTextureFromPaintEvent(
  sender: InstanceType<typeof TextureSender>,
  textureInfo: TextureInfo | undefined,
): PaintDefect | undefined {
  if (!textureInfo) return { reason: "no-texture" };
  const { handle, codedSize } = textureInfo;

  if (process.platform === "win32") {
    const ntHandle = handle.ntHandle;
    if (!ntHandle || !Buffer.isBuffer(ntHandle)) return { reason: "no-nt-handle" };
    const handleValue = Number(ntHandle.readBigInt64LE(0));
    sender.send(handleValue, codedSize.width, codedSize.height);
    return undefined;
  }

  if (process.platform === "darwin") {
    const ioSurface = handle.ioSurface;
    if (!ioSurface) return { reason: "no-io-surface" };
    sender.sendSurface(ioSurface, codedSize.width, codedSize.height);
    return undefined;
  }

  return { reason: "unsupported-platform", platform: process.platform };
}
```

- [ ] **Step 5: テストが通ることを確認**

```bash
pnpm --filter @napolab/texture-bridge-core test
```

Expected: PASS（既存含め全件）

- [ ] **Step 6: core を再ビルド + lint / typecheck**

renderer は workspace の core を **dist の型**（`dist/index.d.cts` / `.d.mts`）で解決するため、ここで再ビルドしないと Task 3 の renderer 側 typecheck が旧シグネチャ（`void` 返り）のままになり型エラーになる:

```bash
pnpm --filter @napolab/texture-bridge-core build
pnpm lint && pnpm typecheck
```

Expected: すべて成功

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/index.ts packages/core/src/__tests__/index.test.ts
git commit -m "feat(core): return PaintDefect from sendTextureFromPaintEvent instead of silent drop"
```

---

### Task 3: renderer — `frameDropped` イベント + デデュープ

**Files:**
- Modify: `packages/renderer/src/types.ts`（`BridgeEvents`、75–82 行目付近）
- Modify: `packages/renderer/src/bridge.ts`（`TextureBridgeImpl` の export、`handlePaint`、フィールド追加）
- Test: `packages/renderer/src/__tests__/bridge.test.ts`

**Interfaces:**
- Consumes: Task 2 の `PaintDefect`（`@napolab/texture-bridge-core` から import type）と `sendTextureFromPaintEvent(): PaintDefect | undefined`
- Produces:
  - `BridgeEvents` に `frameDropped: [defect: PaintDefect]` を追加
  - `TextureBridgeImpl` を named export（テスト seam。パッケージ index からは非公開のまま）
  - `handlePaint(event: { texture?: PaintTexture }): void` — 引数型を実際に使う shape に絞る（`PaintEvent` は非公開のままで dts エラーを回避）
  - デデュープ規約: **同一 `reason` の連続 defect は 1 回だけ emit。送出成功で状態リセット**（60fps での持続 defect が毎フレーム emit されるスパムを防ぐ。reason が変われば即 emit）

- [ ] **Step 1: 失敗するテストを書く**

`packages/renderer/src/__tests__/bridge.test.ts` — import 部を次のように変更:

```typescript
import { buildBrowserWindowOptions, computeDipSize, TextureBridgeImpl } from "../bridge";
import { BrowserWindow } from "electron";
import { TextureSender, sendTextureFromPaintEvent } from "@napolab/texture-bridge-core";
import type { PaintDefect } from "@napolab/texture-bridge-core";
import type { TextureBridgeOptions } from "../types";
```

ファイル末尾に describe を追加:

```typescript
describe("TextureBridgeImpl.handlePaint — frameDropped", () => {
  const sendMock = vi.mocked(sendTextureFromPaintEvent);

  const makeBridge = () =>
    new TextureBridgeImpl(new BrowserWindow(), new TextureSender("t", 16, 9), null, baseOpts);

  const makeTexture = () => ({
    textureInfo: {
      pixelFormat: "bgra" as const,
      codedSize: { width: 16, height: 9 },
      visibleRect: { x: 0, y: 0, width: 16, height: 9 },
      handle: {},
    },
    release: vi.fn(),
  });

  const collectDropped = (bridge: TextureBridgeImpl) => {
    const dropped: PaintDefect[] = [];
    bridge.on("frameDropped", (defect) => {
      dropped.push(defect);
    });
    return dropped;
  };

  it("emits a no-texture defect when the paint event has no texture", () => {
    sendMock.mockReset();
    const bridge = makeBridge();
    const dropped = collectDropped(bridge);

    bridge.handlePaint({ texture: undefined });

    expect(dropped).toEqual([{ reason: "no-texture" }]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("emits the defect returned by sendTextureFromPaintEvent and still releases the texture", () => {
    sendMock.mockReset();
    sendMock.mockReturnValue({ reason: "no-nt-handle" });
    const bridge = makeBridge();
    const dropped = collectDropped(bridge);
    const texture = makeTexture();

    bridge.handlePaint({ texture });

    expect(dropped).toEqual([{ reason: "no-nt-handle" }]);
    expect(texture.release).toHaveBeenCalledTimes(1);
  });

  it("dedupes consecutive defects with the same reason", () => {
    sendMock.mockReset();
    sendMock.mockReturnValue({ reason: "no-nt-handle" });
    const bridge = makeBridge();
    const dropped = collectDropped(bridge);

    bridge.handlePaint({ texture: makeTexture() });
    bridge.handlePaint({ texture: makeTexture() });
    bridge.handlePaint({ texture: makeTexture() });

    expect(dropped).toEqual([{ reason: "no-nt-handle" }]);
  });

  it("re-emits after a successful send resets the dedupe state", () => {
    sendMock.mockReset();
    const bridge = makeBridge();
    const dropped = collectDropped(bridge);

    sendMock.mockReturnValue({ reason: "no-nt-handle" });
    bridge.handlePaint({ texture: makeTexture() });

    sendMock.mockReturnValue(undefined);
    bridge.handlePaint({ texture: makeTexture() });

    sendMock.mockReturnValue({ reason: "no-nt-handle" });
    bridge.handlePaint({ texture: makeTexture() });

    expect(dropped).toEqual([{ reason: "no-nt-handle" }, { reason: "no-nt-handle" }]);
  });

  it("emits immediately when the defect reason changes", () => {
    sendMock.mockReset();
    const bridge = makeBridge();
    const dropped = collectDropped(bridge);

    sendMock.mockReturnValue({ reason: "no-nt-handle" });
    bridge.handlePaint({ texture: makeTexture() });

    sendMock.mockReturnValue({ reason: "no-io-surface" });
    bridge.handlePaint({ texture: makeTexture() });

    expect(dropped).toEqual([{ reason: "no-nt-handle" }, { reason: "no-io-surface" }]);
  });

  it("does not emit frameDropped on a successful send", () => {
    sendMock.mockReset();
    sendMock.mockReturnValue(undefined);
    const bridge = makeBridge();
    const dropped = collectDropped(bridge);
    const texture = makeTexture();

    bridge.handlePaint({ texture });

    expect(dropped).toEqual([]);
    expect(texture.release).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
pnpm --filter @napolab/texture-bridge-renderer test -- bridge
```

Expected: FAIL — `TextureBridgeImpl` が bridge.ts から export されていない（import エラー）

- [ ] **Step 3: `BridgeEvents` に `frameDropped` を追加**

`packages/renderer/src/types.ts` — 先頭の import に追加:

```typescript
import type { PaintDefect } from "@napolab/texture-bridge-core";
```

`BridgeEvents`（75–82 行目）を変更:

```typescript
/** Events emitted by TextureBridge */
export interface BridgeEvents {
  fps: [fps: number];
  ready: [];
  error: [error: Error];
  /**
   * A paint frame was dropped before reaching the sender (missing texture /
   * missing platform handle / unsupported platform). Not an error — but if
   * this fires persistently the output is black on the receiving side.
   * Consecutive drops with the same reason are deduped: the event fires on
   * the first occurrence and again only after a successful send or a reason
   * change.
   */
  frameDropped: [defect: PaintDefect];
  disposed: [];
  resize: [width: number, height: number];
}
```

- [ ] **Step 4: `bridge.ts` を変更**

(a) import に `PaintDefect` を追加（既存の core import 文に足す）:

```typescript
import {
  TextureSender,
  sendTextureFromPaintEvent,
  type PaintTexture,
  type PaintDefect,
} from "@napolab/texture-bridge-core";
```

(b) クラス宣言（40 行目）を export に変更し、JSDoc を付ける:

```typescript
/** Exported for unit tests — not part of the package's public entry point. */
export class TextureBridgeImpl extends EventEmitter implements TextureBridge {
```

(c) フィールドを追加（`private _disposed = false;` の直後）:

```typescript
  private lastDropReason: PaintDefect["reason"] | null = null;
```

(d) private メソッドを追加（`handlePaint` の直前。class メソッドは shorthand — `.claude/rules/function-style.md`）:

```typescript
  /** Emit `frameDropped`, deduping consecutive drops with the same reason. */
  private emitFrameDropped(defect: PaintDefect): void {
    if (defect.reason === this.lastDropReason) return;
    this.lastDropReason = defect.reason;
    this.emit("frameDropped", defect);
  }
```

(e) `handlePaint`（74–96 行目付近）を次に置き換える。引数型を実使用 shape に絞る（`PaintEvent` は非公開のまま）。`catch` 節と fps 部分は既存のまま:

```typescript
  /** Handle a paint event from the offscreen BrowserWindow. */
  handlePaint(event: { texture?: PaintTexture }): void {
    const texture = event.texture;
    if (!texture?.textureInfo) {
      texture?.release?.();
      this.emitFrameDropped({ reason: "no-texture" });
      return;
    }

    // If we've been disposed between the paint event and this callback, the
    // underlying sender has been stopped and calling into it would throw
    // "TextureSender has been stopped" for every in-flight paint. Drop the
    // texture cleanly instead of emitting a stream of teardown errors.
    if (this._disposed) {
      texture.release?.();
      return;
    }

    try {
      const defect = sendTextureFromPaintEvent(this.sender, texture.textureInfo);
      if (defect === undefined) {
        this.lastDropReason = null;
      } else {
        this.emitFrameDropped(defect);
      }
      this.previewManager?.sendFrame(texture);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
    } finally {
      texture.release?.();
    }
```

（`handlePaint` 内のこれ以降 — `if (this._disposed) return;` と fps カウンタ — は既存のまま）

注: `createTextureBridge` 内の `bridge.handlePaint(event)` 呼び出し（260 行目付近）は `PaintEvent` が構造的に `{ texture?: PaintTexture }` を満たすため変更不要。preview への `sendFrame` は defect 時も従来どおり呼ぶ（現行の挙動維持 — 従来も silent return 後に呼ばれていた）。

- [ ] **Step 5: テストが通ることを確認**

```bash
pnpm --filter @napolab/texture-bridge-renderer test
```

Expected: PASS（新 6 件 + 既存全件）

- [ ] **Step 6: lint / typecheck**

```bash
pnpm lint && pnpm typecheck
```

Expected: どちらも成功

- [ ] **Step 7: Commit**

```bash
git add packages/renderer/src/types.ts packages/renderer/src/bridge.ts packages/renderer/src/__tests__/bridge.test.ts
git commit -m "feat(renderer): emit frameDropped event for silently dropped paint frames"
```

---

### Task 4: 公開面の仕上げ — re-export + README

**Files:**
- Modify: `packages/renderer/src/index.ts`
- Modify: `README.md`（`TextureBridge` セクション 584 行目付近、`sendTextureFromPaintEvent` セクション 757 行目付近、Troubleshooting「Black texture output」986 行目付近）

**Interfaces:**
- Consumes: Task 2 の `PaintDefect`、Task 3 の `frameDropped`
- Produces: `@napolab/texture-bridge-renderer` から `PaintDefect` 型が import 可能になる

注: `docs/ja/INSTALLATION.md` のコードサンプルは返り値を無視する形のままで有効なので**変更しない**。CHANGELOG は release-please 管理のため手動編集しない。

- [ ] **Step 1: renderer index から `PaintDefect` を re-export**

`packages/renderer/src/index.ts` に追加:

```typescript
export type { PaintDefect } from "@napolab/texture-bridge-core";
```

- [ ] **Step 2: README — `TextureBridge` interface スニペットを更新**

`README.md` の `#### TextureBridge` 内 interface スニペット（589 行目付近）の `on(event: "error", ...)` 行の直後に追加:

```typescript
  on(event: "frameDropped", listener: (defect: PaintDefect) => void): this;
```

interface スニペットの直後に説明を追加:

```markdown
`frameDropped` fires when a paint frame is dropped before reaching the sender
(`reason`: `"no-texture" | "no-nt-handle" | "no-io-surface" | "unsupported-platform"`).
It is not an error — but if it fires persistently, receivers see black output.
Consecutive drops with the same reason are deduped: the event fires once, and
again only after a successful send or a reason change.
```

- [ ] **Step 3: README — `sendTextureFromPaintEvent` セクションを更新**

`#### sendTextureFromPaintEvent(sender, textureInfo)`（757 行目付近）の本文を次に置き換え:

```markdown
Low-level convenience function that handles platform-specific texture handle extraction and forwarding.

- **macOS**: Reads `handle.ioSurface` buffer → calls `sender.sendSurface()`
- **Windows**: Reads `handle.ntHandle` buffer as BigInt64LE → calls `sender.send()`

Returns `undefined` when the frame was handed to the sender, or a `PaintDefect`
(`{ reason: "no-texture" | "no-nt-handle" | "no-io-surface" | "unsupported-platform" }`)
when the frame was dropped. Drops are normal no-ops, not errors — surface them
in your own paint loop the same way `createTextureBridge` does with its
`frameDropped` event. Native send failures still throw.
```

- [ ] **Step 4: README — Troubleshooting に診断手順を追記**

`### Black texture output`（986 行目付近）のリストに 1 項目追加:

```markdown
- Subscribe to `bridge.on("frameDropped", ...)` (or check the return value of
  `sendTextureFromPaintEvent`) — a persistent `no-nt-handle` / `no-io-surface`
  reason means Chromium is not delivering a shareable GPU handle, which
  otherwise manifests only as black output.
```

- [ ] **Step 5: lint / typecheck / 全テスト**

```bash
pnpm lint && pnpm typecheck && pnpm --filter @napolab/texture-bridge-core test && pnpm --filter @napolab/texture-bridge-renderer test
```

Expected: すべて成功

- [ ] **Step 6: Commit**

```bash
git add packages/renderer/src/index.ts README.md
git commit -m "docs: document frameDropped event and PaintDefect return value"
```

---

### Task 5: 最終検証 + レビュー依頼

**Files:** なし（検証のみ）

- [ ] **Step 1: フルビルドで shim ガードを含む全体を検証**

```bash
pnpm --filter @napolab/texture-bridge-core build
pnpm --filter @napolab/texture-bridge-renderer build
```

Expected: 両方成功。renderer 側は `[esm-shim-guard] OK` を出力

- [ ] **Step 2: 全テスト + lint + typecheck の最終確認**

```bash
pnpm lint && pnpm typecheck && pnpm --filter @napolab/texture-bridge-core test && pnpm --filter @napolab/texture-bridge-renderer test
```

Expected: すべて成功

- [ ] **Step 3: difit でレビュー依頼**

```bash
npx difit HEAD main
```

ユーザーにレビューを依頼し、指摘があれば対応する。**push / PR 作成はユーザーの指示を待つ。**

---

## 実装しないこと（スコープ外）

- neverthrow の core への導入（PR #64 の領分。#64 が先にマージされた場合は、`safeDispatchSend` の `.match` の ok 側で `undefined`、ガード分岐で defect を返す形に本実装を rebase する）
- `frameDropped` のカウンタ・集計 API（消費者側で数えられる）
- `TextureInfo.handle` の公開型変更（Electron 互換のまま。内部分類は今回のガード分岐で十分）
- Cannelloni 側の 0.13.1 アップグレード + patch 撤去（別リポジトリの作業）
