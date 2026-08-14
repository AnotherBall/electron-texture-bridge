// spout_bridge.cpp
// C++ bridge for Rust FFI to Spout2 SDK
//
// Sender side uses the spoutDX helper class.
// Receiver side talks to the Spout primitives directly (SpoutSenderNames,
// SpoutFrameCount, SpoutDirectX). This sidesteps spoutDX::ReceiveTexture's
// implicit contract that `*ppTexture` be pre-allocated, which broke the
// zero-copy GPU receive path in our configuration.

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <set>
#include <string>
#include <d3d11_1.h>
#include <dxgi1_2.h>
#include "SpoutDX.h"
#include "SpoutSenderNames.h"
#include "SpoutFrameCount.h"
#include "SpoutDirectX.h"

struct SpoutBridge {
    spoutDX sender;
    char senderName[256];
    ID3D11Device* device;
    ID3D11Device1* device1;  // For OpenSharedResource1 (NT handles)
    ID3D11DeviceContext* context;
    unsigned int width;
    unsigned int height;
    bool initialized;
};

static void release_sender_device(SpoutBridge* bridge) {
    if (bridge->initialized) {
        bridge->sender.ReleaseSender();
        bridge->sender.CloseDirectX11();
        bridge->initialized = false;
    }
    if (bridge->device1) { bridge->device1->Release(); bridge->device1 = nullptr; }
    if (bridge->context) { bridge->context->Release(); bridge->context = nullptr; }
    if (bridge->device)  { bridge->device->Release();  bridge->device = nullptr; }
}

static bool create_device_for_adapter(IDXGIAdapter1* adapter,
                                      ID3D11Device** outDevice,
                                      ID3D11DeviceContext** outContext) {
    const D3D_FEATURE_LEVEL featureLevels[] = {
        D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_11_0,
    };
    D3D_FEATURE_LEVEL obtained = D3D_FEATURE_LEVEL_11_0;
    HRESULT hr = D3D11CreateDevice(
        adapter,
        D3D_DRIVER_TYPE_UNKNOWN,
        nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        featureLevels,
        ARRAYSIZE(featureLevels),
        D3D11_SDK_VERSION,
        outDevice,
        &obtained,
        outContext);
    return SUCCEEDED(hr) && *outDevice && *outContext;
}

// Chromium exports NT handles from the adapter used by its compositor. A D3D
// shared resource can only be opened on that same adapter, so probe each
// hardware adapter instead of relying on Windows' default-adapter choice.
static ID3D11Texture2D* initialize_sender_for_handle(SpoutBridge* bridge,
                                                     HANDLE ntHandle) {
    IDXGIFactory1* factory = nullptr;
    HRESULT hr = CreateDXGIFactory1(
        __uuidof(IDXGIFactory1), reinterpret_cast<void**>(&factory));
    if (FAILED(hr) || !factory) return nullptr;

    ID3D11Texture2D* openedTexture = nullptr;
    for (UINT index = 0; ; ++index) {
        IDXGIAdapter1* adapter = nullptr;
        const HRESULT enumHr = factory->EnumAdapters1(index, &adapter);
        if (enumHr == DXGI_ERROR_NOT_FOUND) break;
        if (FAILED(enumHr) || !adapter) break;

        DXGI_ADAPTER_DESC1 desc = {};
        adapter->GetDesc1(&desc);
        if ((desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) != 0) {
            adapter->Release();
            continue;
        }

        ID3D11Device* candidateDevice = nullptr;
        ID3D11DeviceContext* candidateContext = nullptr;
        ID3D11Device1* candidateDevice1 = nullptr;
        if (create_device_for_adapter(adapter, &candidateDevice, &candidateContext)) {
            candidateDevice->QueryInterface(
                __uuidof(ID3D11Device1), reinterpret_cast<void**>(&candidateDevice1));
            if (candidateDevice1) {
                hr = candidateDevice1->OpenSharedResource1(
                    ntHandle,
                    __uuidof(ID3D11Texture2D),
                    reinterpret_cast<void**>(&openedTexture));
            } else {
                hr = candidateDevice->OpenSharedResource(
                    ntHandle,
                    __uuidof(ID3D11Texture2D),
                    reinterpret_cast<void**>(&openedTexture));
            }
        }

        if (openedTexture) {
            bridge->device = candidateDevice;
            bridge->device1 = candidateDevice1;
            bridge->context = candidateContext;
            const bool directXOpened = bridge->sender.OpenDirectX11(bridge->device);
            if (directXOpened && bridge->sender.SetSenderName(bridge->senderName)) {
                bridge->sender.SetSenderFormat(DXGI_FORMAT_B8G8R8A8_UNORM);
                bridge->initialized = true;
                fprintf(stderr,
                        "[SpoutBridge] sender matched DXGI adapter %u (vendor=0x%04x device=0x%04x)\n",
                        index, desc.VendorId, desc.DeviceId);
            } else {
                openedTexture->Release();
                openedTexture = nullptr;
                if (directXOpened) bridge->sender.CloseDirectX11();
                release_sender_device(bridge);
            }
        } else {
            if (candidateDevice1) candidateDevice1->Release();
            if (candidateContext) candidateContext->Release();
            if (candidateDevice) candidateDevice->Release();
        }
        adapter->Release();
        if (bridge->initialized) break;
    }
    factory->Release();
    return openedTexture;
}

extern "C" {

void* spout_bridge_create(const char* name, uint32_t width, uint32_t height) {
    SpoutBridge* bridge = new SpoutBridge();
    memset(bridge->senderName, 0, sizeof(bridge->senderName));
    if (name && name[0]) {
        strncpy(bridge->senderName, name, sizeof(bridge->senderName) - 1);
    }
    bridge->width = width;
    bridge->height = height;
    bridge->initialized = false;
    bridge->device = nullptr;
    bridge->device1 = nullptr;
    bridge->context = nullptr;

    // Device selection is deferred until the first frame. Only the frame's NT
    // handle tells us which GPU Chromium used for its compositor texture.
    return bridge;
}

void spout_bridge_destroy(void* handle) {
    if (!handle) return;

    SpoutBridge* bridge = static_cast<SpoutBridge*>(handle);
    release_sender_device(bridge);
    delete bridge;
}

int32_t spout_bridge_send(void* handle, int64_t shared_handle) {
    if (!handle) return -1;

    SpoutBridge* bridge = static_cast<SpoutBridge*>(handle);
    // Cast the shared handle from Electron's texture
    HANDLE nt_handle = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(shared_handle));
    if (!nt_handle) return -3;

    ID3D11Texture2D* shared_texture = nullptr;
    if (!bridge->initialized) {
        shared_texture = initialize_sender_for_handle(bridge, nt_handle);
    } else if (bridge->device1) {
        bridge->device1->OpenSharedResource1(
            nt_handle, __uuidof(ID3D11Texture2D),
            reinterpret_cast<void**>(&shared_texture));
    } else {
        bridge->device->OpenSharedResource(
            nt_handle, __uuidof(ID3D11Texture2D),
            reinterpret_cast<void**>(&shared_texture));
    }

    // Chromium can move to another adapter after a device reset. Re-probe in
    // that case rather than permanently failing every subsequent frame.
    if (!shared_texture && bridge->initialized) {
        release_sender_device(bridge);
        shared_texture = initialize_sender_for_handle(bridge, nt_handle);
    }
    if (!shared_texture) return -4;

    // Send the texture via Spout
    bool success = bridge->sender.SendTexture(shared_texture);

    // Release the shared texture reference
    shared_texture->Release();

    return success ? 0 : -5;
}

int32_t spout_bridge_resize(void* handle, uint32_t width, uint32_t height) {
    if (!handle) return -1;

    SpoutBridge* bridge = static_cast<SpoutBridge*>(handle);
    bridge->width = width;
    bridge->height = height;

    // Spout handles resize automatically on next SendTexture
    return 0;
}

// ============================================================
// Receiver — direct spoutSenderNames / SpoutFrameCount / SpoutDirectX
// implementation. Does not use spoutDX to avoid its ReceiveTexture
// pre-allocation contract that broke our zero-copy path.
// ============================================================

struct SpoutReceiverBridge {
    // D3D11 — owned by this bridge (one device per receiver instance).
    ID3D11Device*        device;
    ID3D11Device1*       device1;
    ID3D11DeviceContext* context;

    // Spout SDK primitives. spoutSenderNames publishes sender info via a
    // memory-mapped file; spoutFrameCount manages per-sender frame semaphore
    // and named mutex; spoutDirectX wraps OpenSharedResource / CreateDX11device.
    spoutSenderNames* senderNames;
    spoutFrameCount*  frameCount;
    spoutDirectX*     directX;

    // Cached sender metadata.
    char              senderName[256];
    unsigned int      senderWidth;
    unsigned int      senderHeight;
    DWORD             senderFormat;      // DXGI_FORMAT as DWORD (e.g. 87=BGRA)
    HANDLE            cachedSenderHandle;
    ID3D11Texture2D*  senderTexture;     // opened from cachedSenderHandle
    bool              frameCountEnabled;
    bool              accessMutexCreated;
    bool              connected;

    // Our NT-shared output staging (per-frame DuplicateHandle target).
    ID3D11Texture2D*  ntStaging;
    unsigned int      ntStagingWidth;
    unsigned int      ntStagingHeight;
    DWORD             ntStagingFormat;
    HANDLE            cachedNtHandle;

    // CPU-mappable staging for the RGBA readback path.
    ID3D11Texture2D*  cpuStaging;
    unsigned int      cpuStagingWidth;
    unsigned int      cpuStagingHeight;
    DWORD             cpuStagingFormat;
};

// Release any cached reference to the sender's shared texture. Called when
// the sender disappears or publishes a new share handle.
static void release_sender_texture(SpoutReceiverBridge* bridge) {
    if (bridge->senderTexture) {
        bridge->senderTexture->Release();
        bridge->senderTexture = nullptr;
    }
    bridge->cachedSenderHandle = nullptr;
}

static void release_receiver_graphics(SpoutReceiverBridge* bridge) {
    if (bridge->cachedNtHandle) {
        CloseHandle(bridge->cachedNtHandle);
        bridge->cachedNtHandle = nullptr;
    }
    if (bridge->ntStaging)  { bridge->ntStaging->Release();  bridge->ntStaging = nullptr; }
    if (bridge->cpuStaging) { bridge->cpuStaging->Release(); bridge->cpuStaging = nullptr; }
    release_sender_texture(bridge);
    if (bridge->context) { bridge->context->Release(); bridge->context = nullptr; }
    if (bridge->device1) { bridge->device1->Release(); bridge->device1 = nullptr; }
    if (bridge->device)  { bridge->device->Release();  bridge->device = nullptr; }
}

static bool open_sender_texture(ID3D11Device* device,
                                ID3D11Device1* device1,
                                HANDLE shareHandle,
                                ID3D11Texture2D** outTexture) {
    HRESULT hr = device->OpenSharedResource(
        shareHandle,
        __uuidof(ID3D11Texture2D),
        reinterpret_cast<void**>(outTexture));
    if (FAILED(hr) && device1) {
        hr = device1->OpenSharedResource1(
            shareHandle,
            __uuidof(ID3D11Texture2D),
            reinterpret_cast<void**>(outTexture));
    }
    return SUCCEEDED(hr) && *outTexture;
}

static bool select_receiver_adapter(SpoutReceiverBridge* bridge,
                                    HANDLE shareHandle) {
    release_receiver_graphics(bridge);

    IDXGIFactory1* factory = nullptr;
    HRESULT hr = CreateDXGIFactory1(
        __uuidof(IDXGIFactory1), reinterpret_cast<void**>(&factory));
    if (FAILED(hr) || !factory) return false;

    bool matched = false;
    for (UINT index = 0; ; ++index) {
        IDXGIAdapter1* adapter = nullptr;
        const HRESULT enumHr = factory->EnumAdapters1(index, &adapter);
        if (enumHr == DXGI_ERROR_NOT_FOUND) break;
        if (FAILED(enumHr) || !adapter) break;

        DXGI_ADAPTER_DESC1 desc = {};
        adapter->GetDesc1(&desc);
        if ((desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) != 0) {
            adapter->Release();
            continue;
        }

        ID3D11Device* candidateDevice = nullptr;
        ID3D11DeviceContext* candidateContext = nullptr;
        ID3D11Device1* candidateDevice1 = nullptr;
        ID3D11Texture2D* candidateTexture = nullptr;
        if (create_device_for_adapter(adapter, &candidateDevice, &candidateContext)) {
            candidateDevice->QueryInterface(
                __uuidof(ID3D11Device1), reinterpret_cast<void**>(&candidateDevice1));
            if (open_sender_texture(candidateDevice, candidateDevice1,
                                    shareHandle, &candidateTexture)) {
                bridge->device = candidateDevice;
                bridge->device1 = candidateDevice1;
                bridge->context = candidateContext;
                bridge->senderTexture = candidateTexture;
                matched = true;
                fprintf(stderr,
                        "[SpoutBridge] receiver matched DXGI adapter %u (vendor=0x%04x device=0x%04x)\n",
                        index, desc.VendorId, desc.DeviceId);
            }
        }

        if (!matched) {
            if (candidateTexture) candidateTexture->Release();
            if (candidateDevice1) candidateDevice1->Release();
            if (candidateContext) candidateContext->Release();
            if (candidateDevice) candidateDevice->Release();
        }
        adapter->Release();
        if (matched) break;
    }
    factory->Release();
    return matched;
}

// Look up the latest sender info from the Spout sender map and keep our
// cached DXGI share handle / opened texture pointer in sync. Returns true
// if we have a live connection at return time.
static bool refresh_sender(SpoutReceiverBridge* bridge) {
    if (!bridge->senderName[0]) {
        bridge->connected = false;
        return false;
    }

    unsigned int w = 0;
    unsigned int h = 0;
    HANDLE       shareHandle = nullptr;
    DWORD        format = 0;

    // CheckSender returns false when the named sender is not published (not
    // yet started, or already closed).
    if (!bridge->senderNames->CheckSender(
            bridge->senderName, w, h, shareHandle, format)) {
        release_sender_texture(bridge);
        bridge->connected = false;
        return false;
    }

    // Dimension / format tracking — caller decides whether to signal a 2
    // "dimensions changed" return via staging compare.
    bridge->senderWidth  = w;
    bridge->senderHeight = h;
    bridge->senderFormat = format;

    // Re-open the shared texture only when the handle changed. Sender
    // publishes a fresh DXGI share handle on restart or resize.
    if (!bridge->senderTexture || shareHandle != bridge->cachedSenderHandle) {
        release_sender_texture(bridge);
        if (!shareHandle) {
            bridge->connected = false;
            return false;
        }
        if (bridge->device) {
            open_sender_texture(
                bridge->device, bridge->device1, shareHandle, &bridge->senderTexture);
        }
        if (!bridge->senderTexture &&
            !select_receiver_adapter(bridge, shareHandle)) {
            bridge->connected = false;
            return false;
        }
        bridge->cachedSenderHandle = shareHandle;
    }

    // Enable the named semaphore + mutex once we know who we're talking to.
    if (!bridge->frameCountEnabled) {
        bridge->frameCount->EnableFrameCount(bridge->senderName);
        bridge->frameCountEnabled = true;
    }
    if (!bridge->accessMutexCreated) {
        bridge->frameCount->CreateAccessMutex(bridge->senderName);
        bridge->accessMutexCreated = true;
    }

    bridge->connected = true;
    return true;
}

// Allocate or reallocate the NT-shared staging texture to match dims/format.
// Mints a fresh NT HANDLE via CreateSharedHandle and caches it for
// per-frame DuplicateHandle.
static bool ensure_nt_staging(SpoutReceiverBridge* bridge,
                              unsigned int width,
                              unsigned int height,
                              DWORD format) {
    if (bridge->ntStaging &&
        bridge->ntStagingWidth == width &&
        bridge->ntStagingHeight == height &&
        bridge->ntStagingFormat == format) {
        return true;
    }
    if (bridge->cachedNtHandle) {
        CloseHandle(bridge->cachedNtHandle);
        bridge->cachedNtHandle = nullptr;
    }
    if (bridge->ntStaging) {
        bridge->ntStaging->Release();
        bridge->ntStaging = nullptr;
    }
    if (!bridge->device || width == 0 || height == 0) return false;

    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = width;
    desc.Height = height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = static_cast<DXGI_FORMAT>(format);
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    // NT handle textures must combine NTHANDLE with SHARED or SHARED_KEYEDMUTEX
    // per D3D11 validation. We use the plain SHARED pairing so readers do not
    // have to acquire a keyed mutex on every frame — `CopyResource` inside
    // this file is the only writer, so no mutex sync is required between
    // writer and reader.
    desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE
                   | D3D11_RESOURCE_MISC_SHARED;

    HRESULT hr = bridge->device->CreateTexture2D(&desc, nullptr, &bridge->ntStaging);
    if (FAILED(hr)) {
        fprintf(stderr,
                "[SpoutBridge] ensure_nt_staging: CreateTexture2D failed hr=0x%08lx w=%u h=%u fmt=%lu\n",
                static_cast<unsigned long>(hr), width, height, static_cast<unsigned long>(format));
        bridge->ntStaging = nullptr;
        return false;
    }

    IDXGIResource1* dxgi = nullptr;
    hr = bridge->ntStaging->QueryInterface(
        __uuidof(IDXGIResource1), reinterpret_cast<void**>(&dxgi));
    if (FAILED(hr) || !dxgi) {
        fprintf(stderr,
                "[SpoutBridge] ensure_nt_staging: QueryInterface(IDXGIResource1) failed hr=0x%08lx\n",
                static_cast<unsigned long>(hr));
        bridge->ntStaging->Release();
        bridge->ntStaging = nullptr;
        return false;
    }

    HANDLE nt_handle = nullptr;
    hr = dxgi->CreateSharedHandle(
        nullptr,
        DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
        nullptr,
        &nt_handle);
    dxgi->Release();
    if (FAILED(hr) || !nt_handle) {
        fprintf(stderr,
                "[SpoutBridge] ensure_nt_staging: CreateSharedHandle failed hr=0x%08lx\n",
                static_cast<unsigned long>(hr));
        bridge->ntStaging->Release();
        bridge->ntStaging = nullptr;
        return false;
    }

    bridge->cachedNtHandle    = nt_handle;
    bridge->ntStagingWidth    = width;
    bridge->ntStagingHeight   = height;
    bridge->ntStagingFormat   = format;
    return true;
}

// Allocate or reallocate a CPU-mappable staging texture. Used to bring the
// sender texture into system memory for the RGBA readback path.
static bool ensure_cpu_staging(SpoutReceiverBridge* bridge,
                               unsigned int width,
                               unsigned int height,
                               DWORD format) {
    if (bridge->cpuStaging &&
        bridge->cpuStagingWidth == width &&
        bridge->cpuStagingHeight == height &&
        bridge->cpuStagingFormat == format) {
        return true;
    }
    if (bridge->cpuStaging) {
        bridge->cpuStaging->Release();
        bridge->cpuStaging = nullptr;
    }
    if (!bridge->device || width == 0 || height == 0) return false;

    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = width;
    desc.Height = height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = static_cast<DXGI_FORMAT>(format);
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_STAGING;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    // MiscFlags = 0, BindFlags = 0 (STAGING forbids both)

    HRESULT hr = bridge->device->CreateTexture2D(&desc, nullptr, &bridge->cpuStaging);
    if (FAILED(hr)) {
        bridge->cpuStaging = nullptr;
        return false;
    }
    bridge->cpuStagingWidth  = width;
    bridge->cpuStagingHeight = height;
    bridge->cpuStagingFormat = format;
    return true;
}

void* spout_receiver_create(const char* sender_name) {
    SpoutReceiverBridge* bridge = new SpoutReceiverBridge();
    memset(bridge, 0, sizeof(*bridge));

    if (sender_name && sender_name[0]) {
        strncpy(bridge->senderName, sender_name, sizeof(bridge->senderName) - 1);
    }

    bridge->senderNames = new spoutSenderNames();
    bridge->frameCount  = new spoutFrameCount();
    bridge->directX     = new spoutDirectX();

    // Device selection is deferred until the sender appears. Opening its
    // shared handle identifies the only adapter that can receive the texture.
    return bridge;
}

void spout_receiver_destroy(void* handle) {
    if (!handle) return;

    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);

    // Duplicates already handed to Electron are independent kernel handles
    // and stay valid until their owners close them.
    release_receiver_graphics(bridge);

    if (bridge->frameCount) {
        if (bridge->accessMutexCreated) bridge->frameCount->CloseAccessMutex();
        if (bridge->frameCountEnabled)  bridge->frameCount->DisableFrameCount();
    }

    delete bridge->senderNames;
    delete bridge->frameCount;
    delete bridge->directX;
    delete bridge;
}

int32_t spout_receiver_has_new_frame(void* handle) {
    if (!handle) return 0;
    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);
    return bridge->frameCount->IsFrameNew() ? 1 : 0;
}

// Return codes:
//   0 = frame received successfully
//   1 = no new frame (poll again later)
//   2 = dimensions changed (out_width/out_height have new dims, caller must re-allocate)
//  -1 = not connected / no sender
int32_t spout_receiver_receive_rgba(void* handle,
                                     uint8_t* out_buffer, uint32_t buffer_size,
                                     uint32_t* out_width, uint32_t* out_height) {
    if (!handle || !out_width || !out_height) return -1;

    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);

    if (!refresh_sender(bridge)) {
        return -1;
    }

    // Dimensions or format changed since last CPU staging — report 2 so the
    // caller re-sizes its output buffer.
    const uint32_t requiredSize = bridge->senderWidth * bridge->senderHeight * 4;
    const bool bufferOk = out_buffer && buffer_size >= requiredSize;
    if (bridge->cpuStagingWidth  != bridge->senderWidth  ||
        bridge->cpuStagingHeight != bridge->senderHeight ||
        bridge->cpuStagingFormat != bridge->senderFormat ||
        !bufferOk) {
        if (!ensure_cpu_staging(bridge, bridge->senderWidth, bridge->senderHeight,
                                bridge->senderFormat)) {
            return -1;
        }
        *out_width = bridge->senderWidth;
        *out_height = bridge->senderHeight;
        return 2;
    }

    // Drop the poll if Spout's semaphore says no new frame arrived.
    if (!bridge->frameCount->GetNewFrame()) return 1;

    // Acquire the sender's texture (keyed mutex or named mutex).
    if (!bridge->frameCount->CheckTextureAccess(bridge->senderTexture)) return 1;
    bridge->context->CopyResource(bridge->cpuStaging, bridge->senderTexture);
    bridge->context->Flush();
    bridge->frameCount->AllowTextureAccess(bridge->senderTexture);

    // Map + memcpy into caller buffer. CopyResource → Map is synchronous on
    // an Immediate context because the staging has CPU_ACCESS_READ.
    D3D11_MAPPED_SUBRESOURCE mapped = {};
    HRESULT hr = bridge->context->Map(bridge->cpuStaging, 0, D3D11_MAP_READ, 0, &mapped);
    if (FAILED(hr)) return -1;

    const uint32_t rowBytes = bridge->senderWidth * 4;
    const uint8_t* src = static_cast<const uint8_t*>(mapped.pData);
    for (unsigned int row = 0; row < bridge->senderHeight; ++row) {
        memcpy(out_buffer + row * rowBytes,
               src + row * mapped.RowPitch,
               rowBytes);
    }
    bridge->context->Unmap(bridge->cpuStaging, 0);

    *out_width = bridge->senderWidth;
    *out_height = bridge->senderHeight;
    return 0;
}

// Receive a frame as a shared NT-handle texture (GPU-to-GPU, zero CPU copy).
// On success, writes a new NT HANDLE into *out_nt_handle that the caller is
// responsible for passing to Electron's sharedTexture.importSharedTexture().
// Electron takes ownership of the handle and will close it when the imported
// texture is released. DO NOT close the handle yourself after a successful
// return.
//
// Return codes:
//   0 = frame received successfully
//   1 = no new frame (poll again later)
//   2 = dimensions changed, caller should re-poll
//  -1 = not connected / no sender
//  -2 = GPU operation failed (device lost, OOM, missing IDXGIResource1)
int32_t spout_receiver_receive_shared_texture(void* handle,
                                              void** out_nt_handle,
                                              uint32_t* out_width,
                                              uint32_t* out_height,
                                              uint32_t* out_format) {
    if (!handle || !out_nt_handle || !out_width || !out_height || !out_format) {
        return -1;
    }

    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);
    *out_nt_handle = nullptr;

    if (!refresh_sender(bridge)) {
        return -1;
    }

    if (bridge->ntStagingWidth  != bridge->senderWidth  ||
        bridge->ntStagingHeight != bridge->senderHeight ||
        bridge->ntStagingFormat != bridge->senderFormat ||
        !bridge->ntStaging) {
        if (!ensure_nt_staging(bridge, bridge->senderWidth, bridge->senderHeight,
                               bridge->senderFormat)) {
            return -2;
        }
        *out_width  = bridge->senderWidth;
        *out_height = bridge->senderHeight;
        return 2;
    }

    if (!bridge->frameCount->GetNewFrame()) return 1;

    if (!bridge->frameCount->CheckTextureAccess(bridge->senderTexture)) return 1;
    bridge->context->CopyResource(bridge->ntStaging, bridge->senderTexture);
    bridge->context->Flush();
    bridge->frameCount->AllowTextureAccess(bridge->senderTexture);

    HANDLE duplicate = nullptr;
    BOOL ok_dup = DuplicateHandle(
        GetCurrentProcess(),
        bridge->cachedNtHandle,
        GetCurrentProcess(),
        &duplicate,
        0,
        FALSE,
        DUPLICATE_SAME_ACCESS);
    if (!ok_dup || !duplicate) {
        return -2;
    }

    *out_nt_handle = duplicate;
    *out_width  = bridge->senderWidth;
    *out_height = bridge->senderHeight;
    *out_format = bridge->senderFormat;
    return 0;
}

// Close a raw NT HANDLE minted by spout_receiver_receive_shared_texture but
// never consumed by Electron's importSharedTexture. Use when the caller
// decides not to import the handle (e.g. target destroyed, import threw).
// Returns 0 on success, -1 if handle is invalid.
int32_t native_close_shared_handle(uintptr_t raw_handle) {
    if (raw_handle == 0) return -1;
    HANDLE nt_handle = reinterpret_cast<HANDLE>(raw_handle);
    if (!CloseHandle(nt_handle)) {
        DWORD err = GetLastError();
        fprintf(stderr,
                "[SpoutBridge] native_close_shared_handle: CloseHandle failed (err=%lu)\n",
                static_cast<unsigned long>(err));
        return -1;
    }
    return 0;
}

int32_t spout_receiver_is_connected(void* handle) {
    if (!handle) return 0;
    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);
    return bridge->connected ? 1 : 0;
}

uint32_t spout_receiver_get_width(void* handle) {
    if (!handle) return 0;
    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);
    return bridge->senderWidth;
}

uint32_t spout_receiver_get_height(void* handle) {
    if (!handle) return 0;
    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);
    return bridge->senderHeight;
}

// ============================================================
// Discovery
// ============================================================

int32_t spout_discovery_get_sender_count(void) {
    spoutSenderNames names;
    return names.GetSenderCount();
}

// Get sender name by index. Returns 0 on success, -1 on error.
// out_name must be at least 256 bytes.
int32_t spout_discovery_get_sender_name(int32_t index, char* out_name, uint32_t name_size) {
    if (!out_name || name_size < 256) return -1;

    spoutSenderNames names;
    char name[256];
    memset(name, 0, sizeof(name));

    if (!names.GetSender(index, name, 256)) {
        return -1;
    }

    strncpy(out_name, name, name_size - 1);
    out_name[name_size - 1] = '\0';
    return 0;
}

// ============================================================
// Consolidated Discovery
// ============================================================

// Returns a JSON string: [{"name":"..."},{"name":"..."}]
// Caller must free the returned string with spout_discovery_free_string().
char* spout_discovery_list_senders(void) {
    spoutSenderNames names;
    std::set<std::string> senderSet;
    names.GetSenderNames(&senderSet);

    std::string json = "[";
    bool first = true;
    for (const std::string& name : senderSet) {
        if (!first) json += ",";
        first = false;
        json += "{\"name\":\"";
        // Escape JSON special characters (including all control chars per JSON spec)
        for (char ch : name) {
            unsigned char c = static_cast<unsigned char>(ch);
            if (c == '"') {
                json += "\\\"";
            } else if (c == '\\') {
                json += "\\\\";
            } else if (c == '\n') {
                json += "\\n";
            } else if (c == '\r') {
                json += "\\r";
            } else if (c == '\t') {
                json += "\\t";
            } else if (c < 0x20) {
                char buf[8];
                snprintf(buf, sizeof(buf), "\\u%04x", c);
                json += buf;
            } else {
                json += ch;
            }
        }
        json += "\"}";
    }
    json += "]";

    return _strdup(json.c_str());
}

void spout_discovery_free_string(char* str) {
    if (str) free(str);
}

} // extern "C"
