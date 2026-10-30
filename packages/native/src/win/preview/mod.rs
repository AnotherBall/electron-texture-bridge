// Native preview view: a child window inside an Electron BrowserWindow that
// shows the newest frame of a Spout sender through its own vsync-paced
// D3D11 flip-model swapchain.
//
// Window calls run on the caller's (UI) thread; GPU work runs on a
// dedicated render thread that shares state through `state::Shared`.

mod gpu;
mod renderer;
use crate::preview_state as state;
mod window;

use super::receiver::Receiver;
use crate::preview_layout::{should_show, Bounds};
use crate::preview_stats::PreviewStatsSnapshot;
use renderer::RenderThread;
use state::Shared;
use std::sync::Arc;
use window::ChildWindow;

pub struct PreviewView {
    // Drop order: the render thread (and its swapchain) goes before the window.
    renderer: Option<RenderThread>,
    window: Option<ChildWindow>,
    shared: Arc<Shared>,
    bounds: Bounds,
    visible: bool,
}

impl PreviewView {
    /// Create a hidden preview inside `parent` (raw HWND) for `sender_name`.
    pub fn new(parent: usize, sender_name: &str) -> Result<Self, String> {
        // A second, independent receiver: the render thread owns it.
        let receiver = Receiver::new(sender_name)?;
        let window = ChildWindow::create(parent)?;
        let shared = Arc::new(Shared::new());
        let renderer = RenderThread::spawn(window.raw(), receiver, shared.clone())?;
        Ok(Self {
            renderer: Some(renderer),
            window: Some(window),
            shared,
            bounds: Bounds::default(),
            visible: false,
        })
    }

    pub fn set_bounds(&mut self, bounds: Bounds) {
        self.bounds = bounds;
        self.shared.update(|v| {
            v.width = bounds.width;
            v.height = bounds.height;
        });
        if let Some(window) = &self.window {
            window.set_bounds(bounds);
        }
        self.apply_visibility();
    }

    pub fn set_visible(&mut self, visible: bool) {
        self.visible = visible;
        self.shared.update(|v| v.visible = visible);
        self.apply_visibility();
    }

    pub fn set_background(&mut self, clear_color: [f32; 4]) {
        self.shared.update(|v| v.clear_color = clear_color);
    }

    pub fn set_vsync(&mut self, vsync: bool) {
        self.shared.update(|v| v.vsync = vsync);
    }

    pub fn stats(&self) -> PreviewStatsSnapshot {
        self.shared.stats()
    }

    /// Stop the render thread, then destroy the window. Idempotent.
    pub fn destroy(&mut self) {
        if let Some(mut renderer) = self.renderer.take() {
            renderer.stop();
        }
        self.window.take();
    }

    fn apply_visibility(&self) {
        if let Some(window) = &self.window {
            window.set_shown(should_show(self.visible, self.bounds));
        }
    }
}

impl Drop for PreviewView {
    fn drop(&mut self) {
        self.destroy();
    }
}
