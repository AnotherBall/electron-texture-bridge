// Platform-independent layout / parsing helpers for `PreviewView`.
//
// Kept free of any Win32 / Metal types so the same rules apply on every
// platform and can be unit-tested without a GPU or a window.

/// Viewport rectangle in swapchain pixels (floats, as D3D11/Metal viewports take).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FitRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// Child-window bounds in physical pixels of the parent's client area.
/// A zero width or height means the view is hidden.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Bounds {
    pub fn is_empty(&self) -> bool {
        self.width == 0 || self.height == 0
    }
}

/// Fit `src` inside `dst` keeping its aspect ratio, centred.
/// Returns `None` when either size has a zero dimension (nothing to draw).
pub fn aspect_fit(
    dst_width: u32,
    dst_height: u32,
    src_width: u32,
    src_height: u32,
) -> Option<FitRect> {
    if dst_width == 0 || dst_height == 0 || src_width == 0 || src_height == 0 {
        return None;
    }
    let (dw, dh) = (dst_width as f64, dst_height as f64);
    let scale = (dw / src_width as f64).min(dh / src_height as f64);
    let width = src_width as f64 * scale;
    let height = src_height as f64 * scale;
    Some(FitRect {
        x: ((dw - width) / 2.0) as f32,
        y: ((dh - height) / 2.0) as f32,
        width: width as f32,
        height: height as f32,
    })
}

/// Convert 0–255 RGB channels to an opaque clear colour. Out-of-range values
/// are clamped and NaN becomes 0.
pub fn clear_color(r: f64, g: f64, b: f64) -> [f32; 4] {
    [
        channel_to_unit(r),
        channel_to_unit(g),
        channel_to_unit(b),
        1.0,
    ]
}

fn channel_to_unit(value: f64) -> f32 {
    if value.is_nan() {
        return 0.0;
    }
    (value.clamp(0.0, 255.0) / 255.0) as f32
}

/// Read a native window handle from Electron's `getNativeWindowHandle()`
/// Buffer: 8 bytes (64-bit) or 4 bytes (32-bit), little-endian.
pub fn parse_parent_handle(bytes: &[u8]) -> Result<usize, String> {
    let raw = match bytes.len() {
        8 => u64::from_le_bytes(bytes.try_into().expect("length checked")),
        4 => u32::from_le_bytes(bytes.try_into().expect("length checked")) as u64,
        other => {
            return Err(format!(
                "Parent handle buffer must be 8 or 4 bytes, got {other}"
            ))
        }
    };
    if raw == 0 {
        return Err("Parent handle is null".into());
    }
    usize::try_from(raw).map_err(|_| "Parent handle does not fit in a pointer".to_string())
}

/// Clamp JS bounds to a valid rectangle; non-positive sizes become 0 (hidden).
pub fn normalize_bounds(x: i32, y: i32, width: i32, height: i32) -> Bounds {
    Bounds {
        x,
        y,
        width: width.max(0) as u32,
        height: height.max(0) as u32,
    }
}

/// The child window is shown only when visible and it has a non-empty size.
pub fn should_show(visible: bool, bounds: Bounds) -> bool {
    visible && !bounds.is_empty()
}

/// A view frame in points of the parent view's own coordinate system, as
/// macOS `-[NSView setFrame:]` takes it.
// macOS only (NSView frames).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ViewFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A backing scale factor (physical px per point) usable as a divisor:
/// non-finite or non-positive values become 1.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn sanitize_scale(scale: f64) -> f64 {
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

/// Convert `bounds` (physical px from the top-left of the parent's content,
/// the same meaning as on Windows) to a frame in the parent's points.
///
/// `parent_height` is the parent's height in points. In an unflipped parent
/// (AppKit's default, origin at the bottom-left) y is measured from the
/// bottom edge to the view's bottom edge; in a flipped one it is the top.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn physical_to_view_frame(
    bounds: Bounds,
    scale: f64,
    parent_height: f64,
    parent_flipped: bool,
) -> ViewFrame {
    let scale = sanitize_scale(scale);
    let x = bounds.x as f64 / scale;
    let top = bounds.y as f64 / scale;
    let width = bounds.width as f64 / scale;
    let height = bounds.height as f64 / scale;
    let y = if parent_flipped {
        top
    } else {
        parent_height - top - height
    };
    ViewFrame {
        x,
        y,
        width,
        height,
    }
}

/// With vsync off, presents follow frames: a new sender frame or a view
/// change (size, background, visibility), at most once per refresh of the
/// monitor, since a DWM-composed window shows one image per refresh anyway.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn should_present_unsynced(
    new_frame: bool,
    view_changed: bool,
    since_last_present_ns: u64,
    min_interval_ns: u64,
) -> bool {
    (new_frame || view_changed) && since_last_present_ns >= min_interval_ns
}

/// One refresh of a `refresh_hz` monitor in ns (240 Hz when unknown).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn unsynced_min_interval_ns(refresh_hz: u32) -> u64 {
    let hz = if refresh_hz > 0 { refresh_hz } else { 240 };
    1_000_000_000 / hz as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- aspect_fit ----

    #[test]
    fn aspect_fit_same_aspect_fills_destination() {
        let r = aspect_fit(1920, 1080, 1280, 720).unwrap();
        assert_eq!(
            r,
            FitRect {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0
            }
        );
    }

    #[test]
    fn aspect_fit_wider_source_letterboxes_vertically() {
        // 2:1 source in a 1000x1000 destination → 1000x500 centred.
        let r = aspect_fit(1000, 1000, 200, 100).unwrap();
        assert_eq!(
            r,
            FitRect {
                x: 0.0,
                y: 250.0,
                width: 1000.0,
                height: 500.0
            }
        );
    }

    #[test]
    fn aspect_fit_taller_source_pillarboxes_horizontally() {
        // 1:2 source in an 800x400 destination → 200x400 centred.
        let r = aspect_fit(800, 400, 100, 200).unwrap();
        assert_eq!(
            r,
            FitRect {
                x: 300.0,
                y: 0.0,
                width: 200.0,
                height: 400.0
            }
        );
    }

    #[test]
    fn aspect_fit_zero_destination_returns_none() {
        assert_eq!(aspect_fit(0, 100, 10, 10), None);
        assert_eq!(aspect_fit(100, 0, 10, 10), None);
    }

    #[test]
    fn aspect_fit_zero_source_returns_none() {
        assert_eq!(aspect_fit(100, 100, 0, 10), None);
        assert_eq!(aspect_fit(100, 100, 10, 0), None);
    }

    // ---- clear_color ----

    #[test]
    fn clear_color_maps_channels_to_unit_floats() {
        assert_eq!(clear_color(255.0, 0.0, 51.0), [1.0, 0.0, 0.2, 1.0]);
    }

    #[test]
    fn clear_color_clamps_out_of_range_values() {
        assert_eq!(clear_color(-10.0, 300.0, 255.0), [0.0, 1.0, 1.0, 1.0]);
    }

    #[test]
    fn clear_color_treats_nan_as_zero() {
        assert_eq!(clear_color(f64::NAN, 0.0, 0.0), [0.0, 0.0, 0.0, 1.0]);
    }

    // ---- parse_parent_handle ----

    #[test]
    fn parse_parent_handle_reads_8_byte_little_endian() {
        let bytes = 0x0001_0203_0405_0607u64.to_le_bytes();
        let expected = 0x0001_0203_0405_0607u64;
        if usize::BITS == 64 {
            assert_eq!(parse_parent_handle(&bytes).unwrap() as u64, expected);
        }
    }

    #[test]
    fn parse_parent_handle_reads_4_byte_little_endian() {
        let bytes = 0x0012_3456u32.to_le_bytes();
        assert_eq!(parse_parent_handle(&bytes).unwrap(), 0x0012_3456);
    }

    #[test]
    fn parse_parent_handle_rejects_other_lengths() {
        assert!(parse_parent_handle(&[]).is_err());
        assert!(parse_parent_handle(&[1, 2, 3]).is_err());
        assert!(parse_parent_handle(&[0; 16]).is_err());
    }

    #[test]
    fn parse_parent_handle_rejects_null() {
        assert!(parse_parent_handle(&[0; 8]).is_err());
        assert!(parse_parent_handle(&[0; 4]).is_err());
    }

    // ---- normalize_bounds ----

    #[test]
    fn normalize_bounds_keeps_positive_sizes() {
        assert_eq!(
            normalize_bounds(-5, 10, 640, 360),
            Bounds {
                x: -5,
                y: 10,
                width: 640,
                height: 360
            }
        );
    }

    #[test]
    fn normalize_bounds_turns_non_positive_sizes_into_zero() {
        let b = normalize_bounds(1, 2, -1, 100);
        assert_eq!(
            b,
            Bounds {
                x: 1,
                y: 2,
                width: 0,
                height: 100
            }
        );
        assert!(b.is_empty());
        assert!(normalize_bounds(0, 0, 100, 0).is_empty());
    }

    // ---- should_show ----

    #[test]
    fn should_show_requires_visible_and_non_empty_bounds() {
        let sized = normalize_bounds(0, 0, 10, 10);
        assert!(should_show(true, sized));
        assert!(!should_show(false, sized));
        assert!(!should_show(true, Bounds::default()));
    }
    // ---- physical_to_view_frame (macOS NSView frame) ----

    #[test]
    fn view_frame_divides_by_scale_in_a_flipped_parent() {
        let b = normalize_bounds(200, 100, 800, 400);
        assert_eq!(
            physical_to_view_frame(b, 2.0, 1000.0, true),
            ViewFrame {
                x: 100.0,
                y: 50.0,
                width: 400.0,
                height: 200.0
            }
        );
    }

    #[test]
    fn view_frame_measures_y_from_the_bottom_in_an_unflipped_parent() {
        // 600 pt tall parent, top edge at 50 pt, 200 pt tall → bottom edge at
        // 250 pt from the top → origin 350 pt above the parent's bottom.
        let b = normalize_bounds(200, 100, 800, 400);
        assert_eq!(
            physical_to_view_frame(b, 2.0, 600.0, false),
            ViewFrame {
                x: 100.0,
                y: 350.0,
                width: 400.0,
                height: 200.0
            }
        );
    }

    #[test]
    fn view_frame_at_scale_one_keeps_pixels() {
        let b = normalize_bounds(-10, 0, 300, 100);
        assert_eq!(
            physical_to_view_frame(b, 1.0, 100.0, false),
            ViewFrame {
                x: -10.0,
                y: 0.0,
                width: 300.0,
                height: 100.0
            }
        );
    }

    #[test]
    fn view_frame_treats_invalid_scale_as_one() {
        let b = normalize_bounds(10, 20, 30, 40);
        let expected = physical_to_view_frame(b, 1.0, 500.0, true);
        assert_eq!(physical_to_view_frame(b, 0.0, 500.0, true), expected);
        assert_eq!(physical_to_view_frame(b, -2.0, 500.0, true), expected);
        assert_eq!(physical_to_view_frame(b, f64::NAN, 500.0, true), expected);
        assert_eq!(
            physical_to_view_frame(b, f64::INFINITY, 500.0, true),
            expected
        );
    }

    #[test]
    fn view_frame_of_empty_bounds_has_zero_size() {
        let f = physical_to_view_frame(Bounds::default(), 2.0, 600.0, false);
        assert_eq!(f.width, 0.0);
        assert_eq!(f.height, 0.0);
    }

    #[test]
    fn sanitize_scale_keeps_finite_positive_values() {
        assert_eq!(sanitize_scale(2.0), 2.0);
        assert_eq!(sanitize_scale(1.5), 1.5);
        assert_eq!(sanitize_scale(0.0), 1.0);
        assert_eq!(sanitize_scale(f64::NAN), 1.0);
    }

    // ---- pacing with vsync off ----

    #[test]
    fn unsynced_presents_need_a_new_frame_or_a_view_change() {
        let gap = unsynced_min_interval_ns(165);
        assert!(should_present_unsynced(true, false, gap, gap));
        assert!(should_present_unsynced(false, true, gap, gap));
        assert!(!should_present_unsynced(false, false, 10 * gap, gap));
    }

    #[test]
    fn unsynced_presents_are_capped_at_the_refresh_rate() {
        let gap = unsynced_min_interval_ns(165);
        assert!(!should_present_unsynced(true, false, gap - 1, gap));
        assert!(should_present_unsynced(true, false, gap, gap));
    }

    #[test]
    fn unsynced_interval_follows_the_monitor() {
        assert_eq!(unsynced_min_interval_ns(165), 1_000_000_000 / 165);
        assert_eq!(unsynced_min_interval_ns(60), 1_000_000_000 / 60);
        // Unknown refresh rate: allow up to 240 per second.
        assert_eq!(unsynced_min_interval_ns(0), 1_000_000_000 / 240);
    }
}
