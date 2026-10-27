use std::collections::HashMap;
use rusqlite::{params, Connection};

use crate::trace::csv_ingest::ProcessedFrame;
use crate::trace::frames::{calculate_percentile, AnalysisOptions, FrameStats};
use crate::trace::source::ExportWindow;
use crate::trace::store::DbEpisode;

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct ScopeBaselineStats {
    pub scope: String,
    pub thread_id: i64,
    pub timer_id: i64,
    pub median_excl_ms: f64,
    pub p95_excl_ms: f64,
    pub median_calls: f64,
    pub samples: usize,
}

pub fn generate_pass_b_windows(
    episodes: &[DbEpisode],
    frames: &[ProcessedFrame],
    stats: &FrameStats,
    options: &AnalysisOptions,
    trace_start_s: f64,
) -> Vec<ExportWindow> {
    if episodes.is_empty() || frames.is_empty() {
        return Vec::new();
    }

    let mut ranked_episodes = episodes.to_vec();
    // Rank by peak_ms * duration_s descending
    ranked_episodes.sort_by(|a, b| {
        let score_a = a.peak_ms * (a.end_s - a.start_s).max(0.016);
        let score_b = b.peak_ms * (b.end_s - b.start_s).max(0.016);
        score_b.partial_cmp(&score_a).unwrap_or(std::cmp::Ordering::Equal)
    });

    let max_eps = options.max_episodes.min(8);
    let top_episodes: Vec<DbEpisode> = ranked_episodes
        .into_iter()
        .take(max_eps)
        .collect();

    let mut windows = Vec::new();
    let pad_before_s = 0.033; // 1-2 frames before
    let pad_after_s = 0.066;  // 2-3 frames after

    let normal_threshold_ms = stats.median_ms * 1.25;

    // Normal frames pool for baseline
    let normal_frames: Vec<&ProcessedFrame> = frames
        .iter()
        .filter(|f| f.interval_ms <= normal_threshold_ms)
        .collect();

    for ep in &top_episodes {
        // Episode Window (Positive ID)
        let win_start = (ep.start_s - pad_before_s).max(0.0) + trace_start_s;
        let win_end = ep.end_s + pad_after_s + trace_start_s;

        windows.push(ExportWindow {
            window_id: ep.id,
            start_s: win_start,
            end_s: win_end,
            threads: vec![
                "GameThread".to_string(),
                "RenderThread*".to_string(),
                "RHIThread".to_string(),
                "GPU*".to_string(),
            ],
        });

        // Local Baseline Window (Negative ID) - one consolidated window per episode
        // Find contiguous normal frames within [ep.start_s - 5.0, ep.start_s + 5.0]
        let local_candidates: Vec<&ProcessedFrame> = normal_frames
            .iter()
            .copied()
            .filter(|f| (f.start_s - ep.start_s).abs() <= 5.0 && (f.start_s < ep.start_s || f.start_s > ep.end_s))
            .collect();

        if !local_candidates.is_empty() {
            // Find a contiguous block of up to 5 normal frames
            let sample_count = local_candidates.len().min(5);
            let first_f = local_candidates[0];
            let last_f = local_candidates[sample_count - 1];
            let b_start = first_f.start_s.min(last_f.start_s) + trace_start_s;
            let b_end = first_f.start_s.max(last_f.start_s) + (last_f.interval_ms / 1000.0) + 0.01 + trace_start_s;

            windows.push(ExportWindow {
                window_id: -ep.id,
                start_s: b_start,
                end_s: b_end,
                threads: vec![
                    "GameThread".to_string(),
                    "RenderThread*".to_string(),
                    "RHIThread".to_string(),
                    "GPU*".to_string(),
                ],
            });
        }
    }

    // Global Baseline Window (Negative ID -9999) - up to 2 consolidated windows
    if !normal_frames.is_empty() {
        let first_norm = normal_frames[0];
        let mid_idx = normal_frames.len() / 2;
        let mid_norm = normal_frames[mid_idx];

        // First normal window (0.3s)
        windows.push(ExportWindow {
            window_id: -9999,
            start_s: first_norm.start_s + trace_start_s,
            end_s: first_norm.start_s + 0.3 + trace_start_s,
            threads: vec![
                "GameThread".to_string(),
                "RenderThread*".to_string(),
                "RHIThread".to_string(),
                "GPU*".to_string(),
            ],
        });

        if mid_idx > 0 && mid_idx < normal_frames.len() {
            // Second normal window (0.3s)
            windows.push(ExportWindow {
                window_id: -9999,
                start_s: mid_norm.start_s + trace_start_s,
                end_s: mid_norm.start_s + 0.3 + trace_start_s,
                threads: vec![
                    "GameThread".to_string(),
                    "RenderThread*".to_string(),
                    "RHIThread".to_string(),
                    "GPU*".to_string(),
                ],
            });
        }
    }

    windows
}

pub fn compute_and_save_baselines(conn: &mut Connection) -> Result<(), String> {
    // 1. Gather baseline stats per window_id (< 0)
    let mut baseline_events: HashMap<(String, i64, i64), Vec<f64>> = HashMap::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT window_id, thread_id, timer_id, excl_ms 
                 FROM window_events 
                 WHERE window_id < 0",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                let win_id: i64 = row.get(0)?;
                let thread_id: i64 = row.get(1)?;
                let timer_id: i64 = row.get(2)?;
                let excl_ms: f64 = row.get(3)?;
                Ok((win_id, thread_id, timer_id, excl_ms))
            })
            .map_err(|e| e.to_string())?;

        for r in rows {
            let (win_id, thread_id, timer_id, excl_ms) = r.map_err(|e| e.to_string())?;
            let scope = if win_id == -9999 {
                "global".to_string()
            } else {
                format!("episode:{}", -win_id)
            };
            baseline_events
                .entry((scope, thread_id, timer_id))
                .or_default()
                .push(excl_ms);
        }
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO baseline_stats (scope, thread_id, timer_id, median_excl_ms, p95_excl_ms, median_calls, samples)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .map_err(|e| e.to_string())?;

        for ((scope, thread_id, timer_id), mut values) in baseline_events {
            values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let median_excl_ms = calculate_percentile(&values, 0.5);
            let p95_excl_ms = calculate_percentile(&values, 0.95);
            let samples = values.len();
            let median_calls = 1.0;

            stmt.execute(params![
                scope,
                thread_id,
                timer_id,
                median_excl_ms,
                p95_excl_ms,
                median_calls,
                samples as i64,
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(())
}
