use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use rusqlite::{params, Connection};

#[derive(Debug, Clone)]
pub struct RawWindowEvent {
    pub thread_id: i64,
    pub timer_id: i64,
    pub start_s: f64,
    pub end_s: f64,
    pub depth: i32,
}

#[derive(Debug, Clone)]
pub struct ExclusiveEvent {
    pub thread_id: i64,
    pub timer_id: i64,
    pub start_s: f64,
    pub end_s: f64,
    pub depth: i32,
    pub excl_ms: f64,
}

struct StackEntry {
    index: usize,
    duration_s: f64,
    end_s: f64,
    children_duration_s: f64,
}

pub fn compute_exclusive_times(events: &[RawWindowEvent]) -> Vec<ExclusiveEvent> {
    let (exclusive_events, _) = compute_exclusive_times_with_hierarchy(events);
    exclusive_events
}

pub fn compute_exclusive_times_with_hierarchy(
    events: &[RawWindowEvent],
) -> (Vec<ExclusiveEvent>, HashMap<i64, (Option<i64>, Vec<i64>)>) {
    if events.is_empty() {
        return (Vec::new(), HashMap::new());
    }

    // Group event indices by thread_id
    let mut thread_map: HashMap<i64, Vec<usize>> = HashMap::new();
    for (i, ev) in events.iter().enumerate() {
        thread_map.entry(ev.thread_id).or_default().push(i);
    }

    let mut excl_ms_results: Vec<f64> = vec![0.0; events.len()];
    let mut timer_hierarchy: HashMap<i64, (Option<i64>, Vec<i64>)> = HashMap::new();

    for (_thread_id, mut indices) in thread_map {
        // Sort events by start_s ascending, then end_s descending (parents before children)
        indices.sort_by(|&a, &b| {
            let ev_a = &events[a];
            let ev_b = &events[b];
            ev_a.start_s
                .partial_cmp(&ev_b.start_s)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    ev_b.end_s
                        .partial_cmp(&ev_a.end_s)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
        });

        let mut stack: Vec<StackEntry> = Vec::new();

        for &idx in &indices {
            let ev = &events[idx];
            let ev_duration = (ev.end_s - ev.start_s).max(0.0);

            // Pop any completed scopes that ended before or at the start of this event
            while let Some(top) = stack.last() {
                if ev.start_s >= top.end_s - 1e-9 {
                    let popped = stack.pop().unwrap();
                    let direct_excl_s = (popped.duration_s - popped.children_duration_s).max(0.0);
                    excl_ms_results[popped.index] = direct_excl_s * 1000.0;
                } else {
                    break;
                }
            }

            // Record parent hierarchy
            if let Some(parent) = stack.last() {
                let parent_tid = events[parent.index].timer_id;
                let ancestors: Vec<i64> = stack.iter().map(|s| events[s.index].timer_id).collect();
                timer_hierarchy.entry(ev.timer_id).or_insert((Some(parent_tid), ancestors));
            } else {
                timer_hierarchy.entry(ev.timer_id).or_insert((None, Vec::new()));
            }

            // If there is still a parent scope on top of the stack, attribute this event's duration to parent
            if let Some(parent) = stack.last_mut() {
                parent.children_duration_s += ev_duration;
            }

            stack.push(StackEntry {
                index: idx,
                duration_s: ev_duration,
                end_s: ev.end_s,
                children_duration_s: 0.0,
            });
        }

        // Pop remaining scopes
        while let Some(popped) = stack.pop() {
            let direct_excl_s = (popped.duration_s - popped.children_duration_s).max(0.0);
            excl_ms_results[popped.index] = direct_excl_s * 1000.0;
        }
    }

    let mut output = Vec::with_capacity(events.len());
    for (i, ev) in events.iter().enumerate() {
        output.push(ExclusiveEvent {
            thread_id: ev.thread_id,
            timer_id: ev.timer_id,
            start_s: ev.start_s,
            end_s: ev.end_s,
            depth: ev.depth,
            excl_ms: excl_ms_results[i],
        });
    }

    (output, timer_hierarchy)
}

use crate::trace::csv_ingest::ProcessedFrame;
use crate::trace::source::ExportSlice;

pub fn ingest_slice_timing_events_stream(
    conn: &mut Connection,
    slice: &ExportSlice,
    frames: &[ProcessedFrame],
    csv_path: &Path,
    trace_start_s: f64,
    threshold_ms: f64,
    export_ms: f64,
) -> Result<usize, String> {
    if !csv_path.is_file() {
        return Ok(0);
    }

    let file = File::open(csv_path).map_err(|e| format!("Failed to open slice CSV: {}", e))?;
    let mut rdr = csv::ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(BufReader::new(file));

    let headers = rdr
        .headers()
        .map_err(|e| format!("Failed to read slice events header: {}", e))?
        .clone();

    let thread_idx = headers
        .iter()
        .position(|h| h.eq_ignore_ascii_case("threadid") || h.eq_ignore_ascii_case("thread_id"));
    let timer_idx = headers
        .iter()
        .position(|h| h.eq_ignore_ascii_case("timerid") || h.eq_ignore_ascii_case("timer_id"));
    let start_idx = headers
        .iter()
        .position(|h| h.eq_ignore_ascii_case("starttime") || h.eq_ignore_ascii_case("start_time") || h.eq_ignore_ascii_case("start_s"));
    let end_idx = headers
        .iter()
        .position(|h| h.eq_ignore_ascii_case("endtime") || h.eq_ignore_ascii_case("end_time") || h.eq_ignore_ascii_case("end_s"));
    let depth_idx = headers.iter().position(|h| h.eq_ignore_ascii_case("depth"));

    if thread_idx.is_none() || timer_idx.is_none() || start_idx.is_none() || end_idx.is_none() {
        return Err("Slice events CSV is missing required columns".to_string());
    }

    let thread_idx = thread_idx.unwrap();
    let timer_idx = timer_idx.unwrap();
    let start_idx = start_idx.unwrap();
    let end_idx = end_idx.unwrap();

    let mut raw_events = Vec::new();
    let mut record = csv::StringRecord::new();

    while rdr.read_record(&mut record).map_err(|e| e.to_string())? {
        if record.len() <= start_idx || record.len() <= end_idx || record.len() <= timer_idx {
            continue;
        }

        let thread_id = match record[thread_idx].parse::<i64>() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let timer_id = match record[timer_idx].parse::<i64>() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let start_s = match record[start_idx].parse::<f64>() {
            Ok(v) => (v - trace_start_s).max(0.0),
            Err(_) => continue,
        };
        let end_s = match record[end_idx].parse::<f64>() {
            Ok(v) => (v - trace_start_s).max(0.0),
            Err(_) => continue,
        };
        let depth = depth_idx
            .and_then(|idx| record.get(idx))
            .and_then(|d| d.parse::<i32>().ok())
            .unwrap_or(0);

        raw_events.push(RawWindowEvent {
            thread_id,
            timer_id,
            start_s,
            end_s,
            depth,
        });
    }

    let (exclusive_events, timer_hierarchy) = compute_exclusive_times_with_hierarchy(&raw_events);

    // Group by (frame_idx, thread_id, timer_id) -> (sum_excl_ms, calls, max_ms)
    struct TimerAgg {
        excl_ms: f64,
        calls: i64,
        max_ms: f64,
    }

    let mut frame_aggregates: HashMap<(i64, i64, i64), TimerAgg> = HashMap::new();

    for ev in &exclusive_events {
        let p = frames.partition_point(|f| f.start_s <= ev.start_s);
        if p == 0 {
            continue;
        }
        let candidate_idx = p - 1;
        let cand = &frames[candidate_idx];
        if cand.idx < slice.frame_from || cand.idx > slice.frame_to {
            continue;
        }

        let frame_end_s = if candidate_idx + 1 < frames.len() {
            frames[candidate_idx + 1].start_s
        } else {
            cand.start_s + (cand.interval_ms / 1000.0)
        };

        if ev.start_s >= cand.start_s && ev.start_s < frame_end_s {
            let key = (cand.idx, ev.thread_id, ev.timer_id);
            let entry = frame_aggregates.entry(key).or_insert(TimerAgg {
                excl_ms: 0.0,
                calls: 0,
                max_ms: 0.0,
            });
            entry.excl_ms += ev.excl_ms;
            entry.calls += 1;
            entry.max_ms = entry.max_ms.max(ev.excl_ms);
        }
    }

    let mut thread_timers: HashMap<(i64, i64), Vec<(i64, TimerAgg)>> = HashMap::new();
    for ((f_idx, t_id, timer_id), agg) in frame_aggregates {
        thread_timers.entry((f_idx, t_id)).or_default().push((timer_id, agg));
    }

    let mut rows_to_insert: Vec<(i64, i64, i64, f64, i64, f64)> = Vec::new();

    for ((f_idx, t_id), timers) in thread_timers {
        let mut rem_excl_ms: f64 = 0.0;
        let mut rem_calls: i64 = 0;
        let mut rem_max_ms: f64 = 0.0;

        for (timer_id, agg) in timers {
            if agg.excl_ms >= threshold_ms {
                rows_to_insert.push((f_idx, t_id, timer_id, agg.excl_ms, agg.calls, agg.max_ms));
            } else {
                rem_excl_ms += agg.excl_ms;
                rem_calls += agg.calls;
                rem_max_ms = rem_max_ms.max(agg.max_ms);
            }
        }

        if rem_excl_ms > 0.0 || rem_calls > 0 {
            rows_to_insert.push((f_idx, t_id, 0, rem_excl_ms, rem_calls, rem_max_ms));
        }
    }

    let inserted_count = rows_to_insert.len();

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT OR REPLACE INTO frame_timer (frame_idx, thread_id, timer_id, excl_ms, calls, max_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .map_err(|e| e.to_string())?;

        for r in &rows_to_insert {
            stmt.execute(params![r.0, r.1, r.2, r.3, r.4, r.5])
                .map_err(|e| e.to_string())?;
        }

        // Update timer parent IDs and paths if discovered
        if !timer_hierarchy.is_empty() {
            let mut timer_names_map: HashMap<i64, String> = HashMap::new();
            if let Ok(mut t_stmt) = tx.prepare("SELECT id, name FROM timers") {
                if let Ok(t_rows) = t_stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))) {
                    for tr in t_rows.flatten() {
                        timer_names_map.insert(tr.0, tr.1);
                    }
                }
            }

            let mut update_timer_stmt = tx.prepare(
                "UPDATE timers SET parent_id = ?1, path = ?2 WHERE id = ?3 AND (path IS NULL OR path = '')"
            ).map_err(|e| e.to_string())?;

            for (tid, (parent_id, ancestors)) in timer_hierarchy {
                if tid <= 0 {
                    continue;
                }
                let mut path_components: Vec<String> = ancestors
                    .iter()
                    .filter_map(|aid| timer_names_map.get(aid).cloned())
                    .collect();
                if let Some(leaf_name) = timer_names_map.get(&tid) {
                    path_components.push(leaf_name.clone());
                }
                let full_path = if !path_components.is_empty() {
                    path_components.join(" > ")
                } else {
                    timer_names_map.get(&tid).cloned().unwrap_or_default()
                };

                let _ = update_timer_stmt.execute(params![parent_id, full_path, tid]);
            }
        }

        tx.execute(
            "INSERT OR REPLACE INTO index_slices (slice_id, frame_from, frame_to, start_s, end_s, state, rows, export_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, 'done', ?6, ?7)",
            params![
                slice.slice_id,
                slice.frame_from,
                slice.frame_to,
                slice.start_s,
                slice.end_s,
                inserted_count as i64,
                export_ms
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    let _ = std::fs::remove_file(csv_path);

    Ok(inserted_count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace::store::init_db;
    use std::io::Write;

    #[test]
    fn test_ingest_slice_streaming_and_thresholding() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();

        let frames = vec![
            ProcessedFrame {
                idx: 0,
                engine_frame: None,
                start_s: 0.0,
                interval_ms: 16.666,
                game_ms: Some(16.0),
                render_ms: Some(15.0),
                gpu_ms: Some(14.0),
            },
            ProcessedFrame {
                idx: 1,
                engine_frame: None,
                start_s: 0.016666,
                interval_ms: 16.666,
                game_ms: Some(16.0),
                render_ms: Some(15.0),
                gpu_ms: Some(14.0),
            },
        ];

        let slice = ExportSlice {
            slice_id: 0,
            frame_from: 0,
            frame_to: 1,
            start_s: 0.0,
            end_s: 0.033332,
            threads: vec!["GameThread".to_string()],
        };

        let csv_path = std::env::temp_dir().join(format!("test_slice_{}.csv", std::process::id()));
        let mut f = File::create(&csv_path).unwrap();
        writeln!(f, "ThreadId,TimerId,StartTime,EndTime,Depth").unwrap();

        // Big timer: 5ms
        writeln!(f, "1,100,0.001,0.006,0").unwrap();
        // Small timer (< 0.1ms): 0.04ms
        writeln!(f, "1,101,0.007,0.00704,0").unwrap();
        // Another small timer (< 0.1ms): 0.03ms
        writeln!(f, "1,102,0.008,0.00803,0").unwrap();

        // Frame 1 event: 8ms
        writeln!(f, "1,200,0.020,0.028,0").unwrap();
        drop(f);

        let rows = ingest_slice_timing_events_stream(&mut conn, &slice, &frames, &csv_path, 0.0, 0.1, 10.0).unwrap();
        assert!(!csv_path.exists(), "CSV should be deleted after ingestion");
        assert_eq!(rows, 3); // Frame 0: timer 100 (5ms), timer 0 (0.07ms); Frame 1: timer 200 (8ms)

        let mut stmt = conn.prepare("SELECT frame_idx, timer_id, excl_ms, calls FROM frame_timer ORDER BY frame_idx, timer_id").unwrap();
        let query_rows: Vec<(i64, i64, f64, i64)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap().map(|r| r.unwrap()).collect();

        assert_eq!(query_rows.len(), 3);
        // Frame 0 remainder (timer_id = 0)
        assert_eq!(query_rows[0].0, 0);
        assert_eq!(query_rows[0].1, 0);
        assert!((query_rows[0].2 - 0.07).abs() < 1e-3);
        assert_eq!(query_rows[0].3, 2);

        // Frame 0 big timer (timer_id = 100)
        assert_eq!(query_rows[1].0, 0);
        assert_eq!(query_rows[1].1, 100);
        assert!((query_rows[1].2 - 5.0).abs() < 1e-3);
        assert_eq!(query_rows[1].3, 1);

        // Frame 1 timer (timer_id = 200)
        assert_eq!(query_rows[2].0, 1);
        assert_eq!(query_rows[2].1, 200);
        assert!((query_rows[2].2 - 8.0).abs() < 1e-3);
        assert_eq!(query_rows[2].3, 1);
    }

    #[test]
    fn test_exclusive_time_stack() {
        // Parent: 0.0 to 10.0 (total 10.0s = 10,000ms)
        // Child 1: 1.0 to 4.0 (3.0s = 3,000ms)
        // Child 2: 5.0 to 7.0 (2.0s = 2,000ms)
        // Grandchild under Child 2: 5.5 to 6.5 (1.0s = 1,000ms)
        let events = vec![
            RawWindowEvent {
                thread_id: 1,
                timer_id: 100, // Parent
                start_s: 0.0,
                end_s: 10.0,
                depth: 0,
            },
            RawWindowEvent {
                thread_id: 1,
                timer_id: 101, // Child 1
                start_s: 1.0,
                end_s: 4.0,
                depth: 1,
            },
            RawWindowEvent {
                thread_id: 1,
                timer_id: 102, // Child 2
                start_s: 5.0,
                end_s: 7.0,
                depth: 1,
            },
            RawWindowEvent {
                thread_id: 1,
                timer_id: 103, // Grandchild
                start_s: 5.5,
                end_s: 6.5,
                depth: 2,
            },
        ];

        let result = compute_exclusive_times(&events);
        assert_eq!(result.len(), 4);

        // Parent exclusive time = 10.0 - (3.0 + 2.0) = 5.0s = 5000.0 ms
        let parent_excl = result.iter().find(|e| e.timer_id == 100).unwrap().excl_ms;
        assert!((parent_excl - 5000.0).abs() < 1e-4);

        // Child 1 exclusive time = 3.0s = 3000.0 ms
        let child1_excl = result.iter().find(|e| e.timer_id == 101).unwrap().excl_ms;
        assert!((child1_excl - 3000.0).abs() < 1e-4);

        // Child 2 exclusive time = 2.0 - 1.0 = 1.0s = 1000.0 ms
        let child2_excl = result.iter().find(|e| e.timer_id == 102).unwrap().excl_ms;
        assert!((child2_excl - 1000.0).abs() < 1e-4);

        // Grandchild exclusive time = 1.0s = 1000.0 ms
        let gchild_excl = result.iter().find(|e| e.timer_id == 103).unwrap().excl_ms;
        assert!((gchild_excl - 1000.0).abs() < 1e-4);
    }
}
