#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Opaque handle
typedef void* SyphonBridgeHandle;

// Lifecycle
SyphonBridgeHandle syphon_bridge_create(const char* name);
void               syphon_bridge_destroy(SyphonBridgeHandle handle);

// Send an IOSurface by its IOSurfaceID
// surface_id: IOSurfaceID from Electron's useSharedTexture handle
// width, height: texture dimensions (from textureInfo.codedSize)
// Returns: 0 on success, -1 on error
int syphon_bridge_send(SyphonBridgeHandle handle,
                       uint32_t surface_id,
                       uint32_t width,
                       uint32_t height);

// Send an IOSurface by direct pointer (IOSurfaceRef)
// surface: IOSurfaceRef pointer from Electron's shared texture handle buffer
// width, height: texture dimensions (from textureInfo.codedSize)
// Returns: 0 on success, -1 on error
int syphon_bridge_send_surface(SyphonBridgeHandle handle,
                               void* surface,
                               uint32_t width,
                               uint32_t height);

// Send raw RGBA buffer data (for VideoFrame.copyTo() workflow)
// data: pointer to RGBA pixel data (4 bytes per pixel, BGRA format expected)
// width, height: texture dimensions
// bytes_per_row: stride in bytes (typically width * 4, but may include padding)
// Returns: 0 on success, -1 on error
int syphon_bridge_send_rgba(SyphonBridgeHandle handle,
                            const uint8_t* data,
                            uint32_t width,
                            uint32_t height,
                            uint32_t bytes_per_row);

#ifdef __cplusplus
}
#endif
