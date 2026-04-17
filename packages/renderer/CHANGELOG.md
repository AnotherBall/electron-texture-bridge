# Changelog

## [0.9.0](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.8.2...renderer-v0.9.0) (2026-04-17)


### ⚠ BREAKING CHANGES

* The native `TextureReceiver.startListening(callback)` API is removed. Frame reception now always goes through JS-driven `setInterval` polling via `receiveFrame()`, matching the semantics the macOS path already used.

### Features

* unify receiver to JS-driven polling, remove startListening ([4daa304](https://github.com/naporin0624/electron-texture-bridge/commit/4daa304231ca6b8b1358a547839f6392a605e911))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.9.0

## [0.8.2](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.8.1...renderer-v0.8.2) (2026-04-17)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.8.2

## [0.8.1](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.8.0...renderer-v0.8.1) (2026-04-17)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.8.1

## [0.8.0](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.7.1...renderer-v0.8.0) (2026-04-02)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.8.0

## [0.7.1](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.7.0...renderer-v0.7.1) (2026-04-02)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.7.1

## [0.7.0](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.6.6...renderer-v0.7.0) (2026-03-29)


### Features

* **spout:** event-driven receiver via native thread ([aa24f9e](https://github.com/naporin0624/electron-texture-bridge/commit/aa24f9ea3f638f8f91998c4b6472b8c5f6d17ee8))
* **spout:** event-driven receiver via native thread + ThreadsafeFunction ([70fbe9e](https://github.com/naporin0624/electron-texture-bridge/commit/70fbe9e775ce9b13e85ab9b879f112227b3882cb))
* **syphon:** event-driven receiver via native listener thread ([be34204](https://github.com/naporin0624/electron-texture-bridge/commit/be34204add6467df914c05a10b7fb0996d894171))
* **syphon:** event-driven receiver via native listener thread ([358fb41](https://github.com/naporin0624/electron-texture-bridge/commit/358fb41dcdc3615d6f92af96172c34ff2409e86d))


### Bug Fixes

* **ci:** use stub module for native package in vitest ([86eccfa](https://github.com/naporin0624/electron-texture-bridge/commit/86eccfacdf568940650eec9b350d2cb581fe89c6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.7.0

## [0.6.6](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.6.5...renderer-v0.6.6) (2026-03-29)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.6.6

## [0.6.5](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.6.4...renderer-v0.6.5) (2026-03-20)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.6.5

## [0.6.4](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.6.3...renderer-v0.6.4) (2026-03-20)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.6.4

## [0.6.3](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.6.2...renderer-v0.6.3) (2026-03-20)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.6.3

## [0.6.2](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.6.1...renderer-v0.6.2) (2026-03-20)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.6.2

## [0.6.1](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.6.0...renderer-v0.6.1) (2026-03-20)


### Bug Fixes

* **spout:** fix receiver never delivering frames on Windows ([a595b43](https://github.com/naporin0624/electron-texture-bridge/commit/a595b437bd654d4eb4a27894cf1629d8bf8f7012))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.6.1

## [0.6.0](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.5.1...renderer-v0.6.0) (2026-03-18)


### Features

* explicit native disposal with Symbol.dispose support ([#18](https://github.com/naporin0624/electron-texture-bridge/issues/18)) ([e65509e](https://github.com/naporin0624/electron-texture-bridge/commit/e65509eb4b12175c6f4416d3f983f2cbf506ecc4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.6.0

## [0.5.1](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.5.0...renderer-v0.5.1) (2026-03-18)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.5.1

## [0.5.0](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.4.1...renderer-v0.5.0) (2026-03-18)


### Features

* add TextureReceiver and listSenders API for Syphon/Spout ([#13](https://github.com/naporin0624/electron-texture-bridge/issues/13)) ([9bbfb54](https://github.com/naporin0624/electron-texture-bridge/commit/9bbfb54dd2b89f7fd621a45f4cd57ddbfb44c4e6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.5.0

## [0.4.1](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.4.0...renderer-v0.4.1) (2026-02-14)


### Bug Fixes

* guard against undefined textureInfo in paint event ([#10](https://github.com/naporin0624/electron-texture-bridge/issues/10)) ([f9f20e4](https://github.com/naporin0624/electron-texture-bridge/commit/f9f20e49efb1857c42a895c52ccd2a6d8bc2c49e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.4.1

## [0.4.0](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.3.5...renderer-v0.4.0) (2026-02-14)


### Features

* add renderer package with high-level createTextureBridge API ([8d44863](https://github.com/naporin0624/electron-texture-bridge/commit/8d44863610d74ace40d9b0568674ca326702be6e))
* migrate to @napolab/texture-bridge package scope ([2f5d3e4](https://github.com/naporin0624/electron-texture-bridge/commit/2f5d3e4c6a6af61a00ae05dc05e25cdc45ff116a))


### Bug Fixes

* add repository field for npm provenance verification ([32da705](https://github.com/naporin0624/electron-texture-bridge/commit/32da705c2d22796c3db80b8284b083c44279eb88))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.4.0

## [0.3.5](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.3.4...renderer-v0.3.5) (2026-02-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.3.5

## [0.3.4](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.3.3...renderer-v0.3.4) (2026-02-12)


### Bug Fixes

* add repository field for npm provenance verification ([32da705](https://github.com/naporin0624/electron-texture-bridge/commit/32da705c2d22796c3db80b8284b083c44279eb88))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.3.4

## [0.3.3](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.3.2...renderer-v0.3.3) (2026-02-12)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.3.3

## [0.3.2](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.3.1...renderer-v0.3.2) (2026-02-11)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.3.2

## [0.3.1](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.3.0...renderer-v0.3.1) (2026-02-10)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.3.1

## [0.3.0](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.2.0...renderer-v0.3.0) (2026-02-10)


### Features

* migrate to @napolab/texture-bridge package scope ([2f5d3e4](https://github.com/naporin0624/electron-texture-bridge/commit/2f5d3e4c6a6af61a00ae05dc05e25cdc45ff116a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.3.0

## [0.2.0](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.1.0...renderer-v0.2.0) (2026-02-10)


### Features

* add renderer package with high-level createTextureBridge API ([8d44863](https://github.com/naporin0624/electron-texture-bridge/commit/8d44863610d74ace40d9b0568674ca326702be6e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.2.0
