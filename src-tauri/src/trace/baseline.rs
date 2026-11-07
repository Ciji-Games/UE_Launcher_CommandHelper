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

    let normal_count = normal_set.len();
    let mut baselines = Vec::new();

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        tx.execute("DELETE FROM baseline_global", []).map_err(|e| e.to_string())?;

        let mut insert_stmt = tx
            .prepare(
                "INSERT INTO baseline_global (thread_id, timer_id, median_excl_ms, p95_excl_ms, median_calls, samples, present_frames)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .map_err(|e| e.to_string())?;

        for ((thread_id, timer_id), (mut values_ms, mut values_calls)) in data {
            let present_frames = values_ms.len() as i64;
            if values_ms.len() < normal_count {
                values_ms.resize(normal_count, 0.0);
                values_calls.resize(normal_count, 0.0);
            }

            values_ms.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            values_calls.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

            let median_excl_ms = calculate_percentile(&values_ms, 0.5);
            let p95_excl_ms = calculate_percentile(&values_ms, 0.95);
            let median_calls = calculate_percentile(&values_calls, 0.5);
            let samples = normal_count as i64;

            insert_stmt
                .execute(params![
                    thread_id,
                    timer_id,
                    median_excl_ms,
                    p95_excl_ms,
                    median_calls,
                    samples,
                    present_frames,
                ])
                .map_err(|e| e.to_string())?;

            baselines.push(DbBaselineGlobal {
                thread_id,
                timer_id,
                median_excl_ms,
                p95_excl_ms,
                median_calls,
                samples,
                present_frames,
            });
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(baselines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace::store::{init_db, DbEpisode, DbFinding};
    use crate::trace::rules::tests::ScenarioContext;

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
        assert_eq!(b.present_frames, 3);
        assert!((b.median_excl_ms - 4.1).abs() < 1e-3);
    }

    #[test]
    fn test_baseline_gc_rare_presence_gives_zero_median() {
        // (a) GC 20 ms in rare normal frames (e.g. 2 of 20 or 6 of 100) gives median 0 and p95 > 0
        let mut conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();

        let mut frames = Vec::new();
        for i in 0..100 {
            frames.push(ProcessedFrame {
                idx: i,
                engine_frame: None,
                start_s: i as f64 * 0.016,
                interval_ms: 16.0,
                game_ms: Some(15.0),
                render_ms: None,
                gpu_ms: None,
            });
        }

        let stats = FrameStats {
            total_frames: 100,
            duration_s: 1.6,
            median_ms: 16.0,
            mad_ms: 0.0,
            p95_ms: 16.0,
            p99_ms: 16.0,
            min_ms: 16.0,
            max_ms: 16.0,
        };

        // Insert GC (timer_id 10) in 6 frames (6% of normal frames) with 20.0 ms
        for &f_idx in &[5, 15, 25, 35, 45, 55] {
            conn.execute("INSERT INTO frame_timer (frame_idx, thread_id, timer_id, excl_ms, calls, max_ms) VALUES (?1, 1, 10, 20.0, 1, 20.0)", params![f_idx]).unwrap();
        }

        let baselines = compute_and_save_global_baseline(&mut conn, &frames, &stats).unwrap();
        assert_eq!(baselines.len(), 1);
        let b = &baselines[0];
        assert_eq!(b.samples, 100);
        assert_eq!(b.present_frames, 6);
        assert_eq!(b.median_excl_ms, 0.0);
        assert!(b.p95_excl_ms > 0.0, "p95 should be > 0 but was {}", b.p95_excl_ms);
    }

    #[test]
    fn test_baseline_timer_in_60_of_100_frames_zero_filled_median() {
        // (b) a timer in 60 of 100 frames gives the correct zero-filled median
        let mut conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();

        let mut frames = Vec::new();
        for i in 0..100 {
            frames.push(ProcessedFrame {
                idx: i,
                engine_frame: None,
                start_s: i as f64 * 0.016,
                interval_ms: 16.0,
                game_ms: Some(15.0),
                render_ms: None,
                gpu_ms: None,
            });
        }

        let stats = FrameStats {
            total_frames: 100,
            duration_s: 1.6,
            median_ms: 16.0,
            mad_ms: 0.0,
            p95_ms: 16.0,
            p99_ms: 16.0,
            min_ms: 16.0,
            max_ms: 16.0,
        };

        // Present in 60 frames (e.g. 40..100) with 10.0 ms
        for i in 40..100 {
            conn.execute("INSERT INTO frame_timer (frame_idx, thread_id, timer_id, excl_ms, calls, max_ms) VALUES (?1, 1, 20, 10.0, 1, 10.0)", params![i]).unwrap();
        }

        let baselines = compute_and_save_global_baseline(&mut conn, &frames, &stats).unwrap();
        assert_eq!(baselines.len(), 1);
        let b = &baselines[0];
        assert_eq!(b.samples, 100);
        assert_eq!(b.present_frames, 60);
        // 40 zeros, 60 tens -> median (50th percentile) is at index 50, which is 10.0
        assert_eq!(b.median_excl_ms, 10.0);
    }

    #[test]
    fn test_end_to_end_gc_hitch_with_rare_baseline() {
        // (c) end to end, a hitch frame with GC 20 ms produces about 20 ms excess and a gc-hitch occurrence
        let mut ctx = ScenarioContext::new();
        ctx.seed_baseline_window_frames(1, 6);

        // GC only present in 1 baseline frame (or baseline median 0)
        let gc_tid = ctx.get_or_create_timer(1, "CollectGarbage");
        ctx.conn.execute(
            "INSERT INTO baseline_global (thread_id, timer_id, median_excl_ms, p95_excl_ms, median_calls, samples, present_frames)
             VALUES (1, ?1, 0.0, 10.0, 0.0, 100, 2)",
            params![gc_tid],
        ).unwrap();

        // Add 20ms GC on hitch frame
        ctx.add_event(1, 1, "CollectGarbage", 20.0);

        let ep = DbEpisode {
            id: 1,
            kind: "hitch".to_string(),
            start_s: 1.0,
            end_s: 1.1,
            frame_from: 100,
            frame_to: 101,
            peak_ms: 40.0,
            median_ms: 16.6,
            bound_by: "unattributed".to_string(),
            periodic_group: Some(1),
        };

        let (findings, bound_by): (Vec<DbFinding>, String) = ctx.evaluate(ep);
        assert_eq!(bound_by, "game");
        let gc_finding = findings.iter().find(|f| f.rule_id == "gc-hitch").expect("Should find gc-hitch");
        let payload: crate::trace::rules::FindingPayload = serde_json::from_str(&gc_finding.payload).unwrap();
        assert!(!payload.evidence.is_empty());
        let ev = &payload.evidence[0];
        assert!(ev.label.contains("CollectGarbage"), "Evidence was: {}", ev.label);
        assert!(ev.label.contains("20.0 ms") || ev.label.contains("20 ms"), "Evidence was: {}", ev.label);
    }
}
