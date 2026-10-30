// Platform-independent debug statistics for `PreviewView`.
//
// The render thread only records events (a present, a received frame) with
// a monotonic timestamp in nanoseconds; this module turns them into sliding
// window rates, present-interval figures and skip counts. No Win32 / Metal
// types, so it is unit-tested without a GPU.

use std::collections::VecDeque;

/// Length of the sliding window the per-second figures cover.
pub const STATS_WINDOW_NS: u64 = 1_000_000_000;

const NS_PER_MS: f64 = 1_000_000.0;

/// Timestamps of one kind of event inside the sliding window.
#[derive(Debug, Clone)]
struct EventWindow {
    stamps: VecDeque<u64>,
}

impl EventWindow {
    fn new() -> Self {
        Self {
            stamps: VecDeque::new(),
        }
    }

    fn record(&mut self, now_ns: u64) {
        self.stamps.push_back(now_ns);
    }

    /// Drop events older than the window ending at `now_ns`.
    fn prune(&mut self, now_ns: u64) {
        while self.stamps.front().is_some_and(|&t| !in_window(t, now_ns)) {
            self.stamps.pop_front();
        }
    }

    fn len(&self) -> usize {
        self.stamps.len()
    }
}

/// `t` lies in the window `(now - STATS_WINDOW_NS, now]`.
fn in_window(t_ns: u64, now_ns: u64) -> bool {
    t_ns <= now_ns && now_ns - t_ns < STATS_WINDOW_NS
}

/// Events in a window converted to events per second.
fn per_second(count: usize) -> f64 {
    count as f64 * 1_000_000_000.0 / STATS_WINDOW_NS as f64
}

/// Turns the sender's frame counter into "frames we never showed".
///
/// The counter is the Spout sender's frame number at the time we copied a
/// frame. A jump of more than one means the frames in between were replaced
/// before we copied them. 0 (or less) means the sender does not count frames.
#[derive(Debug, Clone, Copy, Default)]
pub struct SkipCounter {
    last: Option<i64>,
}

impl SkipCounter {
    /// Account for a copied frame with sender counter `count`; returns how
    /// many sender frames were skipped since the previous copied frame.
    pub fn observe(&mut self, count: i64) -> u64 {
        if count <= 0 {
            self.last = None;
            return 0;
        }
        let skipped = match self.last {
            Some(last) if count > last => (count - last - 1) as u64,
            // First frame, or the sender restarted its counter.
            _ => 0,
        };
        self.last = Some(count);
        skipped
    }

    /// Forget the baseline (sender gone), so a reconnect is not a gap.
    pub fn reset(&mut self) {
        self.last = None;
    }
}

/// Figures the render thread publishes for JS. Rates cover the last
/// `STATS_WINDOW_NS`; totals run since the view was created.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct WindowedStats {
    pub present_fps: f64,
    pub received_fps: f64,
    pub repeated_fps: f64,
    /// 0 when fewer than two presents fall in the window.
    pub present_interval_avg_ms: f64,
    pub present_interval_max_ms: f64,
    pub presented: u64,
    pub received: u64,
    pub skipped: u64,
}

/// Records render-thread events and summarises them over the window.
#[derive(Debug, Clone)]
pub struct StatsTracker {
    presents: EventWindow,
    received: EventWindow,
    repeated: EventWindow,
    /// (present time, time since the previous present), both in ns.
    intervals: VecDeque<(u64, u64)>,
    last_present_ns: Option<u64>,
    new_frame_since_present: bool,
    skips: SkipCounter,
    presented_total: u64,
    received_total: u64,
    skipped_total: u64,
}

impl Default for StatsTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl StatsTracker {
    pub fn new() -> Self {
        Self {
            presents: EventWindow::new(),
            received: EventWindow::new(),
            repeated: EventWindow::new(),
            intervals: VecDeque::new(),
            last_present_ns: None,
            new_frame_since_present: false,
            skips: SkipCounter::default(),
            presented_total: 0,
            received_total: 0,
            skipped_total: 0,
        }
    }

    /// A new sender frame was copied. `sender_count` is the sender's frame
    /// counter for it (0 when the sender does not count).
    pub fn record_frame_received(&mut self, now_ns: u64, sender_count: i64) {
        self.received.record(now_ns);
        self.received_total += 1;
        self.skipped_total += self.skips.observe(sender_count);
        self.new_frame_since_present = true;
    }

    /// The sender is gone: the next frame starts a fresh counter baseline.
    pub fn record_disconnected(&mut self) {
        self.skips.reset();
        self.new_frame_since_present = false;
    }

    /// A Present returned. `showing_frame` is false while only the
    /// background is drawn; such presents never count as repeats.
    pub fn record_present(&mut self, now_ns: u64, showing_frame: bool) {
        self.presents.record(now_ns);
        self.presented_total += 1;
        if showing_frame && !self.new_frame_since_present {
            self.repeated.record(now_ns);
        }
        self.new_frame_since_present = false;
        if let Some(last) = self.last_present_ns {
            self.intervals
                .push_back((now_ns, now_ns.saturating_sub(last)));
        }
        self.last_present_ns = Some(now_ns);
    }

    /// Prune to the window ending at `now_ns` and summarise it.
    pub fn snapshot(&mut self, now_ns: u64) -> WindowedStats {
        self.presents.prune(now_ns);
        self.received.prune(now_ns);
        self.repeated.prune(now_ns);
        while self
            .intervals
            .front()
            .is_some_and(|&(t, _)| !in_window(t, now_ns))
        {
            self.intervals.pop_front();
        }
        let (avg_ms, max_ms) = interval_summary_ms(self.intervals.iter().map(|&(_, d)| d));
        WindowedStats {
            present_fps: per_second(self.presents.len()),
            received_fps: per_second(self.received.len()),
            repeated_fps: per_second(self.repeated.len()),
            present_interval_avg_ms: avg_ms,
            present_interval_max_ms: max_ms,
            presented: self.presented_total,
            received: self.received_total,
            skipped: self.skipped_total,
        }
    }
}

/// Average and maximum of intervals (ns) in milliseconds; (0, 0) when empty.
fn interval_summary_ms(intervals: impl Iterator<Item = u64>) -> (f64, f64) {
    let (mut sum, mut max, mut n) = (0u128, 0u64, 0u64);
    for d in intervals {
        sum += d as u128;
        max = max.max(d);
        n += 1;
    }
    if n == 0 {
        return (0.0, 0.0);
    }
    (sum as f64 / n as f64 / NS_PER_MS, max as f64 / NS_PER_MS)
}

/// Whether a Present sync interval waits for vertical blank.
pub fn is_vsync(sync_interval: u32) -> bool {
    sync_interval > 0
}

/// A fixed-size UTF-16 adapter description (as DXGI returns it) to a String,
/// cut at the first NUL and trimmed.
pub fn adapter_description(raw: &[u16]) -> String {
    let end = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
    String::from_utf16_lossy(&raw[..end]).trim().to_string()
}

/// Everything `PreviewView.getStats()` reports.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PreviewStatsSnapshot {
    pub windowed: WindowedStats,
    pub connected: bool,
    pub swapchain_width: u32,
    pub swapchain_height: u32,
    pub frame_width: u32,
    pub frame_height: u32,
    /// Empty until a device exists.
    pub adapter_name: String,
    pub vsync: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: u64 = 1_000_000;

    /// Present every `step` ms from `start` ms for `n` presents, receiving a
    /// frame before each present when `with_frames`.
    fn run(t: &mut StatsTracker, start_ms: u64, step_ms: u64, n: u64, with_frames: bool) -> u64 {
        let mut now = start_ms * MS;
        for _ in 0..n {
            if with_frames {
                t.record_frame_received(now, 0);
            }
            t.record_present(now, true);
            now += step_ms * MS;
        }
        now - step_ms * MS
    }

    // ---- windowed rates ----

    #[test]
    fn empty_tracker_reports_zeros() {
        let mut t = StatsTracker::new();
        assert_eq!(t.snapshot(5_000 * MS), WindowedStats::default());
    }

    #[test]
    fn present_fps_counts_presents_in_the_last_second() {
        let mut t = StatsTracker::new();
        // 120 presents every 10 ms from t=0 (last at 1190 ms).
        let last = run(&mut t, 0, 10, 120, true);
        let s = t.snapshot(last);
        // Window (190 ms, 1190 ms] holds presents at 200..=1190 → 100.
        assert_eq!(s.present_fps, 100.0);
        assert_eq!(s.received_fps, 100.0);
        assert_eq!(s.presented, 120);
        assert_eq!(s.received, 120);
    }

    #[test]
    fn rates_decay_when_events_stop() {
        let mut t = StatsTracker::new();
        let last = run(&mut t, 0, 10, 50, true);
        assert_eq!(t.snapshot(last + 1_000 * MS).present_fps, 0.0);
        // Totals survive pruning.
        assert_eq!(t.snapshot(last + 1_000 * MS).presented, 50);
    }

    #[test]
    fn repeated_fps_counts_presents_without_a_new_frame() {
        let mut t = StatsTracker::new();
        // Frames at 30 fps, presents at 60 fps: every other present repeats.
        for i in 0..60u64 {
            let now = i * 16 * MS;
            if i % 2 == 0 {
                t.record_frame_received(now, 0);
            }
            t.record_present(now, true);
        }
        let s = t.snapshot(59 * 16 * MS);
        assert_eq!(s.present_fps, 60.0);
        assert_eq!(s.received_fps, 30.0);
        assert_eq!(s.repeated_fps, 30.0);
    }

    #[test]
    fn background_only_presents_are_not_repeats() {
        let mut t = StatsTracker::new();
        t.record_present(0, false);
        t.record_present(16 * MS, false);
        assert_eq!(t.snapshot(16 * MS).repeated_fps, 0.0);
    }

    #[test]
    fn two_frames_before_one_present_do_not_make_later_present_new() {
        let mut t = StatsTracker::new();
        t.record_frame_received(0, 0);
        t.record_frame_received(MS, 0);
        t.record_present(2 * MS, true);
        t.record_present(18 * MS, true);
        let s = t.snapshot(18 * MS);
        assert_eq!(s.repeated_fps, 1.0);
        assert_eq!(s.received_fps, 2.0);
    }

    // ---- present intervals ----

    #[test]
    fn interval_avg_and_max_cover_the_window() {
        let mut t = StatsTracker::new();
        t.record_present(0, true);
        t.record_present(10 * MS, true);
        t.record_present(20 * MS, true);
        t.record_present(50 * MS, true);
        let s = t.snapshot(50 * MS);
        // Intervals 10, 10, 30.
        assert!((s.present_interval_avg_ms - 50.0 / 3.0).abs() < 1e-9);
        assert_eq!(s.present_interval_max_ms, 30.0);
    }

    #[test]
    fn single_present_has_no_interval() {
        let mut t = StatsTracker::new();
        t.record_present(0, true);
        let s = t.snapshot(0);
        assert_eq!(s.present_interval_avg_ms, 0.0);
        assert_eq!(s.present_interval_max_ms, 0.0);
    }

    #[test]
    fn old_long_interval_leaves_the_window() {
        let mut t = StatsTracker::new();
        t.record_present(0, true);
        t.record_present(500 * MS, true); // 500 ms stall
        t.record_present(1_600 * MS, true); // 1100 ms stall
        t.record_present(1_610 * MS, true);
        let s = t.snapshot(1_610 * MS);
        // Only intervals ending at 1600 and 1610 remain.
        assert_eq!(s.present_interval_max_ms, 1_100.0);
        let s = t.snapshot(2_605 * MS);
        assert_eq!(s.present_interval_max_ms, 10.0);
    }

    // ---- skipped frames ----

    #[test]
    fn skip_counter_counts_gaps_in_sender_counter() {
        let mut c = SkipCounter::default();
        assert_eq!(c.observe(10), 0); // baseline
        assert_eq!(c.observe(11), 0);
        assert_eq!(c.observe(14), 2);
        assert_eq!(c.observe(15), 0);
    }

    #[test]
    fn skip_counter_ignores_senders_without_a_counter() {
        let mut c = SkipCounter::default();
        assert_eq!(c.observe(0), 0);
        assert_eq!(c.observe(0), 0);
        assert_eq!(c.observe(-1), 0);
    }

    #[test]
    fn skip_counter_restarts_when_counter_goes_back() {
        let mut c = SkipCounter::default();
        c.observe(100);
        assert_eq!(c.observe(3), 0);
        assert_eq!(c.observe(5), 1);
    }

    #[test]
    fn skip_counter_repeated_count_is_not_a_skip() {
        let mut c = SkipCounter::default();
        c.observe(7);
        assert_eq!(c.observe(7), 0);
    }

    #[test]
    fn tracker_accumulates_skips_and_resets_on_disconnect() {
        let mut t = StatsTracker::new();
        t.record_frame_received(0, 1);
        t.record_frame_received(MS, 4); // 2 skipped
        t.record_disconnected();
        t.record_frame_received(2 * MS, 50); // new baseline
        t.record_frame_received(3 * MS, 52); // 1 skipped
        assert_eq!(t.snapshot(3 * MS).skipped, 3);
    }

    // ---- misc ----

    #[test]
    fn is_vsync_is_true_for_non_zero_sync_interval() {
        assert!(is_vsync(1));
        assert!(!is_vsync(0));
    }

    #[test]
    fn adapter_description_cuts_at_nul_and_trims() {
        let mut raw = [0u16; 16];
        for (i, c) in "GPU X  ".encode_utf16().enumerate() {
            raw[i] = c;
        }
        assert_eq!(adapter_description(&raw), "GPU X");
        assert_eq!(adapter_description(&[0u16; 4]), "");
        let full: Vec<u16> = "ABC".encode_utf16().collect();
        assert_eq!(adapter_description(&full), "ABC");
    }
}
