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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegimeTimerDelta {
    pub timer_id: i64,
    pub name: String,
    pub role: String,
    pub before_avg: f64,
    pub after_avg: f64,
    pub delta_ms: f64,
}

#[derive(Debug, Clone)]
pub struct FrameTimePoint {
    pub idx: i64,
    pub start_s: f64,
    pub interval_ms: f64,
}

/// Detects durable performance degradation regimes using time-based sliding windows.
/// Ignores initial engine startup/loading period.
/// Only flags true performance degradations (where frame times stepped up and frame rate dropped).
pub fn detect_regimes(
    frames: &[FrameTimePoint],
    target_ms: f64,
) -> Vec<PerformanceRegime> {
    if frames.len() < 10 {
        return Vec::new();
    }

    let startup_threshold_s = 1.0;
    let window_duration_s = 1.0;
    let min_durable_duration_s = 2.0;

    // Filter frames after startup warm-up
    let non_startup_frames: Vec<&FrameTimePoint> = frames
        .iter()
        .filter(|f| f.start_s.is_finite() && f.start_s >= startup_threshold_s && f.interval_ms.is_finite())
        .collect();

    if non_startup_frames.is_empty() {
        return Vec::new();
    }

    let trace_start_s = non_startup_frames.first().unwrap().start_s;
    let last_frame = non_startup_frames.last().unwrap();
    let last_interval_s = (last_frame.interval_ms / 1000.0).max(0.0);
    let trace_end_s = last_frame.start_s + last_interval_s;

    if !trace_start_s.is_finite() || !trace_end_s.is_finite() || trace_end_s <= trace_start_s {
        return Vec::new();
    }

    let total_duration_s = trace_end_s - trace_start_s;
    if total_duration_s < min_durable_duration_s * 2.0 {
        return Vec::new();
    }

    // Slice frames into 1.0s non-overlapping windows
    let mut window_medians: Vec<(f64, f64, i64, i64, f64)> = Vec::new(); // (win_start_s, win_end_s, frame_from, frame_to, median_ms)

    let mut curr_w_start_s = trace_start_s;
    while curr_w_start_s + window_duration_s <= trace_end_s + 0.001 {
        if !curr_w_start_s.is_finite() {
            break;
        }
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

    // Skip leading startup windows where frame times are very high (> 100ms or > 3x target)
    let mut effective_start_idx = 0;
    while effective_start_idx < window_medians.len() / 2 && window_medians[effective_start_idx].0 < 10.0 {
        if window_medians[effective_start_idx].4 > 100.0 || window_medians[effective_start_idx].4 > target_ms * 3.0 {
            effective_start_idx += 1;
        } else {
            break;
        }
    }

    let usable_windows = &window_medians[effective_start_idx..];
    if usable_windows.len() < 4 {
        return Vec::new();
    }

    let mut regimes = Vec::new();
    let k = 2; // window radius
    let mut best_shift_idx = None;
    let mut max_delta = 0.0;

    for i in k..=(usable_windows.len() - k) {
        let before_windows = &usable_windows[i.saturating_sub(k)..i];
        let after_windows = &usable_windows[i..(i + k).min(usable_windows.len())];

        let mut before_meds: Vec<f64> = before_windows.iter().map(|w| w.4).collect();
        let mut after_meds: Vec<f64> = after_windows.iter().map(|w| w.4).collect();
        before_meds.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        after_meds.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

        let med_before = crate::trace::frames::calculate_percentile(&before_meds, 0.5);
        let med_after = crate::trace::frames::calculate_percentile(&after_meds, 0.5);

        // A performance degradation regime MUST have med_after > med_before (performance worsened)
        let delta = med_after - med_before;
        let is_significant_degradation = delta >= 4.0 && (
            (med_before > 0.0 && (delta / med_before) >= 0.25) || med_after > target_ms * 1.15
        );

        // med_before should be sane gameplay baseline, not startup loading
        let before_is_baseline = med_before < 100.0;

        if is_significant_degradation && before_is_baseline && delta > max_delta {
            max_delta = delta;
            best_shift_idx = Some(i);
        }
    }

    if let Some(shift_idx) = best_shift_idx {
        let before_windows = &usable_windows[..shift_idx];
        let after_windows = &usable_windows[shift_idx..];

        let mut before_meds: Vec<f64> = before_windows.iter().map(|w| w.4).collect();
        let mut after_meds: Vec<f64> = after_windows.iter().map(|w| w.4).collect();
        before_meds.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        after_meds.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

        let med_before = crate::trace::frames::calculate_percentile(&before_meds, 0.5);
        let med_after = crate::trace::frames::calculate_percentile(&after_meds, 0.5);

        // Find how long performance remains elevated above baseline
        let mut elevated_end_idx = after_windows.len();
        let elevated_threshold = med_before + (med_after - med_before) * 0.5;
        for (idx, w) in after_windows.iter().enumerate().skip(k) {
            if w.4 < elevated_threshold && w.4 <= target_ms * 1.10 {
                elevated_end_idx = idx;
                break;
            }
        }

        let sustained_after_windows = &after_windows[..elevated_end_idx.max(k)];

        let shift_time_s = sustained_after_windows.first().unwrap().0;
        let frame_from = sustained_after_windows.first().unwrap().2;
        let frame_to = sustained_after_windows.last().unwrap().3;
        let end_s = sustained_after_windows.last().unwrap().1;

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

/// Queries top exclusive timer growths between the baseline segment before and the regime segment after
pub fn query_regime_timer_deltas(
    conn: &Connection,
    before_frame_from: i64,
    before_frame_to: i64,
    after_frame_from: i64,
    after_frame_to: i64,
) -> Vec<RegimeTimerDelta> {
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

    let mut deltas = Vec::new();

    let rows = stmt.query_map(
        rusqlite::params![before_frame_from, before_frame_to, after_frame_from, after_frame_to],
        |r| {
            let timer_id: i64 = r.get(0)?;
            let name: String = r.get(1)?;
            let role: String = r.get(2)?;
            let before_sum: f64 = r.get(3)?;
            let after_sum: f64 = r.get(4)?;
            let before_avg = before_sum / before_count;
            let after_avg = after_sum / after_count;
            let delta_ms = after_avg - before_avg;
            Ok(RegimeTimerDelta {
                timer_id,
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
            if r.delta_ms >= 0.3 {
                deltas.push(r);
            }
        }
    }

    deltas.sort_by(|a, b| b.delta_ms.partial_cmp(&a.delta_ms).unwrap_or(std::cmp::Ordering::Equal));
    deltas
}

/// Calculates top exclusive timer growths between the segment before and the regime segment after
pub fn calculate_regime_top_deltas(
    conn: &Connection,
    before_frame_from: i64,
    before_frame_to: i64,
    after_frame_from: i64,
    after_frame_to: i64,
) -> Vec<String> {
    let deltas = query_regime_timer_deltas(
        conn,
        before_frame_from,
        before_frame_to,
        after_frame_from,
        after_frame_to,
    );

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_regimes_with_infinite_interval_terminates() {
        let mut frames = Vec::new();
        for i in 0..100 {
            frames.push(FrameTimePoint {
                idx: i,
                start_s: (i as f64) * 0.0166,
                interval_ms: 16.6,
            });
        }
        // Corrupted/infinite tail frame
        frames.push(FrameTimePoint {
            idx: 100,
            start_s: 1.66,
            interval_ms: f64::INFINITY,
        });

        // Must terminate safely and not hang in an infinite loop
        let regimes = detect_regimes(&frames, 16.67);
        let _ = regimes;
    }

    #[test]
    fn test_detect_regimes_with_all_nan_or_inf() {
        let frames = vec![
            FrameTimePoint { idx: 0, start_s: f64::NAN, interval_ms: f64::NAN },
            FrameTimePoint { idx: 1, start_s: f64::INFINITY, interval_ms: f64::INFINITY },
        ];
        let regimes = detect_regimes(&frames, 16.67);
        assert!(regimes.is_empty());
    }
}
