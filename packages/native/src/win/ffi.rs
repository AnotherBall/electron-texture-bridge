use std::os::raw::c_char;

pub type SpoutBridgeHandle = *mut std::ffi::c_void;

extern "C" {
    pub fn spout_bridge_create(name: *const c_char, width: u32, height: u32) -> SpoutBridgeHandle;
    pub fn spout_bridge_destroy(handle: SpoutBridgeHandle);
    pub fn spout_bridge_send(handle: SpoutBridgeHandle, shared_handle: i64) -> i32;
    pub fn spout_bridge_resize(handle: SpoutBridgeHandle, width: u32, height: u32) -> i32;
}
