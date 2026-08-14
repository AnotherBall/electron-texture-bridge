# pixelExact / OSR device scale 調査 — Electron 40→42 の挙動変更が矛盾の正体

- 日付: 2026-08-11
- 対象: backlog #3（`pixelExact` の再検証、width/height の DIP/pixel 契約不一致）
- 方法: 同一マシン（macOS, Built-in Retina, `scaleFactor = 2`）で Electron **40.2.1 / 41.10.4 / 42.4.0** を並べ、OSR `useSharedTexture` ウィンドウの paint `codedSize` を実測（probe: `osr-scale-probe.cjs`、window 1920×1080 DIP と `computeDipSize` 適用の 960×540 DIP の 2 モード × スイッチ/オプション組合せ）

## 結論

**Genovese（Electron 40, `pixelExact: true` で正常）と Cannelloni（Electron 42, `pixelExact: true` で 1/4 解像度）の矛盾は、両方正しい。** Electron 42 の公式 breaking change「OSR のデフォルト device scale factor を 1.0 に変更」が原因で、`pixelExact` の前提（DIP × scaleFactor = framebuffer px）が 42 以降では成立しない。

## 実測マトリクス

| | Electron 40.2.1 | Electron 41.10.4 | Electron 42.4.0 |
|---|---|---|---|
| OSR paint のデフォルトスケール | **display scale（×2）** | **display scale（×2）** | **1.0** |
| window 1920×1080 DIP → codedSize | 3840×2160 | 3840×2160 | **1920×1080** |
| `pixelExact` 計算（960×540 DIP）→ codedSize | **1920×1080 = 申告一致 ✓** | 1920×1080 ✓ | **960×540 = 1/4 解像度 ✗** |
| `webPreferences.offscreen.deviceScaleFactor: 1` | **無視される**（×2 のまま） | **効く**（×1） | 効く（デフォルトと同じ） |
| `force-device-scale-factor=1` スイッチ | OSR には無効（×2 のまま） | 未測定 | no-op（元から 1.0） |

## 根本原因（Electron 側の変更）

Electron の breaking changes に明記されている:

> Offscreen rendering will use `1.0` as default device scale factor.（従来は primary display の scale factor を使っており、ユーザー環境によって出力サイズが変わっていた。42 から定数 1.0 に変更。）

移行パスとして `webPreferences.offscreen.deviceScaleFactor` が **41 で追加**（未指定時は旧挙動 = display scale を維持）され、**42 でデフォルトが 1.0 に反転**した。実測もこれと完全に一致する（41 ではオプション指定時のみ 1.0、42 では無指定でも 1.0）。

Cannelloni が併用した `force-device-scale-factor=1` は、40 では OSR に対して無効であることを実測確認。42 で彼らの症状が直ったのは **`pixelExact` を外したことが本質**で、スイッチは（OSR に関しては）お守りだった。

## 各消費者への影響の整理

| 消費者 | Electron | 現状 | 将来リスク |
|---|---|---|---|
| Genovese | ^40.0.0 | `pixelExact: true` が設計通り機能 | **42 へ上げた瞬間に 1/4 解像度になる**（texture-bridge 未対応のまま上げた場合） |
| Cannelloni | ^42.4.0 | `pixelExact` 削除 + スイッチで運用（実質: 42 のデフォルト 1.0 に依存） | texture-bridge が 42 対応すれば workaround 一式を撤去できる |
| README の Retina 警告 | — | 「DIP × scaleFactor で膨らむ」記述は **41 まで**の挙動。42 では黒画面の主因ではなくなった | 版別の記述が必要 |

## texture-bridge の修正方針（提案）

鍵は「**推測せず、Electron 41 で追加された `offscreen.deviceScaleFactor` で明示的に固定する**」こと。

- **Electron ≥ 41**: `createTextureBridge` は常に `offscreen: { useSharedTexture: true, deviceScaleFactor: 1 }` を設定する（ユーザーが `webPreferences` で明示指定した場合はそちらを尊重）。
  - これで **DIP = px が全環境で決定論的**になり、`TextureBridgeOptions.width/height` の「pixels」という文書上の契約（Genovese AGENTS.md が指摘した不一致）が**そのまま真になる**
  - `pixelExact` は「framebuffer を width×height px に固定する」という約束が自明に満たされるため **no-op（実質 deprecated）**。DIP 割り算は行わない（行うと 42 系で 1/4 化する）
- **Electron 40**: `deviceScaleFactor` が無視されるため現行ロジック維持（`pixelExact: true` で DIP 割り算、false なら DIP×scale + README 警告）。
- 判定は `process.versions.electron` の major で分岐（41 を境界に）。
- ドキュメント: README の Retina/DPI 節を版別に書き直し。Cannelloni へは「0.14.x 以降 + Electron 42 で `pixelExact` 削除・スイッチ撤去可能」、Genovese へは「Electron 42 に上げる前に texture-bridge を上げること」という移行ガイドを追記。

### この設計が Cannelloni の症状を再現條件ごと解消する理由

1/4 解像度は「`pixelExact` の DIP 割り算」×「42 の scale 1.0」の掛け算で起きた。≥41 で DIP 割り算を廃止し scale を 1 に固定すれば、割り算も掛け算も存在しなくなる。

## 残課題 / 未測定

- Windows での同挙動の確認（display scaling 150%/175% 環境。CI の windows-native-smoke ではヘッドレスのため scale 検証は不可 — 実機確認が必要）
- Electron 41 の `force-device-scale-factor` の OSR への影響（本筋に影響しないため未測定）
- マルチディスプレイ（scale の異なる外部ディスプレイ）で 40/41 のデフォルトがどちらの scale を拾うか

## Sources

- [Electron Breaking Changes](https://www.electronjs.org/docs/latest/breaking-changes) — "Offscreen rendering will use `1.0` as default device scale factor"
- [Electron Offscreen Rendering tutorial](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering/)
- [electron/electron#45428 — Documentation / tests for 'useSharedTexture' offscreen mode on macOS](https://github.com/electron/electron/issues/45428)
- Cannelloni `reports/2026-06-17-syphon-quarter-resolution-pixelexact.md`（1/4 解像度の一次報告）
- Genovese `src/main/bootstrap/texture-bridge-setup.ts:32-38`（pixelExact 使用箇所）/ `AGENTS.md:47`（width/height 契約不一致の指摘）
