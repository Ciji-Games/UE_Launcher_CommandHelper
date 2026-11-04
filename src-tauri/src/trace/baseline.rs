use std::collections::HashMap;
use rusqlite::{params, Connection};

use crate::trace::csv_ingest::ProcessedFrame;
use crate::trace::frames::{calculate_percentile, FrameStats};
use crate::trace::store::DbBaselineGlobal;

pub fn compute_and_save_global_baseline(
    conn: &mut Connection,
    frames: &[ProcessedFrame],
    stats: &FrameStats,
) -> Result<Vec<DbBaselineGlobal>, String> {
    if frames.is_empty() {
        return Ok(Vec::new());
    }

    let normal_threshold_ms = stats.median_ms * 1.25;

    let mut normal_indices: Vec<i64> = frames
        .iter()
        .filter(|f| f.interval_ms <= normal_threshold_ms)
        .map(|f| f.idx)
        .collect();

    // Fallback if no frames meet the normal threshold
    if normal_indices.is_empty() {
        let mut sorted_frames = frames.to_vec();
        sorted_frames.sort_by(|a, b| a.interval_ms.partial_cmp(&b.interval_ms).unwrap_or(std::cmp::Ordering::Equal));
        let take_count = (frames.len() / 2).max(1);
        normal_indices = sorted_frames.into_iter().take(take_count).map(|f| f.idx).collect();
    }

    let mut data: HashMap<(i64, i64), (Vec<f64>, Vec<f64>)> = HashMap::new();
    let normal_set: std::collections::HashSet<i64> = normal_indices.into_iter().collect();

    {
        let mut stmt = conn
            .prepare("SELECT frame_idx, thread_id, timer_id, excl_ms, calls FROM frame_timer ORDER BY frame_idx")
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                let f_idx: i64 = row.get(0)?;
                let t_id: i64 = row.get(1)?;
                let timer_id: i64 = row.get(2)?;
                let excl_ms: f64 = row.get(3)?;
                let calls: i64 = row.get(4)?;
                Ok((f_idx, t_id, timer_id, excl_ms, calls))
            })
            .map_err(|e| e.to_string())?;

        for r in rows {
            let (f_idx, t_id, timer_id, excl_ms, calls) = r.map_err(|e| e.to_string())?;
            if normal_set.contains(&f_idx) {
                let entry = data.entry((t_id, timer_id)).or_insert_with(|| (Vec::new(), Vec::new()));
                entry.0.push(excl_ms);
                entry.1.push(calls as f64);
            }
        }
    }

    let mut baselines = Vec::new();

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        tx.execute("DELETE FROM baseline_global", []).map_err(|e| e.to_string())?;

        let mut insert_stmt = tx
            .prepare(
                "INSERT INTO baseline_global (thread_id, timer_id, median_excl_ms, p95_excl_ms, median_calls, samples)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .map_err(|e| e.to_string())?;

        for ((thread_id, timer_id), (mut values_ms, mut values_calls)) in data {
            values_ms.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            values_calls.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

            let median_excl_ms = calculate_percentile(&values_ms, 0.5);
            let p95_excl_ms = calculate_percentile(&values_ms, 0.95);
            let median_calls = calculate_percentile(&values_calls, 0.5);
            let samples = values_ms.len() as i64;

            insert_stmt
                .execute(params![
                    thread_id,
                    timer_id,
                    median_excl_ms,
                    p95_excl_ms,
                    median_calls,
                    samples,
                ])
                .map_err(|e| e.to_string())?;

            baselines.push(DbBaselineGlobal {
                thread_id,
                timer_id,
                median_excl_ms,
                p95_excl_ms,
                median_calls,
                samples,
            });
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(baselines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace::store::init_db;

    #[test]
    fn test_compute_global_baseline() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();

        let frames = vec![
            ProcessedFrame { idx: 0, engine_frame: None, start_s: 0.00, interval_ms: 16.0, game_ms: Some(15.0), render_ms: None, gpu_ms: None },
            ProcessedFrame { idx: 1, engine_frame: None, start_s: 0.016, interval_ms: 16.2, game_ms: Some(15.2), render_ms: None, gpu_ms: None },
            ProcessedFrame { idx: 2, engine_frame: None, start_s: 0.032, interval_ms: 55.0, game_ms: Some(50.0), render_ms: None, gpu_ms: None }, // Hitch
            ProcessedFrame { idx: 3, engine_frame: None, start_s: 0.087, interval_ms: 16.1, game_ms: Some(15.1), render_ms: None, gpu_ms: None },
        ];

        let stats = FrameStats {
            total_frames: 4,
            duration_s: 0.1,
            median_ms: 16.1,
            mad_ms: 0.1,
            p95_ms: 52.0,
            p99_ms: 54.0,
            min_ms: 16.0,
            max_ms: 55.0,
        };

        // Seed frame_timer rows
        // Normal frames: 0, 1, 3
        conn.execute("INSERT INTO frame_timer (frame_idx, thread_id, timer_id, excl_ms, calls, max_ms) VALUES (0, 1, 10, 4.0, 1, 4.0)", []).unwrap();
        conn.execute("INSERT INTO frame_timer (frame_idx, thread_id, timer_id, excl_ms, calls, max_ms) VALUES (1, 1, 10, 4.2, 1, 4.2)", []).unwrap();
        conn.execute("INSERT INTO frame_timer (frame_idx, thread_id, timer_id, excl_ms, calls, max_ms) VALUES (2, 1, 10, 40.0, 1, 40.0)", []).unwrap(); // in hitch frame
        conn.execute("INSERT INTO frame_timer (frame_idx, thread_id, timer_id, excl_ms, calls, max_ms) VALUES (3, 1, 10, 4.1, 1, 4.1)", []).unwrap();

        let baselines = compute_and_save_global_baseline(&mut conn, &frames, &stats).unwrap();
        assert_eq!(baselines.len(), 1);
        let b = &baselines[0];
        assert_eq!(b.thread_id, 1);
        assert_eq!(b.timer_id, 10);
        assert_eq!(b.samples, 3); // 3 normal frames
        assert!((b.median_excl_ms - 4.1).abs() < 1e-3);
    }
}
