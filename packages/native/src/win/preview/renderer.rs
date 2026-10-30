// Render thread: paces itself on the swapchain's frame-latency waitable
// object, copies the newest Spout frame and presents every refresh (like
// OBS's preview), drawing only the background until a sender appears.

use super::gpu::{create_default_device, FrameTexture, Gpu, ShaderBytecode, PRESENT_SYNC_INTERVAL};
use super::state::{Shared, ViewState};
use super::window::is_window_alive;
use crate::preview_stats::{is_vsync, StatsTracker};
use crate::win::receiver::{CopyFrameResult, Receiver};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use windows::Win32::Foundation::DXGI_STATUS_OCCLUDED;
use windows::Win32::Graphics::Direct3D11::ID3D11Device;

/// Upper bound on a vsync wait, so stop requests are seen promptly.
const FRAME_WAIT_MS: u32 = 100;
/// How long to sleep while hidden before re-checking the state.
const IDLE_WAIT: Duration = Duration::from_millis(100);
/// Back-off after a GPU failure before rebuilding resources.
const RETRY_DELAY: Duration = Duration::from_millis(250);
/// Back-off while the window is occluded (Present does not block then).
const OCCLUDED_DELAY: Duration = Duration::from_millis(16);

pub struct RenderThread {
    shared: Arc<Shared>,
    handle: Option<JoinHandle<()>>,
}

impl RenderThread {
    pub fn spawn(hwnd: usize, receiver: Receiver, shared: Arc<Shared>) -> Result<Self, String> {
        let thread_shared = shared.clone();
        let handle = std::thread::Builder::new()
            .name("preview-view".into())
            .spawn(move || run(hwnd, receiver, thread_shared))
            .map_err(|e| format!("Failed to spawn PreviewView render thread: {e}"))?;
        Ok(Self {
            shared,
            handle: Some(handle),
        })
    }

    /// Signal stop and join. The thread releases the swapchain before exiting.
    pub fn stop(&mut self) {
        self.shared.update(|v| v.stop = true);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for RenderThread {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run(hwnd: usize, receiver: Receiver, shared: Arc<Shared>) {
    let shaders = match ShaderBytecode::compile() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[PreviewView] {e}");
            return;
        }
    };
    Renderer::new(hwnd, receiver, shared, shaders).run();
}

struct Renderer {
    hwnd: usize,
    receiver: Receiver,
    shared: Arc<Shared>,
    shaders: ShaderBytecode,
    // Field order matters: the frame texture is released before the device.
    frame: Option<FrameTexture>,
    has_frame: bool,
    /// Sender description whose texture could not be created; skip retries.
    unsupported: Option<(u32, u32, u32)>,
    gpu: Option<Gpu>,
    /// A present happened (or a fresh swapchain exists) since the last wait.
    wait_pending: bool,
    /// Debug statistics; only this thread records into it.
    stats: StatsTracker,
    /// Origin of the monotonic timestamps fed to `stats`.
    clock: Instant,
}

impl Renderer {
    fn new(hwnd: usize, receiver: Receiver, shared: Arc<Shared>, shaders: ShaderBytecode) -> Self {
        Self {
            hwnd,
            receiver,
            shared,
            shaders,
            frame: None,
            has_frame: false,
            unsupported: None,
            gpu: None,
            wait_pending: false,
            stats: StatsTracker::new(),
            clock: Instant::now(),
        }
    }

    fn now_ns(&self) -> u64 {
        self.clock.elapsed().as_nanos() as u64
    }

    /// Summarise the window and hand it to JS through atomics (never blocks).
    fn publish_stats(&mut self) {
        let now = self.now_ns();
        let snapshot = self.stats.snapshot(now);
        self.shared.publish_stats(&snapshot);
    }

    fn run(&mut self) {
        loop {
            self.wait_for_vsync();
            self.publish_stats();
            let view = self.shared.snapshot();
            if view.stop || !is_window_alive(self.hwnd) {
                break;
            }
            if !view.is_rendering() {
                self.shared.wait_for_change(view.generation, IDLE_WAIT);
                continue;
            }
            if let Err(e) = self.render_frame(&view) {
                eprintln!("[PreviewView] rebuilding GPU resources: {e}");
                self.reset_gpu();
                std::thread::sleep(RETRY_DELAY);
            }
        }
        self.reset_gpu();
    }

    fn wait_for_vsync(&mut self) {
        if !self.wait_pending {
            return;
        }
        if let Some(gpu) = &self.gpu {
            gpu.wait_for_frame(FRAME_WAIT_MS);
        }
        self.wait_pending = false;
    }

    fn render_frame(&mut self, view: &ViewState) -> Result<(), String> {
        self.ensure_gpu()?;
        self.receive_frame()?;

        let gpu = self.gpu.as_mut().ok_or("GPU resources missing")?;
        let created = gpu.ensure_swapchain(self.hwnd, view.width, view.height)?;
        let (sw, sh) = gpu.swapchain_size();
        self.shared.set_swapchain_size(sw, sh);
        if created {
            // A new swapchain starts signalled; consume that before presenting.
            self.wait_pending = true;
            return Ok(());
        }
        let frame = if self.has_frame {
            self.frame.as_ref()
        } else {
            None
        };
        gpu.draw(&view.clear_color, frame)?;
        self.present()
    }

    fn present(&mut self) -> Result<(), String> {
        let gpu = self.gpu.as_ref().ok_or("GPU resources missing")?;
        let hr = gpu.present();
        self.wait_pending = true;
        if hr == DXGI_STATUS_OCCLUDED {
            std::thread::sleep(OCCLUDED_DELAY);
            return Ok(());
        }
        if hr.is_err() {
            let reason = unsafe { gpu.device().GetDeviceRemovedReason() };
            return Err(format!("Present failed: {hr:?} (device: {reason:?})"));
        }
        let now = self.now_ns();
        self.stats.record_present(now, self.has_frame);
        Ok(())
    }

    /// Use the receiver's device once it has one, else a default device so
    /// the background shows before a sender appears.
    fn ensure_gpu(&mut self) -> Result<(), String> {
        if self.gpu.is_some() {
            return Ok(());
        }
        let device = match self.receiver.device() {
            Some(device) => device,
            None => create_default_device()?,
        };
        self.install_gpu(device)
    }

    fn install_gpu(&mut self, device: ID3D11Device) -> Result<(), String> {
        let gpu = Gpu::new(device, &self.shaders)?;
        self.shared.set_adapter_name(gpu.adapter_name());
        self.shared.set_vsync(is_vsync(PRESENT_SYNC_INTERVAL));
        self.gpu = Some(gpu);
        Ok(())
    }

    /// Rebuild on the receiver's device when it differs from ours (first
    /// connection, or the sender moved to another adapter).
    fn follow_receiver_device(&mut self) -> Result<(), String> {
        let Some(device) = self.receiver.device() else {
            return Ok(());
        };
        if self.gpu.as_ref().is_some_and(|g| g.uses_device(&device)) {
            return Ok(());
        }
        self.reset_gpu();
        self.install_gpu(device)
    }

    fn receive_frame(&mut self) -> Result<(), String> {
        let mut result = self
            .receiver
            .copy_frame(self.frame.as_ref().map(|f| f.texture()));
        self.follow_receiver_device()?;

        if let CopyFrameResult::NeedsTexture {
            width,
            height,
            format,
        } = result
        {
            if self.recreate_frame_texture(width, height, format) {
                result = self
                    .receiver
                    .copy_frame(self.frame.as_ref().map(|f| f.texture()));
            }
        }

        match result {
            CopyFrameResult::Copied => {
                self.has_frame = true;
                let now = self.now_ns();
                self.stats
                    .record_frame_received(now, self.receiver.frame_count());
            }
            CopyFrameResult::NotConnected => {
                self.has_frame = false;
                self.stats.record_disconnected();
                self.shared.set_frame_size(0, 0);
            }
            CopyFrameResult::NoNewFrame | CopyFrameResult::NeedsTexture { .. } => {}
        }
        self.shared
            .set_connected(result != CopyFrameResult::NotConnected);
        Ok(())
    }

    /// (Re)create the local frame texture on the receiver's device. Returns
    /// false when it could not be created (logged once per description).
    fn recreate_frame_texture(&mut self, width: u32, height: u32, format: u32) -> bool {
        let Some(gpu) = &self.gpu else {
            return false;
        };
        if width == 0 || height == 0 || self.unsupported == Some((width, height, format)) {
            return false;
        }
        self.frame = None;
        self.has_frame = false;
        self.shared.set_frame_size(0, 0);
        match FrameTexture::new(gpu.device(), width, height, format) {
            Ok(frame) => {
                self.frame = Some(frame);
                self.unsupported = None;
                self.shared.set_frame_size(width, height);
                true
            }
            Err(e) => {
                eprintln!("[PreviewView] {e}");
                self.unsupported = Some((width, height, format));
                false
            }
        }
    }

    fn reset_gpu(&mut self) {
        self.frame = None;
        self.has_frame = false;
        self.gpu = None;
        self.wait_pending = false;
        self.shared.set_frame_size(0, 0);
        self.shared.set_swapchain_size(0, 0);
    }
}
