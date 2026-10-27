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
