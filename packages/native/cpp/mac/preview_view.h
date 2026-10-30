#pragma once

// macOS PreviewView: a layer-backed child NSView with a CAMetalLayer inside
// an Electron window's content view, plus a small Metal renderer and a
// display-link vsync ticker. Rust (src/mac/preview/) owns the render thread
// and all pacing / layout / stats logic; this file only wraps AppKit and Metal.
//
// Threads:
//   - preview_view_* except preview_view_wait_vsync: main thread only
//     (they return an error / do nothing elsewhere).
//   - preview_view_wait_vsync and preview_renderer_*: the render thread.
//   - Destroy order: stop the render thread (destroying its renderer) before
//     preview_view_destroy.

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef void* PreviewNativeViewHandle;
typedef void* PreviewRendererHandle;

// Which display link drives preview_view_wait_vsync.
//   1 = CADisplayLink from -[NSView displayLinkWithTarget:selector:] (macOS 14+)
//   2 = CVDisplayLink (older macOS)
//   0 = none (waits only time out)
#define PREVIEW_DISPLAY_LINK_NONE 0
#define PREVIEW_DISPLAY_LINK_CA 1
#define PREVIEW_DISPLAY_LINK_CV 2

// Create a hidden child view on top of `parent_nsview`'s subviews, with its
// own system-default MTLDevice. Main thread only. Returns NULL on failure and
// writes a message (NUL-terminated, truncated) into `error`.
PreviewNativeViewHandle preview_view_create(void* parent_nsview, char* error, uint32_t error_len);

// Remove the view, stop its display link (bounded wait) and free it.
// Main thread only. NULL is a no-op.
void preview_view_destroy(PreviewNativeViewHandle view);

// The parent's geometry the frame conversion needs: backing scale factor
// (physical px per point), height in points and whether it is flipped.
// Returns 0, or -1 when the view lost its parent / not on the main thread.
int preview_view_parent_geometry(PreviewNativeViewHandle view,
                                 double* out_scale,
                                 double* out_parent_height,
                                 int* out_parent_flipped);

// Set the frame (points, in the parent's coordinate system), the layer's
// contentsScale and its drawableSize (physical px; 0 keeps the old size),
// keep the view above its siblings and follow the window's display.
// Main thread only.
void preview_view_set_frame(PreviewNativeViewHandle view,
                            double x, double y, double width, double height,
                            double scale,
                            uint32_t drawable_width, uint32_t drawable_height);

// Show / hide. Main thread only.
void preview_view_set_hidden(PreviewNativeViewHandle view, int hidden);

// PREVIEW_DISPLAY_LINK_* in use.
int preview_view_display_link_kind(PreviewNativeViewHandle view);

// Block until the next display refresh after the previous call, or
// `timeout_ms`. Returns 1 on a tick, 0 on timeout. Render thread.
int preview_view_wait_vsync(PreviewNativeViewHandle view, uint32_t timeout_ms);

// Unretained id<MTLDevice> of the view (for syphon_receiver_create_with_device).
void* preview_view_device(PreviewNativeViewHandle view);

// The device's name (NUL-terminated, truncated). Returns the full length.
uint32_t preview_view_adapter_name(PreviewNativeViewHandle view, char* out, uint32_t out_len);

// Whether the layer's presents wait for vertical blank (displaySyncEnabled).
int preview_view_vsync_enabled(PreviewNativeViewHandle view);

// Build the command queue and pipeline for `view`'s layer. Render thread.
// Returns NULL on failure (logged).
PreviewRendererHandle preview_renderer_create(PreviewNativeViewHandle view);
void preview_renderer_destroy(PreviewRendererHandle renderer);

// Draw one frame into the layer's next drawable and present it:
// clear to `clear_rgba`, then (when `texture`, an id<MTLTexture>, is not
// NULL) draw it premultiplied (one, oneMinusSourceAlpha) into `viewport`
// (x, y, width, height in drawable px, origin top-left). flip_y != 0 draws
// texture row 0 at the bottom (Syphon's bottom-left origin).
// Writes the drawable's size. Returns 0 when presented, 1 when no drawable
// was available (nothing presented), -1 on error.
int preview_renderer_draw(PreviewRendererHandle renderer,
                          const float* clear_rgba,
                          void* texture,
                          const float* viewport,
                          int flip_y,
                          uint32_t* out_drawable_width,
                          uint32_t* out_drawable_height);

#ifdef __cplusplus
}
#endif
