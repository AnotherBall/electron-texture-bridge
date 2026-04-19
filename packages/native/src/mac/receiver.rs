use super::ffi;
use std::ffi::CString;

pub struct Receiver {
    handle: Option<ffi::SyphonReceiverHandle>,
}

/// Metadata + raw IOSurfaceRef pointer for a Syphon frame received as a shared
/// GPU texture.
///
/// `iosurface_ptr` is CFRetained. Ownership transfers to the caller: either
/// pass to Electron's `importSharedTexture` (which CFReleases on release) or
/// manually `CFRelease` it to avoid leaking.
pub struct SharedIoSurfaceInfo {
    pub iosurface_ptr: u64,
    pub width: u32,
    pub height: u32,
    /// 0 = bgra, 1 = rgba, 2 = rgbaf16. See [`pixel_format_string`].
    pub pixel_format_code: u32,
}

impl SharedIoSurfaceInfo {
    /// Convert the numeric code to an Electron-compatible pixel format string.
    pub fn pixel_format_string(&self) -> String {
        match self.pixel_format_code {
            1 => "rgba".to_string(),
            2 => "rgbaf16".to_string(),
            _ => "bgra".to_string(),
        }
    }
}

unsafe impl Send for Receiver {}

impl Receiver {
    pub fn new(
        server_uuid: Option<&str>,
        server_name: Option<&str>,
        app_name: Option<&str>,
    ) -> Result<Self, String> {
        let c_uuid = server_uuid
            .map(|s| CString::new(s).map_err(|e| e.to_string()))
            .transpose()?;
        let c_name = server_name
            .map(|s| CString::new(s).map_err(|e| e.to_string()))
            .transpose()?;
        let c_app = app_name
            .map(|s| CString::new(s).map_err(|e| e.to_string()))
            .transpose()?;

        let handle = unsafe {
            ffi::syphon_receiver_create(
                c_uuid.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
                c_name.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
                c_app.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
            )
        };

        if handle.is_null() {
            return Err("Failed to create Syphon receiver (no matching server?)".into());
        }

        Ok(Self {
            handle: Some(handle),
        })
    }

    pub fn destroy(&mut self) {
        if let Some(h) = self.handle.take() {
            unsafe {
                ffi::syphon_receiver_destroy(h);
            }
        }
    }

    pub fn has_new_frame(&self) -> bool {
        match self.handle {
            Some(h) => unsafe { ffi::syphon_receiver_has_new_frame(h) != 0 },
            None => false,
        }
    }

    pub fn receive_rgba(&self) -> Result<Option<(Vec<u8>, u32, u32)>, String> {
        let handle = match self.handle {
            Some(h) => h,
            None => return Ok(None),
        };

        let mut width: u32 = 0;
        let mut height: u32 = 0;

        // Use cached dimensions to pre-allocate, or default to 1080p on first call.
        let cached_w = self.width() as usize;
        let cached_h = self.height() as usize;
        let alloc_size = if cached_w > 0 && cached_h > 0 {
            cached_w * cached_h * 4
        } else {
            // First call: no cached dimensions yet. Allocate 1080p as default.
            1920 * 1080 * 4
        };
        let mut buffer: Vec<u8> = vec![0u8; alloc_size];

        let ret = unsafe {
            ffi::syphon_receiver_receive_rgba(
                handle,
                buffer.as_mut_ptr(),
                alloc_size as u32,
                &mut width,
                &mut height,
            )
        };

        // C API return codes:
        //  0 = frame received
        //  1 = no new frame (poll again)
        //  2 = buffer too small — dimensions updated, next poll will allocate correctly
        // -1 = not connected (sender disconnected or never appeared)
        match ret {
            0 => {
                let actual_size = (width as usize) * (height as usize) * 4;
                buffer.truncate(actual_size);
                Ok(Some((buffer, width, height)))
            }
            1 | 2 => Ok(None), // No new frame or buffer too small — next poll uses updated dimensions
            -1 => Err(
                "Shared texture receiver is not connected (sender disconnected or never appeared)"
                    .into(),
            ),
            _ => Ok(None),
        }
    }

    /// Receive the current frame as an IOSurfaceRef (zero-copy for GPU consumers).
    ///
    /// Returns `Ok(Some(info))` on success. The caller owns `info.iosurface_ptr`
    /// and must either pass it to Electron's `importSharedTexture` or `CFRelease`
    /// it directly.
    pub fn receive_shared_iosurface(&mut self) -> Result<Option<SharedIoSurfaceInfo>, String> {
        let handle = match self.handle {
            Some(h) => h,
            None => return Ok(None),
        };

        let mut iosurface: *mut std::ffi::c_void = std::ptr::null_mut();
        let mut width: u32 = 0;
        let mut height: u32 = 0;
        let mut pixel_format: u32 = 0;

        let ret = unsafe {
            ffi::syphon_receiver_receive_shared_iosurface(
                handle,
                &mut iosurface,
                &mut width,
                &mut height,
                &mut pixel_format,
            )
        };

        match ret {
            0 => Ok(Some(SharedIoSurfaceInfo {
                iosurface_ptr: iosurface as u64,
                width,
                height,
                pixel_format_code: pixel_format,
            })),
            1 => Ok(None),
            -1 => Err(
                "Shared texture receiver is not connected (sender disconnected or never appeared)"
                    .into(),
            ),
            -2 => Err("Syphon texture is not IOSurface-backed".into()),
            _ => Ok(None),
        }
    }

    pub fn is_valid(&self) -> bool {
        match self.handle {
            Some(h) => unsafe { ffi::syphon_receiver_is_valid(h) != 0 },
            None => false,
        }
    }

    pub fn width(&self) -> u32 {
        match self.handle {
            Some(h) => unsafe { ffi::syphon_receiver_get_width(h) },
            None => 0,
        }
    }

    pub fn height(&self) -> u32 {
        match self.handle {
            Some(h) => unsafe { ffi::syphon_receiver_get_height(h) },
            None => 0,
        }
    }
}

impl Drop for Receiver {
    fn drop(&mut self) {
        self.destroy();
    }
}

/// List available Syphon servers as a JSON string.
pub fn list_servers_json() -> Result<String, String> {
    unsafe {
        let ptr = ffi::syphon_discovery_list_servers();
        if ptr.is_null() {
            return Err("Failed to list Syphon servers".into());
        }
        // Always free the C string, even if UTF-8 conversion fails
        let result = std::ffi::CStr::from_ptr(ptr)
            .to_str()
            .map(|s| s.to_string())
            .map_err(|e| e.to_string());
        ffi::syphon_discovery_free_string(ptr);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- SharedIoSurfaceInfo::pixel_format_string ----

    #[test]
    fn pixel_format_string_bgra_for_code_0() {
        let info = SharedIoSurfaceInfo {
            iosurface_ptr: 0,
            width: 0,
            height: 0,
            pixel_format_code: 0,
        };
        assert_eq!(info.pixel_format_string(), "bgra");
    }

    #[test]
    fn pixel_format_string_rgba_for_code_1() {
        let info = SharedIoSurfaceInfo {
            iosurface_ptr: 0,
            width: 0,
            height: 0,
            pixel_format_code: 1,
        };
        assert_eq!(info.pixel_format_string(), "rgba");
    }

    #[test]
    fn pixel_format_string_rgbaf16_for_code_2() {
        let info = SharedIoSurfaceInfo {
            iosurface_ptr: 0,
            width: 0,
            height: 0,
            pixel_format_code: 2,
        };
        assert_eq!(info.pixel_format_string(), "rgbaf16");
    }

    #[test]
    fn pixel_format_string_unknown_defaults_to_bgra() {
        let info = SharedIoSurfaceInfo {
            iosurface_ptr: 0,
            width: 0,
            height: 0,
            pixel_format_code: 99,
        };
        assert_eq!(info.pixel_format_string(), "bgra");
    }

    // ---- Pixel format utility tests ----

    #[test]
    fn convert_bgra_to_rgba_single_pixel() {
        let bgra: [u8; 4] = [10, 20, 30, 255]; // B=10, G=20, R=30, A=255
        let mut rgba = [0u8; 4];
        unsafe { ffi::syphon_convert_bgra_to_rgba(bgra.as_ptr(), rgba.as_mut_ptr(), 1) };
        assert_eq!(rgba, [30, 20, 10, 255]); // R=30, G=20, B=10, A=255
    }

    #[test]
    fn convert_bgra_to_rgba_multiple_pixels() {
        let bgra: [u8; 12] = [
            0, 128, 255, 200, // pixel 0: B=0, G=128, R=255, A=200
            50, 100, 150, 0,  // pixel 1: B=50, G=100, R=150, A=0
            1, 2, 3, 4,       // pixel 2: B=1, G=2, R=3, A=4
        ];
        let mut rgba = [0u8; 12];
        unsafe { ffi::syphon_convert_bgra_to_rgba(bgra.as_ptr(), rgba.as_mut_ptr(), 3) };
        assert_eq!(
            rgba,
            [
                255, 128, 0, 200,  // R=255, G=128, B=0, A=200
                150, 100, 50, 0,   // R=150, G=100, B=50, A=0
                3, 2, 1, 4,        // R=3, G=2, B=1, A=4
            ]
        );
    }

    #[test]
    fn convert_bgra_to_rgba_zero_pixels() {
        let bgra: [u8; 0] = [];
        let mut rgba: [u8; 0] = [];
        // Should not crash
        unsafe { ffi::syphon_convert_bgra_to_rgba(bgra.as_ptr(), rgba.as_mut_ptr(), 0) };
    }

    #[test]
    fn convert_bgra_to_rgba_in_place() {
        let mut data: [u8; 8] = [
            10, 20, 30, 40,  // pixel 0: B=10, G=20, R=30, A=40
            50, 60, 70, 80,  // pixel 1: B=50, G=60, R=70, A=80
        ];
        unsafe {
            ffi::syphon_convert_bgra_to_rgba(data.as_ptr(), data.as_mut_ptr(), 2);
        }
        assert_eq!(data, [30, 20, 10, 40, 70, 60, 50, 80]);
    }

    #[test]
    fn convert_bgra_to_rgba_preserves_alpha() {
        // Test with fully transparent and fully opaque
        let bgra: [u8; 8] = [
            100, 100, 100, 0,    // fully transparent
            100, 100, 100, 255,  // fully opaque
        ];
        let mut rgba = [0u8; 8];
        unsafe { ffi::syphon_convert_bgra_to_rgba(bgra.as_ptr(), rgba.as_mut_ptr(), 2) };
        assert_eq!(rgba[3], 0);   // alpha preserved as 0
        assert_eq!(rgba[7], 255); // alpha preserved as 255
    }

    // OSType FourCC values used in IOSurface
    const FOURCC_BGRA: u32 = u32::from_be_bytes(*b"BGRA");
    const FOURCC_RGBA: u32 = u32::from_be_bytes(*b"RGBA");

    #[test]
    fn map_pixel_format_bgra_to_metal_bgra() {
        let result = unsafe { ffi::syphon_map_pixel_format(FOURCC_BGRA) };
        assert_eq!(result, 80); // MTLPixelFormatBGRA8Unorm
    }

    #[test]
    fn map_pixel_format_rgba_to_metal_rgba() {
        let result = unsafe { ffi::syphon_map_pixel_format(FOURCC_RGBA) };
        assert_eq!(result, 70); // MTLPixelFormatRGBA8Unorm
    }

    #[test]
    fn map_pixel_format_unknown_defaults_to_bgra() {
        let result = unsafe { ffi::syphon_map_pixel_format(0x12345678) };
        assert_eq!(result, 80); // MTLPixelFormatBGRA8Unorm (safe default)
    }

    #[test]
    fn map_pixel_format_zero_defaults_to_bgra() {
        let result = unsafe { ffi::syphon_map_pixel_format(0) };
        assert_eq!(result, 80); // MTLPixelFormatBGRA8Unorm
    }

    #[test]
    fn convert_bgra_to_rgba_roundtrip() {
        // BGRA→RGBA→BGRA should give back the original
        let original: [u8; 8] = [10, 20, 30, 40, 50, 60, 70, 80];
        let mut intermediate = [0u8; 8];
        let mut roundtrip = [0u8; 8];
        unsafe {
            ffi::syphon_convert_bgra_to_rgba(original.as_ptr(), intermediate.as_mut_ptr(), 2);
            // Apply again: RGBA→BGRA (same swap operation)
            ffi::syphon_convert_bgra_to_rgba(intermediate.as_ptr(), roundtrip.as_mut_ptr(), 2);
        }
        assert_eq!(roundtrip, original);
    }
}
