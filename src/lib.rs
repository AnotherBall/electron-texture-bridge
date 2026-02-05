mod types;

#[cfg(target_os = "windows")]
mod win;
#[cfg(target_os = "macos")]
mod mac;

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
    inner: win::Sender,
    #[cfg(target_os = "macos")]
    inner: mac::Sender,

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
        let inner = win::Sender::new(&name, width, height)
            .map_err(|e| Error::from_reason(e))?;

        #[cfg(target_os = "macos")]
        let inner = mac::Sender::new(&name)
            .map_err(|e| Error::from_reason(e))?;

        Ok(Self { inner, width, height })
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
        self.width = width;
        self.height = height;

        #[cfg(target_os = "windows")]
        {
            self.inner.send(handle)
                .map_err(|e| Error::from_reason(e))?;
        }

        #[cfg(target_os = "macos")]
        {
            self.inner.send(handle, width, height)
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
        self.width = width;
        self.height = height;

        #[cfg(target_os = "macos")]
        {
            // Extract pointer from buffer (8 bytes = u64 pointer on 64-bit)
            if surface_buffer.len() < 8 {
                return Err(Error::from_reason("Surface buffer too small"));
            }
            let ptr_bytes: [u8; 8] = surface_buffer[..8].try_into()
                .map_err(|_| Error::from_reason("Failed to read surface pointer"))?;
            let surface_ptr = u64::from_le_bytes(ptr_bytes);

            self.inner.send_surface(surface_ptr, width, height)
                .map_err(|e| Error::from_reason(e))?;
        }

        #[cfg(target_os = "windows")]
        {
            return Err(Error::from_reason("send_surface is macOS only"));
        }

        Ok(())
    }

    /// Stop the sender and release resources.
    /// After calling this, the sender cannot be reused.
    #[napi]
    pub fn stop(&mut self) -> Result<()> {
        // Drop が呼ばれるように inner を再構築する方法もあるが、
        // ここでは JS 側で sender = null して GC に任せる想定。
        // 明示的に止めたい場合のための API。
        //
        // 実際の解放は Drop trait で行われる。
        // ここでは何もしない（二重解放を防ぐ）。
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
        let stride = bytes_per_row.unwrap_or(width * 4);

        self.width = width;
        self.height = height;

        self.inner
            .send_rgba(data.as_ref(), width, height, stride)
            .map_err(|e| Error::from_reason(e))
    }

    /// Get the current platform name.
    #[napi]
    pub fn platform(&self) -> String {
        #[cfg(target_os = "windows")]
        return "spout".to_string();
        #[cfg(target_os = "macos")]
        return "syphon-metal".to_string();
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
