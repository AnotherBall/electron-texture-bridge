// spout_bridge.cpp
// C++ bridge for Rust FFI to Spout2 SDK

#include <cstdint>
#include <cstring>
#include <d3d11_1.h>
#include "SpoutDX.h"

struct SpoutBridge {
    spoutDX sender;
    ID3D11Device* device;
    ID3D11Device1* device1;  // For OpenSharedResource1 (NT handles)
    ID3D11DeviceContext* context;
    unsigned int width;
    unsigned int height;
    bool initialized;
};

extern "C" {

void* spout_bridge_create(const char* name, uint32_t width, uint32_t height) {
    SpoutBridge* bridge = new SpoutBridge();
    bridge->width = width;
    bridge->height = height;
    bridge->initialized = false;
    bridge->device = nullptr;
    bridge->device1 = nullptr;
    bridge->context = nullptr;

    // Initialize DirectX 11
    if (!bridge->sender.OpenDirectX11()) {
        delete bridge;
        return nullptr;
    }

    bridge->device = bridge->sender.GetDX11Device();
    bridge->context = bridge->sender.GetDX11Context();

    // Get ID3D11Device1 interface for OpenSharedResource1 (required for NT handles)
    HRESULT hr = bridge->device->QueryInterface(__uuidof(ID3D11Device1), (void**)&bridge->device1);
    if (FAILED(hr)) {
        // Fallback: device1 will be null, we'll try OpenSharedResource instead
        bridge->device1 = nullptr;
    }

    // Set sender name
    if (!bridge->sender.SetSenderName(name)) {
        if (bridge->device1) bridge->device1->Release();
        bridge->sender.CloseDirectX11();
        delete bridge;
        return nullptr;
    }

    // Set format to BGRA (matches Chromium's compositor output)
    bridge->sender.SetSenderFormat(DXGI_FORMAT_B8G8R8A8_UNORM);

    bridge->initialized = true;
    return bridge;
}

void spout_bridge_destroy(void* handle) {
    if (!handle) return;

    SpoutBridge* bridge = static_cast<SpoutBridge*>(handle);
    bridge->sender.ReleaseSender();
    if (bridge->device1) {
        bridge->device1->Release();
        bridge->device1 = nullptr;
    }
    bridge->sender.CloseDirectX11();
    delete bridge;
}

int32_t spout_bridge_send(void* handle, int64_t shared_handle) {
    if (!handle) return -1;

    SpoutBridge* bridge = static_cast<SpoutBridge*>(handle);
    if (!bridge->initialized || !bridge->device) return -2;

    // Cast the shared handle from Electron's texture
    HANDLE nt_handle = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(shared_handle));
    if (!nt_handle) return -3;

    // Open the shared texture from the handle
    ID3D11Texture2D* shared_texture = nullptr;
    HRESULT hr;

    // Electron 40+ uses NT handles, which require OpenSharedResource1 (ID3D11Device1)
    if (bridge->device1) {
        hr = bridge->device1->OpenSharedResource1(
            nt_handle,
            __uuidof(ID3D11Texture2D),
            reinterpret_cast<void**>(&shared_texture)
        );
    } else {
        // Fallback to legacy DXGI handle method (for older Electron versions)
        hr = bridge->device->OpenSharedResource(
            nt_handle,
            __uuidof(ID3D11Texture2D),
            reinterpret_cast<void**>(&shared_texture)
        );
    }

    if (FAILED(hr) || !shared_texture) {
        return -4;
    }

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

} // extern "C"
