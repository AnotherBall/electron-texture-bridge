#import "preview_view.h"
#import <AppKit/AppKit.h>
#import <CoreVideo/CoreVideo.h>
#import <Metal/Metal.h>
#import <QuartzCore/QuartzCore.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <memory>
#include <mutex>

// See preview_view.h for the threading contract.

namespace {

// How long preview_view_destroy waits for the CADisplayLink thread to exit.
constexpr int64_t kLinkThreadJoinTimeoutNs = 500 * NSEC_PER_MSEC;
// The CADisplayLink thread's run loop wakes at least this often to see stop.
constexpr NSTimeInterval kLinkThreadPollSeconds = 0.1;
constexpr NSUInteger kMaximumDrawableCount = 3;

void write_message(char* out, uint32_t out_len, const char* message) {
    if (!out || out_len == 0) return;
    std::strncpy(out, message, out_len - 1);
    out[out_len - 1] = '\0';
}

// Display refresh counter the display link bumps and the render thread
// waits on. Shared (shared_ptr) with the link's callback so it outlives it.
struct VsyncTicker {
    std::mutex mutex;
    std::condition_variable changed;
    uint64_t ticks = 0;
    uint64_t seen = 0;

    void tick() {
        {
            std::lock_guard<std::mutex> lock(mutex);
            ticks++;
        }
        changed.notify_all();
    }

    // Returns true when a tick newer than the previous wait arrived.
    bool wait(uint32_t timeout_ms) {
        std::unique_lock<std::mutex> lock(mutex);
        const bool ticked = changed.wait_for(lock, std::chrono::milliseconds(timeout_ms),
                                             [this] { return ticks != seen; });
        seen = ticks;
        return ticked;
    }
};

CGDirectDisplayID display_of(NSView* view) {
    NSScreen* screen = view.window.screen ?: NSScreen.mainScreen;
    NSNumber* number = screen.deviceDescription[@"NSScreenNumber"];
    return number ? (CGDirectDisplayID)number.unsignedIntValue : CGMainDisplayID();
}

}  // namespace

// Mouse events fall through to Chromium's content underneath: hitTest
// never returns this view.
@interface ETBPreviewNSView : NSView
@end

@implementation ETBPreviewNSView

- (CALayer*)makeBackingLayer {
    CAMetalLayer* layer = [CAMetalLayer layer];
    layer.pixelFormat = MTLPixelFormatBGRA8Unorm;
    layer.opaque = YES;
    layer.framebufferOnly = YES;
    layer.displaySyncEnabled = YES;
    layer.maximumDrawableCount = kMaximumDrawableCount;
    layer.presentsWithTransaction = NO;
    layer.needsDisplayOnBoundsChange = NO;
    // Same colour handling as Chromium's sRGB content around the view.
    CGColorSpaceRef srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    layer.colorspace = srgb;
    CGColorSpaceRelease(srgb);
    return layer;
}

- (BOOL)wantsUpdateLayer {
    return YES;
}

- (void)updateLayer {
    // The render thread owns every pixel.
}

- (BOOL)isOpaque {
    return YES;
}

- (NSView*)hitTest:(NSPoint)point {
    (void)point;
    return nil;
}

- (BOOL)acceptsFirstResponder {
    return NO;
}

@end

// CADisplayLink target: bumps the ticker on every refresh.
@interface ETBVsyncTarget : NSObject {
@public
    std::shared_ptr<VsyncTicker> ticker;
}
- (void)tick:(id)link;
@end

@implementation ETBVsyncTarget
- (void)tick:(id)link {
    (void)link;
    if (ticker) ticker->tick();
}
@end

static CVReturn cv_display_link_callback(CVDisplayLinkRef, const CVTimeStamp*, const CVTimeStamp*,
                                         CVOptionFlags, CVOptionFlags*, void* context) {
    static_cast<VsyncTicker*>(context)->tick();
    return kCVReturnSuccess;
}

struct PreviewNativeView {
    ETBPreviewNSView* view = nil;
    CAMetalLayer* layer = nil;
    id<MTLDevice> device = nil;
    std::shared_ptr<VsyncTicker> ticker = std::make_shared<VsyncTicker>();
    int linkKind = PREVIEW_DISPLAY_LINK_NONE;

    // macOS 14+: CADisplayLink on its own run-loop thread (not the main
    // thread, so a busy Electron main thread does not delay ticks).
    id caLink = nil;  // CADisplayLink*
    std::shared_ptr<std::atomic<bool>> linkThreadStop;
    dispatch_semaphore_t linkThreadDone = nil;

    // Older macOS: CVDisplayLink (ticks on CoreVideo's own thread).
    CVDisplayLinkRef cvLink = nullptr;
    CGDirectDisplayID cvDisplay = 0;
};

#pragma clang diagnostic push
// CVDisplayLink is deprecated from macOS 15; it is only the pre-14 fallback.
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

static void start_cv_display_link(PreviewNativeView* p) {
    if (CVDisplayLinkCreateWithActiveCGDisplays(&p->cvLink) != kCVReturnSuccess || !p->cvLink) {
        p->cvLink = nullptr;
        return;
    }
    CVDisplayLinkSetOutputCallback(p->cvLink, cv_display_link_callback, p->ticker.get());
    p->cvDisplay = display_of(p->view);
    CVDisplayLinkSetCurrentCGDisplay(p->cvLink, p->cvDisplay);
    if (CVDisplayLinkStart(p->cvLink) != kCVReturnSuccess) {
        CVDisplayLinkRelease(p->cvLink);
        p->cvLink = nullptr;
        return;
    }
    p->linkKind = PREVIEW_DISPLAY_LINK_CV;
}

static void follow_display_cv(PreviewNativeView* p) {
    if (!p->cvLink) return;
    const CGDirectDisplayID display = display_of(p->view);
    if (display == p->cvDisplay) return;
    p->cvDisplay = display;
    CVDisplayLinkSetCurrentCGDisplay(p->cvLink, display);
}

static void stop_cv_display_link(PreviewNativeView* p) {
    if (!p->cvLink) return;
    // CVDisplayLinkStop returns after the in-flight callback, so the ticker
    // (kept alive by `p` anyway) is not used afterwards.
    CVDisplayLinkStop(p->cvLink);
    CVDisplayLinkRelease(p->cvLink);
    p->cvLink = nullptr;
}

#pragma clang diagnostic pop

API_AVAILABLE(macos(14.0))
static void start_ca_display_link(PreviewNativeView* p) {
    ETBVsyncTarget* target = [[ETBVsyncTarget alloc] init];
    target->ticker = p->ticker;
    // The view's display link follows the screen the view is on by itself.
    CADisplayLink* link = [p->view displayLinkWithTarget:target selector:@selector(tick:)];
    if (!link) return;
    auto stop = std::make_shared<std::atomic<bool>>(false);
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    NSThread* thread = [[NSThread alloc] initWithBlock:^{
        @autoreleasepool {
            NSRunLoop* runLoop = [NSRunLoop currentRunLoop];
            [link addToRunLoop:runLoop forMode:NSRunLoopCommonModes];
            while (!stop->load(std::memory_order_acquire)) {
                @autoreleasepool {
                    [runLoop runMode:NSDefaultRunLoopMode
                          beforeDate:[NSDate dateWithTimeIntervalSinceNow:kLinkThreadPollSeconds]];
                }
            }
            [link invalidate];
        }
        dispatch_semaphore_signal(done);
    }];
    thread.name = @"preview-view-vsync";
    thread.qualityOfService = NSQualityOfServiceUserInteractive;
    [thread start];
    p->caLink = link;
    p->linkThreadStop = stop;
    p->linkThreadDone = done;
    p->linkKind = PREVIEW_DISPLAY_LINK_CA;
}

static void stop_ca_display_link(PreviewNativeView* p) {
    if (!p->linkThreadStop) return;
    p->linkThreadStop->store(true, std::memory_order_release);
    // Bounded: the thread's run loop wakes every kLinkThreadPollSeconds.
    if (dispatch_semaphore_wait(p->linkThreadDone,
                                dispatch_time(DISPATCH_TIME_NOW, kLinkThreadJoinTimeoutNs)) != 0) {
        NSLog(@"[PreviewView] display link thread did not stop in time");
    }
    p->caLink = nil;
    p->linkThreadStop.reset();
    p->linkThreadDone = nil;
}

static void start_display_link(PreviewNativeView* p) {
    if (@available(macOS 14.0, *)) {
        start_ca_display_link(p);
        if (p->linkKind != PREVIEW_DISPLAY_LINK_NONE) return;
    }
    start_cv_display_link(p);
}

static PreviewNativeView* as_view(PreviewNativeViewHandle handle) {
    return static_cast<PreviewNativeView*>(handle);
}

extern "C" {

PreviewNativeViewHandle preview_view_create(void* parent_nsview, char* error, uint32_t error_len) {
    if (![NSThread isMainThread]) {
        write_message(error, error_len, "PreviewView must be created on the main thread");
        return nullptr;
    }
    @autoreleasepool {
        id parentObject = (__bridge id)parent_nsview;
        if (!parentObject || ![parentObject isKindOfClass:[NSView class]]) {
            write_message(error, error_len, "Parent handle is not an NSView");
            return nullptr;
        }
        NSView* parent = (NSView*)parentObject;

        id<MTLDevice> device = MTLCreateSystemDefaultDevice();
        if (!device) {
            write_message(error, error_len, "No Metal device available");
            return nullptr;
        }

        auto* p = new PreviewNativeView();
        p->device = device;
        p->view = [[ETBPreviewNSView alloc] initWithFrame:NSZeroRect];
        p->view.wantsLayer = YES;  // creates the CAMetalLayer (makeBackingLayer)
        p->view.layerContentsRedrawPolicy = NSViewLayerContentsRedrawNever;
        p->view.hidden = YES;
        p->layer = (CAMetalLayer*)p->view.layer;
        if (![p->layer isKindOfClass:[CAMetalLayer class]]) {
            write_message(error, error_len, "Failed to create the CAMetalLayer");
            delete p;
            return nullptr;
        }
        p->layer.device = device;
        // Keep a constant distance to the parent's top edge while it resizes
        // (an unflipped parent measures y from its bottom edge).
        p->view.autoresizingMask = parent.isFlipped ? NSViewMaxYMargin : NSViewMinYMargin;
        [parent addSubview:p->view positioned:NSWindowAbove relativeTo:nil];
        start_display_link(p);
        return p;
    }
}

void preview_view_destroy(PreviewNativeViewHandle handle) {
    PreviewNativeView* p = as_view(handle);
    if (!p) return;
    @autoreleasepool {
        stop_ca_display_link(p);
        stop_cv_display_link(p);
        [p->view removeFromSuperview];
        p->layer = nil;
        p->view = nil;
        p->device = nil;
    }
    delete p;
}

int preview_view_parent_geometry(PreviewNativeViewHandle handle,
                                 double* out_scale,
                                 double* out_parent_height,
                                 int* out_parent_flipped) {
    PreviewNativeView* p = as_view(handle);
    if (!p || !out_scale || !out_parent_height || !out_parent_flipped) return -1;
    if (![NSThread isMainThread]) return -1;
    NSView* parent = p->view.superview;
    if (!parent) return -1;
    NSWindow* window = parent.window;
    *out_scale = window ? window.backingScaleFactor : NSScreen.mainScreen.backingScaleFactor;
    *out_parent_height = parent.bounds.size.height;
    *out_parent_flipped = parent.isFlipped ? 1 : 0;
    return 0;
}

void preview_view_set_frame(PreviewNativeViewHandle handle,
                            double x, double y, double width, double height,
                            double scale,
                            uint32_t drawable_width, uint32_t drawable_height) {
    PreviewNativeView* p = as_view(handle);
    if (!p || ![NSThread isMainThread]) return;
    @autoreleasepool {
        NSView* parent = p->view.superview;
        if (!parent) return;
        const NSPoint origin = parent.bounds.origin;
        [CATransaction begin];
        [CATransaction setDisableActions:YES];
        p->view.frame = NSMakeRect(origin.x + x, origin.y + y, width, height);
        if (scale > 0) p->layer.contentsScale = scale;
        if (drawable_width > 0 && drawable_height > 0) {
            p->layer.drawableSize = CGSizeMake(drawable_width, drawable_height);
        }
        [CATransaction commit];
        // Chromium may have added subviews since: stay on top of them.
        if (parent.subviews.lastObject != p->view) {
            [parent addSubview:p->view positioned:NSWindowAbove relativeTo:nil];
        }
        follow_display_cv(p);
    }
}

void preview_view_set_hidden(PreviewNativeViewHandle handle, int hidden) {
    PreviewNativeView* p = as_view(handle);
    if (!p || ![NSThread isMainThread]) return;
    p->view.hidden = hidden ? YES : NO;
    if (!hidden) follow_display_cv(p);
}

int preview_view_display_link_kind(PreviewNativeViewHandle handle) {
    PreviewNativeView* p = as_view(handle);
    return p ? p->linkKind : PREVIEW_DISPLAY_LINK_NONE;
}

int preview_view_wait_vsync(PreviewNativeViewHandle handle, uint32_t timeout_ms) {
    PreviewNativeView* p = as_view(handle);
    if (!p) return 0;
    return p->ticker->wait(timeout_ms) ? 1 : 0;
}

void* preview_view_device(PreviewNativeViewHandle handle) {
    PreviewNativeView* p = as_view(handle);
    return p ? (__bridge void*)p->device : nullptr;
}

uint32_t preview_view_adapter_name(PreviewNativeViewHandle handle, char* out, uint32_t out_len) {
    PreviewNativeView* p = as_view(handle);
    if (!p) {
        write_message(out, out_len, "");
        return 0;
    }
    @autoreleasepool {
        const char* name = p->device.name.UTF8String ?: "";
        write_message(out, out_len, name);
        return (uint32_t)std::strlen(name);
    }
}

int preview_view_vsync_enabled(PreviewNativeViewHandle handle) {
    PreviewNativeView* p = as_view(handle);
    return p && p->layer.displaySyncEnabled ? 1 : 0;
}

}  // extern "C"

// ============================================================
// Renderer (render thread)
// ============================================================

// Fullscreen triangle clipped to the viewport. uv.y follows the drawable's
// top-left origin; flip samples texture row 0 at the bottom instead.
static NSString* const kPreviewShaderSource =
    @"#include <metal_stdlib>\n"
    @"using namespace metal;\n"
    @"struct VertexOut { float4 position [[position]]; float2 uv; };\n"
    @"vertex VertexOut preview_vertex(uint vid [[vertex_id]], constant uint& flip [[buffer(0)]]) {\n"
    @"    float2 positions[3] = { float2(-1.0, -1.0), float2(3.0, -1.0), float2(-1.0, 3.0) };\n"
    @"    float2 p = positions[vid];\n"
    @"    VertexOut out;\n"
    @"    out.position = float4(p, 0.0, 1.0);\n"
    @"    float v = flip != 0 ? (p.y + 1.0) * 0.5 : (1.0 - p.y) * 0.5;\n"
    @"    out.uv = float2((p.x + 1.0) * 0.5, v);\n"
    @"    return out;\n"
    @"}\n"
    @"fragment float4 preview_fragment(VertexOut in [[stage_in]], texture2d<float> src [[texture(0)]]) {\n"
    @"    constexpr sampler s(coord::normalized, address::clamp_to_edge, filter::linear);\n"
    @"    return src.sample(s, in.uv);\n"
    @"}\n";

struct PreviewRenderer {
    CAMetalLayer* layer = nil;
    id<MTLCommandQueue> queue = nil;
    id<MTLRenderPipelineState> pipeline = nil;
};

extern "C" {

PreviewRendererHandle preview_renderer_create(PreviewNativeViewHandle handle) {
    PreviewNativeView* view = as_view(handle);
    if (!view) return nullptr;
    @autoreleasepool {
        id<MTLDevice> device = view->device;
        NSError* err = nil;
        id<MTLLibrary> library = [device newLibraryWithSource:kPreviewShaderSource options:nil error:&err];
        if (!library) {
            NSLog(@"[PreviewView] shader compile failed: %@", err);
            return nullptr;
        }
        MTLRenderPipelineDescriptor* desc = [[MTLRenderPipelineDescriptor alloc] init];
        desc.vertexFunction = [library newFunctionWithName:@"preview_vertex"];
        desc.fragmentFunction = [library newFunctionWithName:@"preview_fragment"];
        MTLRenderPipelineColorAttachmentDescriptor* color = desc.colorAttachments[0];
        color.pixelFormat = view->layer.pixelFormat;
        // Premultiplied alpha over the cleared background.
        color.blendingEnabled = YES;
        color.rgbBlendOperation = MTLBlendOperationAdd;
        color.alphaBlendOperation = MTLBlendOperationAdd;
        color.sourceRGBBlendFactor = MTLBlendFactorOne;
        color.sourceAlphaBlendFactor = MTLBlendFactorOne;
        color.destinationRGBBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
        color.destinationAlphaBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
        id<MTLRenderPipelineState> pipeline = [device newRenderPipelineStateWithDescriptor:desc error:&err];
        if (!pipeline) {
            NSLog(@"[PreviewView] pipeline creation failed: %@", err);
            return nullptr;
        }
        auto* r = new PreviewRenderer();
        r->layer = view->layer;
        r->queue = [device newCommandQueue];
        r->pipeline = pipeline;
        if (!r->queue) {
            delete r;
            return nullptr;
        }
        return r;
    }
}

void preview_renderer_destroy(PreviewRendererHandle handle) {
    auto* r = static_cast<PreviewRenderer*>(handle);
    if (!r) return;
    @autoreleasepool {
        r->pipeline = nil;
        r->queue = nil;
        r->layer = nil;
    }
    delete r;
}

int preview_renderer_draw(PreviewRendererHandle handle,
                          const float* clear_rgba,
                          void* texture_ptr,
                          const float* viewport,
                          int flip_y,
                          uint32_t* out_drawable_width,
                          uint32_t* out_drawable_height) {
    auto* r = static_cast<PreviewRenderer*>(handle);
    if (!r || !clear_rgba || !viewport || !out_drawable_width || !out_drawable_height) return -1;
    @autoreleasepool {
        // Thread-safe; blocks while all drawables are in use (bounded by
        // allowsNextDrawableTimeout, 1 s).
        id<CAMetalDrawable> drawable = [r->layer nextDrawable];
        if (!drawable) return 1;
        id<MTLTexture> target = drawable.texture;
        *out_drawable_width = (uint32_t)target.width;
        *out_drawable_height = (uint32_t)target.height;

        MTLRenderPassDescriptor* pass = [MTLRenderPassDescriptor renderPassDescriptor];
        pass.colorAttachments[0].texture = target;
        pass.colorAttachments[0].loadAction = MTLLoadActionClear;
        pass.colorAttachments[0].storeAction = MTLStoreActionStore;
        pass.colorAttachments[0].clearColor =
            MTLClearColorMake(clear_rgba[0], clear_rgba[1], clear_rgba[2], clear_rgba[3]);

        id<MTLCommandBuffer> commands = [r->queue commandBuffer];
        id<MTLRenderCommandEncoder> encoder = [commands renderCommandEncoderWithDescriptor:pass];
        id<MTLTexture> frame = (__bridge id<MTLTexture>)texture_ptr;
        if (frame && viewport[2] > 0 && viewport[3] > 0) {
            MTLViewport vp = {viewport[0], viewport[1], viewport[2], viewport[3], 0.0, 1.0};
            [encoder setViewport:vp];
            [encoder setRenderPipelineState:r->pipeline];
            const uint32_t flip = flip_y ? 1 : 0;
            [encoder setVertexBytes:&flip length:sizeof(flip) atIndex:0];
            [encoder setFragmentTexture:frame atIndex:0];
            [encoder drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];
        }
        [encoder endEncoding];
        // The command buffer retains `frame` until the GPU is done with it.
        [commands presentDrawable:drawable];
        [commands commit];
        return 0;
    }
}

}  // extern "C"
