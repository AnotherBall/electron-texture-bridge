/// Texture handle from Electron's paint event.
///
/// - Windows: DXGI shared HANDLE (cast to i64)
/// - macOS:   IOSurfaceID (uint32, passed as i64)
pub type RawTextureHandle = i64;
