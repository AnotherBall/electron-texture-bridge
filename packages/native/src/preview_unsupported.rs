// Placeholder PreviewView for platforms without a native implementation yet.
// It cannot be constructed, so every method is unreachable.

use crate::preview_layout::Bounds;
use crate::preview_stats::PreviewStatsSnapshot;

pub enum PreviewView {}

impl PreviewView {
    pub fn new(_parent: usize, _sender_name: &str) -> Result<Self, String> {
        Err("PreviewView is not supported on this platform yet".into())
    }

    pub fn set_bounds(&mut self, _bounds: Bounds) {
        match *self {}
    }

    pub fn set_visible(&mut self, _visible: bool) {
        match *self {}
    }

    pub fn set_background(&mut self, _clear_color: [f32; 4]) {
        match *self {}
    }

    pub fn stats(&self) -> PreviewStatsSnapshot {
        match *self {}
    }

    pub fn destroy(&mut self) {
        match *self {}
    }
}
