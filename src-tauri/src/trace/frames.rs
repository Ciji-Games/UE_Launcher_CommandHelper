use std::cmp::Ordering;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::trace::csv_ingest::ProcessedFrame;
use crate::trace::store::DbEpisode;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FrameStats {
    pub total_frames: usize,
    pub duration_s: f64,
    pub median_ms: f64,
    pub mad_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub min_ms: f64,
    pub max_ms: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisOptions {
    pub target_fps: f64,
    pub hitch_factor: f64,
    pub hitch_min_extra_ms: f64,
    pub hitch_floor_ms: f64,
    pub max_episodes: usize,
    pub baseline_samples: usize,
    pub max_window_rows: usize,
}

impl Default for AnalysisOptions {
    fn default() -> Self {
        Self {
            target_fps: 60.0,
            hitch_factor: 2.5,
            hitch_min_extra_ms: 12.0,
            hitch_floor_ms: 33.333,
            max_episodes: 15,
            baseline_samples: 6,
            max_window_rows: 5_000_000,
        }
    }
}

pub fn calculate_percentile(sorted_values: &[f64], percentile: f64) -> f64 {
    if sorted_values.is_empty() {
        return 0.0;
    }
    if sorted_values.len() == 1 {
        return sorted_values[0];
    }
    let p = percentile.clamp(0.0, 1.0);
    let rank = p * (sorted_values.len() - 1) as f64;
    let lower = rank.floor() as usize;
    let upper = rank.ceil() as usize;
    if lower == upper {
        sorted_values[lower]
    } else {
        let weight = rank - lower as f64;
        sorted_values[lower] * (1.0 - weight) + sorted_values[upper] * weight
    }
}

#[allow(dead_code)]
pub fn calculate_median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    calculate_percentile(&sorted, 0.5)
}

pub fn calculate_robust_stats(frames: &[ProcessedFrame]) -> FrameStats {
    if frames.is_empty() {
        return FrameStats {
            total_frames: 0,
            duration_s: 0.0,
            median_ms: 0.0,
            mad_ms: 0.0,
            p95_ms: 0.0,
            p99_ms: 0.0,
            min_ms: 0.0,
            max_ms: 0.0,
        };
    }

    let mut intervals: Vec<f64> = frames.iter().map(|f| f.interval_ms).collect();
    intervals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));

    let min_ms = intervals.first().copied().unwrap_or(0.0);
    let max_ms = intervals.last().copied().unwrap_or(0.0);
    let median_ms = calculate_percentile(&intervals, 0.5);
    let p95_ms = calculate_percentile(&intervals, 0.95);
    let p99_ms = calculate_percentile(&intervals, 0.99);

    // Median Absolute Deviation (MAD)
    let mut abs_devs: Vec<f64> = intervals.iter().map(|x| (x - median_ms).abs()).collect();
    abs_devs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    let mad_ms = calculate_percentile(&abs_devs, 0.5);

    let start_s = frames.first().map(|f| f.start_s).unwrap_or(0.0);
    let last = frames.last().unwrap();
    let duration_s = (last.start_s + last.interval_ms / 1000.0) - start_s;

    FrameStats {
        total_frames: frames.len(),
        duration_s: duration_s.max(0.0),
        median_ms,
        mad_ms,
        p95_ms,
        p99_ms,
        min_ms,
        max_ms,
    }
}

pub fn detect_episodes(
    frames: &[ProcessedFrame],
    stats: &FrameStats,
    options: &AnalysisOptions,
) -> Vec<DbEpisode> {
    if frames.len() < 10 {
        return Vec::new();
    }

    let target_ms = 1000.0 / options.target_fps;
    let hitch_threshold = f64::max(
        options.hitch_factor * stats.median_ms,
        f64::max(stats.median_ms + options.hitch_min_extra_ms, options.hitch_floor_ms),
    );

    let mut episodes: Vec<DbEpisode> = Vec::new();
    let mut next_id: i64 = 1;

    // 1. Detect Isolated Hitches
    let mut i = 0;
    while i < frames.len() {
        if frames[i].interval_ms >= hitch_threshold {
            let start_idx = i;
            let mut end_idx = i;
            let mut peak_ms = frames[i].interval_ms;
            let mut interval_sum = frames[i].interval_ms;

            while end_idx + 1 < frames.len() && frames[end_idx + 1].interval_ms >= hitch_threshold {
                end_idx += 1;
                peak_ms = peak_ms.max(frames[end_idx].interval_ms);
                interval_sum += frames[end_idx].interval_ms;
            }

            let start_s = frames[start_idx].start_s;
            let last_f = &frames[end_idx];
            let end_s = last_f.start_s + (last_f.interval_ms / 1000.0);
            let count = (end_idx - start_idx + 1) as f64;
            let median_ms = interval_sum / count;

            episodes.push(DbEpisode {
                id: next_id,
                kind: "hitch".to_string(),
                start_s,
                end_s,
                frame_from: frames[start_idx].idx,
                frame_to: frames[end_idx].idx,
                peak_ms,
                median_ms,
                bound_by: "unattributed".to_string(), // Initialized, refined in pass B
                periodic_group: None,
            });
            next_id += 1;
            i = end_idx + 1;
        } else {
            i += 1;
        }
    }

    // 2. Detect Sustained Slow Regions using rolling 2.0s windows
    let window_duration_s = 2.0;
    let mut slow_intervals: Vec<(usize, usize)> = Vec::new();

    let mut w_start = 0;
    for w_end in 0..frames.len() {
        while frames[w_end].start_s - frames[w_start].start_s > window_duration_s && w_start < w_end {
            w_start += 1;
        }
        let count = w_end - w_start + 1;
        if count >= 10 {
            let window_frames = &frames[w_start..=w_end];
            let mut w_intervals: Vec<f64> = window_frames.iter().map(|f| f.interval_ms).collect();
            w_intervals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
            let w_med = calculate_percentile(&w_intervals, 0.5);
            let w_p95 = calculate_percentile(&w_intervals, 0.95);

            if w_med >= target_ms * 1.2 || w_p95 >= target_ms * 2.0 {
                slow_intervals.push((w_start, w_end));
            }
        }
    }

    // Merge contiguous slow intervals into slow regions
    if !slow_intervals.is_empty() {
        let mut merged: Vec<(usize, usize)> = Vec::new();
        let mut curr = slow_intervals[0];

        for next in slow_intervals.into_iter().skip(1) {
            if next.0 <= curr.1 + 1 {
                curr.1 = curr.1.max(next.1);
            } else {
                merged.push(curr);
                curr = next;
            }
        }
        merged.push(curr);

        for (from_idx, to_idx) in merged {
            let start_s = frames[from_idx].start_s;
            let last_f = &frames[to_idx];
            let end_s = last_f.start_s + (last_f.interval_ms / 1000.0);
            let duration_s = end_s - start_s;

            // Only keep slow regions >= 1.0 s
            if duration_s >= 1.0 {
                let region_frames = &frames[from_idx..=to_idx];
                let mut intervals: Vec<f64> = region_frames.iter().map(|f| f.interval_ms).collect();
                intervals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
                let peak_ms = intervals.last().copied().unwrap_or(0.0);
                let median_ms = calculate_percentile(&intervals, 0.5);

                episodes.push(DbEpisode {
                    id: next_id,
                    kind: "slow_region".to_string(),
                    start_s,
                    end_s,
                    frame_from: frames[from_idx].idx,
                    frame_to: frames[to_idx].idx,
                    peak_ms,
                    median_ms,
                    bound_by: "unattributed".to_string(),
                    periodic_group: None,
                });
                next_id += 1;
            }
        }
    }

    // 3. Detect Periodicity among Hitches
    let hitch_indices: Vec<usize> = episodes
        .iter()
        .enumerate()
        .filter(|(_, ep)| ep.kind == "hitch")
        .map(|(idx, _)| idx)
        .collect();

    if hitch_indices.len() >= 3 {
        let mut deltas = Vec::new();
        for k in 0..hitch_indices.len() - 1 {
            let t1 = episodes[hitch_indices[k]].start_s;
            let t2 = episodes[hitch_indices[k + 1]].start_s;
            deltas.push(t2 - t1);
        }

        let mean_delta: f64 = deltas.iter().sum::<f64>() / (deltas.len() as f64);
        if mean_delta > 0.1 {
            let variance: f64 = deltas
                .iter()
                .map(|d| (d - mean_delta).powi(2))
                .sum::<f64>()
                / (deltas.len() as f64);
            let std_dev = variance.sqrt();
            let cv = std_dev / mean_delta;

            // If CV < 0.18, consider periodic
            if cv < 0.18 {
                let group_id = 1;
                for idx in hitch_indices {
                    episodes[idx].periodic_group = Some(group_id);
                }
            }
        }
    }

    // Sort all episodes by start_s
    episodes.sort_by(|a, b| a.start_s.partial_cmp(&b.start_s).unwrap_or(Ordering::Equal));

    episodes
}

pub fn save_episodes_to_db(conn: &mut Connection, episodes: &[DbEpisode]) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO episodes (id, kind, start_s, end_s, frame_from, frame_to, peak_ms, median_ms, bound_by, periodic_group)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            )
            .map_err(|e| e.to_string())?;

        for ep in episodes {
            stmt.execute(params![
                ep.id,
                &ep.kind,
                ep.start_s,
                ep.end_s,
                ep.frame_from,
                ep.frame_to,
                ep.peak_ms,
                ep.median_ms,
                &ep.bound_by,
                ep.periodic_group,
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_percentile_calculation() {
        let values = vec![10.0, 20.0, 30.0, 40.0, 50.0];
        assert_eq!(calculate_percentile(&values, 0.5), 30.0);
        assert_eq!(calculate_percentile(&values, 0.0), 10.0);
        assert_eq!(calculate_percentile(&values, 1.0), 50.0);
    }

    #[test]
    fn test_hitch_and_periodicity_detection() {
        let mut frames = Vec::new();
        // Generate 60 regular 16.6ms frames, with 3 periodic hitches at 10s intervals
        let mut t = 0.0;
        let mut idx = 0;
        for sec in 0..30 {
            for f in 0..60 {
                let is_hitch = (sec == 5 || sec == 15 || sec == 25) && f == 0;
                let interval = if is_hitch { 120.0 } else { 16.6 };
                frames.push(ProcessedFrame {
                    idx,
                    engine_frame: None,
                    start_s: t,
                    interval_ms: interval,
                    game_ms: Some(interval),
                    render_ms: Some(10.0),
                    gpu_ms: Some(12.0),
                });
                t += interval / 1000.0;
                idx += 1;
            }
        }

        let stats = calculate_robust_stats(&frames);
        assert!(stats.median_ms >= 16.0 && stats.median_ms <= 17.0);

        let options = AnalysisOptions::default();
        let episodes = detect_episodes(&frames, &stats, &options);

        let hitches: Vec<_> = episodes.iter().filter(|e| e.kind == "hitch").collect();
        assert_eq!(hitches.len(), 3);
        assert_eq!(hitches[0].periodic_group, Some(1));
        assert_eq!(hitches[1].periodic_group, Some(1));
        assert_eq!(hitches[2].periodic_group, Some(1));
    }
}
