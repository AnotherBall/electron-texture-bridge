#import "syphon_bridge.h"
#import <Metal/Metal.h>
#import <IOSurface/IOSurface.h>
#import <Syphon/Syphon.h>
#import <Cocoa/Cocoa.h>
#import <atomic>

// Syphon Metal Server のヘッダー（framework 内）
// SyphonMetalServer は Syphon v5+ で利用可能

struct SyphonBridge {
    id<MTLDevice>       device;
    id<MTLCommandQueue> commandQueue;
    SyphonMetalServer*  server;
};

extern "C" {

SyphonBridgeHandle syphon_bridge_create(const char* name) {
    @autoreleasepool {
        auto* bridge = new SyphonBridge();

        // デフォルト Metal デバイス
        bridge->device = MTLCreateSystemDefaultDevice();
        if (!bridge->device) {
            NSLog(@"[SyphonBridge] ERROR: Failed to create Metal device");
            delete bridge;
            return nullptr;
        }
        NSLog(@"[SyphonBridge] Metal device: %@", bridge->device.name);

        bridge->commandQueue = [bridge->device newCommandQueue];

        // Syphon Metal Server 作成
        NSString* serverName = [NSString stringWithUTF8String:name];
        bridge->server = [[SyphonMetalServer alloc] initWithName:serverName
                                                          device:bridge->device
                                                         options:nil];

        if (!bridge->server) {
            NSLog(@"[SyphonBridge] ERROR: Failed to create SyphonMetalServer");
            delete bridge;
            return nullptr;
        }

        NSLog(@"[SyphonBridge] Created server '%@' (hasClients: %d)", serverName, bridge->server.hasClients);
        return static_cast<SyphonBridgeHandle>(bridge);
    }
}

void syphon_bridge_destroy(SyphonBridgeHandle handle) {
    if (!handle) return;
    @autoreleasepool {
        auto* bridge = static_cast<SyphonBridge*>(handle);
        [bridge->server stop];
        bridge->server      = nil;
        bridge->commandQueue = nil;
        bridge->device       = nil;
        delete bridge;
    }
}

int syphon_bridge_send(SyphonBridgeHandle handle,
                       uint32_t surface_id,
                       uint32_t width,
                       uint32_t height) {
    if (!handle) return -1;
    @autoreleasepool {
        auto* bridge = static_cast<SyphonBridge*>(handle);

        // IOSurfaceID → IOSurfaceRef
        IOSurfaceRef surface = IOSurfaceLookup(surface_id);
        if (!surface) return -1;

        // IOSurface → Metal Texture（GPU zero-copy: 同じ VRAM を参照）
        MTLTextureDescriptor* desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                                                                        width:width
                                                                                       height:height
                                                                                    mipmapped:NO];
        desc.usage = MTLTextureUsageShaderRead;
        desc.storageMode = MTLStorageModeShared;

        id<MTLTexture> texture = [bridge->device newTextureWithDescriptor:desc
                                                               iosurface:surface
                                                                   plane:0];
        CFRelease(surface);

        if (!texture) return -1;

        // Syphon にパブリッシュ（GPU→GPU, zero-copy）
        // flipped:YES because IOSurface from Chromium has flipped Y coordinates
        id<MTLCommandBuffer> cmdBuf = [bridge->commandQueue commandBuffer];
        [bridge->server publishFrameTexture:texture
                            onCommandBuffer:cmdBuf
                                imageRegion:NSMakeRect(0, 0, width, height)
                                    flipped:YES];
        [cmdBuf commit];

        return 0;
    }
}

int syphon_bridge_send_surface(SyphonBridgeHandle handle,
                               void* surface_ptr,
                               uint32_t width,
                               uint32_t height) {
    if (!handle || !surface_ptr) return -1;
    @autoreleasepool {
        auto* bridge = static_cast<SyphonBridge*>(handle);

        // Cast to IOSurfaceRef directly (no lookup needed)
        IOSurfaceRef surface = static_cast<IOSurfaceRef>(surface_ptr);

        // IOSurface → Metal Texture（GPU zero-copy）
        MTLTextureDescriptor* desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                                                                        width:width
                                                                                       height:height
                                                                                    mipmapped:NO];
        desc.usage = MTLTextureUsageShaderRead;
        desc.storageMode = MTLStorageModeShared;

        id<MTLTexture> texture = [bridge->device newTextureWithDescriptor:desc
                                                               iosurface:surface
                                                                   plane:0];

        // Note: We don't CFRelease here because we don't own this surface
        // (it's owned by Electron's shared texture system)

        if (!texture) return -1;

        // Publish to Syphon（GPU→GPU, zero-copy）
        // flipped:YES because IOSurface from Chromium has flipped Y coordinates
        id<MTLCommandBuffer> cmdBuf = [bridge->commandQueue commandBuffer];
        [bridge->server publishFrameTexture:texture
                            onCommandBuffer:cmdBuf
                                imageRegion:NSMakeRect(0, 0, width, height)
                                    flipped:YES];
        [cmdBuf commit];

        return 0;
    }
}

// Frame counter for periodic logging (avoid spamming logs at 60fps)
static uint64_t g_frameCount = 0;

int syphon_bridge_send_rgba(SyphonBridgeHandle handle,
                            const uint8_t* data,
                            uint32_t width,
                            uint32_t height,
                            uint32_t bytes_per_row) {
    if (!handle || !data) {
        NSLog(@"[SyphonBridge] ERROR: send_rgba called with null handle or data");
        return -1;
    }
    @autoreleasepool {
        auto* bridge = static_cast<SyphonBridge*>(handle);
        g_frameCount++;

        // Log every 60 frames (~1 second at 60fps)
        bool shouldLog = (g_frameCount % 60 == 1);

        if (shouldLog) {
            NSLog(@"[SyphonBridge] send_rgba frame #%llu: %ux%u, stride=%u, hasClients=%d",
                  g_frameCount, width, height, bytes_per_row, bridge->server.hasClients);
        }

        // Create IOSurface from RGBA buffer
        NSDictionary* surfaceProps = @{
            (NSString*)kIOSurfaceWidth: @(width),
            (NSString*)kIOSurfaceHeight: @(height),
            (NSString*)kIOSurfaceBytesPerElement: @4,
            (NSString*)kIOSurfaceBytesPerRow: @(bytes_per_row),
            (NSString*)kIOSurfacePixelFormat: @(kCVPixelFormatType_32BGRA),
            (NSString*)kIOSurfaceAllocSize: @(bytes_per_row * height)
        };

        IOSurfaceRef surface = IOSurfaceCreate((__bridge CFDictionaryRef)surfaceProps);
        if (!surface) {
            NSLog(@"[SyphonBridge] ERROR: Failed to create IOSurface");
            return -1;
        }

        // Lock and copy data to IOSurface
        IOSurfaceLock(surface, 0, nullptr);
        void* baseAddr = IOSurfaceGetBaseAddress(surface);
        size_t surfaceBytesPerRow = IOSurfaceGetBytesPerRow(surface);

        // Copy row by row in case of stride mismatch
        const uint8_t* srcRow = data;
        uint8_t* dstRow = static_cast<uint8_t*>(baseAddr);
        size_t copyWidth = (size_t)width * 4;

        for (uint32_t y = 0; y < height; y++) {
            memcpy(dstRow, srcRow, copyWidth);
            srcRow += bytes_per_row;
            dstRow += surfaceBytesPerRow;
        }

        IOSurfaceUnlock(surface, 0, nullptr);

        // Create Metal texture from IOSurface (GPU zero-copy)
        MTLTextureDescriptor* desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                                                                        width:width
                                                                                       height:height
                                                                                    mipmapped:NO];
        desc.usage = MTLTextureUsageShaderRead;
        desc.storageMode = MTLStorageModeShared;

        id<MTLTexture> texture = [bridge->device newTextureWithDescriptor:desc
                                                               iosurface:surface
                                                                   plane:0];
        CFRelease(surface);

        if (!texture) {
            NSLog(@"[SyphonBridge] ERROR: Failed to create Metal texture from IOSurface");
            return -1;
        }

        // Publish to Syphon
        id<MTLCommandBuffer> cmdBuf = [bridge->commandQueue commandBuffer];
        [bridge->server publishFrameTexture:texture
                            onCommandBuffer:cmdBuf
                                imageRegion:NSMakeRect(0, 0, width, height)
                                    flipped:NO];
        [cmdBuf commit];

        return 0;
    }
}

// ============================================================
// Receiver (SyphonMetalClient)
// ============================================================

struct SyphonReceiverBridge {
    id<MTLDevice>       device;
    id<MTLCommandQueue> commandQueue;
    SyphonMetalClient*  client;
    uint32_t            lastWidth;
    uint32_t            lastHeight;
    std::atomic<bool>   hasNewFrameFlag{false};
    id<MTLBuffer>       stagingBuffer;
    uint32_t            stagingSize;
};

SyphonReceiverHandle syphon_receiver_create(const char* server_uuid,
                                             const char* server_name,
                                             const char* app_name) {
    @autoreleasepool {
        // Find the server in the directory
        SyphonServerDirectory* dir = [SyphonServerDirectory sharedDirectory];
        NSArray* servers = dir.servers;

        NSDictionary* serverDesc = nil;

        if (server_uuid) {
            NSString* uuid = [NSString stringWithUTF8String:server_uuid];
            for (NSDictionary* desc in servers) {
                if ([desc[SyphonServerDescriptionUUIDKey] isEqualToString:uuid]) {
                    serverDesc = desc;
                    break;
                }
            }
        } else {
            NSString* name = server_name ? [NSString stringWithUTF8String:server_name] : nil;
            NSString* app  = app_name ? [NSString stringWithUTF8String:app_name] : nil;

            for (NSDictionary* desc in servers) {
                BOOL nameMatch = !name || [desc[SyphonServerDescriptionNameKey] isEqualToString:name];
                BOOL appMatch  = !app  || [desc[SyphonServerDescriptionAppNameKey] isEqualToString:app];
                if (nameMatch && appMatch) {
                    serverDesc = desc;
                    break;
                }
            }
        }

        if (!serverDesc) {
            NSLog(@"[SyphonReceiver] ERROR: No matching server found");
            return nullptr;
        }

        auto* bridge = new SyphonReceiverBridge();
        bridge->lastWidth = 0;
        bridge->lastHeight = 0;
        bridge->stagingBuffer = nil;
        bridge->stagingSize = 0;

        bridge->device = MTLCreateSystemDefaultDevice();
        if (!bridge->device) {
            NSLog(@"[SyphonReceiver] ERROR: Failed to create Metal device");
            delete bridge;
            return nullptr;
        }

        bridge->commandQueue = [bridge->device newCommandQueue];

        // Capture a raw pointer for the newFrameHandler block.
        // The block is invoked on Syphon's background thread, so we use
        // std::atomic<bool> for thread-safe flag access.
        auto* bridgePtr = bridge;
        bridge->client = [[SyphonMetalClient alloc] initWithServerDescription:serverDesc
                                                                       device:bridge->device
                                                                      options:nil
                                                              newFrameHandler:^(SyphonMetalClient* __unused client) {
            bridgePtr->hasNewFrameFlag.store(true, std::memory_order_release);
        }];

        if (!bridge->client) {
            NSLog(@"[SyphonReceiver] ERROR: Failed to create SyphonMetalClient");
            delete bridge;
            return nullptr;
        }

        NSLog(@"[SyphonReceiver] Connected to server: %@ (%@)",
              serverDesc[SyphonServerDescriptionNameKey],
              serverDesc[SyphonServerDescriptionAppNameKey]);

        return static_cast<SyphonReceiverHandle>(bridge);
    }
}

void syphon_receiver_destroy(SyphonReceiverHandle handle) {
    if (!handle) return;
    @autoreleasepool {
        auto* bridge = static_cast<SyphonReceiverBridge*>(handle);
        [bridge->client stop];
        bridge->client        = nil;
        bridge->stagingBuffer = nil;
        bridge->commandQueue  = nil;
        bridge->device        = nil;
        delete bridge;
    }
}

int syphon_receiver_has_new_frame(SyphonReceiverHandle handle) {
    if (!handle) return 0;
    auto* bridge = static_cast<SyphonReceiverBridge*>(handle);
    return bridge->hasNewFrameFlag.load(std::memory_order_acquire) ? 1 : 0;
}

int syphon_receiver_receive_rgba(SyphonReceiverHandle handle,
                                  uint8_t* out_buffer, uint32_t buffer_size,
                                  uint32_t* out_width, uint32_t* out_height) {
    if (!handle || !out_buffer || !out_width || !out_height) return -1;

    auto* bridge = static_cast<SyphonReceiverBridge*>(handle);

    // Fast path: atomically consume the new-frame flag.
    // Using exchange instead of separate load+store prevents a race where
    // the newFrameHandler sets the flag between our load and store.
    if (!bridge->hasNewFrameFlag.exchange(false, std::memory_order_acq_rel)) {
        *out_width = bridge->lastWidth;
        *out_height = bridge->lastHeight;
        return 1; // no new frame
    }

    @autoreleasepool {
        id<MTLTexture> texture = [bridge->client newFrameImage];
        if (!texture) return -1;

        uint32_t w = (uint32_t)texture.width;
        uint32_t h = (uint32_t)texture.height;
        uint32_t bytesPerRow = w * 4;
        uint32_t requiredSize = bytesPerRow * h;

        // Always update cached dimensions so the next poll allocates correctly.
        *out_width = w;
        *out_height = h;
        bridge->lastWidth = w;
        bridge->lastHeight = h;

        if (buffer_size < requiredSize) {
            return 2; // Buffer too small — dimensions updated for next call
        }

        // Reuse staging buffer — only reallocate when frame size changes.
        if (bridge->stagingBuffer == nil || bridge->stagingSize < requiredSize) {
            bridge->stagingBuffer = [bridge->device newBufferWithLength:requiredSize
                                                                options:MTLResourceStorageModeShared];
            bridge->stagingSize = requiredSize;
        }

        // GPU readback: blit texture contents to the staging buffer
        id<MTLCommandBuffer> cmdBuf = [bridge->commandQueue commandBuffer];
        id<MTLBlitCommandEncoder> blit = [cmdBuf blitCommandEncoder];
        [blit copyFromTexture:texture
                  sourceSlice:0
                  sourceLevel:0
                 sourceOrigin:MTLOriginMake(0, 0, 0)
                   sourceSize:MTLSizeMake(w, h, 1)
                     toBuffer:bridge->stagingBuffer
            destinationOffset:0
       destinationBytesPerRow:bytesPerRow
     destinationBytesPerImage:requiredSize];
        [blit endEncoding];
        [cmdBuf commit];
        [cmdBuf waitUntilCompleted];

        // Copy from staging buffer to output
        memcpy(out_buffer, bridge->stagingBuffer.contents, requiredSize);

        // Flag was already consumed by exchange() at the top — no need to clear.

        return 0;
    }
}

int syphon_receiver_is_valid(SyphonReceiverHandle handle) {
    if (!handle) return 0;
    @autoreleasepool {
        auto* bridge = static_cast<SyphonReceiverBridge*>(handle);
        return bridge->client.isValid ? 1 : 0;
    }
}

uint32_t syphon_receiver_get_width(SyphonReceiverHandle handle) {
    if (!handle) return 0;
    auto* bridge = static_cast<SyphonReceiverBridge*>(handle);
    return bridge->lastWidth;
}

uint32_t syphon_receiver_get_height(SyphonReceiverHandle handle) {
    if (!handle) return 0;
    auto* bridge = static_cast<SyphonReceiverBridge*>(handle);
    return bridge->lastHeight;
}

// ============================================================
// Discovery (SyphonServerDirectory)
// ============================================================

char* syphon_discovery_list_servers(void) {
    @autoreleasepool {
        SyphonServerDirectory* dir = [SyphonServerDirectory sharedDirectory];
        NSArray* servers = dir.servers;

        NSMutableArray* result = [NSMutableArray array];
        for (NSDictionary* desc in servers) {
            NSMutableDictionary* entry = [NSMutableDictionary dictionary];
            NSString* name = desc[SyphonServerDescriptionNameKey];
            if (name) entry[@"name"] = name;
            else entry[@"name"] = @"";

            NSString* appName = desc[SyphonServerDescriptionAppNameKey];
            if (appName) entry[@"appName"] = appName;

            NSString* uuid = desc[SyphonServerDescriptionUUIDKey];
            if (uuid) entry[@"uuid"] = uuid;

            [result addObject:entry];
        }

        NSError* error = nil;
        NSData* jsonData = [NSJSONSerialization dataWithJSONObject:result
                                                           options:0
                                                             error:&error];
        if (error || !jsonData) {
            NSLog(@"[SyphonDiscovery] ERROR: Failed to serialize server list: %@", error);
            // Return empty array as fallback
            char* empty = strdup("[]");
            return empty;
        }

        NSString* jsonStr = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
        return strdup([jsonStr UTF8String]);
    }
}

void syphon_discovery_free_string(char* str) {
    if (str) free(str);
}

} // extern "C"
