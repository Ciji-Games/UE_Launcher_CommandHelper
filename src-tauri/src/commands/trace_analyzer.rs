use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::trace::baseline::{compute_and_save_baselines, generate_pass_b_windows};
use crate::trace::buckets::update_timers_classification;
use crate::trace::csv_ingest::{
    ingest_threads_csv, ingest_timers_csv, process_and_ingest_frames, read_frame_events,
};
use crate::trace::exclusive::ingest_window_csv;
use crate::trace::frames::{
    calculate_robust_stats, detect_episodes, save_episodes_to_db, AnalysisOptions,
};
use crate::trace::insights_cli::{InsightsCliSource, TraceCandidate};
use crate::trace::rules::{evaluate_and_save_findings, generate_verdict};
use crate::trace::source::TraceSource;
use crate::trace::store::{
    clear_cache, compute_cache_key, get_cache_db_path, get_cache_info, get_meta,
    init_db, query_episodes, query_findings, query_frame_buckets, query_frame_points, set_meta,
    CacheInfo, DbEpisode, DbFinding, FrameBucket, FramePoint,
};

static IS_CANCELLED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InsightsExeInfo {
    pub path: Option<String>,
    pub exists: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TraceSummary {
    pub trace_id: String,
    pub path: String,
    pub size_bytes: u64,
    pub duration_s: f64,
    pub frame_count: usize,
    pub engine_version: Option<String>,
    pub is_editor_build: bool,
    pub median_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub target_ms: f64,
    pub hitch_count: usize,
    pub slow_region_count: usize,
    pub verdict: String,
    pub detected_channels: Vec<String>,
    pub missing_channels: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FrameSeriesResponse {
    pub is_bucketed: bool,
    pub buckets: Vec<FrameBucket>,
    pub points: Vec<FramePoint>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BucketBreakdown {
    pub bucket: String,
    pub episode_ms: f64,
    pub baseline_ms: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TimerExcessDetail {
    pub timer_name: String,
    pub bucket: String,
    pub episode_excl_ms: f64,
    pub baseline_median_ms: f64,
    pub excess_ms: f64,
    pub call_count: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ThreadBusyDetail {
    pub thread_name: String,
    pub role: String,
    pub busy_ms: f64,
    pub wait_ms: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeDetailResponse {
    pub episode: DbEpisode,
    pub bound_by: String,
    pub buckets: Vec<BucketBreakdown>,
    pub top_timers: Vec<TimerExcessDetail>,
    pub threads: Vec<ThreadBusyDetail>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TraceProgressPayload {
    pub stage: String,
    pub indeterminate: bool,
    pub percent: Option<f64>,
    pub rows: Option<usize>,
    pub bytes_read: Option<u64>,
    pub bytes_total: Option<u64>,
    pub elapsed_ms: u64,
    pub message: Option<String>,
}

#[tauri::command]
pub fn trace_find_insights(engine_root: String) -> InsightsExeInfo {
    let root = Path::new(&engine_root);
    let exe = InsightsCliSource::find_insights_exe(root);
    InsightsExeInfo {
        exists: exe.is_some(),
        path: exe.map(|p| p.to_string_lossy().to_string()),
    }
}

#[tauri::command]
pub fn trace_list_candidates(
    app: AppHandle,
    project_path: Option<String>,
) -> Result<Vec<TraceCandidate>, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    let proj = project_path.as_deref().map(Path::new);
    let candidates = InsightsCliSource::list_candidate_traces(proj, |trace_p| {
        if let Ok(meta) = fs::metadata(trace_p) {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let key = compute_cache_key(trace_p, meta.len(), mtime, "5.x");
            if let Ok(db_path) = get_cache_db_path(&app_data_dir, &key) {
                return db_path.is_file();
            }
        }
        false
    });

    Ok(candidates)
}

#[tauri::command]
pub async fn trace_cancel() -> Result<(), String> {
    IS_CANCELLED.store(true, Ordering::SeqCst);
    crate::running_process::take_running_pid();
    Ok(())
}

#[tauri::command]
pub async fn trace_open(
    app: AppHandle,
    trace_path: String,
    insights_path: String,
    engine_version: Option<String>,
    options: Option<AnalysisOptions>,
) -> Result<TraceSummary, String> {
    IS_CANCELLED.store(false, Ordering::SeqCst);
    let cancel_flag = Arc::new(AtomicBool::new(false));

    let app_clone = app.clone();
    let opts = options.unwrap_or_default();
    let eng_ver = engine_version.unwrap_or_else(|| "5.7".to_string());

    tokio::task::spawn_blocking(move || {
        let start_time = Instant::now();
        let app_data_dir = app_clone
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get app data dir: {}", e))?;

        let trace_p = PathBuf::from(&trace_path);
        if !trace_p.is_file() {
            return Err(format!("Trace file not found: {}", trace_path));
        }

        let trace_meta = fs::metadata(&trace_p).map_err(|e| e.to_string())?;
        let size_bytes = trace_meta.len();
        let mtime = trace_meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let cache_key = compute_cache_key(&trace_p, size_bytes, mtime, &eng_ver);
        let db_path = get_cache_db_path(&app_data_dir, &cache_key)?;

        // Check cache hit
        if db_path.is_file() {
            if let Ok(conn) = Connection::open(&db_path) {
                if let Ok(Some(status)) = get_meta(&conn, "status") {
                    if status == "done" {
                        return read_summary_from_db(&conn, &cache_key, &trace_path, size_bytes, &eng_ver, &opts);
                    }
                }
            }
        }

        // Cache miss -> Run pipeline
        let emit_progress = |stage: &str, msg: Option<&str>| {
            let payload = TraceProgressPayload {
                stage: stage.to_string(),
                indeterminate: true,
                percent: None,
                rows: None,
                bytes_read: None,
                bytes_total: Some(size_bytes),
                elapsed_ms: start_time.elapsed().as_millis() as u64,
                message: msg.map(|s| s.to_string()),
            };
            let _ = app_clone.emit("trace-analyzer:progress", payload);
        };

        // Stage 1: locating insights
        emit_progress("locating_insights", Some("Locating Unreal Insights executable..."));
        let insights_p = PathBuf::from(&insights_path);
        if !insights_p.is_file() {
            return Err(format!("Unreal Insights executable not found: {}", insights_path));
        }

        let temp_dir = app_data_dir.join("temp_trace").join(&cache_key);
        if temp_dir.exists() {
            let _ = fs::remove_dir_all(&temp_dir);
        }
        fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create temp dir: {}", e))?;

        let source = InsightsCliSource::new(insights_p);

        // Stage 2: exporting frames (Pass A)
        emit_progress("exporting_frames", Some("Running Unreal Insights Pass A (Exporting frames)..."));
        let pass_a_out = source.export_pass_a(&trace_p, &temp_dir, &cancel_flag)?;

        // Stage 3: ingesting frames
        emit_progress("ingesting_frames", Some("Streaming Pass A CSV data into SQLite cache..."));
        if db_path.exists() {
            let _ = fs::remove_file(&db_path);
        }
        let mut conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        init_db(&conn).map_err(|e| e.to_string())?;

        let threads = ingest_threads_csv(&mut conn, &pass_a_out.threads_csv)?;
        let _timers = ingest_timers_csv(&mut conn, &pass_a_out.timers_csv)?;
        let frame_events = read_frame_events(&pass_a_out.frames_csv)?;
        let processed_frames = process_and_ingest_frames(&mut conn, &threads, &frame_events)?;

        update_timers_classification(&mut conn)?;

        let stats = calculate_robust_stats(&processed_frames);

        // Emit frames ready so graph draws immediately
        let _ = app_clone.emit("trace-analyzer:frames-ready", ());

        // Stage 4: detecting episodes
        emit_progress("detecting_episodes", Some("Detecting hitches, slow regions, and periodicity..."));
        let episodes = detect_episodes(&processed_frames, &stats, &opts);
        save_episodes_to_db(&mut conn, &episodes)?;

        let trace_start_s: f64 = get_meta(&conn, "trace_start_s")
            .ok()
            .flatten()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0);

        // Stage 5: exporting windows (Pass B)
        emit_progress("exporting_windows", Some("Running Unreal Insights Pass B (Targeted windows)..."));
        let windows = generate_pass_b_windows(&episodes, &processed_frames, &stats, &opts, trace_start_s);
        let pass_b_out = source.export_pass_b(&trace_p, &windows, &temp_dir, &cancel_flag)?;

        // Stage 6: ingesting windows
        emit_progress("ingesting_windows", Some("Computing exclusive time nesting and baseline statistics..."));
        for (win_id, csv_p) in pass_b_out.window_csvs {
            ingest_window_csv(&mut conn, win_id, &csv_p, trace_start_s)?;
        }
        compute_and_save_baselines(&mut conn)?;

        // Stage 7: analyzing
        emit_progress("analyzing", Some("Matching diagnostic rules and evaluating findings..."));
        let findings = evaluate_and_save_findings(&mut conn, &episodes)?;

        let hitch_count = episodes.iter().filter(|e| e.kind == "hitch").count();
        let slow_region_count = episodes.iter().filter(|e| e.kind == "slow_region").count();
        let verdict = generate_verdict(processed_frames.len(), stats.median_ms, hitch_count, slow_region_count, &findings);

        // Stage 8: done & save metadata
        let is_editor = detect_is_editor_build(&conn);
        let (detected_channels, missing_channels) = crate::trace::rules::detect_trace_channels(&conn);
        set_meta(&conn, "status", "done").map_err(|e| e.to_string())?;
        set_meta(&conn, "trace_path", &trace_path).map_err(|e| e.to_string())?;
        set_meta(&conn, "engine_version", &eng_ver).map_err(|e| e.to_string())?;
        set_meta(&conn, "verdict", &verdict).map_err(|e| e.to_string())?;
        set_meta(&conn, "is_editor", if is_editor { "true" } else { "false" }).map_err(|e| e.to_string())?;

        // Cleanup temporary CSVs
        let _ = fs::remove_dir_all(&temp_dir);

        emit_progress("done", Some("Trace analysis complete."));
        let _ = app_clone.emit("trace-analyzer:findings-ready", ());

        Ok(TraceSummary {
            trace_id: cache_key,
            path: trace_path,
            size_bytes,
            duration_s: stats.duration_s,
            frame_count: stats.total_frames,
            engine_version: Some(eng_ver),
            is_editor_build: is_editor,
            median_ms: stats.median_ms,
            p95_ms: stats.p95_ms,
            p99_ms: stats.p99_ms,
            target_ms: 1000.0 / opts.target_fps,
            hitch_count,
            slow_region_count,
            verdict,
            detected_channels,
            missing_channels,
        })
    })
    .await
    .map_err(|e| format!("Task execution error: {}", e))?
}

fn detect_is_editor_build(conn: &Connection) -> bool {
    let result: Result<i64, _> = conn.query_row(
        "SELECT COUNT(*) FROM timers WHERE name LIKE '%UEditorEngine%' OR name LIKE '%FEditorViewportClient%' OR name LIKE '%FUnrealEdEngine%' OR name LIKE '%EditorInit%'",
        [],
        |row| row.get(0),
    );
    result.map(|c| c > 0).unwrap_or(false)
}

fn read_summary_from_db(
    conn: &Connection,
    cache_key: &str,
    trace_path: &str,
    size_bytes: u64,
    engine_version: &str,
    opts: &AnalysisOptions,
) -> Result<TraceSummary, String> {
    let mut stmt = conn
        .prepare("SELECT interval_ms FROM frames ORDER BY interval_ms ASC")
        .map_err(|e| e.to_string())?;

    let intervals: Vec<f64> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();

    let frame_count = intervals.len();
    let median_ms = crate::trace::frames::calculate_percentile(&intervals, 0.5);
    let p95_ms = crate::trace::frames::calculate_percentile(&intervals, 0.95);
    let p99_ms = crate::trace::frames::calculate_percentile(&intervals, 0.99);

    let duration_s: f64 = conn
        .query_row("SELECT MAX(start_s) - MIN(start_s) FROM frames", [], |row| row.get(0))
        .unwrap_or(0.0);

    let episodes = query_episodes(conn).map_err(|e| e.to_string())?;
    let findings = query_findings(conn).map_err(|e| e.to_string())?;

    let hitch_count = episodes.iter().filter(|e| e.kind == "hitch").count();
    let slow_region_count = episodes.iter().filter(|e| e.kind == "slow_region").count();
    let verdict = get_meta(conn, "verdict")
        .ok()
        .flatten()
        .unwrap_or_else(|| generate_verdict(frame_count, median_ms, hitch_count, slow_region_count, &findings));

    let is_editor = get_meta(conn, "is_editor")
        .ok()
        .flatten()
        .map(|v| v == "true")
        .unwrap_or_else(|| detect_is_editor_build(conn));

    let (detected_channels, missing_channels) = crate::trace::rules::detect_trace_channels(conn);

    Ok(TraceSummary {
        trace_id: cache_key.to_string(),
        path: trace_path.to_string(),
        size_bytes,
        duration_s,
        frame_count,
        engine_version: Some(engine_version.to_string()),
        is_editor_build: is_editor,
        median_ms,
        p95_ms,
        p99_ms,
        target_ms: 1000.0 / opts.target_fps,
        hitch_count,
        slow_region_count,
        verdict,
        detected_channels,
        missing_channels,
    })
}

#[tauri::command]
pub fn trace_get_summary(app: AppHandle, trace_id: String) -> Result<TraceSummary, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let db_path = get_cache_db_path(&app_data_dir, &trace_id)?;
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    let trace_path = get_meta(&conn, "trace_path").unwrap_or_default().unwrap_or_default();
    let eng_ver = get_meta(&conn, "engine_version").unwrap_or_default().unwrap_or_else(|| "5.x".to_string());
    let size_bytes = fs::metadata(&trace_path).map(|m| m.len()).unwrap_or(0);
    let opts = AnalysisOptions::default();

    read_summary_from_db(&conn, &trace_id, &trace_path, size_bytes, &eng_ver, &opts)
}

#[tauri::command]
pub fn trace_get_frame_series(
    app: AppHandle,
    trace_id: String,
    start_s: f64,
    end_s: f64,
    max_items: usize,
) -> Result<FrameSeriesResponse, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let db_path = get_cache_db_path(&app_data_dir, &trace_id)?;
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    let total_frames: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM frames WHERE start_s >= ?1 AND start_s <= ?2",
            rusqlite::params![start_s, end_s],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let max_capped = max_items.clamp(50, 4000);

    if (total_frames as usize) <= max_capped {
        let points = query_frame_points(&conn, start_s, end_s, max_capped).map_err(|e| e.to_string())?;
        Ok(FrameSeriesResponse {
            is_bucketed: false,
            buckets: Vec::new(),
            points,
        })
    } else {
        let buckets = query_frame_buckets(&conn, start_s, end_s, max_capped).map_err(|e| e.to_string())?;
        Ok(FrameSeriesResponse {
            is_bucketed: true,
            buckets,
            points: Vec::new(),
        })
    }
}

#[tauri::command]
pub fn trace_get_episodes(app: AppHandle, trace_id: String) -> Result<Vec<DbEpisode>, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let db_path = get_cache_db_path(&app_data_dir, &trace_id)?;
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    query_episodes(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn trace_get_findings(app: AppHandle, trace_id: String) -> Result<Vec<DbFinding>, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let db_path = get_cache_db_path(&app_data_dir, &trace_id)?;
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    query_findings(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn trace_get_episode_detail(
    app: AppHandle,
    trace_id: String,
    episode_id: i64,
) -> Result<EpisodeDetailResponse, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let db_path = get_cache_db_path(&app_data_dir, &trace_id)?;
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    let episode: DbEpisode = conn
        .query_row(
            "SELECT id, kind, start_s, end_s, frame_from, frame_to, peak_ms, median_ms, bound_by, periodic_group 
             FROM episodes WHERE id = ?1",
            rusqlite::params![episode_id],
            |row| {
                Ok(DbEpisode {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    start_s: row.get(2)?,
                    end_s: row.get(3)?,
                    frame_from: row.get(4)?,
                    frame_to: row.get(5)?,
                    peak_ms: row.get(6)?,
                    median_ms: row.get(7)?,
                    bound_by: row.get(8)?,
                    periodic_group: row.get(9)?,
                })
            },
        )
        .map_err(|e| format!("Episode not found: {}", e))?;

    // Top excess timers
    let mut top_timers = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT t.name, t.bucket, SUM(we.excl_ms) as total_excl, COUNT(*) as call_count,
                        COALESCE((
                            SELECT AVG(bs.median_excl_ms) 
                            FROM baseline_stats bs 
                            JOIN timers t2 ON t2.id = bs.timer_id 
                            WHERE t2.name = t.name
                        ), 0.0) as baseline_median
                 FROM window_events we
                 JOIN timers t ON t.id = we.timer_id
                 WHERE we.window_id = ?1
                 GROUP BY t.name, t.bucket
                 ORDER BY (total_excl - baseline_median) DESC
                 LIMIT 15",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(rusqlite::params![episode_id], |row| {
                let timer_name: String = row.get(0)?;
                let bucket: String = row.get(1)?;
                let episode_excl_ms: f64 = row.get(2)?;
                let call_count: i64 = row.get(3)?;
                let baseline_median_ms: f64 = row.get(4)?;
                let excess_ms = (episode_excl_ms - baseline_median_ms).max(0.0);

                Ok(TimerExcessDetail {
                    timer_name,
                    bucket,
                    episode_excl_ms,
                    baseline_median_ms,
                    excess_ms,
                    call_count: call_count as usize,
                })
            })
            .map_err(|e| e.to_string())?;

        for r in rows {
            top_timers.push(r.map_err(|e| e.to_string())?);
        }
    }

    // Bucket breakdown
    let mut buckets = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT t.bucket, SUM(we.excl_ms) as total_excl
                 FROM window_events we
                 JOIN timers t ON t.id = we.timer_id
                 WHERE we.window_id = ?1
                 GROUP BY t.bucket
                 ORDER BY total_excl DESC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(rusqlite::params![episode_id], |row| {
                let bucket: String = row.get(0)?;
                let episode_ms: f64 = row.get(1)?;
                Ok(BucketBreakdown {
                    bucket,
                    episode_ms,
                    baseline_ms: 0.0,
                })
            })
            .map_err(|e| e.to_string())?;

        for r in rows {
            buckets.push(r.map_err(|e| e.to_string())?);
        }
    }

    // Thread busy / wait details
    let mut threads = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT th.name, th.role, 
                        SUM(CASE WHEN t.kind = 'work' THEN we.excl_ms ELSE 0 END) as busy_ms,
                        SUM(CASE WHEN t.kind = 'wait' THEN we.excl_ms ELSE 0 END) as wait_ms
                 FROM window_events we
                 JOIN threads th ON th.id = we.thread_id
                 JOIN timers t ON t.id = we.timer_id
                 WHERE we.window_id = ?1
                 GROUP BY th.name, th.role
                 ORDER BY busy_ms DESC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(rusqlite::params![episode_id], |row| {
                let thread_name: String = row.get(0)?;
                let role: String = row.get(1)?;
                let busy_ms: f64 = row.get(2)?;
                let wait_ms: f64 = row.get(3)?;
                Ok(ThreadBusyDetail {
                    thread_name,
                    role,
                    busy_ms,
                    wait_ms,
                })
            })
            .map_err(|e| e.to_string())?;

        for r in rows {
            threads.push(r.map_err(|e| e.to_string())?);
        }
    }

    Ok(EpisodeDetailResponse {
        bound_by: episode.bound_by.clone(),
        episode,
        buckets,
        top_timers,
        threads,
    })
}

#[tauri::command]
pub fn trace_open_in_insights(trace_path: String, insights_path: String) -> Result<(), String> {
    let mut cmd = std::process::Command::new(insights_path);
    cmd.arg(format!("-OpenTraceFile={}", trace_path));

    #[cfg(windows)]
    {
        // Don't hide window when launching GUI
    }

    cmd.spawn()
        .map_err(|e| format!("Failed to launch Unreal Insights GUI: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn trace_cache_info(app: AppHandle) -> Result<CacheInfo, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    get_cache_info(&app_data_dir)
}

#[tauri::command]
pub fn trace_clear_cache(app: AppHandle, trace_id: Option<String>) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    clear_cache(&app_data_dir, trace_id.as_deref())
}
