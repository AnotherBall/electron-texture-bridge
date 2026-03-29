use super::ffi;
use std::ffi::CString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

pub struct Receiver {
    handle: Option<ffi::SpoutReceiverHandle>,
    buffer: Vec<u8>,
    sender_name: String,
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

unsafe impl Send for Receiver {}

impl Receiver {
    pub fn new(sender_name: &str) -> Result<Self, String> {
        let c_name = CString::new(sender_name).map_err(|e| e.to_string())?;
        let handle = unsafe { ffi::spout_receiver_create(c_name.as_ptr()) };
        if handle.is_null() {
            return Err("Failed to create Spout receiver".into());
        }
        Ok(Self {
            handle: Some(handle),
            buffer: Vec::new(),
            sender_name: sender_name.to_string(),
        })
    }

    pub fn sender_name(&self) -> &str {
        &self.sender_name
    }

    pub fn destroy(&mut self) {
        if let Some(h) = self.handle.take() {
            unsafe {
                ffi::spout_receiver_destroy(h);
            }
        }
    }

    pub fn has_new_frame(&self) -> bool {
        match self.handle {
            Some(h) => unsafe { ffi::spout_receiver_has_new_frame(h) != 0 },
            None => false,
        }
    }

    pub fn receive_rgba(&mut self) -> Result<Option<(Vec<u8>, u32, u32)>, String> {
        let handle = match self.handle {
            Some(h) => h,
            None => return Ok(None),
        };

        let mut width: u32 = 0;
        let mut height: u32 = 0;

        // Ensure buffer matches current sender dimensions.
        // On first call (dimensions unknown), pass empty buffer — C++ handles nullptr.
        let cached_w = self.width() as usize;
        let cached_h = self.height() as usize;
        let required = cached_w * cached_h * 4;
        if self.buffer.len() != required {
            self.buffer.resize(required, 0);
        }

        let ret = unsafe {
            ffi::spout_receiver_receive_rgba(
                handle,
                self.buffer.as_mut_ptr(),
                self.buffer.len() as u32,
                &mut width,
                &mut height,
            )
        };

        // C API return codes:
        //  0 = frame received
        //  1 = no new frame (poll again)
        //  2 = dimensions changed (next poll will use updated size)
        // -1 = not connected
        match ret {
            0 => {
                let actual_size = (width as usize) * (height as usize) * 4;
                let frame = self.buffer[..actual_size].to_vec();
                Ok(Some((frame, width, height)))
            }
            1 | 2 => Ok(None),
            _ => Ok(None),
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

/// Start a listener thread that receives frames and delivers them via callback.
/// Creates its own SpoutReceiverBridge (and D3D11 device) on the listener thread
/// to avoid DirectX thread-affinity issues.
pub fn start_listening<F>(sender_name: &str, callback: F) -> Result<ReceiverListener, String>
where
    F: Fn(Vec<u8>, u32, u32) + Send + 'static,
{
    let c_name = CString::new(sender_name).map_err(|e| e.to_string())?;
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop = stop_flag.clone();

    let thread = thread::spawn(move || {
        let handle = unsafe { ffi::spout_receiver_create(c_name.as_ptr()) };
        if handle.is_null() {
            return;
        }

        let mut buffer: Vec<u8> = Vec::new();
        let mut cached_w: u32 = 0;
        let mut cached_h: u32 = 0;

        while !stop.load(Ordering::Acquire) {
            let mut out_w: u32 = 0;
            let mut out_h: u32 = 0;

            let required = (cached_w as usize) * (cached_h as usize) * 4;
            if buffer.len() != required {
                buffer.resize(required, 0);
            }

            let buf_ptr = if buffer.is_empty() {
                std::ptr::null_mut()
            } else {
                buffer.as_mut_ptr()
            };

            let ret = unsafe {
                ffi::spout_receiver_receive_rgba(
                    handle,
                    buf_ptr,
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
            ffi::spout_receiver_destroy(handle);
        }
    });

    Ok(ReceiverListener {
        stop_flag,
        thread: Some(thread),
    })
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
