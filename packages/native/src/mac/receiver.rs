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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// Runs the receiver polling loop on the current thread.
/// Extracted as a standalone function so it can be called from a spawned thread
/// without closure-capture Send issues with raw pointers.
fn listener_loop(
    handle: ffi::SyphonReceiverHandle,
    stop: Arc<AtomicBool>,
    callback: impl Fn(Vec<u8>, u32, u32),
) {
    let mut buffer: Vec<u8> = Vec::new();
    let mut cached_w: u32 = unsafe { ffi::syphon_receiver_get_width(handle) };
    let mut cached_h: u32 = unsafe { ffi::syphon_receiver_get_height(handle) };

    while !stop.load(Ordering::Acquire) {
        let mut out_w: u32 = 0;
        let mut out_h: u32 = 0;

        // Use cached dimensions, or default to 1080p on first call.
        let alloc_size = if cached_w > 0 && cached_h > 0 {
            (cached_w as usize) * (cached_h as usize) * 4
        } else {
            1920 * 1080 * 4
        };
        if buffer.len() != alloc_size {
            buffer.resize(alloc_size, 0);
        }

        let ret = unsafe {
            ffi::syphon_receiver_receive_rgba(
                handle,
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                &mut out_w,
                &mut out_h,
            )
        };

        match ret {
            0 => {
                let actual_size = (out_w as usize) * (out_h as usize) * 4;
                if actual_size <= buffer.len() {
                    let frame = buffer[..actual_size].to_vec();
                    callback(frame, out_w, out_h);
                }
            }
            2 => {
                cached_w = out_w;
                cached_h = out_h;
                continue;
            }
            1 => {
                thread::sleep(Duration::from_millis(1));
            }
            _ => {
                thread::sleep(Duration::from_millis(50));
            }
        }
    }

    unsafe {
        ffi::syphon_receiver_destroy(handle);
    }
}

pub struct ReceiverListener {
    stop_flag: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl ReceiverListener {
    pub fn stop_flag(&self) -> Arc<AtomicBool> {
        self.stop_flag.clone()
    }

    pub fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for ReceiverListener {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Start a listener thread that receives frames and delivers them via callback.
/// Creates the SyphonReceiverBridge on the calling thread (which must have an
/// active NSRunLoop for Syphon server discovery), then moves the handle to the
/// listener thread for polling.
pub fn start_listening<F>(
    server_uuid: Option<&str>,
    server_name: Option<&str>,
    app_name: Option<&str>,
    callback: F,
) -> Result<ReceiverListener, String>
where
    F: Fn(Vec<u8>, u32, u32) + Send + 'static,
{
    let c_uuid = server_uuid
        .map(|s| CString::new(s).map_err(|e| e.to_string()))
        .transpose()?;
    let c_name = server_name
        .map(|s| CString::new(s).map_err(|e| e.to_string()))
        .transpose()?;
    let c_app = app_name
        .map(|s| CString::new(s).map_err(|e| e.to_string()))
        .transpose()?;

    // Create the receiver on the calling thread (Electron's main thread has an
    // active NSRunLoop needed by SyphonServerDirectory for server discovery).
    let raw_handle = unsafe {
        ffi::syphon_receiver_create(
            c_uuid.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
            c_name.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
            c_app.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
        )
    };
    if raw_handle.is_null() {
        return Err("Failed to create Syphon receiver (no matching server?)".into());
    }

    let stop_flag = Arc::new(AtomicBool::new(false));

    // Cast the raw pointer to usize so it can cross thread boundaries safely.
    // Safety: The SyphonReceiverBridge has its own Metal device/queue and
    // SyphonMetalClient. Metal operations are thread-safe.
    let handle_addr = raw_handle as usize;
    let stop = stop_flag.clone();
    let thread = thread::spawn(move || {
        let handle = handle_addr as ffi::SyphonReceiverHandle;
        listener_loop(handle, stop, callback);
    });

    Ok(ReceiverListener {
        stop_flag,
        thread: Some(thread),
    })
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

    #[test]
    fn listener_stop_flag_initially_false() {
        let flag = Arc::new(AtomicBool::new(false));
        let listener = ReceiverListener {
            stop_flag: flag.clone(),
            thread: None,
        };
        assert!(!flag.load(Ordering::Acquire));
        drop(listener);
    }

    #[test]
    fn listener_stop_sets_flag_and_joins_thread() {
        let flag = Arc::new(AtomicBool::new(false));
        let flag_clone = flag.clone();

        let thread = thread::spawn(move || {
            while !flag_clone.load(Ordering::Acquire) {
                thread::sleep(Duration::from_millis(1));
            }
        });

        let mut listener = ReceiverListener {
            stop_flag: flag.clone(),
            thread: Some(thread),
        };

        assert!(!flag.load(Ordering::Acquire));
        listener.stop();
        assert!(flag.load(Ordering::Acquire));
        assert!(listener.thread.is_none());
    }

    #[test]
    fn listener_drop_stops_thread() {
        let flag = Arc::new(AtomicBool::new(false));
        let flag_clone = flag.clone();
        let flag_check = flag.clone();

        let thread = thread::spawn(move || {
            while !flag_clone.load(Ordering::Acquire) {
                thread::sleep(Duration::from_millis(1));
            }
        });

        let listener = ReceiverListener {
            stop_flag: flag,
            thread: Some(thread),
        };

        drop(listener);
        assert!(flag_check.load(Ordering::Acquire));
    }

    #[test]
    fn listener_double_stop_is_idempotent() {
        let flag = Arc::new(AtomicBool::new(false));
        let flag_clone = flag.clone();

        let thread = thread::spawn(move || {
            while !flag_clone.load(Ordering::Acquire) {
                thread::sleep(Duration::from_millis(1));
            }
        });

        let mut listener = ReceiverListener {
            stop_flag: flag,
            thread: Some(thread),
        };

        listener.stop();
        listener.stop(); // should not panic
    }

    #[test]
    fn listener_stop_flag_accessor_returns_shared_flag() {
        let flag = Arc::new(AtomicBool::new(false));
        let listener = ReceiverListener {
            stop_flag: flag.clone(),
            thread: None,
        };

        let shared = listener.stop_flag();
        shared.store(true, Ordering::Release);
        assert!(flag.load(Ordering::Acquire));
    }

    #[test]
    fn listener_callback_receives_frames_until_stopped() {
        let flag = Arc::new(AtomicBool::new(false));
        let stop = flag.clone();
        let count = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let count_clone = count.clone();

        let thread = thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                count_clone.fetch_add(1, Ordering::Relaxed);
                thread::sleep(Duration::from_millis(1));
            }
        });

        let mut listener = ReceiverListener {
            stop_flag: flag,
            thread: Some(thread),
        };

        thread::sleep(Duration::from_millis(20));
        listener.stop();

        let final_count = count.load(Ordering::Relaxed);
        assert!(
            final_count > 0,
            "callback should have been invoked at least once"
        );

        // After stop, count should not increase
        let after_stop = count.load(Ordering::Relaxed);
        thread::sleep(Duration::from_millis(10));
        assert_eq!(count.load(Ordering::Relaxed), after_stop);
    }

    #[test]
    fn start_listening_rejects_null_byte_in_name() {
        let result = start_listening(None, Some("bad\0name"), None, |_, _, _| {});
        assert!(result.is_err());
    }

    #[test]
    fn start_listening_rejects_null_byte_in_uuid() {
        let result = start_listening(Some("bad\0uuid"), None, None, |_, _, _| {});
        assert!(result.is_err());
    }

    #[test]
    fn start_listening_rejects_null_byte_in_app_name() {
        let result = start_listening(None, None, Some("bad\0app"), |_, _, _| {});
        assert!(result.is_err());
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
