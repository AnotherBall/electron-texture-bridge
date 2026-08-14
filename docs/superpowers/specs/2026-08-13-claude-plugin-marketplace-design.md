# Claude Plugin Marketplace for electron-texture-bridge — Design

Date: 2026-08-13
Status: Approved in chat (brainstorming session), pending spec review
Branch: `feat/claude-plugin-marketplace` (based on `feat/forward-frames-multiviewer`)

## Overview

Turn the electron-texture-bridge repository into a Claude Code plugin
marketplace that ships one plugin, `texture-bridge`, containing four skills.
The skills teach a consumer project's Claude session how to set up, choose,
migrate to, and receive from the library's APIs — including the new
`forwardSharedTexture` / `forwardFrames` primitives.

Users install with:

```
/plugin marketplace add naporin0624/electron-texture-bridge
/plugin install texture-bridge
```

## Goals

- Distribute up-to-date usage knowledge alongside the library in the same
  repository, so API changes and skill updates land in the same PR.
- Give existing users (e.g. Cannelloni) a guided migration path from
  capturePage-based previews and manual paint wiring to the new APIs.
- Encode the multiviewer receiver recipe (preload receiver + demux + rAF
  composition) as a reusable skill.

## Non-goals

- No slash commands, no agents, no hooks — skills only.
- No separate plugins repo; this repo is the marketplace.
- No Japanese translations of skills (English only).

## Key Constraint: Self-Contained Skills

The plugin is installed into **consumer projects** (Cannelloni, Genovese,
third-party apps). Skill bodies MUST NOT reference files in this repository
(no `packages/example/...` paths, no repo-relative doc links). All recipes
are inlined in the skill or placed in the skill's own `references/*.md`.
The `packages/example` multiviewer implementation is the source of truth
when *authoring* the recipes, but the extracted code must stand alone.

## Directory Structure

```
electron-texture-bridge/
├── .claude-plugin/
│   └── marketplace.json          # marketplace definition
└── plugins/
    └── texture-bridge/
        ├── .claude-plugin/
        │   └── plugin.json       # name, description, version, author
        └── skills/
            ├── setting-up-texture-bridge/
            │   └── SKILL.md
            ├── choosing-texture-bridge-api/
            │   └── SKILL.md
            ├── migrating-to-forward-frames/
            │   └── SKILL.md
            └── receiving-shared-textures/
                └── SKILL.md
```

Long recipes may add `references/*.md` under the skill directory
(progressive disclosure); keep SKILL.md focused on triggers and the core
workflow.

## marketplace.json

- Marketplace name: `electron-texture-bridge`
- Owner: `naporin0624`
- One plugin entry: `texture-bridge`, source `./plugins/texture-bridge`

## Versioning

The plugin uses its own semver starting at `0.1.0`, independent of the
npm packages. It is intentionally **not** added to the release-please
`linked-versions` group — plugin content changes (prose) should not force
npm releases. Bump the plugin version manually when skill content changes.

## Skills

All skills are written in English, follow superpowers:writing-skills
conventions (gerund names, trigger-focused descriptions), and are validated
before merge.

### 1. setting-up-texture-bridge

- **Triggers:** installing or bootstrapping the library, first-time wiring,
  "add texture-bridge to my Electron app".
- **Content:** `pnpm add @napolab/texture-bridge`; Electron 40+ requirement;
  `OffscreenBrowserWindow` with `useSharedTexture: true`; electron-vite
  preload entry configuration; platform notes (Syphon on macOS, Spout on
  Windows) at the level a consumer needs (prebuilt binaries; vendor SDK
  builds only for source builds).

### 2. choosing-texture-bridge-api

- **Triggers:** "which API should I use", designing a new integration,
  reviewing an integration plan.
- **Content:** decision table for simple vs core vs `forwardSharedTexture`
  vs `forwardFrames`; anti-pattern catalog: capturePage polling previews,
  GPU→CPU readback + IPC bitmap transfer, per-tag window sprawl and the
  transfer-volume/CPU concerns that motivate atlasing.

### 3. migrating-to-forward-frames

- **Triggers:** replacing an existing preview/transfer implementation,
  upgrading to the release that ships the new APIs.
- **Content:** two migration paths:
  1. capturePage-based preview → `forwardFrames` (Cannelloni deck preview
     pattern; one-line insertion
     `bridge.forwardFrames(webContents, { extraArgs })`).
  2. Manual `handlePaint` + `TextureSender` wiring → `forwardSharedTexture`.
- Version prerequisites (Electron 40+, texture-bridge version that ships the
  APIs) and the v0.14.0 explicit-dispose semantics change.

### 4. receiving-shared-textures

- **Triggers:** implementing the receiving side of forwarded frames,
  building a multiviewer/preview grid.
- **Content:** preload recipe `installSharedTextureReceiver` +
  `consumeSharedTexture` demux + rAF composition; multi-source grid
  pattern; stale-frame guards; disconnect cleanup (clearing quadrants,
  release/dispose obligations).

## Quality Gates

- `plugin-dev:plugin-validator` agent over the plugin directory.
- `plugin-dev:skill-reviewer` agent over each skill.
- Local install smoke test: `/plugin marketplace add <local path>` and
  verify the four skills load in a scratch project.
- `pnpm lint && pnpm typecheck` remain green (no TS code is added, but the
  gates must not regress).

## Branch / Review Strategy

- Implement on `feat/claude-plugin-marketplace`, branched from
  `feat/forward-frames-multiviewer` so skill content can cite the new API
  docs and example.
- Separate PR from the multiviewer PR; merge after it.
- Every commit goes through difit review per project workflow; no
  unsolicited commits.

## Testing Strategy

Skills are prose, not code, so vitest TDD does not apply. Verification is:
validator + reviewer agents (above), local install smoke test, and manual
trigger checks (paste representative user prompts, confirm the intended
skill fires).
