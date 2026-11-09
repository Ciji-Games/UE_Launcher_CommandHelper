use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceRegime {
    pub start_s: f64,
    pub end_s: f64,
    pub frame_from: i64,
    pub frame_to: i64,
    pub median_ms: f64,
    pub avg_ms: f64,
    pub fps: f64,
    pub previous_median_ms: Option<f64>,
    pub previous_fps: Option<f64>,
    pub top_deltas: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct FrameTimePoint {
    pub idx: i64,
    pub start_s: f64,
    pub interval_ms: f64,
}

/// Detects durable performance regimes using time-based sliding windows.
/// Ignores initial startup warm-up (first 0.75s or high transient init period).
/// Requires a durable shift holding for at least several windows (e.g. >= 2.0s duration)
/// with a significant frame time delta (>= max(4.0 ms, 25% shift)).
pub fn detect_regimes(
    frames: &[FrameTimePoint],
    _target_ms: f64,
) -> Vec<PerformanceRegime> {
    if frames.len() < 10 {
        return Vec::new();
    }

    let startup_threshold_s = 0.75;
    let window_duration_s = 1.0;
    let min_durable_duration_s = 2.0;

    // Filter frames after startup warm-up
    let non_startup_frames: Vec<&FrameTimePoint> = frames
        .iter()
        .filter(|f| f.start_s >= startup_threshold_s)
        .collect();

    if non_startup_frames.is_empty() {
        return Vec::new();
    }

    let trace_start_s = non_startup_frames.first().unwrap().start_s;
    let trace_end_s = non_startup_frames.last().unwrap().start_s + (non_startup_frames.last().unwrap().interval_ms / 1000.0);
    let total_duration_s = trace_end_s - trace_start_s;

    if total_duration_s < min_durable_duration_s * 2.0 {
        return Vec::new();
    }

    // Slice frames into 1.0s non-overlapping windows
    let mut window_medians: Vec<(f64, f64, i64, i64, f64)> = Vec::new(); // (win_start_s, win_end_s, frame_from, frame_to, median_ms)

    let mut curr_w_start_s = trace_start_s;
    while curr_w_start_s + window_duration_s <= trace_end_s + 0.001 {
        let curr_w_end_s = curr_w_start_s + window_duration_s;
        let win_frames: Vec<&&FrameTimePoint> = non_startup_frames
            .iter()
            .filter(|f| f.start_s >= curr_w_start_s && f.start_s < curr_w_end_s)
            .collect();

        if !win_frames.is_empty() {
            let mut intervals: Vec<f64> = win_frames.iter().map(|f| f.interval_ms).collect();
            intervals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let med = crate::trace::frames::calculate_percentile(&intervals, 0.5);
            let f_from = win_frames.first().unwrap().idx;
            let f_to = win_frames.last().unwrap().idx;
            window_medians.push((curr_w_start_s, curr_w_end_s, f_from, f_to, med));
        }

        curr_w_start_s += window_duration_s;
    }

    if window_medians.len() < 4 {
        return Vec::new();
    }

    let mut regimes = Vec::new();

    // Look for step changes between adjacent window blocks (at least 2 windows before, and durable for at least 2 windows after)
    let k = 2; // window radius
    let mut best_shift_idx = None;
    let mut max_delta = 0.0;

    for i in k..=(window_medians.len() - k) {
        let before_windows = &window_medians[i.saturating_sub(k)..i];
        let after_windows = &window_medians[i..(i + k).min(window_medians.len())];

        let mut before_meds: Vec<f64> = before_windows.iter().map(|w| w.4).collect();
        let mut after_meds: Vec<f64> = after_windows.iter().map(|w| w.4).collect();
        before_meds.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        after_meds.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

        let med_before = crate::trace::frames::calculate_percentile(&before_meds, 0.5);
        let med_after = crate::trace::frames::calculate_percentile(&after_meds, 0.5);

        let delta = (med_after - med_before).abs();
        let is_significant = delta >= 4.0 || (med_before > 0.0 && (delta / med_before) >= 0.25);

        if is_significant && delta > max_delta {
            max_delta = delta;
            best_shift_idx = Some(i);
        }
    }

    if let Some(shift_idx) = best_shift_idx {
        let before_windows = &window_medians[..shift_idx];
        let after_windows = &window_medians[shift_idx..];

        let mut before_meds: Vec<f64> = before_windows.iter().map(|w| w.4).collect();
        let mut after_meds: Vec<f64> = after_windows.iter().map(|w| w.4).collect();
        before_meds.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        after_meds.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

        let med_before = crate::trace::frames::calculate_percentile(&before_meds, 0.5);
        let med_after = crate::trace::frames::calculate_percentile(&after_meds, 0.5);

        let shift_time_s = after_windows.first().unwrap().0;
        let frame_from = after_windows.first().unwrap().2;
        let frame_to = after_windows.last().unwrap().3;
        let end_s = after_windows.last().unwrap().1;

        // Compute avg & median for the regime segment
        let regime_frames: Vec<&&FrameTimePoint> = non_startup_frames
            .iter()
            .filter(|f| f.idx >= frame_from && f.idx <= frame_to)
            .collect();

        if !regime_frames.is_empty() {
            let sum: f64 = regime_frames.iter().map(|f| f.interval_ms).sum();
            let avg_ms = sum / (regime_frames.len() as f64);
            let fps = if med_after > 0.0 { (1000.0 / med_after).round() } else { 0.0 };
            let prev_fps = if med_before > 0.0 { Some((1000.0 / med_before).round()) } else { None };

            regimes.push(PerformanceRegime {
                start_s: shift_time_s,
                end_s,
                frame_from,
                frame_to,
                median_ms: med_after,
                avg_ms,
                fps,
                previous_median_ms: Some(med_before),
                previous_fps: prev_fps,
                top_deltas: Vec::new(),
            });
        }
    }

    regimes
}

/// Calculates top exclusive timer growths between the segment before and the regime segment after
pub fn calculate_regime_top_deltas(
    conn: &Connection,
    before_frame_from: i64,
    before_frame_to: i64,
    after_frame_from: i64,
    after_frame_to: i64,
) -> Vec<String> {
    let before_count = (before_frame_to - before_frame_from + 1).max(1) as f64;
    let after_count = (after_frame_to - after_frame_from + 1).max(1) as f64;

    let mut stmt = match conn.prepare(
        "SELECT ft.timer_id, t.name, th.role,
                SUM(CASE WHEN ft.frame_idx >= ?1 AND ft.frame_idx <= ?2 THEN ft.excl_ms ELSE 0.0 END) as before_excl,
                SUM(CASE WHEN ft.frame_idx >= ?3 AND ft.frame_idx <= ?4 THEN ft.excl_ms ELSE 0.0 END) as after_excl
         FROM frame_timer ft
         JOIN timers t ON t.id = ft.timer_id
         JOIN threads th ON th.id = ft.thread_id
         WHERE (ft.frame_idx >= ?1 AND ft.frame_idx <= ?2) OR (ft.frame_idx >= ?3 AND ft.frame_idx <= ?4)
         GROUP BY ft.timer_id, t.name, th.role"
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    struct TimerDelta {
        name: String,
        role: String,
        before_avg: f64,
        after_avg: f64,
        delta_ms: f64,
    }

    let mut deltas = Vec::new();

    let rows = stmt.query_map(
        rusqlite::params![before_frame_from, before_frame_to, after_frame_from, after_frame_to],
        |r| {
            let name: String = r.get(1)?;
            let role: String = r.get(2)?;
            let before_sum: f64 = r.get(3)?;
            let after_sum: f64 = r.get(4)?;
            let before_avg = before_sum / before_count;
            let after_avg = after_sum / after_count;
            let delta_ms = after_avg - before_avg;
            Ok(TimerDelta {
                name,
                role,
                before_avg,
                after_avg,
                delta_ms,
            })
        },
    );

    if let Ok(rows) = rows {
        for r in rows.flatten() {
            if r.delta_ms >= 0.5 {
                deltas.push(r);
            }
        }
    }

    deltas.sort_by(|a, b| b.delta_ms.partial_cmp(&a.delta_ms).unwrap_or(std::cmp::Ordering::Equal));

    deltas
        .into_iter()
        .take(5)
        .map(|d| {
            format!(
                "{} [{}]: {:.1} -> {:.1} ms (+{:.1} ms/frame)",
                d.name, d.role, d.before_avg, d.after_avg, d.delta_ms
            )
        })
        .collect()
}
