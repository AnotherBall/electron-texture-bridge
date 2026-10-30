// Render thread: paces itself on the view's display link, takes the newest
// Syphon frame and presents every refresh (like the Windows PreviewView),
// drawing only the background until the server appears. Reconnects on its
// own when the server goes away or has not appeared yet.

use super::ffi;
use super::view::RawView;
use super::SyphonSource;
use crate::mac::receiver::{NewestTexture, Receiver, SyphonTexture};
use crate::preview_layout::aspect_fit;
use crate::preview_state::{RetryGate, Shared, ViewState};
use crate::preview_stats::StatsTracker;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Upper bound on a vsync wait, so stop requests are seen promptly.
const FRAME_WAIT_MS: u32 = 100;
/// How long to sleep while hidden before re-checking the state.
const IDLE_WAIT: Duration = Duration::from_millis(100);
/// Back-off after a GPU failure before rebuilding resources.
const RETRY_DELAY: Duration = Duration::from_millis(250);
/// How often to look for the Syphon server while not connected.
const CONNECT_RETRY_NS: u64 = 500_000_000;

pub struct RenderThread {
    shared: Arc<Shared>,
    handle: Option<JoinHandle<()>>,
}

impl RenderThread {
    pub fn spawn(view: RawView, source: SyphonSource, shared: Arc<Shared>) -> Result<Self, String> {
        let thread_shared = shared.clone();
        let handle = std::thread::Builder::new()
            .name("preview-view".into())
            .spawn(move || Renderer::new(view, source, thread_shared).run())
            .map_err(|e| format!("Failed to spawn PreviewView render thread: {e}"))?;
        Ok(Self {
            shared,
            handle: Some(handle),
        })
    }

    /// Signal stop and join. Bounded: every wait in the loop has a timeout
    /// (vsync 100 ms, idle 100 ms, nextDrawable 1 s).
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

/// The Metal command queue + pipeline for the view's layer.
struct Gpu {
    handle: ffi::PreviewRendererHandle,
}

impl Gpu {
    fn new(view: RawView) -> Result<Self, String> {
        let handle = unsafe { ffi::preview_renderer_create(view.handle()) };
        if handle.is_null() {
            return Err("Failed to create the Metal pipeline".into());
        }
        Ok(Self { handle })
    }

    /// Ok(Some(drawable size)) when presented, Ok(None) when no drawable was free.
    fn draw(
        &self,
        clear_color: &[f32; 4],
        frame: Option<&SyphonTexture>,
        viewport: [f32; 4],
        flip_y: bool,
    ) -> Result<Option<(u32, u32)>, String> {
        let (mut width, mut height) = (0u32, 0u32);
        let texture = frame.map_or(std::ptr::null_mut(), |f| f.as_ptr());
        let ret = unsafe {
            ffi::preview_renderer_draw(
                self.handle,
                clear_color.as_ptr(),
                texture,
                viewport.as_ptr(),
                i32::from(flip_y),
                &mut width,
                &mut height,
            )
        };
        match ret {
            0 => Ok(Some((width, height))),
            1 => Ok(None),
            _ => Err("Metal draw failed".into()),
        }
    }
}

impl Drop for Gpu {
    fn drop(&mut self) {
        unsafe { ffi::preview_renderer_destroy(self.handle) };
    }
}

struct Renderer {
    view: RawView,
    source: SyphonSource,
    shared: Arc<Shared>,
    // Field order matters: the frame and receiver go before the pipeline.
    frame: Option<SyphonTexture>,
    receiver: Option<Receiver>,
    connect: RetryGate,
    gpu: Option<Gpu>,
    /// A draw happened since the last vsync wait.
    wait_pending: bool,
    /// Debug statistics; only this thread records into it.
    stats: StatsTracker,
    /// Origin of the monotonic timestamps fed to `stats`.
    clock: Instant,
}

impl Renderer {
    fn new(view: RawView, source: SyphonSource, shared: Arc<Shared>) -> Self {
        Self {
            view,
            source,
            shared,
            frame: None,
            receiver: None,
            connect: RetryGate::new(CONNECT_RETRY_NS),
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
            if self.wait_pending {
                self.view.wait_vsync(FRAME_WAIT_MS);
                self.wait_pending = false;
            }
            self.publish_stats();
            let view = self.shared.snapshot();
            if view.stop {
                break;
            }
            if !view.is_rendering() {
                self.shared.wait_for_change(view.generation, IDLE_WAIT);
                continue;
            }
            if let Err(e) = self.render_frame(&view) {
                eprintln!("[PreviewView] rebuilding GPU resources: {e}");
                self.gpu = None;
                self.shared.set_swapchain_size(0, 0);
                std::thread::sleep(RETRY_DELAY);
            }
        }
        self.disconnect();
        self.gpu = None;
        self.shared.set_swapchain_size(0, 0);
    }

    fn render_frame(&mut self, view: &ViewState) -> Result<(), String> {
        if self.gpu.is_none() {
            self.gpu = Some(Gpu::new(self.view)?);
        }
        self.receive_frame();

        let frame = self.frame.as_ref();
        // view.width/height is the drawable size the main thread set.
        let viewport = frame
            .and_then(|f| aspect_fit(view.width, view.height, f.width, f.height))
            .map_or([0.0; 4], |r| [r.x, r.y, r.width, r.height]);
        let gpu = self.gpu.as_ref().ok_or("GPU resources missing")?;
        let presented = gpu.draw(&view.clear_color, frame, viewport, self.source.flip_y)?;
        // Either way the next draw waits for a refresh.
        self.wait_pending = true;
        if let Some((width, height)) = presented {
            self.shared.set_swapchain_size(width, height);
            let now = self.now_ns();
            self.stats.record_present(now, frame.is_some());
        }
        Ok(())
    }

    fn receive_frame(&mut self) {
        self.ensure_receiver();
        let Some(receiver) = &self.receiver else {
            self.shared.set_connected(false);
            return;
        };
        match receiver.newest_texture() {
            NewestTexture::Frame {
                texture,
                frame_count,
            } => {
                self.shared.set_frame_size(texture.width, texture.height);
                self.frame = Some(texture);
                let now = self.now_ns();
                let count = i64::try_from(frame_count).unwrap_or(i64::MAX);
                self.stats.record_frame_received(now, count);
                self.shared.set_connected(true);
            }
            NewestTexture::NoNewFrame => self.shared.set_connected(true),
            NewestTexture::NotConnected => self.disconnect(),
        }
    }

    /// Look for the server at most every CONNECT_RETRY_NS while not connected.
    fn ensure_receiver(&mut self) {
        if self.receiver.is_some() || !self.connect.try_now(self.now_ns()) {
            return;
        }
        let source = &self.source;
        self.receiver = Receiver::with_device(
            source.server_uuid.as_deref(),
            Some(&source.name),
            source.app_name.as_deref(),
            self.view.device(),
        )
        .ok();
    }

    fn disconnect(&mut self) {
        if self.receiver.is_some() || self.frame.is_some() {
            self.stats.record_disconnected();
        }
        self.frame = None;
        self.receiver = None;
        self.shared.set_frame_size(0, 0);
        self.shared.set_connected(false);
    }
}
