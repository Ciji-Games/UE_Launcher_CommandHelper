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
    #[serde(default)]
    pub hitch_factor: Option<f64>,
    #[serde(default)]
    pub hitch_min_extra_ms: Option<f64>,
    #[serde(default)]
    pub hitch_floor_ms: Option<f64>,
    #[serde(default)]
    pub max_episodes: Option<usize>,
    pub baseline_samples: usize,
    pub max_window_rows: usize,
}

impl Default for AnalysisOptions {
    fn default() -> Self {
        Self {
            target_fps: 60.0,
            hitch_factor: None,
            hitch_min_extra_ms: None,
            hitch_floor_ms: None,
            max_episodes: None,
            baseline_samples: 6,
            max_window_rows: 5_000_000,
        }
    }
}

/// Computes whether a frame interval is considered a hitch / spike.
///
/// Criteria:
/// - Must be significantly higher than the local moving median (>= 1.5 * local_median_ms)
/// - Must exceed the target frametime budget (>= 1.5 * target_ms)
/// - Absolute sanity floor: interval_ms > 100.0 ms is always a hitch even during slow plateaus.
///
/// Threshold: max(1.5 * target_ms, 1.5 * local_median_ms).
pub fn is_hitch(interval_ms: f64, local_median_ms: f64, target_ms: f64) -> bool {
    let threshold = (target_ms * 1.5).max(1.5 * local_median_ms);
    interval_ms >= threshold || interval_ms > 100.0
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

pub const BLOCK_SIZE_L1: usize = 64;
pub const BLOCK_SIZE_L2: usize = 4096;

pub fn build_block_pyramid(
    conn: &mut Connection,
    frames: &[ProcessedFrame],
    stats: &FrameStats,
    opts: &AnalysisOptions,
) -> Result<(), String> {
    if frames.is_empty() {
        return Ok(());
    }

    let target_ms = 1000.0 / opts.target_fps;
    let normal_threshold_ms = stats.median_ms * 1.25;

    let mut frame_timer_map: std::collections::HashMap<i64, Vec<(i64, i64, f64, i64)>> = std::collections::HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT frame_idx, thread_id, timer_id, excl_ms, calls FROM frame_timer ORDER BY frame_idx")
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, f64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        for r in rows {
            let (f_idx, th_id, timer_id, excl_ms, calls) = r.map_err(|e| e.to_string())?;
            frame_timer_map.entry(f_idx).or_default().push((th_id, timer_id, excl_ms, calls));
        }
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        tx.execute("DELETE FROM block_frames", []).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM block_profile", []).map_err(|e| e.to_string())?;

        let mut insert_frames_stmt = tx
            .prepare(
                "INSERT INTO block_frames (level, block_idx, frames, spike_frames, sum_frame_ms, over_budget_frames)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .map_err(|e| e.to_string())?;

        let mut insert_profile_stmt = tx
            .prepare(
                "INSERT INTO block_profile (level, block_idx, thread_id, timer_id, sum_excl_ms, sum_calls, normal_frames)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .map_err(|e| e.to_string())?;

        // Level 1: 64 frames per block
        let total_frames = frames.len();
        let num_l1_blocks = (total_frames + BLOCK_SIZE_L1 - 1) / BLOCK_SIZE_L1;

        for b_idx in 0..num_l1_blocks {
            let start_f = b_idx * BLOCK_SIZE_L1;
            let end_f = (start_f + BLOCK_SIZE_L1).min(total_frames);
            let block_frames_slice = &frames[start_f..end_f];

            let mut spike_frames = 0i64;
            let mut sum_frame_ms = 0.0f64;
            let mut over_budget_frames = 0i64;
            let mut normal_frames = 0i64;

            let mut timer_agg: std::collections::HashMap<(i64, i64), (f64, i64)> = std::collections::HashMap::new();

            for f in block_frames_slice {
                sum_frame_ms += f.interval_ms;
                if f.interval_ms > target_ms {
                    over_budget_frames += 1;
                }
                let is_normal = f.interval_ms <= normal_threshold_ms;
                if is_normal {
                    normal_frames += 1;
                } else {
                    spike_frames += 1;
                }

                if let Some(timers) = frame_timer_map.get(&f.idx) {
                    for &(th_id, tid, excl_ms, calls) in timers {
                        if is_normal {
                            let entry = timer_agg.entry((th_id, tid)).or_insert((0.0, 0));
                            entry.0 += excl_ms;
                            entry.1 += calls;
                        }
                    }
                }
            }

            insert_frames_stmt
                .execute(params![
                    1,
                    b_idx as i64,
                    block_frames_slice.len() as i64,
                    spike_frames,
                    sum_frame_ms,
                    over_budget_frames
                ])
                .map_err(|e| e.to_string())?;

            for ((th_id, tid), (sum_excl_ms, sum_calls)) in timer_agg {
                insert_profile_stmt
                    .execute(params![
                        1,
                        b_idx as i64,
                        th_id,
                        tid,
                        sum_excl_ms,
                        sum_calls,
                        normal_frames
                    ])
                    .map_err(|e| e.to_string())?;
            }
        }

        // Level 2: 4096 frames per block
        let num_l2_blocks = (total_frames + BLOCK_SIZE_L2 - 1) / BLOCK_SIZE_L2;

        for b_idx in 0..num_l2_blocks {
            let start_f = b_idx * BLOCK_SIZE_L2;
            let end_f = (start_f + BLOCK_SIZE_L2).min(total_frames);
            let block_frames_slice = &frames[start_f..end_f];

            let mut spike_frames = 0i64;
            let mut sum_frame_ms = 0.0f64;
            let mut over_budget_frames = 0i64;
            let mut normal_frames = 0i64;

            let mut timer_agg: std::collections::HashMap<(i64, i64), (f64, i64)> = std::collections::HashMap::new();

            for f in block_frames_slice {
                sum_frame_ms += f.interval_ms;
                if f.interval_ms > target_ms {
                    over_budget_frames += 1;
                }
                let is_normal = f.interval_ms <= normal_threshold_ms;
                if is_normal {
                    normal_frames += 1;
                } else {
                    spike_frames += 1;
                }

                if let Some(timers) = frame_timer_map.get(&f.idx) {
                    for &(th_id, tid, excl_ms, calls) in timers {
                        if is_normal {
                            let entry = timer_agg.entry((th_id, tid)).or_insert((0.0, 0));
                            entry.0 += excl_ms;
                            entry.1 += calls;
                        }
                    }
                }
            }

            insert_frames_stmt
                .execute(params![
                    2,
                    b_idx as i64,
                    block_frames_slice.len() as i64,
                    spike_frames,
                    sum_frame_ms,
                    over_budget_frames
                ])
                .map_err(|e| e.to_string())?;

            for ((th_id, tid), (sum_excl_ms, sum_calls)) in timer_agg {
                insert_profile_stmt
                    .execute(params![
                        2,
                        b_idx as i64,
                        th_id,
                        tid,
                        sum_excl_ms,
                        sum_calls,
                        normal_frames
                    ])
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RangeAssemblyPlan {
    pub level2_blocks: Vec<i64>,
    pub level1_blocks: Vec<i64>,
    pub edge_frame_indices: Vec<i64>,
}

pub fn plan_range_assembly(
    frame_from: i64,
    frame_to: i64,
) -> RangeAssemblyPlan {
    let mut plan = RangeAssemblyPlan {
        level2_blocks: Vec::new(),
        level1_blocks: Vec::new(),
        edge_frame_indices: Vec::new(),
    };

    if frame_from > frame_to {
        return plan;
    }

    let mut curr = frame_from;

    // Small range (< 128 frames) can just read edge frames directly
    if frame_to - frame_from + 1 < (BLOCK_SIZE_L1 * 2) as i64 {
        for idx in frame_from..=frame_to {
            plan.edge_frame_indices.push(idx);
        }
        return plan;
    }

    // 1. Consume left partial level 1 edge frames until aligned with BLOCK_SIZE_L1
    while (curr % (BLOCK_SIZE_L1 as i64) != 0) && curr <= frame_to {
        plan.edge_frame_indices.push(curr);
        curr += 1;
    }

    // 2. Consume left level 1 blocks until aligned with BLOCK_SIZE_L2
    while (curr % (BLOCK_SIZE_L2 as i64) != 0) && (curr + (BLOCK_SIZE_L1 as i64) - 1 <= frame_to) {
        let b1 = curr / (BLOCK_SIZE_L1 as i64);
        plan.level1_blocks.push(b1);
        curr += BLOCK_SIZE_L1 as i64;
    }

    // 3. Consume whole level 2 blocks
    while curr + (BLOCK_SIZE_L2 as i64) - 1 <= frame_to {
        let b2 = curr / (BLOCK_SIZE_L2 as i64);
        plan.level2_blocks.push(b2);
        curr += BLOCK_SIZE_L2 as i64;
    }

    // 4. Consume right level 1 blocks
    while curr + (BLOCK_SIZE_L1 as i64) - 1 <= frame_to {
        let b1 = curr / (BLOCK_SIZE_L1 as i64);
        plan.level1_blocks.push(b1);
        curr += BLOCK_SIZE_L1 as i64;
    }

    // 5. Consume remaining right partial level 1 edge frames
    while curr <= frame_to {
        plan.edge_frame_indices.push(curr);
        curr += 1;
    }

    plan
}

pub fn assemble_range_timer_sums(
    conn: &Connection,
    frame_from: i64,
    frame_to: i64,
) -> Result<std::collections::HashMap<(i64, i64), (f64, i64)>, String> {
    let plan = plan_range_assembly(frame_from, frame_to);
    let mut timer_map: std::collections::HashMap<(i64, i64), (f64, i64)> = std::collections::HashMap::new();

    // 1. Level 2 blocks
    if !plan.level2_blocks.is_empty() {
        let in_clause = plan.level2_blocks.iter().map(|b| b.to_string()).collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT thread_id, timer_id, SUM(sum_excl_ms), SUM(sum_calls) 
             FROM block_profile 
             WHERE level = 2 AND block_idx IN ({}) 
             GROUP BY thread_id, timer_id",
            in_clause
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rows {
            let (th_id, tid, sum_excl_ms, sum_calls) = r.map_err(|e| e.to_string())?;
            let entry = timer_map.entry((th_id, tid)).or_insert((0.0, 0));
            entry.0 += sum_excl_ms;
            entry.1 += sum_calls;
        }
    }

    // 2. Level 1 blocks
    if !plan.level1_blocks.is_empty() {
        let in_clause = plan.level1_blocks.iter().map(|b| b.to_string()).collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT thread_id, timer_id, SUM(sum_excl_ms), SUM(sum_calls) 
             FROM block_profile 
             WHERE level = 1 AND block_idx IN ({}) 
             GROUP BY thread_id, timer_id",
            in_clause
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rows {
            let (th_id, tid, sum_excl_ms, sum_calls) = r.map_err(|e| e.to_string())?;
            let entry = timer_map.entry((th_id, tid)).or_insert((0.0, 0));
            entry.0 += sum_excl_ms;
            entry.1 += sum_calls;
        }
    }

    // 3. Edge frames (filtering out spike frames to match block_profile normal sums)
    if !plan.edge_frame_indices.is_empty() {
        let normal_threshold: f64 = conn
            .query_row(
                "SELECT CAST(value AS REAL) * 1.25 FROM meta WHERE key = 'median_frame_ms'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(999999.0);

        let in_clause = plan.edge_frame_indices.iter().map(|f| f.to_string()).collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT ft.thread_id, ft.timer_id, SUM(ft.excl_ms), SUM(ft.calls) 
             FROM frame_timer ft
             LEFT JOIN frames f ON f.idx = ft.frame_idx
             WHERE ft.frame_idx IN ({}) AND (f.interval_ms IS NULL OR f.interval_ms <= ?1)
             GROUP BY ft.thread_id, ft.timer_id",
            in_clause
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![normal_threshold], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rows {
            let (th_id, tid, sum_excl_ms, sum_calls) = r.map_err(|e| e.to_string())?;
            let entry = timer_map.entry((th_id, tid)).or_insert((0.0, 0));
            entry.0 += sum_excl_ms;
            entry.1 += sum_calls;
        }
    }

    Ok(timer_map)
}

pub fn calculate_local_medians(
    frames: &[ProcessedFrame],
    window_radius_s: f64,
    fallback_median: f64,
) -> Vec<f64> {
    if frames.is_empty() {
        return Vec::new();
    }
    let mut medians = Vec::with_capacity(frames.len());
    let mut w_start = 0;
    let mut w_end = 0;

    for (i, f) in frames.iter().enumerate() {
        let t = f.start_s;
        while w_start < i && frames[w_start].start_s < t - window_radius_s {
            w_start += 1;
        }
        while w_end + 1 < frames.len() && frames[w_end + 1].start_s <= t + window_radius_s {
            w_end += 1;
        }

        let count = w_end - w_start + 1;
        if count >= 5 {
            let mut vals: Vec<f64> = frames[w_start..=w_end].iter().map(|fr| fr.interval_ms).collect();
            vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
            medians.push(calculate_percentile(&vals, 0.5));
        } else {
            medians.push(fallback_median);
        }
    }

    medians
}

pub fn determine_dominant_thread(frames: &[ProcessedFrame]) -> String {
    let mut game_times: Vec<f64> = frames.iter().filter_map(|f| f.game_ms).collect();
    game_times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    let med_game = if game_times.is_empty() { 0.0 } else { calculate_percentile(&game_times, 0.5) };

    let mut render_times: Vec<f64> = frames.iter().filter_map(|f| f.render_ms).collect();
    render_times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    let med_render = if render_times.is_empty() { 0.0 } else { calculate_percentile(&render_times, 0.5) };

    let mut gpu_times: Vec<f64> = frames.iter().filter_map(|f| f.gpu_ms).collect();
    gpu_times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    let med_gpu = if gpu_times.is_empty() { 0.0 } else { calculate_percentile(&gpu_times, 0.5) };

    if med_gpu >= med_game && med_gpu >= med_render && med_gpu > 0.0 {
        "gpu".to_string()
    } else if med_game >= med_render && med_game > 0.0 {
        "game".to_string()
    } else if med_render > 0.0 {
        "render".to_string()
    } else {
        "unattributed".to_string()
    }
}

fn get_frame_level_and_thread(frames: &[ProcessedFrame], idx: usize) -> (f64, String) {
    let end = (idx + 5).min(frames.len());
    let slice = &frames[idx..end];
    let mut intervals: Vec<f64> = slice.iter().map(|f| f.interval_ms).collect();
    intervals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    let level = calculate_percentile(&intervals, 0.5);
    let thread = determine_dominant_thread(slice);
    (level, thread)
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
    let local_medians = calculate_local_medians(frames, 1.0, stats.median_ms);

    let mut episodes: Vec<DbEpisode> = Vec::new();
    let mut next_id: i64 = 1;

    // 1. Detect Isolated Hitches using local moving baselines
    let mut i = 0;
    while i < frames.len() {
        let local_med = local_medians[i];

        if is_hitch(frames[i].interval_ms, local_med, target_ms) {
            let start_idx = i;
            let mut end_idx = i;
            let mut peak_ms = frames[i].interval_ms;
            let mut interval_sum = frames[i].interval_ms;

            while end_idx + 1 < frames.len() {
                let next_med = local_medians[end_idx + 1];
                if is_hitch(frames[end_idx + 1].interval_ms, next_med, target_ms) {
                    end_idx += 1;
                    peak_ms = peak_ms.max(frames[end_idx].interval_ms);
                    interval_sum += frames[end_idx].interval_ms;
                } else {
                    break;
                }
            }

            let start_s = frames[start_idx].start_s;
            let last_f = &frames[end_idx];
            let end_s = last_f.start_s + (last_f.interval_ms / 1000.0);
            let frame_count = end_idx - start_idx + 1;
            let duration_s = end_s - start_s;
            let median_ms = interval_sum / (frame_count as f64);

            // Enforce transient criteria: at most 4 frames for isolated hitches
            if frame_count <= 4 || (frame_count <= 6 && duration_s <= 0.250) {
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
            }

            i = end_idx + 1;
        } else {
            i += 1;
        }
    }

    // 2. Detect Sustained Slow Regions with Regime Segmentation
    let slow_threshold = target_ms * 1.2;

    let mut slow_frame_indices: Vec<usize> = Vec::new();
    for (idx, f) in frames.iter().enumerate() {
        if local_medians[idx] >= slow_threshold || f.interval_ms >= slow_threshold {
            slow_frame_indices.push(idx);
        }
    }

    if !slow_frame_indices.is_empty() {
        let mut regions: Vec<(usize, usize, String)> = Vec::new();
        let mut start_idx = slow_frame_indices[0];
        let mut end_idx = slow_frame_indices[0];
        let (_reg_level, mut reg_thread) = get_frame_level_and_thread(frames, start_idx);

        for &curr_idx in slow_frame_indices.iter().skip(1) {
            let prev_frame = &frames[end_idx];
            let curr_frame = &frames[curr_idx];
            let gap_s = curr_frame.start_s - (prev_frame.start_s + prev_frame.interval_ms / 1000.0);

            let (_curr_level, curr_thread) = get_frame_level_and_thread(frames, curr_idx);

            let thread_compatible = reg_thread == curr_thread
                || reg_thread == "unattributed"
                || curr_thread == "unattributed";

            // If gap between slow frames is small (<= 0.75s) and thread is compatible, continue region
            if gap_s <= 0.75 && thread_compatible {
                end_idx = curr_idx;
                if reg_thread == "unattributed" && curr_thread != "unattributed" {
                    reg_thread = curr_thread;
                }
            } else {
                regions.push((start_idx, end_idx, reg_thread));
                start_idx = curr_idx;
                end_idx = curr_idx;
                reg_thread = curr_thread;
            }
        }
        regions.push((start_idx, end_idx, reg_thread));

        for (from_idx, to_idx, reg_thread) in regions {
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
                let bound_by = if reg_thread != "unattributed" {
                    reg_thread
                } else {
                    determine_dominant_thread(region_frames)
                };

                episodes.push(DbEpisode {
                    id: next_id,
                    kind: "slow_region".to_string(),
                    start_s,
                    end_s,
                    frame_from: frames[from_idx].idx,
                    frame_to: frames[to_idx].idx,
                    peak_ms,
                    median_ms,
                    bound_by,
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

    #[test]
    fn test_steady_slow_sequence_generates_zero_hitches() {
        let mut frames = Vec::new();
        let mut t = 0.0;
        // 300 frames all at 35ms (below 60 FPS target, but steady)
        for idx in 0..300 {
            frames.push(ProcessedFrame {
                idx,
                engine_frame: None,
                start_s: t,
                interval_ms: 35.0,
                game_ms: Some(34.0),
                render_ms: Some(10.0),
                gpu_ms: Some(12.0),
            });
            t += 35.0 / 1000.0;
        }

        let stats = calculate_robust_stats(&frames);
        let options = AnalysisOptions::default();
        let episodes = detect_episodes(&frames, &stats, &options);

        let hitches: Vec<_> = episodes.iter().filter(|e| e.kind == "hitch").collect();
        assert_eq!(hitches.len(), 0, "Steady 35ms sequence should generate 0 hitches");
    }

    #[test]
    fn test_transient_hitch_in_slow_sequence() {
        let mut frames = Vec::new();
        let mut t = 0.0;
        // 200 frames at 35ms with a single 120ms spike at frame 100
        for idx in 0..200 {
            let interval = if idx == 100 { 120.0 } else { 35.0 };
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
        }

        let stats = calculate_robust_stats(&frames);
        let options = AnalysisOptions::default();
        let episodes = detect_episodes(&frames, &stats, &options);

        let hitches: Vec<_> = episodes.iter().filter(|e| e.kind == "hitch").collect();
        assert_eq!(hitches.len(), 1, "Should isolate exactly 1 hitch in slow sequence");
        assert_eq!(hitches[0].frame_from, 100);
        assert_eq!(hitches[0].frame_to, 100);
        assert_eq!(hitches[0].peak_ms, 120.0);
    }

    #[test]
    fn test_transient_burst_limit_rejects_long_bursts() {
        let mut frames = Vec::new();
        let mut t = 0.0;
        // 100 frames at 16.6ms with 5 consecutive 60ms frames at 50..55
        for idx in 0..100 {
            let interval = if idx >= 50 && idx < 55 { 60.0 } else { 16.6 };
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
        }

        let stats = calculate_robust_stats(&frames);
        let options = AnalysisOptions::default();
        let episodes = detect_episodes(&frames, &stats, &options);

        let hitches: Vec<_> = episodes.iter().filter(|e| e.kind == "hitch").collect();
        assert_eq!(hitches.len(), 0, "5 consecutive slow frames should not be treated as isolated hitch");
    }

    #[test]
    fn test_performance_regime_segmentation_splits_distinct_slow_regions() {
        let mut frames = Vec::new();
        let mut t = 0.0;
        let mut idx = 0;

        // 5 seconds at 22ms (mild GPU-bound load) -> ~227 frames
        while t < 5.0 {
            frames.push(ProcessedFrame {
                idx,
                engine_frame: None,
                start_s: t,
                interval_ms: 22.0,
                game_ms: Some(10.0),
                render_ms: Some(8.0),
                gpu_ms: Some(21.0),
            });
            t += 22.0 / 1000.0;
            idx += 1;
        }

        // 5 seconds at 80ms (heavy CPU GameThread bottleneck) -> ~63 frames
        let switch_time = t;
        while t < 10.0 {
            frames.push(ProcessedFrame {
                idx,
                engine_frame: None,
                start_s: t,
                interval_ms: 80.0,
                game_ms: Some(78.0),
                render_ms: Some(12.0),
                gpu_ms: Some(20.0),
            });
            t += 80.0 / 1000.0;
            idx += 1;
        }

        let stats = calculate_robust_stats(&frames);
        let options = AnalysisOptions::default();
        let episodes = detect_episodes(&frames, &stats, &options);

        let slow_regions: Vec<_> = episodes.iter().filter(|e| e.kind == "slow_region").collect();
        assert_eq!(slow_regions.len(), 2, "Distinct 22ms GPU and 80ms GameThread regimes must be segmented into 2 regions");

        let reg1 = &slow_regions[0];
        let reg2 = &slow_regions[1];

        assert_eq!(reg1.bound_by, "gpu");
        assert!(reg1.median_ms >= 21.0 && reg1.median_ms <= 23.0);
        assert!(reg1.start_s < 1.0);
        assert!(reg1.end_s <= switch_time + 0.1);

        assert_eq!(reg2.bound_by, "game");
        assert!(reg2.median_ms >= 78.0 && reg2.median_ms <= 82.0);
        assert!(reg2.start_s >= switch_time - 0.1);
        assert!(reg2.end_s >= 9.5);
    }

    #[test]
    fn test_plan_range_assembly_hierarchy() {
        // Small range: directly edge frames
        let plan_small = plan_range_assembly(10, 50);
        assert!(plan_small.level2_blocks.is_empty());
        assert!(plan_small.level1_blocks.is_empty());
        assert_eq!(plan_small.edge_frame_indices.len(), 41);

        // Large range: 100 to 10,000
        let plan_large = plan_range_assembly(100, 10000);
        assert!(!plan_large.level2_blocks.is_empty(), "Large range should contain Level 2 blocks");
        assert!(!plan_large.level1_blocks.is_empty(), "Large range should contain Level 1 blocks");
        // Edges should not exceed 128 frames total
        assert!(plan_large.edge_frame_indices.len() <= 128);
    }

    #[test]
    fn test_block_pyramid_and_exact_range_assembly() {
        use crate::trace::store::init_db;

        let mut conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();

        let mut frames = Vec::new();
        let mut t = 0.0;
        let total_count = 5000;

        for idx in 0..total_count {
            let interval = if idx % 100 == 0 { 80.0 } else { 16.0 };
            frames.push(ProcessedFrame {
                idx,
                engine_frame: None,
                start_s: t,
                interval_ms: interval,
                game_ms: Some(interval - 1.0),
                render_ms: Some(10.0),
                gpu_ms: Some(12.0),
            });
            t += interval / 1000.0;
        }

        let stats = calculate_robust_stats(&frames);
        let opts = AnalysisOptions::default();

        conn.execute("INSERT INTO meta (key, value) VALUES ('median_frame_ms', ?1)", params![stats.median_ms.to_string()]).unwrap();

        // Seed frames and frame_timer rows
        let tx = conn.transaction().unwrap();
        {
            let mut f_stmt = tx.prepare("INSERT INTO frames (idx, start_s, interval_ms, game_ms, render_ms, gpu_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").unwrap();
            let mut stmt = tx.prepare("INSERT INTO frame_timer (frame_idx, thread_id, timer_id, excl_ms, calls, max_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?4)").unwrap();
            for f in &frames {
                f_stmt.execute(params![f.idx, f.start_s, f.interval_ms, f.game_ms, f.render_ms, f.gpu_ms]).unwrap();
                stmt.execute(params![f.idx, 1, 101, 5.0, 1]).unwrap();
                stmt.execute(params![f.idx, 1, 102, 2.5, 2]).unwrap();
                stmt.execute(params![f.idx, 2, 201, 8.0, 1]).unwrap();
            }
        }
        tx.commit().unwrap();

        build_block_pyramid(&mut conn, &frames, &stats, &opts).unwrap();

        // Validate multiple random ranges
        let test_ranges = vec![
            (0, 100),
            (50, 500),
            (64, 4095),
            (100, 4500),
            (0, 4999),
        ];

        let normal_threshold_ms = stats.median_ms * 1.25;

        for (from, to) in test_ranges {
            let assembled = assemble_range_timer_sums(&conn, from, to).unwrap();

            // Brute-force count normal frames in [from..=to]
            let normal_frames_in_range = frames[from as usize..=to as usize]
                .iter()
                .filter(|f| f.interval_ms <= normal_threshold_ms)
                .count() as f64;

            let expected_101_ms = normal_frames_in_range * 5.0;
            let expected_102_ms = normal_frames_in_range * 2.5;
            let expected_201_ms = normal_frames_in_range * 8.0;

            let actual_101 = assembled.get(&(1, 101)).map(|x| x.0).unwrap_or(0.0);
            let actual_102 = assembled.get(&(1, 102)).map(|x| x.0).unwrap_or(0.0);
            let actual_201 = assembled.get(&(2, 201)).map(|x| x.0).unwrap_or(0.0);

            assert!((actual_101 - expected_101_ms).abs() < 1e-4, "Mismatch on timer 101 for range [{}, {}]: actual={}, expected={}", from, to, actual_101, expected_101_ms);
            assert!((actual_102 - expected_102_ms).abs() < 1e-4, "Mismatch on timer 102 for range [{}, {}]: actual={}, expected={}", from, to, actual_102, expected_102_ms);
            assert!((actual_201 - expected_201_ms).abs() < 1e-4, "Mismatch on timer 201 for range [{}, {}]: actual={}, expected={}", from, to, actual_201, expected_201_ms);
        }
    }
}
