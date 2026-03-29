// spout_bridge.cpp
// C++ bridge for Rust FFI to Spout2 SDK

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
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

// ============================================================
// Receiver
// ============================================================

struct SpoutReceiverBridge {
    spoutDX receiver;
    unsigned int width;
    unsigned int height;
    bool connected;
    char senderName[256];
};

void* spout_receiver_create(const char* sender_name) {
    SpoutReceiverBridge* bridge = new SpoutReceiverBridge();
    bridge->width = 0;
    bridge->height = 0;
    bridge->connected = false;
    memset(bridge->senderName, 0, sizeof(bridge->senderName));

    if (sender_name && sender_name[0]) {
        strncpy(bridge->senderName, sender_name, sizeof(bridge->senderName) - 1);
    }

    // Initialize DirectX 11
    if (!bridge->receiver.OpenDirectX11()) {
        delete bridge;
        return nullptr;
    }

    // Set the sender name to connect to (empty = first available)
    bridge->receiver.SetReceiverName(bridge->senderName);

    return bridge;
}

void spout_receiver_destroy(void* handle) {
    if (!handle) return;

    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);
    bridge->receiver.ReleaseReceiver();
    bridge->receiver.CloseDirectX11();
    delete bridge;
}

int32_t spout_receiver_has_new_frame(void* handle) {
    if (!handle) return 0;
    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);
    return bridge->receiver.IsFrameNew() ? 1 : 0;
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

    // Call ReceiveImage following the official pattern.
    // On first call (width=0, height=0, pixels=nullptr), it establishes connection.
    // Pass current cached dimensions; pixels can be null if not yet allocated.
    unsigned int w = bridge->width;
    unsigned int h = bridge->height;

    // Determine if we have a valid buffer to receive into
    uint32_t requiredSize = w * h * 4;
    bool hasValidBuffer = out_buffer && w > 0 && h > 0 && buffer_size >= requiredSize;

    // ReceiveImage: handles connection, sender detection, and pixel copy.
    // bRGB=false → native BGRA, bInvert=false → top-down.
    if (!bridge->receiver.ReceiveImage(
            hasValidBuffer ? out_buffer : nullptr, w, h, false, false)) {
        // ReceiveImage returns false when no sender found or sender closed
        bridge->connected = false;
        return -1;
    }

    // ReceiveImage returned true — check if this is an update notification
    if (bridge->receiver.IsUpdated()) {
        // First connection or sender changed — update dimensions
        bridge->width = bridge->receiver.GetSenderWidth();
        bridge->height = bridge->receiver.GetSenderHeight();
        bridge->connected = true;
        *out_width = bridge->width;
        *out_height = bridge->height;
        return 2;  // Signal caller to (re-)allocate buffer with new dimensions
    }

    // Normal frame — pixels were copied if we had a valid buffer
    if (!hasValidBuffer) {
        // We didn't have a buffer; shouldn't normally happen after initial handshake
        *out_width = w;
        *out_height = h;
        return 2;
    }

    bridge->connected = true;
    *out_width = bridge->width;
    *out_height = bridge->height;
    return 0;  // Frame received successfully
}

int32_t spout_receiver_is_connected(void* handle) {
    if (!handle) return 0;
    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);
    return bridge->receiver.IsConnected() ? 1 : 0;
}

uint32_t spout_receiver_get_width(void* handle) {
    if (!handle) return 0;
    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);
    return bridge->width;
}

uint32_t spout_receiver_get_height(void* handle) {
    if (!handle) return 0;
    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);
    return bridge->height;
}

// ============================================================
// Discovery
// ============================================================

int32_t spout_discovery_get_sender_count(void) {
    spoutDX spout;
    return spout.GetSenderCount();
}

// Get sender name by index. Returns 0 on success, -1 on error.
// out_name must be at least 256 bytes.
int32_t spout_discovery_get_sender_name(int32_t index, char* out_name, uint32_t name_size) {
    if (!out_name || name_size < 256) return -1;

    spoutDX spout;
    char name[256];
    memset(name, 0, sizeof(name));

    if (!spout.GetSender(index, name)) {
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
// Uses a single spoutDX instance for all queries (avoids N+1 DX context churn).
// Caller must free the returned string with spout_discovery_free_string().
char* spout_discovery_list_senders(void) {
    spoutDX spout;
    int count = spout.GetSenderCount();

    std::string json = "[";
    bool first = true;
    for (int i = 0; i < count; i++) {
        char name[256];
        memset(name, 0, sizeof(name));
        if (!spout.GetSender(i, name)) continue;

        if (!first) json += ",";
        first = false;
        json += "{\"name\":\"";
        // Escape JSON special characters (including all control chars per JSON spec)
        for (const char* p = name; *p; p++) {
            unsigned char c = static_cast<unsigned char>(*p);
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
                json += *p;
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
