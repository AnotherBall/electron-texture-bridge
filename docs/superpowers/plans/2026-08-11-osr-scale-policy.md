# OSR Scale Policy（Electron 41+ deviceScaleFactor 固定）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Electron 42 の「OSR デフォルト device scale = 1.0」breaking change に対応し、Electron ≥ 41 では `offscreen.deviceScaleFactor: 1` を明示固定して `width/height` = pixels の契約を全環境で決定論化する（`pixelExact` は ≥41 で自明に満たされる no-op に）。

**Architecture:** 判定は純関数 3 つ（`resolveElectronMajor` / `resolveOsrScalePolicy` / `resolveWindowDipSize`）に分離して単体テスト可能にする。`buildBrowserWindowOptions` が policy を受けて offscreen prefs と `enableLargerThanScreen` を出し分け、`createTextureBridge` / `resize()` は `resolveWindowDipSize` でウィンドウ寸法を決める。Electron 40（`deviceScaleFactor` 無視、実測済み）は現行ロジック完全維持。根拠は `reports/2026-08-11-pixelexact-osr-scale-investigation.md` の実測マトリクス。

**Tech Stack:** pnpm / vitest / tsgo / oxlint+oxfmt。electron mock は既存 bridge.test.ts の `vi.mock("electron", ...)` を拡張。

## Global Constraints

- ベースは **main**（マージ済み #67 込み）。開始前に `git fetch origin main && git pull --ff-only origin main`
- ブランチ名: `feat/osr-scale-policy`
- 境界は **major ≥ 41 → "unit-scale"**（`deviceScaleFactor` オプションは 41 で追加・実測で動作確認済み。40 では無視されるため "device-scale" = 現行ロジック）
- ユーザーが `webPreferences.offscreen` を明示指定した場合はそれが**全体として**勝つ（現行の spread 順 `offscreen: {...}, ...webPreferences` を維持）
- Sender は常に pixel-space（`new TextureSender(name, width, height)`）— 変更しない
- 各タスク完了時 `pnpm lint && pnpm typecheck`（tsc 直接実行禁止）
- コミットは本計画のステップでのみ。CLAUDE.md / tasks.md を含めない。push は指示があるまでしない
- semver 注意: Electron 41 ユーザーはデフォルト挙動が変わる（×2 → ×1 テクスチャ）。0.x の feat として README に移行節を書く
- 実装完了後 difit でレビュー依頼（Task 5）

## File Structure

| ファイル | 役割 |
|---|---|
| `packages/renderer/src/bridge.ts` | policy 純関数 3 つの追加、`buildBrowserWindowOptions` に policy 引数、`createTextureBridge`/`resize` の配線 |
| `packages/renderer/src/types.ts` | `pixelExact` JSDoc の版別注記 |
| `packages/renderer/src/__tests__/bridge.test.ts` | policy 純関数・options 出し分け・resize のテスト追加、electron mock の `getPrimaryDisplay` を vi.fn 化 |
| `packages/renderer/scripts/osr-scale-probe.cjs` | 調査で使った実測 probe を再検証用にコミット |
| `README.md` / `lang/ja/README.md` | Retina/DPI 節の版別書き直し + Electron 42 移行節 |

---

### Task 1: policy 純関数（resolveElectronMajor / resolveOsrScalePolicy / resolveWindowDipSize）

**Files:**
- Modify: `packages/renderer/src/bridge.ts`（`computeDipSize` の直後に追加）
- Test: `packages/renderer/src/__tests__/bridge.test.ts`

**Interfaces:**
- Produces:
  - `type OsrScalePolicy = "device-scale" | "unit-scale"`
  - `resolveElectronMajor(versions: { electron?: string }): number` — parse 失敗時 0
  - `resolveOsrScalePolicy(electronMajor: number): OsrScalePolicy` — `>= 41` で `"unit-scale"`
  - `resolveWindowDipSize(options: Pick<TextureBridgeOptions, "width" | "height" | "pixelExact">, policy: OsrScalePolicy, scaleFactor: number): { width: number; height: number }`

- [ ] **Step 1: 失敗するテストを書く**

`packages/renderer/src/__tests__/bridge.test.ts` — import に追加:

```typescript
import {
  buildBrowserWindowOptions,
  computeDipSize,
  resolveElectronMajor,
  resolveOsrScalePolicy,
  resolveWindowDipSize,
  TextureBridgeImpl,
} from "../bridge";
```

ファイル末尾に describe を追加:

```typescript
describe("resolveElectronMajor", () => {
  it("parses the major version from a semver string", () => {
    expect(resolveElectronMajor({ electron: "42.4.0" })).toBe(42);
    expect(resolveElectronMajor({ electron: "40.2.1" })).toBe(40);
  });

  it("returns 0 when the electron version is missing or malformed", () => {
    expect(resolveElectronMajor({})).toBe(0);
    expect(resolveElectronMajor({ electron: "garbage" })).toBe(0);
  });
});

describe("resolveOsrScalePolicy", () => {
  it("selects device-scale for Electron 40 and below", () => {
    expect(resolveOsrScalePolicy(40)).toBe("device-scale");
    expect(resolveOsrScalePolicy(0)).toBe("device-scale");
  });

  it("selects unit-scale for Electron 41 and above", () => {
    expect(resolveOsrScalePolicy(41)).toBe("unit-scale");
    expect(resolveOsrScalePolicy(42)).toBe("unit-scale");
  });
});

describe("resolveWindowDipSize", () => {
  it("returns width/height untouched under unit-scale, even with pixelExact", () => {
    const size = resolveWindowDipSize({ width: 1920, height: 1080, pixelExact: true }, "unit-scale", 2);
    expect(size).toEqual({ width: 1920, height: 1080 });
  });

  it("divides by scaleFactor under device-scale when pixelExact is set", () => {
    const size = resolveWindowDipSize({ width: 1920, height: 1080, pixelExact: true }, "device-scale", 2);
    expect(size).toEqual({ width: 960, height: 540 });
  });

  it("returns width/height untouched under device-scale without pixelExact", () => {
    const size = resolveWindowDipSize({ width: 1920, height: 1080 }, "device-scale", 2);
    expect(size).toEqual({ width: 1920, height: 1080 });
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
pnpm --filter @napolab/texture-bridge-renderer test -- bridge
```

Expected: FAIL — `resolveElectronMajor` 等が export されていない（import エラー）

- [ ] **Step 3: 実装**

`packages/renderer/src/bridge.ts` — `computeDipSize` の直後に追加（top-level は arrow 関数 — `.claude/rules/function-style.md`。既存の `function` 宣言はリファクタ PR の領分なので触らない）:

```typescript
/**
 * How the OSR compositor maps the window's DIP size to the shared-texture
 * pixel size.
 *
 * - `"device-scale"` (Electron ≤ 40): the paint framebuffer is
 *   `DIP × display.scaleFactor`, and `webPreferences.offscreen.deviceScaleFactor`
 *   is ignored — `pixelExact` must pre-divide the window size to hit an exact
 *   pixel count.
 * - `"unit-scale"` (Electron ≥ 41): `offscreen.deviceScaleFactor` is honored
 *   (and defaults to 1.0 from Electron 42), so we pin it to 1 and DIP == px
 *   holds deterministically — no DIP division, `pixelExact` is trivially
 *   satisfied.
 *
 * Empirical basis: reports/2026-08-11-pixelexact-osr-scale-investigation.md
 * (measured on Electron 40.2.1 / 41.10.4 / 42.4.0, macOS Retina scaleFactor 2).
 */
export type OsrScalePolicy = "device-scale" | "unit-scale";

/** Parse the Electron major version; 0 when missing or malformed. */
export const resolveElectronMajor = (versions: { electron?: string }): number => {
  const [major] = (versions.electron ?? "").split(".");
  const parsed = parseInt(major ?? "", 10);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** `offscreen.deviceScaleFactor` exists (and is honored) from Electron 41. */
export const resolveOsrScalePolicy = (electronMajor: number): OsrScalePolicy =>
  electronMajor >= 41 ? "unit-scale" : "device-scale";

/**
 * Window DIP size for the requested pixel size under the given policy.
 * Under unit-scale DIP == px, so the size passes through; under device-scale
 * only `pixelExact` pre-divides by the display scaleFactor (legacy behavior).
 */
export const resolveWindowDipSize = (
  options: Pick<TextureBridgeOptions, "width" | "height" | "pixelExact">,
  policy: OsrScalePolicy,
  scaleFactor: number,
): { width: number; height: number } => {
  if (policy === "unit-scale") return { width: options.width, height: options.height };
  if (options.pixelExact === true) return computeDipSize(options.width, options.height, scaleFactor);
  return { width: options.width, height: options.height };
};
```

- [ ] **Step 4: テストが通ることを確認**

```bash
pnpm --filter @napolab/texture-bridge-renderer test -- bridge
```

Expected: PASS（新 7 件 + 既存全件）

- [ ] **Step 5: lint / typecheck**

```bash
pnpm lint && pnpm typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/renderer/src/bridge.ts packages/renderer/src/__tests__/bridge.test.ts
git commit -m "feat(renderer): add OSR scale policy resolvers for Electron 41+ deviceScaleFactor"
```

---

### Task 2: buildBrowserWindowOptions の policy 対応

**Files:**
- Modify: `packages/renderer/src/bridge.ts:217-243`（`buildBrowserWindowOptions`）
- Test: `packages/renderer/src/__tests__/bridge.test.ts`

**Interfaces:**
- Consumes: Task 1 の `OsrScalePolicy`
- Produces: `buildBrowserWindowOptions(options: TextureBridgeOptions, policy: OsrScalePolicy): Electron.BrowserWindowConstructorOptions`
  - unit-scale: `offscreen: { useSharedTexture: true, deviceScaleFactor: 1 }` + **常に** `enableLargerThanScreen: true`（要求 px がディスプレイ DIP を超えても work-area クランプで縮まないように）
  - device-scale: 現行どおり（`offscreen: { useSharedTexture: true }`、`pixelExact` 時のみ `enableLargerThanScreen`）
  - ユーザー `webPreferences` の spread 位置は現行のまま（`offscreen` ごと上書き可能）

- [ ] **Step 1: 失敗するテストを書く**

既存の `describe("buildBrowserWindowOptions", ...)` は**全呼び出しに第 2 引数 `"device-scale"` を追加**して現行アサーションを維持する（現行挙動の回帰テストになる）。その上で新 describe を追加:

```typescript
describe("buildBrowserWindowOptions — OSR scale policy", () => {
  it("pins offscreen.deviceScaleFactor to 1 under unit-scale", () => {
    const out = buildBrowserWindowOptions(baseOpts, "unit-scale");
    expect(out.webPreferences?.offscreen).toEqual({ useSharedTexture: true, deviceScaleFactor: 1 });
  });

  it("does not set deviceScaleFactor under device-scale", () => {
    const out = buildBrowserWindowOptions(baseOpts, "device-scale");
    expect(out.webPreferences?.offscreen).toEqual({ useSharedTexture: true });
  });

  it("always enables enableLargerThanScreen under unit-scale", () => {
    const out = buildBrowserWindowOptions(baseOpts, "unit-scale");
    expect(out.enableLargerThanScreen).toBe(true);
  });

  it("keeps enableLargerThanScreen gated on pixelExact under device-scale", () => {
    expect(buildBrowserWindowOptions(baseOpts, "device-scale").enableLargerThanScreen).toBeUndefined();
    expect(
      buildBrowserWindowOptions({ ...baseOpts, pixelExact: true }, "device-scale").enableLargerThanScreen,
    ).toBe(true);
  });

  it("lets a user-supplied webPreferences.offscreen win entirely", () => {
    const out = buildBrowserWindowOptions(
      { ...baseOpts, webPreferences: { offscreen: { useSharedTexture: true, deviceScaleFactor: 2 } } },
      "unit-scale",
    );
    expect(out.webPreferences?.offscreen).toEqual({ useSharedTexture: true, deviceScaleFactor: 2 });
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
pnpm --filter @napolab/texture-bridge-renderer test -- bridge
```

Expected: FAIL — 第 2 引数が未実装（型エラー or deviceScaleFactor 不在）

- [ ] **Step 3: 実装**

`buildBrowserWindowOptions` を次に置き換える（JSDoc は既存文の末尾に policy の段落を 1 つ追加）:

```typescript
export function buildBrowserWindowOptions(
  options: TextureBridgeOptions,
  policy: OsrScalePolicy,
): Electron.BrowserWindowConstructorOptions {
  const { width, height, webPreferences, includeAlpha, pixelExact } = options;

  const offscreen =
    policy === "unit-scale"
      ? { useSharedTexture: true, deviceScaleFactor: 1 }
      : { useSharedTexture: true };
  const largerThanScreen = policy === "unit-scale" || pixelExact === true;

  return {
    width,
    height,
    show: false,
    // `enableLargerThanScreen` is documented as macOS-only but is harmless on
    // other platforms. Under unit-scale the DIP size equals the requested pixel
    // size — which may exceed the display work area — so it is always set;
    // under device-scale it is set only when `pixelExact` requests it.
    ...(largerThanScreen ? { enableLargerThanScreen: true } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      offscreen,
      ...webPreferences,
    },
    // Hex `#RRGGBBAA` with alpha=0x00 is the explicit "fully transparent
    // backdrop" signal Chromium honors on offscreen render surfaces. The
    // `transparent: true` flag alone leaves the compositor painting opaque,
    // so both keys must be applied together.
    ...(includeAlpha ? { transparent: true, backgroundColor: "#00000000" } : {}),
  };
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
pnpm --filter @napolab/texture-bridge-renderer test -- bridge
```

Expected: PASS

- [ ] **Step 5: lint / typecheck**

```bash
pnpm lint && pnpm typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/renderer/src/bridge.ts packages/renderer/src/__tests__/bridge.test.ts
git commit -m "feat(renderer): pin offscreen.deviceScaleFactor=1 under unit-scale policy"
```

---

### Task 3: createTextureBridge / resize の配線

**Files:**
- Modify: `packages/renderer/src/bridge.ts`（`TextureBridgeImpl` constructor、`resize`、`createTextureBridge`）
- Test: `packages/renderer/src/__tests__/bridge.test.ts`（electron mock の `getPrimaryDisplay` を vi.fn 化 + resize テスト）

**Interfaces:**
- Consumes: Task 1 の `resolveWindowDipSize` / `resolveOsrScalePolicy` / `resolveElectronMajor`、Task 2 の `buildBrowserWindowOptions(options, policy)`
- Produces:
  - `TextureBridgeImpl` constructor 第 5 引数 `policy: OsrScalePolicy = resolveOsrScalePolicy(resolveElectronMajor(process.versions))`（デフォルト付きなので既存テストの 4 引数呼び出しはそのまま通る）
  - `resize()` / rollback が `resolveWindowDipSize(opts, this.policy, screen.getPrimaryDisplay().scaleFactor)` を使う
  - `createTextureBridge` が policy を一度解決し、window 構築（`resolveWindowDipSize` で寸法決定 + `buildBrowserWindowOptions(…, policy)`）と `TextureBridgeImpl` に渡す

- [ ] **Step 1: 失敗するテストを書く**

(a) electron mock の `screen` を可変化（ファイル先頭の `vi.mock("electron", ...)` を変更）:

```typescript
const getPrimaryDisplayMock = vi.fn(() => ({ scaleFactor: 1 }));

vi.mock("electron", () => ({
  app: { isReady: () => true },
  BrowserWindow: class MockBrowserWindow {
    setSize = vi.fn();
    isDestroyed(): boolean {
      return false;
    }
    close(): void {}
  },
  screen: {
    getPrimaryDisplay: () => getPrimaryDisplayMock(),
  },
}));
```

（既存テストで `MockBrowserWindow` に追加済みのメソッドがあれば残す。`setSize` は resize テスト用に `vi.fn()` プロパティとして持たせ、インスタンスから参照する。**`MockTextureSender` にも `stop(): void {}` を追加すること** — `resize()` は `this.sender.stop()` と `new TextureSender(...)` を呼ぶため、無いと resize テストが throw する）

(b) ファイル末尾に resize の describe を追加:

```typescript
describe("TextureBridgeImpl.resize — OSR scale policy", () => {
  const makeBridgeWithPolicy = (policy: "device-scale" | "unit-scale", opts: TextureBridgeOptions) =>
    new TextureBridgeImpl(new BrowserWindow(), new TextureSender("t", 16, 9), null, opts, policy);

  it("sets the window to the raw pixel size under unit-scale even with pixelExact", () => {
    getPrimaryDisplayMock.mockReturnValue({ scaleFactor: 2 });
    const bridge = makeBridgeWithPolicy("unit-scale", { ...baseOpts, pixelExact: true });

    bridge.resize(1280, 720);

    expect(bridge.renderWindow.setSize).toHaveBeenCalledWith(1280, 720);
  });

  it("divides the window size by scaleFactor under device-scale with pixelExact", () => {
    getPrimaryDisplayMock.mockReturnValue({ scaleFactor: 2 });
    const bridge = makeBridgeWithPolicy("device-scale", { ...baseOpts, pixelExact: true });

    bridge.resize(1280, 720);

    expect(bridge.renderWindow.setSize).toHaveBeenCalledWith(640, 360);
  });
});
```

注: `bridge.renderWindow.setSize` の参照は mock クラスのインスタンスプロパティ（`setSize = vi.fn()`）。`TextureBridge` 型には `setSize` が無いので、テスト内では `new BrowserWindow()` を変数に取り、その `setSize` を assert する形にしてよい（`const win = new BrowserWindow(); const bridge = new TextureBridgeImpl(win, ...); expect(win.setSize).toHaveBeenCalledWith(...)`）。実装時にコンパイルが通る形を選ぶこと。

- [ ] **Step 2: テストが失敗することを確認**

```bash
pnpm --filter @napolab/texture-bridge-renderer test -- bridge
```

Expected: FAIL — constructor 第 5 引数が未実装 / resize が pixelExact 分岐のまま

- [ ] **Step 3: 実装**

(a) `TextureBridgeImpl` にフィールドと constructor 引数を追加:

```typescript
  private readonly policy: OsrScalePolicy;

  constructor(
    renderWindow: BrowserWindow,
    sender: InstanceType<typeof TextureSender>,
    previewManager: PreviewManager | null,
    options: TextureBridgeOptions,
    policy: OsrScalePolicy = resolveOsrScalePolicy(resolveElectronMajor(process.versions)),
  ) {
    super();
    this._renderWindow = renderWindow;
    this.sender = sender;
    this.previewManager = previewManager;
    this.options = options;
    this.policy = policy;
  }
```

(b) `resize()` 内の 2 箇所の DIP 計算を置き換え:

```typescript
    const dip = resolveWindowDipSize(this.options, this.policy, screen.getPrimaryDisplay().scaleFactor);
    this._renderWindow.setSize(dip.width, dip.height);
```

rollback 側も同様:

```typescript
      const prevDip = resolveWindowDipSize(prevOpts, this.policy, screen.getPrimaryDisplay().scaleFactor);
      this._renderWindow.setSize(prevDip.width, prevDip.height);
```

（`this.options = { ...this.options, width, height }` の更新タイミングは現行実装のまま — `resolveWindowDipSize` へは resize 後の新しい width/height が入っている options を渡す。現行コードが `computeDipSize(width, height, ...)` と引数直渡しなら、`resolveWindowDipSize({ ...this.options, width, height }, ...)` の形で等価にする）

(c) `createTextureBridge` の window 構築部を置き換え:

```typescript
  const policy = resolveOsrScalePolicy(resolveElectronMajor(process.versions));

  // ---- Offscreen BrowserWindow ----
  // Window DIP size per the OSR scale policy: under unit-scale DIP == px so the
  // requested size passes through; under device-scale (Electron ≤ 40) pixelExact
  // pre-divides by the primary display's scaleFactor. The sender below always
  // uses pixel-space dimensions.
  const dip = resolveWindowDipSize(options, policy, screen.getPrimaryDisplay().scaleFactor);
  const renderWindow = new BrowserWindow(buildBrowserWindowOptions({ ...options, ...dip }, policy));
```

`TextureBridgeImpl` 構築に policy を渡す:

```typescript
  const bridge = new TextureBridgeImpl(renderWindow, sender, previewManager, options, policy);
```

**注:** `createTextureBridge` 冒頭の destructure `const { name, width, height, frameRate = 60, rendererUrl, preview, pixelExact } = options;` から **`pixelExact` を削除する**こと（`resolveWindowDipSize` に移ったため未使用になり lint エラーになる）。`width`/`height` は sender 構築で引き続き使用する。

- [ ] **Step 4: テストが通ることを確認**

```bash
pnpm --filter @napolab/texture-bridge-renderer test
```

Expected: PASS（全件。既存 frameDropped テスト群は constructor デフォルト引数のため無変更で通る）

- [ ] **Step 5: lint / typecheck**

```bash
pnpm lint && pnpm typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/renderer/src/bridge.ts packages/renderer/src/__tests__/bridge.test.ts
git commit -m "feat(renderer): apply OSR scale policy to window sizing and resize"
```

---

### Task 4: ドキュメント（pixelExact JSDoc / README EN+JA / probe スクリプト）

**Files:**
- Modify: `packages/renderer/src/types.ts`（`pixelExact` JSDoc）
- Modify: `README.md`（「macOS Retina and Windows DPI scaling」節 361–366 行付近、`TextureBridgeOptions` API ref、Migration 節の追加）
- Modify: `lang/ja/README.md`（対応箇所のミラー）
- Create: `packages/renderer/scripts/osr-scale-probe.cjs`（調査で使った probe をコピーしてコミット。冒頭コメントに `reports/2026-08-11-pixelexact-osr-scale-investigation.md` への参照を追記）

**Interfaces:**
- Consumes: Task 1–3 の実装済み挙動

- [ ] **Step 1: `pixelExact` JSDoc に版別注記を追加**

`packages/renderer/src/types.ts` の `pixelExact` JSDoc 冒頭（`Pin the offscreen framebuffer...` の段落の直後）に追加:

```
   * Electron ≥ 41: this option is trivially satisfied and effectively a no-op —
   * the bridge pins `webPreferences.offscreen.deviceScaleFactor` to 1, so the
   * framebuffer always lands at exactly `width × height` pixels regardless of
   * display scaling (Electron 42 changed the OSR default device scale factor
   * to 1.0; the bridge makes it explicit from 41 where the option first
   * exists). The DIP-division described below applies only to Electron 40.
```

- [ ] **Step 2: README EN の Retina/DPI 節を版別に書き直し**

`README.md` の `> ### macOS Retina and Windows DPI scaling` ブロックを次で置き換え:

```markdown
> ### macOS Retina and Windows DPI scaling
>
> ⚠️ **This is the #1 cause of a black or garbled output on Electron ≤ 40.** How the offscreen framebuffer relates to your requested `width × height` depends on the Electron version:
>
> - **Electron ≥ 41:** `createTextureBridge` pins `webPreferences.offscreen.deviceScaleFactor` to `1`, so the framebuffer is always exactly `width × height` pixels — display scaling does not affect the texture. (`Electron 42` changed the OSR default device scale factor to `1.0`; the bridge sets it explicitly from 41, where the option first appeared.) `pixelExact` is trivially satisfied and effectively a no-op.
> - **Electron 40:** Chromium sizes the offscreen surface in **device-independent pixels (DIP)**, so the framebuffer delivered to the shared texture is `width × height × display.scaleFactor`. On a macOS Retina display (scaleFactor 2) a sender declared as `new TextureSender("X", 1280, 720)` ends up producing a **2560×1440** texture. Use `createTextureBridge({ pixelExact: true })` to absorb this, or handle DPR yourself on the low-level core path.
>
> **Low-level core** (manual `BrowserWindow` + `paint`) has no absorption on any version — on Electron ≥ 41 pass `offscreen: { useSharedTexture: true, deviceScaleFactor: 1 }` yourself; on Electron 40 keep the sender's declared size and the actual framebuffer size in agreement manually.
```

- [ ] **Step 3: README EN に移行節を追加**

`## Migration: Explicit Disposal (v0.6+)` の直前に追加:

```markdown
## Migration: Electron 42 / OSR device scale

Electron 42 changed offscreen rendering's default device scale factor to `1.0`
([breaking change](https://www.electronjs.org/docs/latest/breaking-changes)).
From the release containing this change, `createTextureBridge` pins
`offscreen.deviceScaleFactor: 1` on Electron ≥ 41, making `width`/`height`
mean exact pixels on every display.

- **If you used `pixelExact: true`** (e.g. on Electron 40): keep it — it is a
  no-op on Electron ≥ 41 and still required on 40.
- **If you worked around scaling yourself** (`force-device-scale-factor=1`,
  manual DIP math, removing `pixelExact` after a quarter-resolution output on
  Electron 42): those workarounds are no longer needed once you upgrade.
- **If you intentionally want a scaled framebuffer**, pass your own
  `webPreferences: { offscreen: { useSharedTexture: true, deviceScaleFactor: <n> } }` —
  a user-supplied `offscreen` block always wins.

Empirical background: `reports/2026-08-11-pixelexact-osr-scale-investigation.md`.
```

- [ ] **Step 4: lang/ja/README.md に対応 3 箇所をミラー**

EN の Retina/DPI 節・移行節・`pixelExact` 関連記述を対応位置に自然な日本語で反映（EN の挿入文を先に読み、忠実に翻訳）。

- [ ] **Step 5: probe スクリプトをコミット対象として配置**

調査で使った probe（`/private/tmp/.../scratchpad/osr-scale-probe.cjs` と同内容）を `packages/renderer/scripts/osr-scale-probe.cjs` として作成。冒頭コメントに追記:

```javascript
/**
 * ...（既存ヘッダーコメント）...
 *
 * Findings recorded in reports/2026-08-11-pixelexact-osr-scale-investigation.md
 * (Electron 40: paints at display scale, deviceScaleFactor ignored;
 *  Electron 41: deviceScaleFactor honored, default = display scale;
 *  Electron 42: default flipped to 1.0).
 *
 * Re-run: <electron binary> packages/renderer/scripts/osr-scale-probe.cjs <plain|dip> [--dsf-1] [--force-scale-1]
 */
```

- [ ] **Step 6: 検証**

```bash
pnpm lint && pnpm typecheck && pnpm --filter @napolab/texture-bridge-renderer test
```

- [ ] **Step 7: Commit**

```bash
git add packages/renderer/src/types.ts README.md lang/ja/README.md packages/renderer/scripts/osr-scale-probe.cjs
git commit -m "docs: version-specific OSR scaling behavior and Electron 42 migration guide"
```

---

### Task 5: 実機検証 + 最終レビュー + difit

**Files:** なし（検証のみ）

- [ ] **Step 1: ビルド + 全テスト**

```bash
pnpm --filter @napolab/texture-bridge-core build && pnpm --filter @napolab/texture-bridge-renderer build
pnpm lint && pnpm typecheck && pnpm --filter @napolab/texture-bridge-core test && pnpm --filter @napolab/texture-bridge-renderer test
```

Expected: すべて成功（renderer build は `[esm-shim-guard] OK` を含む）

- [ ] **Step 2: 実機スモーク（Electron 40 = example）**

example（Electron 40）を起動し、fps が出ること・`frameDropped` が出ないことを確認して必ず kill する。40 は device-scale policy なので従来と同一挙動のはず。

```bash
pnpm --filter @napolab/texture-bridge-example dev   # バックグラウンド起動 → ログ確認 → 必ず process kill
```

- [ ] **Step 3: probe による policy 実証（Electron 42）**

renderer をビルドした状態で、42 の Electron バイナリから `createTextureBridge` 相当の window options を検証する。最低限、コミットした probe を 42 で実行して `deviceScaleFactor: 1` の codedSize が要求 px と一致することを確認:

```bash
# scratchpad に electron@42 がある場合はそれを利用
<electron42> packages/renderer/scripts/osr-scale-probe.cjs plain --dsf-1
```

Expected: `codedSize == 1920×1080`（scaleFactor 2 のディスプレイでも）

- [ ] **Step 4: difit でレビュー依頼**

```bash
npx difit HEAD main
```

ユーザーにレビューを依頼。**push / PR 作成は指示を待つ。**

---

## 実装しないこと（スコープ外）

- Electron 40 サポートの削除（peerDependencies は `>=40.0.0` のまま）
- `pixelExact` オプションの削除（deprecated 扱いの文書化のみ。削除は次 major）
- Windows 実機での display scaling 検証（レポートの残課題。CI では不可能）
- core（低レベル）API への policy 自動適用（core は「吸収しない」契約 — README に手動指定方法を記載するのみ）
