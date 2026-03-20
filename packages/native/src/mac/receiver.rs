use super::ffi;
use std::ffi::CString;

pub struct Receiver {
    handle: Option<ffi::SyphonReceiverHandle>,
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

        Ok(Self { handle: Some(handle) })
    }

    pub fn destroy(&mut self) {
        if let Some(h) = self.handle.take() {
            unsafe { ffi::syphon_receiver_destroy(h); }
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
        // -1 = error (not connected, etc.)
        match ret {
            0 => {
                let actual_size = (width as usize) * (height as usize) * 4;
                buffer.truncate(actual_size);
                Ok(Some((buffer, width, height)))
            }
            1 | 2 => Ok(None), // No new frame or buffer too small — next poll uses updated dimensions
            _ => Ok(None),     // Error or not connected — return None
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
