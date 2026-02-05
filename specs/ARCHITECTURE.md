# Electron Texture Bridge Architecture

## Overview

Electron Texture Bridge は、Electron アプリケーションから外部アプリケーション（VJ ソフト、OBS など）へ GPU テクスチャを **GPU Zero-Copy** で共有するためのライブラリです。

### サポートプラットフォーム

| Platform | Protocol | GPU API |
|----------|----------|---------|
| macOS | Syphon (Metal) | IOSurface + Metal |
| Windows | Spout | DXGI Shared Handle + D3D11 |

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Electron Application                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────────────┐     ┌──────────────────────────────────┐  │
│  │   Offscreen BrowserWindow    │     │       Preview BrowserWindow      │  │
│  │   (Rendering Source)         │     │       (Optional Display)         │  │
│  │                              │     │                                  │  │
│  │  ┌────────────────────────┐  │     │  ┌────────────────────────────┐  │  │
│  │  │  WebGL/Canvas Content  │  │     │  │   WebGPU Renderer          │  │  │
│  │  │  (Web Worker)          │  │     │  │   (texture_external)       │  │  │
│  │  └────────────────────────┘  │     │  └────────────────────────────┘  │  │
│  │                              │     │              ▲                   │  │
│  │  useSharedTexture: true      │     │              │                   │  │
│  └───────────────┬──────────────┘     └──────────────┼───────────────────┘  │
│                  │                                   │                      │
│                  │ paint event                       │ sharedTexture.send   │
│                  ▼                                   │                      │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                        Main Process                                 │    │
│  │                                                                     │    │
│  │   event.texture.textureInfo                                         │    │
│  │   ├── handle.ioSurface (macOS: IOSurfaceRef as Buffer)             │    │
│  │   ├── handle.dxgiHandle (Windows: DXGI HANDLE)                     │    │
│  │   └── codedSize { width, height }                                  │    │
│  │                                                                     │    │
│  │   ┌─────────────────────┐    ┌──────────────────────────────────┐   │    │
│  │   │ sharedTexture API   │───▶│  importSharedTexture()           │───┼────┘
│  │   │ (Electron 40+)      │    │  sendSharedTexture()             │   │
│  │   └─────────────────────┘    └──────────────────────────────────┘   │
│  │                                                                     │
│  │   ┌─────────────────────────────────────────────────────────────┐   │
│  │   │                  Native Addon (napi-rs)                     │   │
│  │   │                                                             │   │
│  │   │   TextureSender                                             │   │
│  │   │   ├── sendSurface(ioSurfaceBuffer, width, height)          │   │
│  │   │   ├── send(dxgiHandle, width, height)                      │   │
│  │   │   └── sendRgbaBuffer(data, width, height, stride)          │   │
│  │   │                                                             │   │
│  │   └──────────────────────────┬──────────────────────────────────┘   │
│  │                              │                                      │
│  └──────────────────────────────┼──────────────────────────────────────┘
│                                 │
└─────────────────────────────────┼─────────────────────────────────────────┘
                                  │ FFI (C ABI)
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Native Libraries                                      │
├────────────────────────────────┬────────────────────────────────────────────┤
│           macOS                │               Windows                       │
│                                │                                             │
│  ┌──────────────────────────┐  │  ┌──────────────────────────────────────┐  │
│  │   Syphon Metal Bridge    │  │  │          Spout SDK                   │  │
│  │                          │  │  │                                      │  │
│  │  IOSurfaceLookup()       │  │  │  DXGI Handle → D3D11 Texture         │  │
│  │        ↓                 │  │  │        ↓                             │  │
│  │  MTLTexture (from        │  │  │  ID3D11Texture2D                     │  │
│  │  IOSurface)              │  │  │        ↓                             │  │
│  │        ↓                 │  │  │  Spout Sender                        │  │
│  │  Syphon Metal Server     │  │  │                                      │  │
│  └──────────────────────────┘  │  └──────────────────────────────────────┘  │
│                                │                                             │
└────────────────────────────────┴────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    External Applications                                     │
│                                                                              │
│   Syphon Receivers (macOS)         │   Spout Receivers (Windows)            │
│   ├── Resolume Arena               │   ├── Resolume Arena                   │
│   ├── OBS                          │   ├── OBS                              │
│   ├── VDMX                         │   ├── TouchDesigner                    │
│   └── Mad Mapper                   │   └── etc.                             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow

### 1. Rendering Phase (Offscreen Window)

```
index.html
    │
    ▼ transferControlToOffscreen()
OffscreenCanvas
    │
    ▼ postMessage()
Web Worker (render-worker.js)
    │
    ▼ WebGL2 rendering
GPU Texture
    │
    ▼ Chromium Compositor
Shared GPU Texture (IOSurface / DXGI)
```

### 2. Texture Capture Phase (Main Process)

```
BrowserWindow.webContents.on('paint', (event) => {
    const { texture } = event
    const { textureInfo } = texture
    // textureInfo.handle.ioSurface: Buffer (8 bytes = IOSurfaceRef pointer)
    // textureInfo.codedSize: { width, height }
})
```

### 3. Distribution Phase

#### Path A: Preview Window (GPU Zero-Copy)

```
Main Process                          Preview Renderer
     │                                      │
     │  sharedTexture.importSharedTexture() │
     │  sharedTexture.sendSharedTexture()   │
     │ ─────────────────────────────────────▶
     │                                      │
     │                    sharedTexture.setSharedTextureReceiver()
     │                                      │
     │                    imported.getVideoFrame()
     │                                      │
     │                    device.importExternalTexture(videoFrame)
     │                                      │
     │                    WebGPU Render (GPU zero-copy)
```

#### Path B: Syphon/Spout (GPU Zero-Copy)

```
Main Process                          Native Addon
     │                                      │
     │  sender.sendSurface(                 │
     │    handle.ioSurface,                 │
     │    width, height                     │
     │  )                                   │
     │ ─────────────────────────────────────▶
     │                                      │
     │                    IOSurfaceRef → MTLTexture
     │                                      │
     │                    Syphon Metal Server.publish()
     │                                      ▼
     │                              External VJ Apps
```

---

## Component Details

### Offscreen BrowserWindow Configuration

```javascript
new BrowserWindow({
  width: 1920,
  height: 1080,
  show: false,  // Offscreen, no display
  webPreferences: {
    offscreen: {
      useSharedTexture: true,  // Critical: enables GPU texture sharing
    },
  },
})
```

- `useSharedTexture: true` により paint イベントで GPU テクスチャハンドルが取得可能
- `show: false` でウィンドウを非表示にしつつレンダリング継続

### TextureSender Native Addon (Rust + napi-rs)

```rust
#[napi]
pub struct TextureSender {
    #[cfg(target_os = "macos")]
    inner: mac::Sender,  // Syphon Metal
    #[cfg(target_os = "windows")]
    inner: win::Sender,  // Spout
}
```

**API:**

| Method | Description |
|--------|-------------|
| `new(name, width, height)` | Create sender with given name |
| `sendSurface(buffer, w, h)` | Send IOSurfaceRef (macOS) |
| `send(handle, w, h)` | Send DXGI handle (Windows) |
| `sendRgbaBuffer(data, w, h, stride)` | Send raw RGBA (fallback) |
| `stop()` | Release resources |

### Syphon Metal FFI (macOS)

```rust
extern "C" {
    fn syphon_bridge_create(name: *const c_char) -> SyphonBridgeHandle;
    fn syphon_bridge_destroy(handle: SyphonBridgeHandle);
    fn syphon_bridge_send_surface(
        handle: SyphonBridgeHandle,
        surface: IOSurfaceRef,
        width: u32,
        height: u32,
    ) -> i32;
}
```

---

## Key Technologies

### Electron 40+ sharedTexture API

```javascript
// Main Process
const { sharedTexture } = require('electron')

// Import texture for sharing
const imported = sharedTexture.importSharedTexture({ textureInfo })

// Send to renderer process
sharedTexture.sendSharedTexture({
  frame: previewWin.webContents.mainFrame,
  importedSharedTexture: imported,
})
```

```javascript
// Renderer Process (preload.js)
sharedTexture.setSharedTextureReceiver((data) => {
  const imported = data.importedSharedTexture
  const videoFrame = imported.getVideoFrame()
  // Use with WebGPU importExternalTexture()
})
```

### WebGPU External Texture

```javascript
// GPU zero-copy import of VideoFrame
const externalTexture = device.importExternalTexture({
  source: videoFrame,
})

// WGSL shader
@group(0) @binding(0) var externalTexture: texture_external;
```

### WGSL (WebGPU Shading Language)

**WGSL** は WebGPU 専用に設計されたシェーダー言語です。GPU 上で実行されるプログラム（シェーダー）を記述します。

#### 従来のシェーダー言語との比較

| 言語 | 用途 | 特徴 |
|------|------|------|
| **WGSL** | WebGPU | Web 向け、Rust 風構文、型安全 |
| GLSL | WebGL / OpenGL | C 風構文、広く普及 |
| HLSL | DirectX | Microsoft 標準、Windows 向け |
| MSL | Metal | Apple 標準、C++ 風 |

#### GLSL vs WGSL：主な違い

| 項目 | GLSL (WebGL) | WGSL (WebGPU) |
|------|--------------|---------------|
| 構文スタイル | C 風 | Rust 風 |
| 型宣言 | `float x;` | `var x: f32;` |
| ベクトル型 | `vec4` | `vec4f` または `vec4<f32>` |
| 関数宣言 | `void main()` | `fn main()` |
| 入出力 | `attribute`, `varying`, `uniform` | `@location`, `@group`, `@binding` |
| エントリポイント | 固定 `main()` | 任意の関数名 + `@vertex`/`@fragment` |

**同じ処理を GLSL と WGSL で比較:**

```glsl
// ===== GLSL (WebGL) =====
#version 300 es
precision highp float;

// 入力（attribute）
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_texCoord;

// 出力（varying）
out vec2 v_texCoord;

// ユニフォーム
uniform mat4 u_matrix;

void main() {
  gl_Position = u_matrix * vec4(a_position, 0.0, 1.0);
  v_texCoord = a_texCoord;
}
```

```wgsl
// ===== WGSL (WebGPU) =====

// 構造体で入出力を定義
struct VertexInput {
  @location(0) position: vec2f,
  @location(1) texCoord: vec2f,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) texCoord: vec2f,
}

// ユニフォームはバインドグループで管理
@group(0) @binding(0) var<uniform> matrix: mat4x4f;

// エントリポイントは任意の関数名 + アトリビュート
@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = matrix * vec4f(input.position, 0.0, 1.0);
  output.texCoord = input.texCoord;
  return output;
}
```

**フラグメントシェーダーの比較:**

```glsl
// ===== GLSL (WebGL) =====
#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_texture;

void main() {
  fragColor = texture(u_texture, v_texCoord);
}
```

```wgsl
// ===== WGSL (WebGPU) =====
@group(0) @binding(0) var textureSampler: sampler;
@group(0) @binding(1) var textureData: texture_2d<f32>;

@fragment
fn fragmentMain(@location(0) texCoord: vec2f) -> @location(0) vec4f {
  return textureSample(textureData, textureSampler, texCoord);
}
```

**WGSL の主な利点:**
1. **型安全**: コンパイル時に厳密な型チェック
2. **明示的なバインディング**: リソースの場所が構文で明確
3. **構造体ベース**: 入出力が構造体で整理される
4. **モダンな構文**: Rust 風で可読性が高い

**WGSL で戸惑いやすい点:**
1. `var` と `let` の違い（`var` = 可変、`let` = 不変）
2. テクスチャとサンプラーが分離している
3. `gl_Position` → `@builtin(position)`
4. `main()` ではなく任意の関数名

#### WGSL の基本構文

```wgsl
// 構造体定義
struct VertexOutput {
  @builtin(position) position: vec4f,  // GPU組み込み変数（クリップ座標）
  @location(0) texCoord: vec2f,        // カスタム出力（UV座標）
}

// 頂点シェーダー: 各頂点の位置を計算
@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // フルスクリーン三角形の頂点座標
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );

  var output: VertexOutput;
  output.position = vec4f(pos[vertexIndex], 0.0, 1.0);
  return output;
}

// バインディング宣言: JavaScript から渡されるリソース
@group(0) @binding(0) var externalTexture: texture_external;  // 外部テクスチャ
@group(0) @binding(1) var texSampler: sampler;                // サンプラー

// フラグメントシェーダー: 各ピクセルの色を計算
@fragment
fn fragmentMain(@location(0) texCoord: vec2f) -> @location(0) vec4f {
  // texture_external からサンプリング（GPU zero-copy）
  return textureSampleBaseClampToEdge(externalTexture, texSampler, texCoord);
}
```

#### WGSL のキーコンセプト

**1. アトリビュート (`@`)**
```wgsl
@vertex              // 頂点シェーダーを示す
@fragment            // フラグメントシェーダーを示す
@builtin(position)   // GPU 組み込み変数
@location(0)         // 入出力スロット番号
@group(0) @binding(0) // バインドグループとスロット
```

**2. 型システム**
```wgsl
f32          // 32bit 浮動小数点
u32          // 32bit 符号なし整数
vec2f        // vec2<f32> の省略形
vec4f        // vec4<f32> の省略形
mat4x4f      // 4x4 行列
```

**3. texture_external（本プロジェクトの核心）**
```wgsl
// VideoFrame を GPU zero-copy でテクスチャとして使用
@group(0) @binding(0) var externalTexture: texture_external;

// サンプリング関数（texture_external 専用）
textureSampleBaseClampToEdge(externalTexture, sampler, uv)
```

`texture_external` は WebGPU 独自の型で、以下のソースを GPU コピーなしで直接テクスチャとして使用できます：
- `VideoFrame` (本プロジェクトで使用)
- `HTMLVideoElement`
- `VideoDecoder` 出力

#### JavaScript からの WGSL 使用

```javascript
// 1. シェーダーモジュール作成
const shaderModule = device.createShaderModule({
  code: wgslCode,  // WGSL ソースコード文字列
});

// 2. パイプライン作成
const pipeline = device.createRenderPipeline({
  vertex: {
    module: shaderModule,
    entryPoint: 'vertexMain',  // WGSL の @vertex 関数名
  },
  fragment: {
    module: shaderModule,
    entryPoint: 'fragmentMain', // WGSL の @fragment 関数名
    targets: [{ format: 'bgra8unorm' }],
  },
});

// 3. バインドグループ作成（WGSL の @group/@binding に対応）
const bindGroup = device.createBindGroup({
  layout: pipeline.getBindGroupLayout(0),  // @group(0)
  entries: [
    { binding: 0, resource: externalTexture }, // @binding(0)
    { binding: 1, resource: sampler },         // @binding(1)
  ],
});
```

---

## Performance Characteristics

| Path | Copy Operations | Latency | Memory |
|------|-----------------|---------|--------|
| Syphon/Spout | 0 (GPU zero-copy) | < 1 frame | Shared GPU memory |
| Preview (WebGPU) | 0 (GPU zero-copy) | < 1 frame | Shared GPU memory |
| RGBA Buffer | 1 (CPU → GPU) | 2-3 frames | CPU + GPU |

---

## File Structure

```
electron-texture-bridge/
├── src/
│   ├── lib.rs           # napi-rs entry point, TextureSender API
│   ├── types.rs         # RawTextureHandle type alias
│   ├── mac/
│   │   ├── mod.rs       # macOS Sender implementation
│   │   └── ffi.rs       # Syphon Metal FFI declarations
│   └── win/
│       └── ...          # Windows Spout implementation
├── example/
│   ├── main.js          # Electron main process
│   ├── preload.js       # sharedTexture receiver setup
│   ├── index.html       # WebGL + OffscreenCanvas + Worker
│   ├── render-worker.js # WebGL rendering in Worker
│   ├── preview.html     # WebGPU preview window
│   └── index-simple.html # Simple Canvas2D demo
├── Cargo.toml           # Rust dependencies
└── package.json         # npm package config
```

---

## Requirements

- **Electron**: 40.0.0+ (for sharedTexture API)
- **macOS**: 10.15+ (Metal support)
- **Windows**: 10+ (DXGI 1.2+)
- **Rust**: 1.70+ (for napi-rs)
