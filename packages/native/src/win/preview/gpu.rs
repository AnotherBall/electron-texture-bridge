// D3D11 resources for the preview: device-level pipeline objects, the
// flip-model swapchain on the child window, and the local frame texture.
//
// Everything here is created and dropped on the render thread.

use crate::preview_layout::aspect_fit;
use crate::preview_stats::adapter_description;
use windows::core::{s, Interface, HRESULT, PCSTR};
use windows::Win32::Foundation::{CloseHandle, BOOL, HANDLE, HMODULE, HWND};
use windows::Win32::Graphics::Direct3D::Fxc::{D3DCompile, D3DCOMPILE_OPTIMIZATION_LEVEL3};
use windows::Win32::Graphics::Direct3D::{
    ID3DBlob, ID3DInclude, D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0,
    D3D_FEATURE_LEVEL_11_1, D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11BlendState, ID3D11ClassLinkage, ID3D11Device, ID3D11DeviceContext,
    ID3D11InputLayout, ID3D11PixelShader, ID3D11RenderTargetView, ID3D11SamplerState,
    ID3D11ShaderResourceView, ID3D11Texture2D, ID3D11VertexShader, D3D11_BIND_SHADER_RESOURCE,
    D3D11_BLEND_DESC, D3D11_BLEND_INV_SRC_ALPHA, D3D11_BLEND_ONE, D3D11_BLEND_OP_ADD,
    D3D11_COLOR_WRITE_ENABLE_ALL, D3D11_COMPARISON_NEVER, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_FILTER_MIN_MAG_MIP_LINEAR, D3D11_FLOAT32_MAX, D3D11_RENDER_TARGET_BLEND_DESC,
    D3D11_SAMPLER_DESC, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_TEXTURE_ADDRESS_CLAMP,
    D3D11_USAGE_DEFAULT, D3D11_VIEWPORT,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_ALPHA_MODE_IGNORE, DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    IDXGIDevice, IDXGIFactory2, IDXGIFactory5, IDXGIOutput, IDXGISwapChain2,
    DXGI_FEATURE_PRESENT_ALLOW_TEARING, DXGI_MWA_NO_WINDOW_CHANGES, DXGI_PRESENT,
    DXGI_PRESENT_ALLOW_TEARING, DXGI_SCALING_STRETCH, DXGI_SWAP_CHAIN_DESC1, DXGI_SWAP_CHAIN_FLAG,
    DXGI_SWAP_CHAIN_FLAG_ALLOW_TEARING, DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT,
    DXGI_SWAP_EFFECT_FLIP_DISCARD, DXGI_USAGE_RENDER_TARGET_OUTPUT,
};
use windows::Win32::System::Threading::WaitForSingleObject;

const BUFFER_COUNT: u32 = 2;
const SWAPCHAIN_FORMAT: DXGI_FORMAT = DXGI_FORMAT_B8G8R8A8_UNORM;

// Fullscreen triangle from SV_VertexID; the viewport limits it to the
// aspect-fit rectangle. The frame is premultiplied, so it is sampled as-is.
const SHADER_SOURCE: &str = r#"
struct VSOut {
    float4 pos : SV_Position;
    float2 uv  : TEXCOORD0;
};

VSOut vs_main(uint id : SV_VertexID) {
    VSOut o;
    float2 uv = float2((id << 1) & 2, id & 2);
    o.pos = float4(uv * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);
    o.uv = uv;
    return o;
}

Texture2D    frameTexture : register(t0);
SamplerState frameSampler : register(s0);

float4 ps_main(VSOut i) : SV_Target {
    return frameTexture.Sample(frameSampler, i.uv);
}
"#;

/// Compiled shader bytecode; device independent, so compiled once per thread.
/// Present sync interval: 1 = wait for every vertical blank (vsync).
pub const PRESENT_SYNC_INTERVAL: u32 = 1;

pub struct ShaderBytecode {
    vertex: Vec<u8>,
    pixel: Vec<u8>,
}

impl ShaderBytecode {
    pub fn compile() -> Result<Self, String> {
        Ok(Self {
            vertex: compile_shader(s!("vs_main"), s!("vs_4_0"))?,
            pixel: compile_shader(s!("ps_main"), s!("ps_4_0"))?,
        })
    }
}

fn compile_shader(entry: PCSTR, target: PCSTR) -> Result<Vec<u8>, String> {
    let mut code: Option<ID3DBlob> = None;
    let mut errors: Option<ID3DBlob> = None;
    let result = unsafe {
        D3DCompile(
            SHADER_SOURCE.as_ptr() as *const _,
            SHADER_SOURCE.len(),
            s!("preview.hlsl"),
            None,
            None::<&ID3DInclude>,
            entry,
            target,
            D3DCOMPILE_OPTIMIZATION_LEVEL3,
            0,
            &mut code,
            Some(&mut errors),
        )
    };
    if let Err(e) = result {
        let detail = errors.as_ref().map(blob_to_string).unwrap_or_default();
        return Err(format!("D3DCompile failed: {e} {detail}"));
    }
    code.map(|blob| blob_bytes(&blob).to_vec())
        .ok_or_else(|| "D3DCompile returned no bytecode".to_string())
}

fn blob_bytes(blob: &ID3DBlob) -> &[u8] {
    unsafe {
        std::slice::from_raw_parts(blob.GetBufferPointer() as *const u8, blob.GetBufferSize())
    }
}

fn blob_to_string(blob: &ID3DBlob) -> String {
    String::from_utf8_lossy(blob_bytes(blob))
        .trim_end_matches('\0')
        .to_string()
}

/// A hardware device for drawing the background before any sender appears.
pub fn create_default_device() -> Result<ID3D11Device, String> {
    let levels = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];
    let mut device: Option<ID3D11Device> = None;
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )
    }
    .map_err(|e| format!("D3D11CreateDevice failed: {e}"))?;
    device.ok_or_else(|| "D3D11CreateDevice returned no device".into())
}

/// The receiver's copy of the newest sender frame, plus its SRV.
pub struct FrameTexture {
    texture: ID3D11Texture2D,
    view: ID3D11ShaderResourceView,
    width: u32,
    height: u32,
}

impl FrameTexture {
    pub fn new(
        device: &ID3D11Device,
        width: u32,
        height: u32,
        format: u32,
    ) -> Result<Self, String> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT(format as i32),
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut texture: Option<ID3D11Texture2D> = None;
        unsafe { device.CreateTexture2D(&desc, None, Some(&mut texture)) }
            .map_err(|e| format!("CreateTexture2D ({width}x{height} fmt={format}) failed: {e}"))?;
        let texture = texture.ok_or("CreateTexture2D returned no texture")?;

        let mut view: Option<ID3D11ShaderResourceView> = None;
        unsafe { device.CreateShaderResourceView(&texture, None, Some(&mut view)) }
            .map_err(|e| format!("CreateShaderResourceView failed: {e}"))?;
        let view = view.ok_or("CreateShaderResourceView returned no view")?;

        Ok(Self {
            texture,
            view,
            width,
            height,
        })
    }

    pub fn texture(&self) -> &ID3D11Texture2D {
        &self.texture
    }
}

/// Flip-model swapchain bound to the child window.
struct Swapchain {
    chain: IDXGISwapChain2,
    waitable: HANDLE,
    target: Option<ID3D11RenderTargetView>,
    width: u32,
    height: u32,
}

impl Drop for Swapchain {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.waitable) };
    }
}

/// Device-level pipeline state plus the (lazily created) swapchain.
pub struct Gpu {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    vertex_shader: ID3D11VertexShader,
    pixel_shader: ID3D11PixelShader,
    sampler: ID3D11SamplerState,
    blend: ID3D11BlendState,
    swapchain: Option<Swapchain>,
    /// The system supports tearing presents (vsync off without waiting for
    /// DWM); the swapchain is then created with ALLOW_TEARING.
    tearing: bool,
}

impl Gpu {
    pub fn new(device: ID3D11Device, shaders: &ShaderBytecode) -> Result<Self, String> {
        let context = unsafe { device.GetImmediateContext() }
            .map_err(|e| format!("GetImmediateContext failed: {e}"))?;
        let tearing = supports_tearing(&device);
        Ok(Self {
            vertex_shader: create_vertex_shader(&device, &shaders.vertex)?,
            pixel_shader: create_pixel_shader(&device, &shaders.pixel)?,
            sampler: create_linear_clamp_sampler(&device)?,
            blend: create_premultiplied_blend(&device)?,
            device,
            context,
            swapchain: None,
            tearing,
        })
    }

    pub fn tearing_supported(&self) -> bool {
        self.tearing
    }

    fn swapchain_flags(&self) -> DXGI_SWAP_CHAIN_FLAG {
        let mut flags = DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT.0;
        if self.tearing {
            flags |= DXGI_SWAP_CHAIN_FLAG_ALLOW_TEARING.0;
        }
        DXGI_SWAP_CHAIN_FLAG(flags)
    }

    pub fn device(&self) -> &ID3D11Device {
        &self.device
    }

    /// Current swapchain size, (0, 0) before it exists.
    pub fn swapchain_size(&self) -> (u32, u32) {
        self.swapchain
            .as_ref()
            .map_or((0, 0), |sc| (sc.width, sc.height))
    }

    /// DXGI description of the adapter behind the device ("" on failure).
    pub fn adapter_name(&self) -> String {
        let Ok(dxgi) = self.device.cast::<IDXGIDevice>() else {
            return String::new();
        };
        let Ok(adapter) = (unsafe { dxgi.GetAdapter() }) else {
            return String::new();
        };
        match unsafe { adapter.GetDesc() } {
            Ok(desc) => adapter_description(&desc.Description),
            Err(_) => String::new(),
        }
    }

    pub fn uses_device(&self, device: &ID3D11Device) -> bool {
        self.device.as_raw() == device.as_raw()
    }

    /// Create the swapchain on first use, or resize it to `width` x `height`.
    /// Returns true when a new swapchain was created.
    pub fn ensure_swapchain(
        &mut self,
        hwnd: usize,
        width: u32,
        height: u32,
    ) -> Result<bool, String> {
        match &self.swapchain {
            Some(sc) if sc.width == width && sc.height == height => Ok(false),
            Some(_) => self.resize_swapchain(width, height).map(|_| false),
            None => {
                self.swapchain = Some(self.create_swapchain(hwnd, width, height)?);
                Ok(true)
            }
        }
    }

    /// Wait until DXGI can take another frame (vsync pacing, latency 1).
    pub fn wait_for_frame(&self, timeout_ms: u32) {
        if let Some(sc) = &self.swapchain {
            let _ = unsafe { WaitForSingleObject(sc.waitable, timeout_ms) };
        }
    }

    /// Clear to `clear_color` and draw `frame` aspect-fit and centred.
    pub fn draw(&self, clear_color: &[f32; 4], frame: Option<&FrameTexture>) -> Result<(), String> {
        let sc = self.swapchain.as_ref().ok_or("draw without a swapchain")?;
        let target = sc.target.as_ref().ok_or("draw without a render target")?;
        unsafe {
            self.context
                .OMSetRenderTargets(Some(&[Some(target.clone())]), None);
            self.context.ClearRenderTargetView(target, clear_color);
        }
        if let Some(frame) = frame {
            if let Some(rect) = aspect_fit(sc.width, sc.height, frame.width, frame.height) {
                self.draw_frame(frame, rect);
            }
        }
        Ok(())
    }

    fn draw_frame(&self, frame: &FrameTexture, rect: crate::preview_layout::FitRect) {
        let viewport = D3D11_VIEWPORT {
            TopLeftX: rect.x,
            TopLeftY: rect.y,
            Width: rect.width,
            Height: rect.height,
            MinDepth: 0.0,
            MaxDepth: 1.0,
        };
        unsafe {
            let ctx = &self.context;
            ctx.RSSetViewports(Some(&[viewport]));
            ctx.IASetInputLayout(None::<&ID3D11InputLayout>);
            ctx.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            ctx.VSSetShader(&self.vertex_shader, None);
            ctx.PSSetShader(&self.pixel_shader, None);
            ctx.PSSetShaderResources(0, Some(&[Some(frame.view.clone())]));
            ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            ctx.OMSetBlendState(&self.blend, None, 0xffff_ffff);
            ctx.Draw(3, 0);
            // Unbind so the next CopyResource into the frame texture is clean.
            ctx.PSSetShaderResources(0, Some(&[None]));
        }
    }

    /// Present with `PRESENT_SYNC_INTERVAL` when `vsync`, else at once
    /// (sync interval 0, tearing allowed when supported). Returns the raw
    /// HRESULT so the caller can tell device loss from status codes such as
    /// occlusion.
    pub fn present(&self, vsync: bool) -> HRESULT {
        let Some(sc) = &self.swapchain else {
            return HRESULT(0);
        };
        let (interval, flags) = if vsync {
            (PRESENT_SYNC_INTERVAL, DXGI_PRESENT(0))
        } else if self.tearing {
            (0, DXGI_PRESENT_ALLOW_TEARING)
        } else {
            (0, DXGI_PRESENT(0))
        };
        unsafe { sc.chain.Present(interval, flags) }
    }

    fn create_swapchain(&self, hwnd: usize, width: u32, height: u32) -> Result<Swapchain, String> {
        let hwnd = HWND(hwnd as *mut _);
        let factory = self.factory()?;
        let desc = DXGI_SWAP_CHAIN_DESC1 {
            Width: width,
            Height: height,
            Format: SWAPCHAIN_FORMAT,
            Stereo: BOOL(0),
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
            BufferCount: BUFFER_COUNT,
            Scaling: DXGI_SCALING_STRETCH,
            SwapEffect: DXGI_SWAP_EFFECT_FLIP_DISCARD,
            AlphaMode: DXGI_ALPHA_MODE_IGNORE,
            Flags: self.swapchain_flags().0 as u32,
        };
        let chain = unsafe {
            factory.CreateSwapChainForHwnd(&self.device, hwnd, &desc, None, None::<&IDXGIOutput>)
        }
        .map_err(|e| format!("CreateSwapChainForHwnd failed: {e}"))?;
        // Keep DXGI from hooking Alt+Enter etc. on Electron's window.
        let _ = unsafe { factory.MakeWindowAssociation(hwnd, DXGI_MWA_NO_WINDOW_CHANGES) };

        let chain: IDXGISwapChain2 = chain
            .cast()
            .map_err(|e| format!("IDXGISwapChain2 unavailable: {e}"))?;
        unsafe { chain.SetMaximumFrameLatency(1) }
            .map_err(|e| format!("SetMaximumFrameLatency failed: {e}"))?;
        let waitable = unsafe { chain.GetFrameLatencyWaitableObject() };

        let mut swapchain = Swapchain {
            chain,
            waitable,
            target: None,
            width,
            height,
        };
        swapchain.target = Some(render_target_for(&self.device, &swapchain.chain)?);
        Ok(swapchain)
    }

    fn resize_swapchain(&mut self, width: u32, height: u32) -> Result<(), String> {
        let flags = self.swapchain_flags();
        // Every back-buffer reference must be gone before ResizeBuffers.
        unsafe {
            self.context.OMSetRenderTargets(None, None);
            self.context.Flush();
        }
        let sc = self
            .swapchain
            .as_mut()
            .ok_or("resize without a swapchain")?;
        sc.target = None;
        unsafe {
            sc.chain
                .ResizeBuffers(BUFFER_COUNT, width, height, SWAPCHAIN_FORMAT, flags)
        }
        .map_err(|e| format!("ResizeBuffers ({width}x{height}) failed: {e}"))?;
        sc.width = width;
        sc.height = height;
        sc.target = Some(render_target_for(&self.device, &sc.chain)?);
        Ok(())
    }

    fn factory(&self) -> Result<IDXGIFactory2, String> {
        let dxgi: IDXGIDevice = self
            .device
            .cast()
            .map_err(|e| format!("IDXGIDevice unavailable: {e}"))?;
        let adapter =
            unsafe { dxgi.GetAdapter() }.map_err(|e| format!("GetAdapter failed: {e}"))?;
        unsafe { adapter.GetParent() }.map_err(|e| format!("IDXGIFactory2 unavailable: {e}"))
    }
}

impl Drop for Gpu {
    fn drop(&mut self) {
        // Flush deferred destruction so the HWND is free for a new swapchain
        // (only one flip-model swapchain may own a window at a time).
        unsafe {
            self.context.ClearState();
            self.context.Flush();
        }
    }
}

// With FLIP_DISCARD on D3D11, buffer 0 always aliases the current back
// buffer, so one view stays valid until the next ResizeBuffers.
fn render_target_for(
    device: &ID3D11Device,
    chain: &IDXGISwapChain2,
) -> Result<ID3D11RenderTargetView, String> {
    let buffer: ID3D11Texture2D =
        unsafe { chain.GetBuffer(0) }.map_err(|e| format!("GetBuffer failed: {e}"))?;
    let mut target: Option<ID3D11RenderTargetView> = None;
    unsafe { device.CreateRenderTargetView(&buffer, None, Some(&mut target)) }
        .map_err(|e| format!("CreateRenderTargetView failed: {e}"))?;
    target.ok_or_else(|| "CreateRenderTargetView returned no view".into())
}

fn create_vertex_shader(
    device: &ID3D11Device,
    bytecode: &[u8],
) -> Result<ID3D11VertexShader, String> {
    let mut shader: Option<ID3D11VertexShader> = None;
    unsafe { device.CreateVertexShader(bytecode, None::<&ID3D11ClassLinkage>, Some(&mut shader)) }
        .map_err(|e| format!("CreateVertexShader failed: {e}"))?;
    shader.ok_or_else(|| "CreateVertexShader returned no shader".into())
}

fn create_pixel_shader(
    device: &ID3D11Device,
    bytecode: &[u8],
) -> Result<ID3D11PixelShader, String> {
    let mut shader: Option<ID3D11PixelShader> = None;
    unsafe { device.CreatePixelShader(bytecode, None::<&ID3D11ClassLinkage>, Some(&mut shader)) }
        .map_err(|e| format!("CreatePixelShader failed: {e}"))?;
    shader.ok_or_else(|| "CreatePixelShader returned no shader".into())
}

fn create_linear_clamp_sampler(device: &ID3D11Device) -> Result<ID3D11SamplerState, String> {
    let desc = D3D11_SAMPLER_DESC {
        Filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR,
        AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
        AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
        AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
        MipLODBias: 0.0,
        MaxAnisotropy: 1,
        ComparisonFunc: D3D11_COMPARISON_NEVER,
        BorderColor: [0.0; 4],
        MinLOD: 0.0,
        MaxLOD: D3D11_FLOAT32_MAX,
    };
    let mut sampler: Option<ID3D11SamplerState> = None;
    unsafe { device.CreateSamplerState(&desc, Some(&mut sampler)) }
        .map_err(|e| format!("CreateSamplerState failed: {e}"))?;
    sampler.ok_or_else(|| "CreateSamplerState returned no sampler".into())
}

/// Premultiplied-alpha "over": out = src + dst * (1 - src.a).
fn create_premultiplied_blend(device: &ID3D11Device) -> Result<ID3D11BlendState, String> {
    let mut desc = D3D11_BLEND_DESC::default();
    desc.RenderTarget[0] = D3D11_RENDER_TARGET_BLEND_DESC {
        BlendEnable: BOOL(1),
        SrcBlend: D3D11_BLEND_ONE,
        DestBlend: D3D11_BLEND_INV_SRC_ALPHA,
        BlendOp: D3D11_BLEND_OP_ADD,
        SrcBlendAlpha: D3D11_BLEND_ONE,
        DestBlendAlpha: D3D11_BLEND_INV_SRC_ALPHA,
        BlendOpAlpha: D3D11_BLEND_OP_ADD,
        RenderTargetWriteMask: D3D11_COLOR_WRITE_ENABLE_ALL.0 as u8,
    };
    let mut blend: Option<ID3D11BlendState> = None;
    unsafe { device.CreateBlendState(&desc, Some(&mut blend)) }
        .map_err(|e| format!("CreateBlendState failed: {e}"))?;
    blend.ok_or_else(|| "CreateBlendState returned no blend state".into())
}

/// Whether DXGI allows tearing presents on this system (Windows 10 1607+
/// with a supporting driver).
fn supports_tearing(device: &ID3D11Device) -> bool {
    let Ok(dxgi) = device.cast::<IDXGIDevice>() else {
        return false;
    };
    let Ok(adapter) = (unsafe { dxgi.GetAdapter() }) else {
        return false;
    };
    let Ok(factory) = (unsafe { adapter.GetParent::<IDXGIFactory5>() }) else {
        return false;
    };
    let mut allowed = BOOL(0);
    unsafe {
        factory.CheckFeatureSupport(
            DXGI_FEATURE_PRESENT_ALLOW_TEARING,
            &mut allowed as *mut BOOL as *mut _,
            std::mem::size_of::<BOOL>() as u32,
        )
    }
    .is_ok()
        && allowed.as_bool()
}
