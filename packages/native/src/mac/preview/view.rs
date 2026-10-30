// The child NSView (CAMetalLayer) inside Electron's content view.
//
// Every AppKit call goes through `NativeView`, which lives on the JS
// (main) thread; the render thread only gets a `RawView` for the
// thread-safe calls (vsync wait, device).

use super::ffi;
use crate::preview_layout::{physical_to_view_frame, sanitize_scale, Bounds};
use std::ffi::{c_char, c_void};

const MESSAGE_LEN: usize = 256;

pub struct NativeView {
    handle: ffi::PreviewNativeViewHandle,
}

impl NativeView {
    /// Create a hidden child of `parent` (a raw `NSView*`). Main thread only.
    pub fn create(parent: usize) -> Result<Self, String> {
        let mut error = [0 as c_char; MESSAGE_LEN];
        let handle = unsafe {
            ffi::preview_view_create(
                parent as *mut c_void,
                error.as_mut_ptr(),
                MESSAGE_LEN as u32,
            )
        };
        if handle.is_null() {
            let message = c_message(&error);
            return Err(if message.is_empty() {
                "Failed to create the PreviewView NSView".into()
            } else {
                message
            });
        }
        Ok(Self { handle })
    }

    pub fn raw(&self) -> RawView {
        RawView(self.handle as usize)
    }

    /// Place the view at `bounds` (physical px from the top-left of the
    /// parent's content) and size its drawable to match.
    pub fn set_bounds(&self, bounds: Bounds) {
        let (mut scale, mut parent_height, mut flipped) = (1.0f64, 0.0f64, 0i32);
        let ok = unsafe {
            ffi::preview_view_parent_geometry(
                self.handle,
                &mut scale,
                &mut parent_height,
                &mut flipped,
            )
        };
        if ok != 0 {
            eprintln!("[PreviewView] parent view is gone; bounds ignored");
            return;
        }
        let frame = physical_to_view_frame(bounds, scale, parent_height, flipped != 0);
        unsafe {
            ffi::preview_view_set_frame(
                self.handle,
                frame.x,
                frame.y,
                frame.width,
                frame.height,
                sanitize_scale(scale),
                bounds.width,
                bounds.height,
            )
        };
    }

    pub fn set_shown(&self, shown: bool) {
        unsafe { ffi::preview_view_set_hidden(self.handle, i32::from(!shown)) };
    }

    pub fn adapter_name(&self) -> String {
        let mut name = [0 as c_char; MESSAGE_LEN];
        unsafe {
            ffi::preview_view_adapter_name(self.handle, name.as_mut_ptr(), MESSAGE_LEN as u32)
        };
        c_message(&name)
    }

    pub fn vsync_enabled(&self) -> bool {
        unsafe { ffi::preview_view_vsync_enabled(self.handle) != 0 }
    }

    pub fn display_link_name(&self) -> &'static str {
        match unsafe { ffi::preview_view_display_link_kind(self.handle) } {
            ffi::PREVIEW_DISPLAY_LINK_CA => "CADisplayLink",
            ffi::PREVIEW_DISPLAY_LINK_CV => "CVDisplayLink",
            _ => "none",
        }
    }
}

impl Drop for NativeView {
    fn drop(&mut self) {
        // Main thread; the render thread has already stopped (PreviewView::destroy).
        unsafe { ffi::preview_view_destroy(self.handle) };
    }
}

/// The view handle for the render thread. Valid until the owning
/// `NativeView` drops, which happens only after the render thread joined.
#[derive(Clone, Copy)]
pub struct RawView(usize);

impl RawView {
    pub fn handle(self) -> ffi::PreviewNativeViewHandle {
        self.0 as ffi::PreviewNativeViewHandle
    }

    /// Block until the next display refresh or `timeout_ms`.
    pub fn wait_vsync(self, timeout_ms: u32) -> bool {
        unsafe { ffi::preview_view_wait_vsync(self.handle(), timeout_ms) != 0 }
    }

    /// Unretained `id<MTLDevice>` of the view.
    pub fn device(self) -> *mut c_void {
        unsafe { ffi::preview_view_device(self.handle()) }
    }
}

/// A NUL-terminated C string written into `buffer` (cut at the end if none).
fn c_message(buffer: &[c_char]) -> String {
    let bytes: Vec<u8> = buffer
        .iter()
        .take_while(|&&c| c != 0)
        .map(|&c| c as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}
