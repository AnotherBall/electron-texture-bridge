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
}
