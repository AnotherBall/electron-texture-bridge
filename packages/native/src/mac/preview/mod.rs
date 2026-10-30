// Native preview view (macOS): a layer-backed child NSView with a
// CAMetalLayer inside an Electron window's content view that shows the
// newest frame of a Syphon server, presented once per display refresh.
//
// AppKit calls run synchronously on the caller's (Electron main) thread;
// Metal work runs on a dedicated render thread that shares state through
// `preview_state::Shared`, like the Windows implementation.

mod ffi;
mod renderer;
mod view;

use super::ffi::syphon_directory_warm_up;
use crate::preview_layout::{should_show, Bounds};
use crate::preview_state::Shared;
use crate::preview_stats::PreviewStatsSnapshot;
use renderer::RenderThread;
use std::sync::Arc;
use view::NativeView;

/// Which Syphon server to show.
#[derive(Debug, Clone)]
pub struct SyphonSource {
    /// Server name (used when `server_uuid` is None).
    pub name: String,
    /// Server UUID; takes priority over name / app.
    pub server_uuid: Option<String>,
    /// Application name filter (with `name`).
    pub app_name: Option<String>,
    /// Draw texture row 0 at the bottom (Syphon's bottom-left origin).
    pub flip_y: bool,
}

pub struct PreviewView {
    // Drop order: the render thread goes before the view.
    renderer: Option<RenderThread>,
    view: Option<NativeView>,
    shared: Arc<Shared>,
    bounds: Bounds,
    visible: bool,
}

impl PreviewView {
    /// Create a hidden preview inside `parent` (raw `NSView*`). Main thread.
    pub fn new(parent: usize, source: SyphonSource) -> Result<Self, String> {
        // The directory's notifications register from the main run loop; the
        // render thread then connects from its own thread.
        unsafe { syphon_directory_warm_up() };
        let view = NativeView::create(parent)?;
        let shared = Arc::new(Shared::new());
        shared.set_adapter_name(view.adapter_name());
        shared.set_vsync(view.vsync_enabled());
        eprintln!(
            "[PreviewView] pacing with {} for \"{}\"",
            view.display_link_name(),
            source.server_uuid.as_deref().unwrap_or(&source.name)
        );
        let renderer = RenderThread::spawn(view.raw(), source, shared.clone())?;
        Ok(Self {
            renderer: Some(renderer),
            view: Some(view),
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
        if let Some(view) = &self.view {
            view.set_bounds(bounds);
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

    /// Recorded only: the macOS view keeps `displaySyncEnabled` on for now.
    pub fn set_vsync(&mut self, vsync: bool) {
        self.shared.update(|v| v.vsync = vsync);
    }

    pub fn stats(&self) -> PreviewStatsSnapshot {
        self.shared.stats()
    }

    /// Stop the render thread, then remove the view. Idempotent.
    pub fn destroy(&mut self) {
        if let Some(mut renderer) = self.renderer.take() {
            renderer.stop();
        }
        self.view.take();
    }

    fn apply_visibility(&self) {
        if let Some(view) = &self.view {
            view.set_shown(should_show(self.visible, self.bounds));
        }
    }
}

impl Drop for PreviewView {
    fn drop(&mut self) {
        self.destroy();
    }
}
