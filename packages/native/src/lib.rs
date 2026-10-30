mod types;
// Platform-independent PreviewView helpers; only the Windows and macOS
// implementations consume them.
#[cfg_attr(
    not(any(target_os = "windows", target_os = "macos")),
    allow(dead_code)
)]
mod preview_layout;
#[cfg_attr(
    not(any(target_os = "windows", target_os = "macos")),
    allow(dead_code)
)]
mod preview_state;
#[cfg_attr(
    not(any(target_os = "windows", target_os = "macos")),
    allow(dead_code)
)]
mod preview_stats;
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod preview_unsupported;

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "windows")]
mod win;

use napi::*;
use napi_derive::napi;

// ============================================================
// JS API: TextureSender
//
//   const sender = new TextureSender("MyVJ", 1920, 1080)
//   sender.send(handle, width, height)
//   sender.stop()
//
// ============================================================

#[napi]
pub struct TextureSender {
    #[cfg(target_os = "windows")]
    inner: Option<win::Sender>,
    #[cfg(target_os = "macos")]
    inner: Option<mac::Sender>,

    width: u32,
    height: u32,
}

#[napi]
impl TextureSender {
    /// Create a new texture sender.
    ///
    /// - `name`: Sender name visible in Spout/Syphon receivers
    /// - `width`: Initial texture width
    /// - `height`: Initial texture height
    #[napi(constructor)]
    pub fn new(name: String, width: u32, height: u32) -> Result<Self> {
        #[cfg(target_os = "windows")]
        let inner = win::Sender::new(&name, width, height).map_err(|e| Error::from_reason(e))?;

        #[cfg(target_os = "macos")]
        let inner = mac::Sender::new(&name).map_err(|e| Error::from_reason(e))?;

        Ok(Self {
            inner: Some(inner),
            width,
            height,
        })
    }

    /// Send a shared texture to Spout (Win) or Syphon (Mac).
    ///
    /// - `handle`: The native texture handle from Electron's paint event
    ///   - Windows: `texture.textureInfo.handle` (DXGI HANDLE as number/BigInt)
    ///   - macOS: `texture.textureInfo.handle` (IOSurfaceID as number)
    /// - `width`: Texture width (from `textureInfo.codedSize.width`)
    /// - `height`: Texture height (from `textureInfo.codedSize.height`)
    #[napi]
    pub fn send(&mut self, handle: i64, width: u32, height: u32) -> Result<()> {
        let inner = self
            .inner
            .as_mut()
            .ok_or_else(|| Error::from_reason("TextureSender has been stopped"))?;
        self.width = width;
        self.height = height;

        #[cfg(target_os = "windows")]
        {
            inner.send(handle).map_err(|e| Error::from_reason(e))?;
        }

        #[cfg(target_os = "macos")]
        {
            inner
                .send(handle, width, height)
                .map_err(|e| Error::from_reason(e))?;
        }

        Ok(())
    }

    /// Send an IOSurface by direct pointer (macOS only).
    /// Use this when you have an IOSurfaceRef buffer from Electron's shared texture.
    ///
    /// - `surface_buffer`: Buffer containing IOSurfaceRef pointer (8 bytes on 64-bit)
    /// - `width`: Texture width
    /// - `height`: Texture height
    #[napi]
    pub fn send_surface(
        &mut self,
        surface_buffer: napi::bindgen_prelude::Buffer,
        width: u32,
        height: u32,
    ) -> Result<()> {
        let inner = self
            .inner
            .as_mut()
            .ok_or_else(|| Error::from_reason("TextureSender has been stopped"))?;
        self.width = width;
        self.height = height;

        #[cfg(target_os = "macos")]
        {
            // Extract pointer from buffer (8 bytes = u64 pointer on 64-bit)
            if surface_buffer.len() < 8 {
                return Err(Error::from_reason("Surface buffer too small"));
            }
            let ptr_bytes: [u8; 8] = surface_buffer[..8]
                .try_into()
                .map_err(|_| Error::from_reason("Failed to read surface pointer"))?;
            let surface_ptr = u64::from_le_bytes(ptr_bytes);

            inner
                .send_surface(surface_ptr, width, height)
                .map_err(|e| Error::from_reason(e))?;
            Ok(())
        }

        #[cfg(not(target_os = "macos"))]
        {
            let _ = (inner, surface_buffer);
            Err(Error::from_reason("send_surface is macOS only"))
        }
    }

    /// Stop the sender and release native resources immediately.
    /// This is a terminal operation — the sender cannot be reused afterward.
    /// Repeated calls are safe and idempotent.
    #[napi]
    pub fn stop(&mut self) -> Result<()> {
        // Drop the inner sender immediately, releasing native resources.
        // Subsequent calls are idempotent (inner is already None).
        self.inner.take();
        Ok(())
    }

    /// Send raw RGBA buffer data to Syphon/Spout.
    /// Use this for VideoFrame.copyTo() workflow where you have pixel data in a Buffer.
    ///
    /// - `data`: Buffer containing RGBA pixel data (BGRA format expected)
    /// - `width`: Texture width in pixels
    /// - `height`: Texture height in pixels
    /// - `bytes_per_row`: Optional stride in bytes. Defaults to width * 4 if not provided.
    #[napi]
    pub fn send_rgba_buffer(
        &mut self,
        data: napi::bindgen_prelude::Buffer,
        width: u32,
        height: u32,
        bytes_per_row: Option<u32>,
    ) -> Result<()> {
        let inner = self
            .inner
            .as_mut()
            .ok_or_else(|| Error::from_reason("TextureSender has been stopped"))?;
        let stride = bytes_per_row.unwrap_or(width * 4);

        self.width = width;
        self.height = height;

        inner
            .send_rgba(data.as_ref(), width, height, stride)
            .map_err(|e| Error::from_reason(e))
    }

    /// Returns true if native resources have been released via `stop()`.
    #[cfg(test)]
    pub fn is_stopped(&self) -> bool {
        self.inner.is_none()
    }

    /// Get the current platform name.
    #[napi]
    pub fn platform(&self) -> String {
        #[cfg(target_os = "windows")]
        return "spout".to_string();
        #[cfg(target_os = "macos")]
        return "syphon-metal".to_string();
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        return "unsupported".to_string();
    }
}

/// Returns the current platform's texture sharing protocol name.
#[napi]
pub fn get_platform() -> String {
    #[cfg(target_os = "windows")]
    return "spout".to_string();
    #[cfg(target_os = "macos")]
    return "syphon-metal".to_string();
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    return "unsupported".to_string();
}

// ============================================================
// Sender info for discovery
// ============================================================

/// Information about an available texture sender (Syphon server / Spout sender).
#[derive(Debug, Clone, PartialEq)]
pub struct SenderInfo {
    pub name: String,
    pub app_name: Option<String>,
    pub uuid: Option<String>,
}

/// Parse a JSON string from the C++ discovery bridge into a Vec<SenderInfo>.
fn parse_senders_json(json: &str) -> std::result::Result<Vec<SenderInfo>, String> {
    let array: Vec<serde_json::Value> =
        serde_json::from_str(json).map_err(|e| format!("Invalid JSON: {}", e))?;

    array
        .into_iter()
        .map(|v| {
            let name = v
                .get("name")
                .and_then(|n| n.as_str())
                .ok_or_else(|| "Missing 'name' field in sender info".to_string())?;
            let app_name = v.get("appName").and_then(|n| n.as_str()).map(String::from);
            let uuid = v.get("uuid").and_then(|n| n.as_str()).map(String::from);
            Ok(SenderInfo {
                name: name.to_string(),
                app_name,
                uuid,
            })
        })
        .collect()
}

// ============================================================
// JS API: TextureReceiver
//
//   const receiver = new TextureReceiver("ServerName")
//   if (receiver.hasNewFrame()) {
//     const frame = receiver.receiveFrame()
//     // frame: { data: Buffer, width: number, height: number }
//   }
//   receiver.stop()
//
// ============================================================

/// napi-rs object returned from `receiveSharedTexture()`.
///
/// Zero-copy GPU frame metadata, designed to be passed almost verbatim into
/// Electron's `sharedTexture.importSharedTexture({ textureInfo: ... })` in the
/// main process.
///
/// `handle` is an 8-byte little-endian encoding of the platform-native shared
/// resource descriptor:
/// - Windows: an NT HANDLE (freshly minted for this frame via
///   `IDXGIResource1::CreateSharedHandle`). Ownership transfers to the consumer;
///   Electron will close it when the imported texture is released.
/// - macOS: an `IOSurfaceRef` pointer (retained by this call, released when the
///   imported texture is released by Electron).
///
/// **Ownership contract.** The handle is fresh per frame and is always owned by
/// the caller. On a successful `sharedTexture.importSharedTexture` the imported
/// texture takes ownership and frees the handle on its own `release()`. On any
/// path that does *not* feed the handle into `importSharedTexture` — unknown
/// pixelFormat, target WebContents destroyed, `importSharedTexture` threw — the
/// caller MUST feed the handle to `closeNativeHandle()` to avoid leaking an
/// NT HANDLE / IOSurface per frame.
///
/// The `ownerPid` field is the process ID in which the handle is valid, so
/// Chromium's GPU process can duplicate it correctly.
#[napi(object)]
pub struct SharedTextureFrame {
    pub width: u32,
    pub height: u32,
    /// Subset of Electron's `SharedTextureImportTextureInfo.pixelFormat` values
    /// that this receiver ever emits: `"bgra" | "rgba" | "rgbaf16"`. Kept in
    /// lockstep with `dxgi_format_to_pixel_format` (Windows) and
    /// `SharedIoSurfaceInfo::pixel_format_string` (macOS).
    pub pixel_format: String,
    /// Process ID that owns the handle. Almost always `process.pid` of the
    /// Node process that called `receiveSharedTexture`.
    pub owner_pid: u32,
    /// 8-byte little-endian encoding of the platform-native handle/pointer.
    pub handle: napi::bindgen_prelude::Buffer,
}

/// napi-rs object returned from receiveFrame()
#[napi(object)]
pub struct ReceivedFrame {
    pub data: napi::bindgen_prelude::Buffer,
    pub width: u32,
    pub height: u32,
}

/// napi-rs object returned from listSenders()
#[napi(object)]
pub struct JsSenderInfo {
    pub name: String,
    pub app_name: Option<String>,
    pub uuid: Option<String>,
}

#[napi]
pub struct TextureReceiver {
    #[cfg(target_os = "macos")]
    inner: Option<mac::receiver::Receiver>,
    #[cfg(target_os = "windows")]
    inner: Option<win::receiver::Receiver>,

    #[allow(dead_code)]
    sender_name: String,
    #[cfg(target_os = "macos")]
    #[allow(dead_code)]
    app_name: Option<String>,
    #[cfg(target_os = "macos")]
    #[allow(dead_code)]
    server_uuid: Option<String>,
}

#[napi]
impl TextureReceiver {
    /// Create a new texture receiver.
    ///
    /// - `sender_name`: Name of the Syphon server / Spout sender to connect to
    /// - `app_name`: (macOS only) Filter by application name
    /// - `server_uuid`: (macOS only) Connect by server UUID (highest priority)
    #[napi(constructor)]
    #[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
    pub fn new(
        sender_name: String,
        app_name: Option<String>,
        server_uuid: Option<String>,
    ) -> Result<Self> {
        #[cfg(target_os = "macos")]
        let inner = mac::receiver::Receiver::new(
            server_uuid.as_deref(),
            Some(&sender_name),
            app_name.as_deref(),
        )
        .map_err(|e| Error::from_reason(e))?;

        #[cfg(target_os = "windows")]
        let inner =
            win::receiver::Receiver::new(&sender_name).map_err(|e| Error::from_reason(e))?;

        let result = Self {
            inner: Some(inner),
            sender_name,
            #[cfg(target_os = "macos")]
            app_name,
            #[cfg(target_os = "macos")]
            server_uuid,
        };

        Ok(result)
    }

    /// Returns true if the server has output a new frame since the last receive.
    /// Returns false if `stop()` has been called.
    #[napi]
    pub fn has_new_frame(&self) -> bool {
        self.inner.as_ref().map_or(false, |r| r.has_new_frame())
    }

    /// Receive the current frame as RGBA pixel data.
    /// Returns null if no frame is available or if `stop()` has been called.
    #[napi]
    pub fn receive_frame(&mut self) -> Result<Option<ReceivedFrame>> {
        let inner = match &mut self.inner {
            Some(r) => r,
            None => return Ok(None),
        };
        match inner.receive_rgba() {
            Ok(Some((data, width, height))) => Ok(Some(ReceivedFrame {
                data: data.into(),
                width,
                height,
            })),
            Ok(None) => Ok(None),
            Err(e) => Err(Error::from_reason(e)),
        }
    }

    /// Receive the current frame as a GPU-shared texture descriptor.
    ///
    /// Returns `null` if no new frame is available or if `stop()` has been called.
    /// The returned object can be handed to Electron's
    /// `sharedTexture.importSharedTexture` after wrapping the `handle` Buffer
    /// under the appropriate platform key (`ntHandle` on Windows,
    /// `ioSurface` on macOS).
    #[napi]
    pub fn receive_shared_texture(&self) -> Result<Option<SharedTextureFrame>> {
        let inner = match &self.inner {
            Some(r) => r,
            None => return Ok(None),
        };

        #[cfg(target_os = "windows")]
        {
            match inner.receive_shared_texture() {
                Ok(Some(info)) => {
                    let pixel_format = dxgi_format_to_pixel_format(info.format)
                        .map_err(|e| Error::from_reason(e))?;
                    let mut bytes = vec![0u8; 8];
                    bytes.copy_from_slice(&info.nt_handle.to_le_bytes());
                    Ok(Some(SharedTextureFrame {
                        width: info.width,
                        height: info.height,
                        pixel_format: pixel_format.to_string(),
                        owner_pid: std::process::id(),
                        handle: bytes.into(),
                    }))
                }
                Ok(None) => Ok(None),
                Err(e) => Err(Error::from_reason(e)),
            }
        }

        #[cfg(target_os = "macos")]
        {
            match inner.receive_shared_iosurface() {
                Ok(Some(info)) => {
                    let mut bytes = vec![0u8; 8];
                    bytes.copy_from_slice(&info.iosurface_ptr.to_le_bytes());
                    Ok(Some(SharedTextureFrame {
                        width: info.width,
                        height: info.height,
                        pixel_format: info.pixel_format_string(),
                        owner_pid: std::process::id(),
                        handle: bytes.into(),
                    }))
                }
                Ok(None) => Ok(None),
                Err(e) => Err(Error::from_reason(e)),
            }
        }
    }

    /// Returns true if the receiver has a valid connection to a server.
    /// Returns false if `stop()` has been called.
    #[napi]
    pub fn is_connected(&self) -> bool {
        match &self.inner {
            Some(r) => {
                #[cfg(target_os = "macos")]
                return r.is_valid();
                #[cfg(target_os = "windows")]
                return r.is_connected();
            }
            None => false,
        }
    }

    /// Get the width of the last received texture.
    /// Returns 0 if `stop()` has been called.
    #[napi]
    pub fn get_width(&self) -> u32 {
        self.inner.as_ref().map_or(0, |r| r.width())
    }

    /// Get the height of the last received texture.
    /// Returns 0 if `stop()` has been called.
    #[napi]
    pub fn get_height(&self) -> u32 {
        self.inner.as_ref().map_or(0, |r| r.height())
    }

    /// Stop the receiver and release native resources immediately.
    /// This is a terminal operation — the receiver cannot be reused afterward.
    /// Repeated calls are safe and idempotent.
    #[napi]
    pub fn stop(&mut self) -> Result<()> {
        if let Some(mut r) = self.inner.take() {
            r.destroy();
        }
        Ok(())
    }

    /// Toggle whether `receiveSharedTexture` applies a vertical flip when
    /// staging the frame for `importSharedTexture`. Defaults to `true`
    /// (matches PR #46 behavior, suitable for `drawImage(VideoFrame)` /
    /// WebGPU `importExternalTexture` consumers expecting Y-DOWN). Pass
    /// `false` when the upstream Syphon source already publishes the
    /// orientation Electron's `importSharedTexture` expects.
    ///
    /// macOS only — a no-op on Windows (Spout's receive path does not have
    /// a flip stage).
    #[napi]
    #[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
    pub fn set_flip_y(&self, flip: bool) -> Result<()> {
        #[cfg(target_os = "macos")]
        if let Some(r) = &self.inner {
            r.set_flip_y(flip);
        }
        Ok(())
    }

    /// Returns true if native resources have been released via `stop()`.
    #[cfg(test)]
    pub fn is_stopped(&self) -> bool {
        self.inner.is_none()
    }

    /// Get the current platform name.
    #[napi]
    pub fn platform(&self) -> String {
        #[cfg(target_os = "windows")]
        return "spout".to_string();
        #[cfg(target_os = "macos")]
        return "syphon-metal".to_string();
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        return "unsupported".to_string();
    }
}

/// Map a raw `DXGI_FORMAT` value to an Electron-compatible pixel format string.
///
/// Currently supports the formats Chromium/Electron accepts in
/// `SharedTextureImportTextureInfo.pixelFormat`. Returns `Err` for unknown
/// formats so the caller can surface a useful error rather than silently
/// lying about the texture layout.
#[cfg(target_os = "windows")]
fn dxgi_format_to_pixel_format(format: u32) -> std::result::Result<&'static str, String> {
    // DXGI_FORMAT values:
    //   87 = DXGI_FORMAT_B8G8R8A8_UNORM
    //   28 = DXGI_FORMAT_R8G8B8A8_UNORM
    //   10 = DXGI_FORMAT_R16G16B16A16_FLOAT
    match format {
        87 => Ok("bgra"),
        28 => Ok("rgba"),
        10 => Ok("rgbaf16"),
        other => Err(format!(
            "Unsupported DXGI_FORMAT for shared texture: {other}"
        )),
    }
}

/// Release a native shared texture handle (NT HANDLE on Windows, IOSurfaceRef
/// on macOS) that was minted by receiveSharedTexture() but never consumed by
/// Electron's importSharedTexture. Buffer must be 8 bytes LE.
#[napi]
pub fn close_native_handle(handle: napi::bindgen_prelude::Buffer) -> Result<()> {
    if handle.len() != 8 {
        return Err(Error::from_reason(format!(
            "close_native_handle: expected 8-byte buffer, got {}",
            handle.len()
        )));
    }
    let bytes: [u8; 8] = handle[..8]
        .try_into()
        .map_err(|_| Error::from_reason("Failed to read 8-byte handle buffer"))?;
    let raw = u64::from_le_bytes(bytes);

    #[cfg(target_os = "windows")]
    {
        win::close_shared_handle(raw).map_err(|e| Error::from_reason(e))?;
    }

    #[cfg(target_os = "macos")]
    {
        mac::close_shared_iosurface(raw).map_err(|e| Error::from_reason(e))?;
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = raw;
        return Err(Error::from_reason(
            "close_native_handle is not supported on this platform",
        ));
    }

    Ok(())
}

// ============================================================
// JS API: PreviewView
//
//   const view = new PreviewView(win.getNativeWindowHandle(), "SenderName")
//   // macOS: new PreviewView(handle, "SenderName", { serverUuid })
//   view.setBounds(x, y, width, height)  // physical px in the parent client area
//   view.setVisible(true)
//   view.setBackground(32, 32, 32)
//   view.getStats()  // { presentFps, receivedFps, repeatedFps, framesSkipped, ... }
//   view.destroy()
//
// ============================================================

#[cfg(target_os = "macos")]
use mac::preview::PreviewView as PreviewInner;
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
use preview_unsupported::PreviewView as PreviewInner;
#[cfg(target_os = "windows")]
use win::preview::PreviewView as PreviewInner;

/// Optional `PreviewView` constructor settings. Every field is macOS-only
/// and ignored on Windows (a Spout sender is found by name alone).
#[napi(object)]
#[derive(Default)]
pub struct PreviewViewOptions {
    /// Syphon server UUID (`listSenders()[].uuid`); takes priority over the
    /// name, like `TextureReceiver`'s `serverUuid`.
    pub server_uuid: Option<String>,
    /// Syphon application name filter, used with the sender name.
    pub app_name: Option<String>,
    /// Draw the Syphon texture's first row at the bottom (Syphon's
    /// bottom-left origin). Default true, matching `TextureReceiver`'s
    /// default receive-side flip.
    pub flip_y: Option<bool>,
}

#[cfg(target_os = "macos")]
fn create_preview_inner(
    parent: usize,
    sender_name: String,
    options: PreviewViewOptions,
) -> std::result::Result<PreviewInner, String> {
    PreviewInner::new(
        parent,
        mac::preview::SyphonSource {
            name: sender_name,
            server_uuid: options.server_uuid,
            app_name: options.app_name,
            flip_y: options.flip_y.unwrap_or(true),
        },
    )
}

#[cfg(not(target_os = "macos"))]
fn create_preview_inner(
    parent: usize,
    sender_name: String,
    _options: PreviewViewOptions,
) -> std::result::Result<PreviewInner, String> {
    PreviewInner::new(parent, &sender_name)
}

/// napi-rs object returned from `PreviewView.getStats()`. Per-second figures
/// cover a sliding window of about 1 s; totals run since the view was created.
#[napi(object)]
pub struct PreviewStats {
    /// Swapchain presents (one per display refresh while visible), total.
    pub presented: i64,
    /// New sender frames copied and drawn, total. Same as `received`; kept
    /// for compatibility.
    pub frames_drawn: i64,
    /// New sender frames copied, total.
    pub received: i64,
    /// Sender frames that were never shown (gaps in the sender's frame
    /// counter), total. Always 0 for senders that do not count frames.
    pub frames_skipped: i64,
    /// Presents in the last second.
    pub present_fps: f64,
    /// New sender frames copied in the last second.
    pub received_fps: f64,
    /// Presents in the last second that showed the previous frame again
    /// because no new frame had arrived.
    pub repeated_fps: f64,
    /// Average time between consecutive presents in the last second (ms);
    /// 0 with fewer than two presents.
    pub present_interval_avg_ms: f64,
    /// Longest time between consecutive presents in the last second (ms).
    pub present_interval_max_ms: f64,
    /// Swapchain (macOS: CAMetalLayer drawable) size in physical pixels
    /// (0 until it exists).
    pub swapchain_width: u32,
    pub swapchain_height: u32,
    /// Size of the sender frame being drawn (0 while not connected).
    pub frame_width: u32,
    pub frame_height: u32,
    /// GPU rendering the view: DXGI adapter description / MTLDevice name
    /// ("" until known).
    pub adapter_name: String,
    /// Whether presents wait for vertical blank (Windows: sync interval > 0;
    /// macOS: CAMetalLayer.displaySyncEnabled).
    pub vsync: bool,
    /// Whether the sender was published at the last poll.
    pub connected: bool,
    /// Refresh rate of the monitor the view is on (Hz); 0 when unknown.
    pub monitor_refresh_hz: u32,
    /// Sender polls per second (last 1 s) that found the sender holding the
    /// texture; the previous frame is shown again instead of waiting.
    pub sender_busy_fps: f64,
    /// Render-loop stage times over the last 1 s (ms): waiting for the
    /// swapchain, polling + copying the sender frame, draw + Present.
    pub wait_avg_ms: f64,
    pub receive_avg_ms: f64,
    pub receive_max_ms: f64,
    pub present_call_avg_ms: f64,
    /// Tearing presents are available for vsync off (Windows).
    pub tearing_supported: bool,
}

impl From<preview_stats::PreviewStatsSnapshot> for PreviewStats {
    fn from(s: preview_stats::PreviewStatsSnapshot) -> Self {
        let w = s.windowed;
        Self {
            presented: w.presented as i64,
            frames_drawn: w.received as i64,
            received: w.received as i64,
            frames_skipped: w.skipped as i64,
            present_fps: w.present_fps,
            received_fps: w.received_fps,
            repeated_fps: w.repeated_fps,
            present_interval_avg_ms: w.present_interval_avg_ms,
            present_interval_max_ms: w.present_interval_max_ms,
            swapchain_width: s.swapchain_width,
            swapchain_height: s.swapchain_height,
            frame_width: s.frame_width,
            frame_height: s.frame_height,
            adapter_name: s.adapter_name,
            monitor_refresh_hz: s.monitor_refresh_hz,
            sender_busy_fps: w.busy_fps,
            wait_avg_ms: w.wait_avg_ms,
            receive_avg_ms: w.receive_avg_ms,
            receive_max_ms: w.receive_max_ms,
            present_call_avg_ms: w.present_call_avg_ms,
            tearing_supported: s.tearing_supported,
            vsync: s.vsync,
            connected: s.connected,
        }
    }
}

/// A native child view inside a parent window that draws the newest frame of
/// a sender on a solid background, paced by the display's vsync.
/// Windows (child HWND, D3D11) and macOS (child NSView, Metal); the
/// constructor throws elsewhere.
#[napi]
pub struct PreviewView {
    inner: Option<PreviewInner>,
}

#[napi]
impl PreviewView {
    /// Create a hidden preview view.
    ///
    /// - `parentHandle`: native window handle of the parent, e.g. Electron's
    ///   `BrowserWindow.getNativeWindowHandle()` (Windows: HWND; macOS: the
    ///   content `NSView*`; 8 or 4 bytes LE)
    /// - `senderName`: Spout sender / Syphon server name to show
    /// - `options`: macOS-only Syphon settings (see `PreviewViewOptions`)
    ///
    /// Must be called on the thread that owns the parent window (Electron's
    /// main process thread).
    #[napi(constructor)]
    pub fn new(
        parent_handle: napi::bindgen_prelude::Buffer,
        sender_name: String,
        options: Option<PreviewViewOptions>,
    ) -> Result<Self> {
        let parent = preview_layout::parse_parent_handle(parent_handle.as_ref())
            .map_err(|e| Error::from_reason(e))?;
        let inner = create_preview_inner(parent, sender_name, options.unwrap_or_default())
            .map_err(|e| Error::from_reason(e))?;
        Ok(Self { inner: Some(inner) })
    }

    /// Position and size in physical pixels of the parent's client area.
    /// A zero (or negative) width or height hides the view.
    #[napi]
    pub fn set_bounds(&mut self, x: i32, y: i32, width: i32, height: i32) -> Result<()> {
        let bounds = preview_layout::normalize_bounds(x, y, width, height);
        self.inner_mut()?.set_bounds(bounds);
        Ok(())
    }

    /// Show or hide the view. It is shown only once it also has a size.
    #[napi]
    pub fn set_visible(&mut self, visible: bool) -> Result<()> {
        self.inner_mut()?.set_visible(visible);
        Ok(())
    }

    /// Present on vsync (true), or when a new frame arrives (false, the
    /// default: sync interval 0, tearing when supported, at most once per
    /// monitor refresh). Applies at once. Windows: a child window's vsync
    /// presents were held near 60 on a 165 Hz monitor, so frames were missed.
    #[napi]
    pub fn set_vsync(&mut self, vsync: bool) -> Result<()> {
        self.inner_mut()?.set_vsync(vsync);
        Ok(())
    }

    /// Background colour behind the frame, 0–255 per channel.
    #[napi]
    pub fn set_background(&mut self, r: f64, g: f64, b: f64) -> Result<()> {
        self.inner_mut()?
            .set_background(preview_layout::clear_color(r, g, b));
        Ok(())
    }

    /// Debug statistics (see `PreviewStats`). Returns zeros once destroyed.
    #[napi]
    pub fn get_stats(&self) -> PreviewStats {
        self.inner
            .as_ref()
            .map(|v| v.stats())
            .unwrap_or_default()
            .into()
    }

    /// Stop rendering and destroy the native view. Repeated calls are safe.
    #[napi]
    pub fn destroy(&mut self) -> Result<()> {
        if let Some(mut inner) = self.inner.take() {
            inner.destroy();
        }
        Ok(())
    }

    fn inner_mut(&mut self) -> Result<&mut PreviewInner> {
        self.inner
            .as_mut()
            .ok_or_else(|| Error::from_reason("PreviewView has been destroyed"))
    }
}

/// List all available texture senders (Syphon servers / Spout senders).
#[napi]
pub fn list_senders() -> Result<Vec<JsSenderInfo>> {
    #[cfg(target_os = "macos")]
    let json = mac::receiver::list_servers_json().map_err(|e| Error::from_reason(e))?;

    #[cfg(target_os = "windows")]
    let json = win::receiver::list_senders_json().map_err(|e| Error::from_reason(e))?;

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let json = "[]".to_string();

    let infos = parse_senders_json(&json).map_err(|e| Error::from_reason(e))?;

    Ok(infos
        .into_iter()
        .map(|info| JsSenderInfo {
            name: info.name,
            app_name: info.app_name,
            uuid: info.uuid,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Disposal lifecycle tests ----
    //
    // Note: TextureSender and TextureReceiver types link platform-specific C++
    // bridge code (Syphon/Spout). Constructing instances in pure Rust tests
    // pulls in C++ runtime symbols that are unavailable in the test binary
    // linker context. The full lifecycle (stop → error on use, idempotent stop)
    // is tested at the integration level via TypeScript tests in the core and
    // renderer packages.
    //
    // The compile-time contract is enforced by the Option<Inner> pattern:
    // - `stop()` calls `self.inner.take()` → deterministic drop
    // - Operational methods call `self.inner.as_mut().ok_or_else(...)` → error after stop
    // - Read-only methods call `self.inner.as_ref().map_or(default, ...)` → safe defaults

    // ---- parse_senders_json tests ----

    #[test]
    fn parse_senders_json_valid_array() {
        let json = r#"[{"name":"VJ","appName":"Resolume","uuid":"abc-123"}]"#;
        let result = parse_senders_json(json).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "VJ");
        assert_eq!(result[0].app_name, Some("Resolume".to_string()));
        assert_eq!(result[0].uuid, Some("abc-123".to_string()));
    }

    #[test]
    fn parse_senders_json_multiple_senders() {
        let json = r#"[{"name":"A","appName":"App1","uuid":"1"},{"name":"B"}]"#;
        let result = parse_senders_json(json).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].name, "A");
        assert_eq!(result[1].name, "B");
        assert_eq!(result[1].app_name, None);
        assert_eq!(result[1].uuid, None);
    }

    #[test]
    fn parse_senders_json_empty_array() {
        let json = "[]";
        let result = parse_senders_json(json).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn parse_senders_json_invalid_json() {
        let json = "not valid json";
        let result = parse_senders_json(json);
        assert!(result.is_err());
    }

    #[test]
    fn parse_senders_json_missing_name() {
        let json = r#"[{"appName":"App"}]"#;
        let result = parse_senders_json(json);
        assert!(result.is_err());
    }

    #[test]
    fn sender_info_to_js_sender_info_conversion() {
        let info = SenderInfo {
            name: "Test".to_string(),
            app_name: Some("App".to_string()),
            uuid: None,
        };
        let js_info = JsSenderInfo {
            name: info.name.clone(),
            app_name: info.app_name.clone(),
            uuid: info.uuid.clone(),
        };
        assert_eq!(js_info.name, "Test");
        assert_eq!(js_info.app_name, Some("App".to_string()));
        assert_eq!(js_info.uuid, None);
    }

    #[test]
    fn parse_senders_json_with_special_characters_in_name() {
        let json = r#"[{"name":"My \"VJ\" App"}]"#;
        let result = parse_senders_json(json).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, r#"My "VJ" App"#);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn dxgi_format_bgra_maps_to_bgra_string() {
        assert_eq!(dxgi_format_to_pixel_format(87).unwrap(), "bgra");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn dxgi_format_rgba_maps_to_rgba_string() {
        assert_eq!(dxgi_format_to_pixel_format(28).unwrap(), "rgba");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn dxgi_format_rgba16f_maps_to_rgbaf16_string() {
        assert_eq!(dxgi_format_to_pixel_format(10).unwrap(), "rgbaf16");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn dxgi_format_unknown_returns_error() {
        assert!(dxgi_format_to_pixel_format(0).is_err());
        assert!(dxgi_format_to_pixel_format(999).is_err());
    }

    #[test]
    fn parse_senders_json_with_null_fields() {
        let json = r#"[{"name":"VJ","appName":null,"uuid":null}]"#;
        let result = parse_senders_json(json).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "VJ");
        assert_eq!(result[0].app_name, None);
        assert_eq!(result[0].uuid, None);
    }
}
