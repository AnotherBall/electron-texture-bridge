use std::os::raw::c_char;

pub type SyphonBridgeHandle = *mut std::ffi::c_void;
pub type IOSurfaceRef = *mut std::ffi::c_void;

extern "C" {
    pub fn syphon_bridge_create(name: *const c_char) -> SyphonBridgeHandle;
    pub fn syphon_bridge_destroy(handle: SyphonBridgeHandle);
    pub fn syphon_bridge_send(
        handle: SyphonBridgeHandle,
        surface_id: u32,
        width: u32,
        height: u32,
    ) -> i32;
    /// Send IOSurface via direct pointer (from Electron's shared texture handle)
    pub fn syphon_bridge_send_surface(
        handle: SyphonBridgeHandle,
        surface: IOSurfaceRef,
        width: u32,
        height: u32,
    ) -> i32;
    pub fn syphon_bridge_send_rgba(
        handle: SyphonBridgeHandle,
        data: *const u8,
        width: u32,
        height: u32,
        bytes_per_row: u32,
    ) -> i32;
}
