// FFI declarations for cpp/mac/preview_view.mm (see preview_view.h).

use std::ffi::c_void;
use std::os::raw::c_char;

pub type PreviewNativeViewHandle = *mut c_void;
pub type PreviewRendererHandle = *mut c_void;

pub const PREVIEW_DISPLAY_LINK_CA: i32 = 1;
pub const PREVIEW_DISPLAY_LINK_CV: i32 = 2;

extern "C" {
    pub fn preview_view_create(
        parent_nsview: *mut c_void,
        error: *mut c_char,
        error_len: u32,
    ) -> PreviewNativeViewHandle;
    pub fn preview_view_destroy(view: PreviewNativeViewHandle);
    pub fn preview_view_parent_geometry(
        view: PreviewNativeViewHandle,
        out_scale: *mut f64,
        out_parent_height: *mut f64,
        out_parent_flipped: *mut i32,
    ) -> i32;
    #[allow(clippy::too_many_arguments)]
    pub fn preview_view_set_frame(
        view: PreviewNativeViewHandle,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        scale: f64,
        drawable_width: u32,
        drawable_height: u32,
    );
    pub fn preview_view_set_hidden(view: PreviewNativeViewHandle, hidden: i32);
    pub fn preview_view_display_link_kind(view: PreviewNativeViewHandle) -> i32;
    pub fn preview_view_wait_vsync(view: PreviewNativeViewHandle, timeout_ms: u32) -> i32;
    pub fn preview_view_device(view: PreviewNativeViewHandle) -> *mut c_void;
    pub fn preview_view_adapter_name(
        view: PreviewNativeViewHandle,
        out: *mut c_char,
        out_len: u32,
    ) -> u32;
    pub fn preview_view_vsync_enabled(view: PreviewNativeViewHandle) -> i32;

    pub fn preview_renderer_create(view: PreviewNativeViewHandle) -> PreviewRendererHandle;
    pub fn preview_renderer_destroy(renderer: PreviewRendererHandle);
    pub fn preview_renderer_draw(
        renderer: PreviewRendererHandle,
        clear_rgba: *const f32,
        texture: *mut c_void,
        viewport: *const f32,
        flip_y: i32,
        out_drawable_width: *mut u32,
        out_drawable_height: *mut u32,
    ) -> i32;
}
