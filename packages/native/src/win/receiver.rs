use super::ffi;
use std::ffi::CString;

pub struct Receiver {
    handle: Option<ffi::SpoutReceiverHandle>,
}

unsafe impl Send for Receiver {}

impl Receiver {
    pub fn new(sender_name: &str) -> Result<Self, String> {
        let c_name = CString::new(sender_name).map_err(|e| e.to_string())?;
        let handle = unsafe { ffi::spout_receiver_create(c_name.as_ptr()) };
        if handle.is_null() {
            return Err("Failed to create Spout receiver".into());
        }
        Ok(Self { handle: Some(handle) })
    }

    pub fn destroy(&mut self) {
        if let Some(h) = self.handle.take() {
            unsafe { ffi::spout_receiver_destroy(h); }
        }
    }

    pub fn has_new_frame(&self) -> bool {
        match self.handle {
            Some(h) => unsafe { ffi::spout_receiver_has_new_frame(h) != 0 },
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

        // Use cached dimensions to allocate the buffer.
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
            ffi::spout_receiver_receive_rgba(
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
        //  2 = buffer too small / dimensions changed (next poll will use updated size)
        // -1 = not connected
        // -2 = ReceiveImage failed
        match ret {
            0 => {
                let actual_size = (width as usize) * (height as usize) * 4;
                buffer.truncate(actual_size);
                Ok(Some((buffer, width, height)))
            }
            1 | 2 => Ok(None), // No new frame or dimensions changed — poll again
            _ => Ok(None),     // Not connected or error — don't throw, just return None
        }
    }

    pub fn is_connected(&self) -> bool {
        match self.handle {
            Some(h) => unsafe { ffi::spout_receiver_is_connected(h) != 0 },
            None => false,
        }
    }

    pub fn width(&self) -> u32 {
        match self.handle {
            Some(h) => unsafe { ffi::spout_receiver_get_width(h) },
            None => 0,
        }
    }

    pub fn height(&self) -> u32 {
        match self.handle {
            Some(h) => unsafe { ffi::spout_receiver_get_height(h) },
            None => 0,
        }
    }
}

impl Drop for Receiver {
    fn drop(&mut self) {
        self.destroy();
    }
}

/// List available Spout senders.
pub fn list_senders_json() -> Result<String, String> {
    unsafe {
        let ptr = ffi::spout_discovery_list_senders();
        if ptr.is_null() {
            return Err("Failed to list Spout senders".into());
        }
        // Always free the C string, even if UTF-8 conversion fails
        let result = std::ffi::CStr::from_ptr(ptr)
            .to_str()
            .map(|s| s.to_string())
            .map_err(|e| e.to_string());
        ffi::spout_discovery_free_string(ptr);
        result
    }
}
