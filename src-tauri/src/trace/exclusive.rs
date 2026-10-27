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
    if events.is_empty() {
        return Vec::new();
    }

    // Group event indices by thread_id
    let mut thread_map: HashMap<i64, Vec<usize>> = HashMap::new();
    for (i, ev) in events.iter().enumerate() {
        thread_map.entry(ev.thread_id).or_default().push(i);
    }

    let mut excl_ms_results: Vec<f64> = vec![0.0; events.len()];

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

    output
}

pub fn ingest_window_csv(
    conn: &mut Connection,
    window_id: i64,
    csv_path: &Path,
    trace_start_s: f64,
) -> Result<Vec<ExclusiveEvent>, String> {
    if !csv_path.is_file() {
        return Ok(Vec::new());
    }

    let file = File::open(csv_path).map_err(|e| format!("Failed to open window CSV: {}", e))?;
    let mut rdr = csv::ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(BufReader::new(file));

    let headers = rdr
        .headers()
        .map_err(|e| format!("Failed to read window events header: {}", e))?
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
        return Err("Window events CSV is missing required columns".to_string());
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

    let exclusive_events = compute_exclusive_times(&raw_events);

    // Save to window_events table in SQLite
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO window_events (window_id, thread_id, timer_id, start_s, end_s, depth, excl_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .map_err(|e| e.to_string())?;

        for ev in &exclusive_events {
            stmt.execute(params![
                window_id,
                ev.thread_id,
                ev.timer_id,
                ev.start_s,
                ev.end_s,
                ev.depth,
                ev.excl_ms,
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(exclusive_events)
}

#[cfg(test)]
mod tests {
    use super::*;

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
