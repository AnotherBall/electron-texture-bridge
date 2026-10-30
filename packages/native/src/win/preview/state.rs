// State shared between the JS-facing PreviewView and its render thread.

use crate::preview_stats::{PreviewStatsSnapshot, WindowedStats};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

/// What the render thread should draw, written by JS calls.
#[derive(Debug, Clone, Copy)]
pub struct ViewState {
    /// Swapchain size in physical pixels (0 = hidden).
    pub width: u32,
    pub height: u32,
    pub visible: bool,
    pub clear_color: [f32; 4],
    pub stop: bool,
    /// Bumped on every update so the idle thread can tell it missed nothing.
    pub generation: u64,
}

impl ViewState {
    /// The thread presents only while the view is on screen with a real size.
    pub fn is_rendering(&self) -> bool {
        self.visible && self.width > 0 && self.height > 0
    }
}

/// Windowed figures stored as atomics so the render thread never blocks
/// publishing them. Fields may tear between each other; fine for debug stats.
#[derive(Default)]
struct PublishedStats {
    present_fps: AtomicU64,
    received_fps: AtomicU64,
    repeated_fps: AtomicU64,
    present_interval_avg_ms: AtomicU64,
    present_interval_max_ms: AtomicU64,
    presented: AtomicU64,
    received: AtomicU64,
    skipped: AtomicU64,
}

fn store_f64(a: &AtomicU64, v: f64) {
    a.store(v.to_bits(), Ordering::Relaxed);
}

fn load_f64(a: &AtomicU64) -> f64 {
    f64::from_bits(a.load(Ordering::Relaxed))
}

impl PublishedStats {
    fn store(&self, s: &WindowedStats) {
        store_f64(&self.present_fps, s.present_fps);
        store_f64(&self.received_fps, s.received_fps);
        store_f64(&self.repeated_fps, s.repeated_fps);
        store_f64(&self.present_interval_avg_ms, s.present_interval_avg_ms);
        store_f64(&self.present_interval_max_ms, s.present_interval_max_ms);
        self.presented.store(s.presented, Ordering::Relaxed);
        self.received.store(s.received, Ordering::Relaxed);
        self.skipped.store(s.skipped, Ordering::Relaxed);
    }

    fn load(&self) -> WindowedStats {
        WindowedStats {
            present_fps: load_f64(&self.present_fps),
            received_fps: load_f64(&self.received_fps),
            repeated_fps: load_f64(&self.repeated_fps),
            present_interval_avg_ms: load_f64(&self.present_interval_avg_ms),
            present_interval_max_ms: load_f64(&self.present_interval_max_ms),
            presented: self.presented.load(Ordering::Relaxed),
            received: self.received.load(Ordering::Relaxed),
            skipped: self.skipped.load(Ordering::Relaxed),
        }
    }
}

pub struct Shared {
    view: Mutex<ViewState>,
    changed: Condvar,
    stats: PublishedStats,
    connected: AtomicBool,
    vsync: AtomicBool,
    swapchain_width: AtomicU32,
    swapchain_height: AtomicU32,
    frame_width: AtomicU32,
    frame_height: AtomicU32,
    /// Written only when the render thread (re)creates its device.
    adapter_name: Mutex<String>,
}

impl Shared {
    pub fn new() -> Self {
        Self {
            view: Mutex::new(ViewState {
                width: 0,
                height: 0,
                visible: false,
                clear_color: [0.0, 0.0, 0.0, 1.0],
                stop: false,
                generation: 0,
            }),
            changed: Condvar::new(),
            stats: PublishedStats::default(),
            connected: AtomicBool::new(false),
            vsync: AtomicBool::new(false),
            swapchain_width: AtomicU32::new(0),
            swapchain_height: AtomicU32::new(0),
            frame_width: AtomicU32::new(0),
            frame_height: AtomicU32::new(0),
            adapter_name: Mutex::new(String::new()),
        }
    }

    pub fn snapshot(&self) -> ViewState {
        *self.lock_view()
    }

    /// Apply `change` and wake the render thread if it is idling.
    pub fn update(&self, change: impl FnOnce(&mut ViewState)) {
        let mut view = self.lock_view();
        change(&mut view);
        view.generation += 1;
        drop(view);
        self.changed.notify_all();
    }

    /// Block until an update newer than `seen_generation` or `timeout`.
    pub fn wait_for_change(&self, seen_generation: u64, timeout: Duration) {
        let view = self.lock_view();
        let _ = self
            .changed
            .wait_timeout_while(view, timeout, |v| v.generation == seen_generation);
    }

    pub fn publish_stats(&self, stats: &WindowedStats) {
        self.stats.store(stats);
    }

    pub fn set_connected(&self, connected: bool) {
        self.connected.store(connected, Ordering::Relaxed);
    }

    pub fn set_vsync(&self, vsync: bool) {
        self.vsync.store(vsync, Ordering::Relaxed);
    }

    pub fn set_swapchain_size(&self, width: u32, height: u32) {
        self.swapchain_width.store(width, Ordering::Relaxed);
        self.swapchain_height.store(height, Ordering::Relaxed);
    }

    pub fn set_frame_size(&self, width: u32, height: u32) {
        self.frame_width.store(width, Ordering::Relaxed);
        self.frame_height.store(height, Ordering::Relaxed);
    }

    pub fn set_adapter_name(&self, name: String) {
        *self.adapter_name.lock().unwrap_or_else(|e| e.into_inner()) = name;
    }

    pub fn stats(&self) -> PreviewStatsSnapshot {
        PreviewStatsSnapshot {
            windowed: self.stats.load(),
            connected: self.connected.load(Ordering::Relaxed),
            swapchain_width: self.swapchain_width.load(Ordering::Relaxed),
            swapchain_height: self.swapchain_height.load(Ordering::Relaxed),
            frame_width: self.frame_width.load(Ordering::Relaxed),
            frame_height: self.frame_height.load(Ordering::Relaxed),
            adapter_name: self
                .adapter_name
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
            vsync: self.vsync.load(Ordering::Relaxed),
        }
    }

    // A panic while holding the lock leaves plain data behind; keep using it.
    fn lock_view(&self) -> std::sync::MutexGuard<'_, ViewState> {
        self.view.lock().unwrap_or_else(|e| e.into_inner())
    }
}
