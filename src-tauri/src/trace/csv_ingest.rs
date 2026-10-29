use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use rusqlite::{params, Connection};

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct RawThread {
    pub id: i64,
    pub name: String,
    pub group: String,
    pub role: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct RawTimer {
    pub id: i64,
    pub timer_type: String,
    pub name: String,
    pub file: String,
    pub line: i32,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct FrameEvent {
    pub thread_id: i64,
    pub timer_id: i64,
    pub start_s: f64,
    pub end_s: f64,
    pub depth: i32,
}

#[derive(Debug, Clone)]
pub struct ProcessedFrame {
    pub idx: i64,
    pub engine_frame: Option<i64>,
    pub start_s: f64,
    pub interval_ms: f64,
    pub game_ms: Option<f64>,
    pub render_ms: Option<f64>,
    pub gpu_ms: Option<f64>,
}

pub fn determine_thread_role(name: &str, group: &str) -> &'static str {
    let lower_name = name.to_lowercase();
    let lower_group = group.to_lowercase();

    if lower_name.contains("gamethread") || lower_name == "game" {
        "game"
    } else if lower_name.contains("renderthread") || lower_group == "render" {
        "render"
    } else if lower_name.contains("rhithread") || lower_name == "rhi" {
        "rhi"
    } else if lower_name.starts_with("gpu") || lower_group == "gpu" {
        "gpu"
    } else if lower_name.contains("worker") || lower_name.contains("task") {
        "worker"
    } else {
        "other"
    }
}

pub fn ingest_threads_csv(conn: &mut Connection, path: &Path) -> Result<Vec<RawThread>, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open threads CSV: {}", e))?;
    let mut rdr = csv::ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(BufReader::new(file));

    let headers = rdr
        .headers()
        .map_err(|e| format!("Failed to read threads header: {}", e))?
        .clone();

    let id_idx = headers.iter().position(|h| h.eq_ignore_ascii_case("id"));
    let name_idx = headers.iter().position(|h| h.eq_ignore_ascii_case("name"));
    let group_idx = headers.iter().position(|h| h.eq_ignore_ascii_case("group"));

    if id_idx.is_none() || name_idx.is_none() {
        return Err("threads.csv is missing required 'Id' or 'Name' column".to_string());
    }
    let id_idx = id_idx.unwrap();
    let name_idx = name_idx.unwrap();

    let mut threads = Vec::new();
    let mut record = csv::StringRecord::new();

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("INSERT INTO threads (id, name, role) VALUES (?1, ?2, ?3)")
            .map_err(|e| e.to_string())?;

        while rdr.read_record(&mut record).map_err(|e| e.to_string())? {
            if record.len() <= id_idx || record.len() <= name_idx {
                continue;
            }
            if let Ok(id) = record[id_idx].parse::<i64>() {
                let name = record[name_idx].to_string();
                let group = group_idx
                    .and_then(|idx| record.get(idx))
                    .unwrap_or("")
                    .to_string();
                let role = determine_thread_role(&name, &group).to_string();

                stmt.execute(params![id, &name, &role])
                    .map_err(|e| e.to_string())?;

                threads.push(RawThread {
                    id,
                    name,
                    group,
                    role,
                });
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(threads)
}

pub fn ingest_timers_csv(conn: &mut Connection, path: &Path) -> Result<Vec<RawTimer>, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open timers CSV: {}", e))?;
    let mut rdr = csv::ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(BufReader::new(file));

    let headers = rdr
        .headers()
        .map_err(|e| format!("Failed to read timers header: {}", e))?
        .clone();

    let id_idx = headers.iter().position(|h| h.eq_ignore_ascii_case("id"));
    let type_idx = headers.iter().position(|h| h.eq_ignore_ascii_case("type"));
    let name_idx = headers.iter().position(|h| h.eq_ignore_ascii_case("name"));
    let file_idx = headers.iter().position(|h| h.eq_ignore_ascii_case("file"));
    let line_idx = headers.iter().position(|h| h.eq_ignore_ascii_case("line"));

    if id_idx.is_none() || name_idx.is_none() {
        return Err("timers.csv is missing required 'Id' or 'Name' column".to_string());
    }
    let id_idx = id_idx.unwrap();
    let name_idx = name_idx.unwrap();

    let mut timers = Vec::new();
    let mut record = csv::StringRecord::new();

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("INSERT INTO timers (id, name, bucket, kind) VALUES (?1, ?2, ?3, ?4)")
            .map_err(|e| e.to_string())?;

        while rdr.read_record(&mut record).map_err(|e| e.to_string())? {
            if record.len() <= id_idx || record.len() <= name_idx {
                continue;
            }
            if let Ok(id) = record[id_idx].parse::<i64>() {
                let name = record[name_idx].to_string();
                let timer_type = type_idx
                    .and_then(|idx| record.get(idx))
                    .unwrap_or("CPU")
                    .to_string();
                let file = file_idx
                    .and_then(|idx| record.get(idx))
                    .unwrap_or("")
                    .to_string();
                let line = line_idx
                    .and_then(|idx| record.get(idx))
                    .and_then(|l| l.parse::<i32>().ok())
                    .unwrap_or(0);

                // Initial insertion with placeholder bucket and kind (populated by buckets module)
                stmt.execute(params![id, &name, "Other", "work"])
                    .map_err(|e| e.to_string())?;

                timers.push(RawTimer {
                    id,
                    timer_type,
                    name,
                    file,
                    line,
                });
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(timers)
}

pub fn read_frame_events(path: &Path) -> Result<Vec<FrameEvent>, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open frame events CSV: {}", e))?;
    let mut rdr = csv::ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(BufReader::new(file));

    let headers = rdr
        .headers()
        .map_err(|e| format!("Failed to read frame events header: {}", e))?
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

    if thread_idx.is_none() || start_idx.is_none() || end_idx.is_none() {
        return Err("Frame events CSV is missing required columns (ThreadId, StartTime, EndTime)".to_string());
    }

    let thread_idx = thread_idx.unwrap();
    let timer_idx = timer_idx.unwrap_or(0);
    let start_idx = start_idx.unwrap();
    let end_idx = end_idx.unwrap();

    let mut events = Vec::new();
    let mut record = csv::StringRecord::new();

    while rdr.read_record(&mut record).map_err(|e| e.to_string())? {
        if record.len() <= start_idx || record.len() <= end_idx || record.len() <= thread_idx {
            continue;
        }

        let thread_id = record[thread_idx].parse::<i64>().unwrap_or(0);
        let timer_id = if timer_idx < record.len() {
            record[timer_idx].parse::<i64>().unwrap_or(0)
        } else {
            0
        };
        let start_s = match record[start_idx].parse::<f64>() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let end_s = match record[end_idx].parse::<f64>() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let depth = depth_idx
            .and_then(|idx| record.get(idx))
            .and_then(|d| d.parse::<i32>().ok())
            .unwrap_or(0);

        events.push(FrameEvent {
            thread_id,
            timer_id,
            start_s,
            end_s,
            depth,
        });
    }

    Ok(events)
}

pub fn process_and_ingest_frames(
    conn: &mut Connection,
    threads: &[RawThread],
    events: &[FrameEvent],
) -> Result<Vec<ProcessedFrame>, String> {
    let mut thread_roles = HashMap::new();
    for t in threads {
        thread_roles.insert(t.id, t.role.as_str());
    }

    // Separate events by role
    let mut game_events = Vec::new();
    let mut render_events = Vec::new();
    let mut gpu_events = Vec::new();

    for ev in events {
        let role = thread_roles.get(&ev.thread_id).copied().unwrap_or("other");
        match role {
            "game" => game_events.push(ev),
            "render" => render_events.push(ev),
            "gpu" => gpu_events.push(ev),
            _ => {}
        }
    }

    // Sort by start_s
    game_events.sort_by(|a, b| a.start_s.partial_cmp(&b.start_s).unwrap_or(std::cmp::Ordering::Equal));
    render_events.sort_by(|a, b| a.start_s.partial_cmp(&b.start_s).unwrap_or(std::cmp::Ordering::Equal));
    gpu_events.sort_by(|a, b| a.start_s.partial_cmp(&b.start_s).unwrap_or(std::cmp::Ordering::Equal));

    if game_events.is_empty() {
        return Err("No GameThread frame events found in trace export".to_string());
    }

    let trace_start_s = game_events[0].start_s;
    let _ = crate::trace::store::set_meta(conn, "trace_start_s", &trace_start_s.to_string());

    let mut processed_frames = Vec::with_capacity(game_events.len());

    let mut render_idx = 0;
    let mut gpu_idx = 0;

    for i in 0..game_events.len() {
        let curr = game_events[i];
        let game_ms = (curr.end_s - curr.start_s) * 1000.0;

        let interval_ms = if i + 1 < game_events.len() {
            let next = game_events[i + 1];
            (next.start_s - curr.start_s) * 1000.0
        } else {
            game_ms
        };

        // Align render frame: find the first render event whose start is >= curr.start_s
        // or closest in time
        let mut render_ms = None;
        while render_idx < render_events.len() && render_events[render_idx].end_s < curr.start_s {
            render_idx += 1;
        }
        if render_idx < render_events.len() {
            let r_ev = render_events[render_idx];
            // If it starts within a reasonable window (e.g. within 2 frames)
            if (r_ev.start_s - curr.start_s).abs() < 0.2 {
                render_ms = Some((r_ev.end_s - r_ev.start_s) * 1000.0);
            }
        }

        // Align GPU frame
        let mut gpu_ms = None;
        while gpu_idx < gpu_events.len() && gpu_events[gpu_idx].end_s < curr.start_s {
            gpu_idx += 1;
        }
        if gpu_idx < gpu_events.len() {
            let g_ev = gpu_events[gpu_idx];
            if (g_ev.start_s - curr.start_s).abs() < 0.2 {
                gpu_ms = Some((g_ev.end_s - g_ev.start_s) * 1000.0);
            }
        }

        let normalized_start_s = (curr.start_s - trace_start_s).max(0.0);

        processed_frames.push(ProcessedFrame {
            idx: i as i64,
            engine_frame: None,
            start_s: normalized_start_s,
            interval_ms: interval_ms.max(0.001),
            game_ms: Some(game_ms.max(0.001)),
            render_ms,
            gpu_ms,
        });
    }

    // Insert into SQLite in batches
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO frames (idx, engine_frame, start_s, interval_ms, game_ms, render_ms, gpu_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .map_err(|e| e.to_string())?;

        for f in &processed_frames {
            stmt.execute(params![
                f.idx,
                f.engine_frame,
                f.start_s,
                f.interval_ms,
                f.game_ms,
                f.render_ms,
                f.gpu_ms,
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(processed_frames)
}

fn clean_bookmark_name(raw: &str) -> String {
    let mut s = raw.trim();
    if s.starts_with("TRACE_BOOKMARK(") && s.ends_with(')') {
        s = &s[15..s.len() - 1].trim();
    }
    if (s.starts_with("TEXT(\"") || s.starts_with("TEXT('")) && s.ends_with(')') {
        s = &s[5..s.len() - 1].trim();
    }
    if (s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\'')) {
        if s.len() >= 2 {
            s = &s[1..s.len() - 1].trim();
        }
    }
    s.to_string()
}

pub fn is_valid_bookmark(name: &str, start_s: f64) -> bool {
    let s = name.trim();
    if s.is_empty() {
        return false;
    }

    let lower = s.to_ascii_lowercase();

    // 1. Generic placeholder names at startup (<= 0.001s) are channel initialization noise
    let is_generic = lower == "bookmark"
        || lower == "marker"
        || lower == "namedregion"
        || lower == "trace_bookmark"
        || lower == "unnamed";
    if start_s <= 0.001 && is_generic {
        return false;
    }

    // 2. Filter out Blueprint/Code timers that might be caught by substring filters or timer exports
    // e.g. BPI_HitmarkerTargetInfo_C, HitmarkerDispatcher_DelegateSignature, OnDispatchHitmarkerInfo
    if s.ends_with("_C")
        || s.contains("_DelegateSignature")
        || s.contains("DelegateSignature")
        || s.starts_with("BPI_")
        || s.starts_with("Function ")
        || s.starts_with("ExecuteUbergraph_")
        || (start_s <= 0.001 && (s.starts_with("OnDispatch") || s.starts_with("BP_") || s.starts_with("WBP_")))
    {
        return false;
    }

    true
}

pub fn ingest_bookmarks_csv(
    conn: &mut Connection,
    path: &Path,
    trace_start_s: f64,
) -> Result<usize, String> {
    if !path.is_file() {
        return Ok(0);
    }
    let file = File::open(path).map_err(|e| format!("Failed to open bookmarks CSV: {}", e))?;
    let mut rdr = csv::ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(BufReader::new(file));

    let headers = match rdr.headers() {
        Ok(h) => h.clone(),
        Err(_) => return Ok(0),
    };

    let thread_idx = headers
        .iter()
        .position(|h| h.eq_ignore_ascii_case("threadid") || h.eq_ignore_ascii_case("thread_id"));
    let timer_idx = headers
        .iter()
        .position(|h| h.eq_ignore_ascii_case("timerid") || h.eq_ignore_ascii_case("timer_id"));
    let name_idx = headers.iter().position(|h| {
        h.eq_ignore_ascii_case("name")
            || h.eq_ignore_ascii_case("timername")
            || h.eq_ignore_ascii_case("timer_name")
            || h.eq_ignore_ascii_case("text")
    });
    let start_idx = headers.iter().position(|h| {
        h.eq_ignore_ascii_case("starttime")
            || h.eq_ignore_ascii_case("start_time")
            || h.eq_ignore_ascii_case("start_s")
    });
    let end_idx = headers.iter().position(|h| {
        h.eq_ignore_ascii_case("endtime")
            || h.eq_ignore_ascii_case("end_time")
            || h.eq_ignore_ascii_case("end_s")
    });

    if start_idx.is_none() {
        return Ok(0);
    }
    let start_idx = start_idx.unwrap();

    let mut timer_names: HashMap<i64, String> = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT id, name FROM timers") {
        if let Ok(rows) = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?))) {
            for r in rows.flatten() {
                timer_names.insert(r.0, r.1);
            }
        }
    }

    let mut thread_priorities: HashMap<i64, i32> = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT id, role FROM threads") {
        if let Ok(rows) = stmt.query_map([], |row| Ok((row.get(0)?, row.get::<_, String>(1)?))) {
            for r in rows.flatten() {
                let prio = match r.1.as_str() {
                    "game" => 100,
                    "render" => 80,
                    "rhi" => 60,
                    "gpu" => 40,
                    "worker" => 20,
                    _ => 10,
                };
                thread_priorities.insert(r.0, prio);
            }
        }
    }

    struct RawBookmarkEntry {
        name: String,
        start_s: f64,
        duration_s: f64,
        thread_id: Option<i64>,
    }

    let mut raw_entries: Vec<RawBookmarkEntry> = Vec::new();
    let mut record = csv::StringRecord::new();

    while rdr.read_record(&mut record).map_err(|e| e.to_string())? {
        if record.len() <= start_idx {
            continue;
        }

        let start_raw: f64 = match record[start_idx].parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let end_raw: f64 = end_idx
            .and_then(|idx| record.get(idx))
            .and_then(|v| v.parse().ok())
            .unwrap_or(start_raw);

        let thread_id = thread_idx
            .and_then(|idx| record.get(idx))
            .and_then(|v| v.parse::<i64>().ok());

        let mut name = String::new();
        if let Some(n_idx) = name_idx {
            if let Some(val) = record.get(n_idx) {
                if !val.trim().is_empty() {
                    name = clean_bookmark_name(val);
                }
            }
        }

        if name.is_empty() {
            if let Some(t_idx) = timer_idx {
                if let Some(t_val) = record.get(t_idx).and_then(|v| v.parse::<i64>().ok()) {
                    if let Some(found_name) = timer_names.get(&t_val) {
                        name = clean_bookmark_name(found_name);
                    }
                }
            }
        }

        if name.is_empty() {
            name = "Bookmark".to_string();
        }

        let start_s = (start_raw - trace_start_s).max(0.0);
        let duration_s = (end_raw - start_raw).max(0.0);

        if !is_valid_bookmark(&name, start_s) {
            continue;
        }

        raw_entries.push(RawBookmarkEntry {
            name,
            start_s,
            duration_s,
            thread_id,
        });
    }

    // Sort by start_s ascending
    raw_entries.sort_by(|a, b| {
        a.start_s
            .partial_cmp(&b.start_s)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Deduplicate / Cluster duplicate broadcasts across threads
    // If two events have the same name (case-insensitive) and start within 0.1s of each other,
    // merge them into a single bookmark entry.
    let mut deduplicated: Vec<RawBookmarkEntry> = Vec::new();

    for entry in raw_entries {
        let entry_lower = entry.name.to_ascii_lowercase();
        let mut merged = false;

        for existing in deduplicated.iter_mut().rev() {
            if (entry.start_s - existing.start_s).abs() > 0.1 {
                break;
            }

            if existing.name.to_ascii_lowercase() == entry_lower {
                existing.duration_s = existing.duration_s.max(entry.duration_s);
                let existing_prio = existing
                    .thread_id
                    .and_then(|tid| thread_priorities.get(&tid))
                    .copied()
                    .unwrap_or(0);
                let entry_prio = entry
                    .thread_id
                    .and_then(|tid| thread_priorities.get(&tid))
                    .copied()
                    .unwrap_or(0);
                if entry_prio > existing_prio {
                    existing.thread_id = entry.thread_id;
                }
                merged = true;
                break;
            }
        }

        if !merged {
            deduplicated.push(entry);
        }
    }

    let count = deduplicated.len();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("INSERT INTO bookmarks (name, start_s, duration_s, thread_id) VALUES (?1, ?2, ?3, ?4)")
            .map_err(|e| e.to_string())?;

        for entry in deduplicated {
            stmt.execute(params![
                entry.name,
                entry.start_s,
                entry.duration_s,
                entry.thread_id
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace::store::init_db;
    use std::io::Write;
    use std::fs::File;

    #[test]
    fn test_clean_bookmark_name() {
        assert_eq!(clean_bookmark_name("  BossSpawn  "), "BossSpawn");
        assert_eq!(clean_bookmark_name("TRACE_BOOKMARK(\"BossSpawn\")"), "BossSpawn");
        assert_eq!(clean_bookmark_name("TRACE_BOOKMARK(TEXT(\"BossSpawn\"))"), "BossSpawn");
        assert_eq!(clean_bookmark_name("\"BossSpawn\""), "BossSpawn");
    }

    #[test]
    fn test_is_valid_bookmark() {
        // Legitimate bookmarks
        assert!(is_valid_bookmark("BossSpawn", 12.5));
        assert!(is_valid_bookmark("Combat_Start", 0.0));
        assert!(is_valid_bookmark("Phase2", 34.2));

        // Generic startup noise
        assert!(!is_valid_bookmark("Bookmark", 0.000));
        assert!(!is_valid_bookmark("Marker", 0.001));
        assert!(!is_valid_bookmark("TRACE_BOOKMARK", 0.000));
        assert!(is_valid_bookmark("Bookmark", 12.0)); // Allowed after startup

        // Blueprint / Code artifacts
        assert!(!is_valid_bookmark("BPI_HitmarkerTargetInfo_C", 0.0));
        assert!(!is_valid_bookmark("BPI_HitmarkerTargetInfo_C", 10.0));
        assert!(!is_valid_bookmark("HitmarkerDispatcher_DelegateSignature", 0.0));
        assert!(!is_valid_bookmark("OnDispatchHitmarkerInfo", 0.0));
        assert!(!is_valid_bookmark("BP_Player_C", 5.0));
        assert!(!is_valid_bookmark("Function /Game/Characters/BP_Enemy.BP_Enemy_C:ReceiveTick", 2.0));
        assert!(!is_valid_bookmark("ExecuteUbergraph_BP_Enemy", 2.0));
    }

    #[test]
    fn test_ingest_bookmarks_csv_deduplication_and_filtering() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();

        // Seed threads
        conn.execute("INSERT INTO threads (id, name, role) VALUES (1, 'GameThread', 'game')", []).unwrap();
        conn.execute("INSERT INTO threads (id, name, role) VALUES (2, 'RenderThread', 'render')", []).unwrap();
        conn.execute("INSERT INTO threads (id, name, role) VALUES (3, 'Worker1', 'worker')", []).unwrap();
        conn.execute("INSERT INTO threads (id, name, role) VALUES (4, 'Worker2', 'worker')", []).unwrap();

        // Seed timers
        conn.execute("INSERT INTO timers (id, name, bucket, kind) VALUES (10, 'BookMark', 'Other', 'work')", []).unwrap();
        conn.execute("INSERT INTO timers (id, name, bucket, kind) VALUES (11, 'BossFight', 'Other', 'work')", []).unwrap();

        let csv_path = std::env::temp_dir().join(format!("test_bookmarks_{}.csv", std::process::id()));
        let mut csv_file = File::create(&csv_path).unwrap();
        writeln!(csv_file, "ThreadId,TimerId,StartTime,EndTime,Depth,Name").unwrap();

        // 38 generic startup noise events
        for _ in 0..38 {
            writeln!(csv_file, "3,10,0.000,0.000,0,Bookmark").unwrap();
        }

        // Blueprint loading noise caught by timer matching at 0.0s
        writeln!(csv_file, "1,0,0.000,0.000,0,BPI_HitmarkerTargetInfo_C").unwrap();
        writeln!(csv_file, "1,0,0.000,0.000,0,HitmarkerDispatcher_DelegateSignature").unwrap();
        writeln!(csv_file, "1,0,0.000,0.000,0,OnDispatchHitmarkerInfo").unwrap();

        // 1 meaningful event at 0.0s
        writeln!(csv_file, "1,0,0.000,0.000,0,GameInit").unwrap();

        // 3 duplicate events at 13.0s
        writeln!(csv_file, "3,10,13.010,13.010,0,BookMark").unwrap();
        writeln!(csv_file, "1,10,13.012,13.012,0,BookMark").unwrap();
        writeln!(csv_file, "2,10,13.011,13.011,0,BookMark").unwrap();

        // 4 duplicate events at 49.0s
        writeln!(csv_file, "3,10,49.005,49.005,0,BookMark").unwrap();
        writeln!(csv_file, "4,10,49.006,49.006,0,BookMark").unwrap();
        writeln!(csv_file, "1,10,49.008,49.008,0,BookMark").unwrap();
        writeln!(csv_file, "2,10,49.007,49.007,0,BookMark").unwrap();

        // 1 event at 55.0s
        writeln!(csv_file, "1,11,55.000,55.020,0,BossFight").unwrap();
        drop(csv_file);

        let count = ingest_bookmarks_csv(&mut conn, &csv_path, 0.0).unwrap();
        let _ = std::fs::remove_file(&csv_path);
        assert_eq!(count, 4);

        let bookmarks = crate::trace::store::query_bookmarks(&conn).unwrap();
        assert_eq!(bookmarks.len(), 4);

        assert_eq!(bookmarks[0].name, "GameInit");
        assert_eq!(bookmarks[0].start_s, 0.0);

        assert_eq!(bookmarks[1].name, "BookMark");
        assert!((bookmarks[1].start_s - 13.01).abs() < 0.05);
        assert_eq!(bookmarks[1].thread_name.as_deref(), Some("GameThread"));

        assert_eq!(bookmarks[2].name, "BookMark");
        assert!((bookmarks[2].start_s - 49.005).abs() < 0.05);
        assert_eq!(bookmarks[2].thread_name.as_deref(), Some("GameThread"));

        assert_eq!(bookmarks[3].name, "BossFight");
        assert_eq!(bookmarks[3].start_s, 55.0);
    }
}
