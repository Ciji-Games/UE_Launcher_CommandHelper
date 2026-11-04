use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::trace::baseline::compute_and_save_global_baseline;
use crate::trace::buckets::update_timers_classification;
use crate::trace::csv_ingest::{
    ingest_bookmarks_csv, ingest_threads_csv, ingest_timers_csv, process_and_ingest_frames,
    read_frame_events,
};
use crate::trace::diagnosis::{diagnose_chunk, init_chunk_states, IssueWithOccurrences};
use crate::trace::exclusive::ingest_slice_timing_events_stream;
use crate::trace::frames::{
    assemble_range_timer_sums, build_block_pyramid, calculate_robust_stats, detect_episodes,
    save_episodes_to_db, AnalysisOptions,
};
use crate::trace::insights_cli::{InsightsCliSource, TraceCandidate};
use crate::trace::rules::{evaluate_and_save_findings, generate_verdict};
use crate::trace::source::TraceSource;
use crate::trace::store::{
    clear_cache, compute_cache_key, get_cache_db_path, get_cache_info, get_meta,
    init_db, query_bookmarks, query_episodes, query_findings, query_frame_buckets,
    query_frame_points, set_meta, CacheInfo, DbChunkState, DbEpisode, DbFinding, DbIssue,
    DbOccurrence, FrameBucket, FramePoint, TraceBookmark, SCHEMA_VERSION,
};

static IS_CANCELLED: AtomicBool = AtomicBool::new(false);
static FRONTIER_START_S: Mutex<Option<f64>> = Mutex::new(None);

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
pub struct ThreadMedians {
    pub game_ms: f64,
    pub render_ms: f64,
    pub gpu_ms: f64,
    pub limiting_thread: String, // "gpu" | "game" | "render" | "idle"
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RangeTopTimer {
    pub name: String,
    pub bucket: String,
    pub thread_role: String,
    pub avg_ms_per_frame: f64,
    pub total_ms: f64,
    pub call_count: usize,
    pub share_of_budget_gap_pct: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RangeStatisticsResponse {
    pub start_s: f64,
    pub end_s: f64,
    pub duration_s: f64,
    pub frame_count: usize,
    pub median_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub min_ms: f64,
    pub max_ms: f64,
    pub over_budget_pct: f64,
    pub budget_gap_ms: f64,
    pub thread_medians: ThreadMedians,
    pub top_timers: Vec<RangeTopTimer>,
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
pub struct ImportProgressPayload {
    pub stage: String, // "pass_a" | "slices" | "baseline" | "summaries" | "done"
    pub current_slice: usize,
    pub total_slices: usize,
    pub processed_frames: usize,
    pub total_frames: usize,
    pub elapsed_ms: u64,
    pub estimated_remaining_ms: Option<u64>,
    pub message: String,
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

pub fn get_default_trace_store_dir() -> PathBuf {
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        PathBuf::from(local_app_data)
            .join("UnrealEngine")
            .join("Common")
            .join("UnrealTrace")
            .join("Store")
            .join("001")
    } else {
        std::env::temp_dir()
            .join("UnrealEngine")
            .join("UnrealTrace")
            .join("Store")
            .join("001")
    }
}

fn generate_trace_timestamp_filename() -> String {
    let now = std::time::SystemTime::now();
    let since_epoch = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let seconds_in_day = 86400;
    let day_number = since_epoch / seconds_in_day;
    let time_of_day = since_epoch % seconds_in_day;

    let hour = time_of_day / 3600;
    let minute = (time_of_day % 3600) / 60;
    let second = time_of_day % 60;

    // Hinnant's algorithm for converting civil days since 1970-01-01 to Y-M-D
    let z = (day_number as i64) + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1024 + doe / 1461 - doe / 142400) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!("{:04}{:02}{:02}_{:02}{:02}{:02}.utrace", y, m, d, hour, minute, second)
}

fn find_newest_trace_file(search_dirs: &[PathBuf], after_timestamp_secs: u64) -> Option<PathBuf> {
    let mut newest: Option<(PathBuf, u64)> = None;
    for dir in search_dirs {
        if !dir.is_dir() {
            continue;
        }
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file()
                    && p.extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.eq_ignore_ascii_case("utrace"))
                        == Some(true)
                {
                    if let Ok(meta) = entry.metadata() {
                        let mtime = meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs())
                            .unwrap_or(0);
                        if mtime >= after_timestamp_secs.saturating_sub(15) {
                            if newest.as_ref().map_or(true, |(_, max_m)| mtime > *max_m) {
                                newest = Some((p, mtime));
                            }
                        }
                    }
                }
            }
        }
    }
    newest.map(|(p, _)| p)
}

fn run_trace_analysis_pipeline_sync(
    app: &AppHandle,
    trace_p: &Path,
    insights_path: &str,
    eng_ver: &str,
    opts: &AnalysisOptions,
) -> Result<TraceSummary, String> {
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let start_time = Instant::now();
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    if !trace_p.is_file() {
        return Err(format!("Trace file not found: {}", trace_p.display()));
    }

    let trace_meta = fs::metadata(trace_p).map_err(|e| e.to_string())?;
    let size_bytes = trace_meta.len();
    let mtime = trace_meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let cache_key = compute_cache_key(trace_p, size_bytes, mtime, eng_ver);
    let db_path = get_cache_db_path(&app_data_dir, &cache_key)?;
    let trace_path_str = trace_p.to_string_lossy().to_string();

    // Check cache hit
    if db_path.is_file() {
        if let Ok(conn) = Connection::open(&db_path) {
            let status = get_meta(&conn, "status").ok().flatten();
            let cached_index_ver: Option<i32> = get_meta(&conn, "index_version").ok().flatten().and_then(|s| s.parse().ok());
            if status.as_deref() == Some("done") && cached_index_ver == Some(SCHEMA_VERSION) {
                let current_analysis_ver = format!("rules_v3_fps_{:.1}", opts.target_fps);
                let cached_analysis_ver = get_meta(&conn, "analysis_version").ok().flatten();
                if cached_analysis_ver.as_deref() != Some(&current_analysis_ver) {
                    let _ = conn.execute("DELETE FROM issue", []);
                    let _ = conn.execute("DELETE FROM occurrence", []);
                    let _ = conn.execute("UPDATE chunk_state SET state = 'queued', done_at = NULL", []);
                    let _ = set_meta(&conn, "analysis_version", &current_analysis_ver);
                }
                drop(conn);
                start_background_diagnosis_task(app.clone(), db_path.clone(), opts.target_fps);
                let conn_read = Connection::open(&db_path).map_err(|e| e.to_string())?;
                return read_summary_from_db(&conn_read, &cache_key, &trace_path_str, size_bytes, eng_ver, opts);
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
        let _ = app.emit("trace-analyzer:progress", payload);
    };

    // Stage 1: locating insights
    emit_progress("locating_insights", Some("Locating Unreal Insights executable..."));
    let insights_p = PathBuf::from(insights_path);
    if !insights_p.is_file() {
        return Err(format!("Unreal Insights executable not found: {}", insights_path));
    }

    let temp_dir = app_data_dir.join("temp_trace").join(&cache_key);
    if temp_dir.exists() {
        let _ = fs::remove_dir_all(&temp_dir);
    }
    fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let source = InsightsCliSource::new(insights_p);

    // Stage 1a (Pass A): export metadata and frames
    let _ = app.emit(
        "trace-analyzer:import-progress",
        ImportProgressPayload {
            stage: "pass_a".to_string(),
            current_slice: 0,
            total_slices: 0,
            processed_frames: 0,
            total_frames: 0,
            elapsed_ms: start_time.elapsed().as_millis() as u64,
            estimated_remaining_ms: None,
            message: "Running Unreal Insights Pass A (Exporting threads, timers & frame boundaries)...".to_string(),
        },
    );
    emit_progress("exporting_frames", Some("Running Unreal Insights Pass A (Exporting frames)..."));
    let pass_a_out = source.export_pass_a(trace_p, &temp_dir, &cancel_flag)?;

    // Ingest metadata & frames
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

    let trace_start_s: f64 = get_meta(&conn, "trace_start_s")
        .ok()
        .flatten()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);

    if let Some(ref bm_csv) = pass_a_out.bookmarks_csv {
        let _ = ingest_bookmarks_csv(&mut conn, bm_csv, trace_start_s);
    }

    update_timers_classification(&mut conn)?;

    let stats = calculate_robust_stats(&processed_frames);

    // Emit frames ready so graph draws immediately
    let _ = app.emit("trace-analyzer:frames-ready", ());

    // Detecting episodes
    let episodes = detect_episodes(&processed_frames, &stats, opts);
    save_episodes_to_db(&mut conn, &episodes)?;

    // Stage 1b: Sliced streaming export of all frames & timers
    let slices = InsightsCliSource::plan_slices(&processed_frames, trace_start_s, 1500);
    let total_slices = slices.len();
    let slice_stream_start = Instant::now();

    for (i, slice) in slices.iter().enumerate() {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err("Analysis cancelled by user".to_string());
        }

        let elapsed_slice_stream = slice_stream_start.elapsed().as_millis() as u64;
        let est_remaining_ms = if i > 0 {
            let avg_ms = elapsed_slice_stream as f64 / i as f64;
            Some((avg_ms * (total_slices - i) as f64) as u64)
        } else {
            None
        };

        let msg = format!("Exporting & indexing timer slice {} of {}...", i + 1, total_slices);
        emit_progress("ingesting_windows", Some(&msg));
        let _ = app.emit(
            "trace-analyzer:import-progress",
            ImportProgressPayload {
                stage: "slices".to_string(),
                current_slice: i + 1,
                total_slices,
                processed_frames: (slice.frame_to + 1) as usize,
                total_frames: processed_frames.len(),
                elapsed_ms: start_time.elapsed().as_millis() as u64,
                estimated_remaining_ms: est_remaining_ms,
                message: msg,
            },
        );

        let slice_t0 = Instant::now();
        let csv_path = source.export_slice(trace_p, slice, &temp_dir, &cancel_flag)?;
        let slice_export_ms = slice_t0.elapsed().as_secs_f64() * 1000.0;

        ingest_slice_timing_events_stream(
            &mut conn,
            slice,
            &processed_frames,
            &csv_path,
            trace_start_s,
            0.1,
            slice_export_ms,
        )?;
    }

    // Stage 1c: Global baseline
    let _ = app.emit(
        "trace-analyzer:import-progress",
        ImportProgressPayload {
            stage: "baseline".to_string(),
            current_slice: total_slices,
            total_slices,
            processed_frames: processed_frames.len(),
            total_frames: processed_frames.len(),
            elapsed_ms: start_time.elapsed().as_millis() as u64,
            estimated_remaining_ms: None,
            message: "Computing global normal baseline across steady-state frames...".to_string(),
        },
    );
    emit_progress("ingesting_windows", Some("Computing global baseline statistics..."));
    compute_and_save_global_baseline(&mut conn, &processed_frames, &stats)?;

    // Stage 1d: Block Summary Pyramid
    let _ = app.emit(
        "trace-analyzer:import-progress",
        ImportProgressPayload {
            stage: "summaries".to_string(),
            current_slice: total_slices,
            total_slices,
            processed_frames: processed_frames.len(),
            total_frames: processed_frames.len(),
            elapsed_ms: start_time.elapsed().as_millis() as u64,
            estimated_remaining_ms: None,
            message: "Building 2-level hierarchical block summaries (64 & 4096 frames)...".to_string(),
        },
    );
    build_block_pyramid(&mut conn, &processed_frames, &stats, opts)?;

    // Stage 1e: Diagnostic findings evaluation
    emit_progress("analyzing", Some("Matching diagnostic rules and evaluating findings..."));
    let findings = evaluate_and_save_findings(&mut conn, &episodes)?;

    let hitch_count = episodes.iter().filter(|e| e.kind == "hitch").count();
    let slow_region_count = episodes.iter().filter(|e| e.kind == "slow_region").count();
    let verdict = generate_verdict(processed_frames.len(), stats.median_ms, hitch_count, slow_region_count, &findings);

    // Stage 8: done & save metadata
    let is_editor = detect_is_editor_build(&conn);
    let (detected_channels, missing_channels) = crate::trace::rules::detect_trace_channels(&conn);
    set_meta(&conn, "status", "done").map_err(|e| e.to_string())?;
    set_meta(&conn, "index_version", &SCHEMA_VERSION.to_string()).map_err(|e| e.to_string())?;
    set_meta(&conn, "analysis_version", &format!("rules_v3_fps_{:.1}", opts.target_fps)).map_err(|e| e.to_string())?;
    set_meta(&conn, "trace_path", &trace_path_str).map_err(|e| e.to_string())?;
    set_meta(&conn, "engine_version", eng_ver).map_err(|e| e.to_string())?;
    set_meta(&conn, "verdict", &verdict).map_err(|e| e.to_string())?;
    set_meta(&conn, "is_editor", if is_editor { "true" } else { "false" }).map_err(|e| e.to_string())?;

    // Cleanup temporary CSVs
    let _ = fs::remove_dir_all(&temp_dir);

    // Initialize background diagnosis chunk states
    init_chunk_states(&mut conn, processed_frames.len())?;

    emit_progress("done", Some("Trace analysis complete."));
    let _ = app.emit("trace-analyzer:findings-ready", ());

    // Spawn background diagnosis worker ahead of user
    start_background_diagnosis_task(app.clone(), db_path.clone(), opts.target_fps);

    Ok(TraceSummary {
        trace_id: cache_key,
        path: trace_path_str,
        size_bytes,
        duration_s: stats.duration_s,
        frame_count: stats.total_frames,
        engine_version: Some(eng_ver.to_string()),
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
    let app_clone = app.clone();
    let opts = options.unwrap_or_default();
    let eng_ver = engine_version.unwrap_or_else(|| "5.7".to_string());

    tokio::task::spawn_blocking(move || {
        let trace_p = PathBuf::from(&trace_path);
        run_trace_analysis_pipeline_sync(&app_clone, &trace_p, &insights_path, &eng_ver, &opts)
    })
    .await
    .map_err(|e| format!("Task execution error: {}", e))?
}

#[tauri::command]
pub async fn trace_launch_and_monitor(
    app: AppHandle,
    exe_path: String,
    custom_args: Option<String>,
    trace_file_path: Option<String>,
    insights_path: String,
    engine_version: Option<String>,
    options: Option<AnalysisOptions>,
) -> Result<TraceSummary, String> {
    IS_CANCELLED.store(false, Ordering::SeqCst);
    let app_clone = app.clone();
    let opts = options.unwrap_or_default();
    let eng_ver = engine_version.unwrap_or_else(|| "5.7".to_string());

    tokio::task::spawn_blocking(move || {
        let launch_start_time = Instant::now();
        let launch_timestamp_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let exe_p = PathBuf::from(&exe_path);
        if !exe_p.is_file() {
            return Err(format!("Executable not found: {}", exe_path));
        }

        let store_dir = get_default_trace_store_dir();
        let _ = fs::create_dir_all(&store_dir);

        let target_trace_p = if let Some(custom_trace_path) = trace_file_path.filter(|s| !s.trim().is_empty()) {
            PathBuf::from(custom_trace_path)
        } else {
            let filename = generate_trace_timestamp_filename();
            store_dir.join(filename)
        };

        if let Some(parent) = target_trace_p.parent() {
            let _ = fs::create_dir_all(parent);
        }

        let exe_name = exe_p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Game.exe")
            .to_string();

        let emit_progress = |stage: &str, msg: Option<&str>| {
            let payload = TraceProgressPayload {
                stage: stage.to_string(),
                indeterminate: true,
                percent: None,
                rows: None,
                bytes_read: None,
                bytes_total: None,
                elapsed_ms: launch_start_time.elapsed().as_millis() as u64,
                message: msg.map(|s| s.to_string()),
            };
            let _ = app_clone.emit("trace-analyzer:progress", payload);
        };

        emit_progress(
            "launching_game",
            Some(&format!("Launching {} with Unreal trace arguments...", exe_name)),
        );

        let mut cmd = std::process::Command::new(&exe_p);
        let mut args = vec![
            "-trace=cpu,gpu,frame,loadtime,counters,bookmark".to_string(),
            "-cpuprofilertrace".to_string(),
            format!("-tracefile={}", target_trace_p.to_string_lossy()),
        ];

        if let Some(custom) = custom_args.as_deref() {
            for arg in custom.split_whitespace() {
                args.push(arg.to_string());
            }
        }

        cmd.args(&args);
        if let Some(working_dir) = exe_p.parent() {
            cmd.current_dir(working_dir);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn game process '{}': {}", exe_path, e))?;
        let pid = child.id();
        crate::running_process::set_running_pid(pid);

        // Monitor process loop
        let mut last_progress_emit = Instant::now();
        loop {
            if IS_CANCELLED.load(Ordering::SeqCst) {
                let _ = crate::utils::kill_pid(pid);
                crate::running_process::clear_running_pid();
                return Err("Game execution cancelled by user.".to_string());
            }

            match child.try_wait() {
                Ok(Some(_exit_status)) => {
                    crate::running_process::clear_running_pid();
                    break;
                }
                Ok(None) => {
                    if last_progress_emit.elapsed() >= Duration::from_millis(500) {
                        emit_progress(
                            "monitoring_game",
                            Some(&format!(
                                "Monitoring {} (PID: {}) — running for {:.1}s...",
                                exe_name,
                                pid,
                                launch_start_time.elapsed().as_secs_f64()
                            )),
                        );
                        last_progress_emit = Instant::now();
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => {
                    crate::running_process::clear_running_pid();
                    return Err(format!("Error monitoring game process: {}", e));
                }
            }
        }

        emit_progress(
            "monitoring_game",
            Some(&format!("{} process closed. Finalizing trace file...", exe_name)),
        );

        // Brief wait for file buffers to flush
        std::thread::sleep(Duration::from_millis(500));

        // Locate trace file
        let resolved_trace_path = if target_trace_p.is_file()
            && fs::metadata(&target_trace_p).map(|m| m.len() > 0).unwrap_or(false)
        {
            target_trace_p
        } else {
            let mut search_dirs = vec![store_dir.clone()];
            if let Some(parent) = exe_p.parent() {
                search_dirs.push(parent.join("Saved").join("Profiling").join("UnrealTrace"));
                search_dirs.push(parent.join("Saved").join("Trace"));
                if let Some(grandparent) = parent.parent().and_then(|p| p.parent()) {
                    search_dirs.push(grandparent.join("Saved").join("Profiling").join("UnrealTrace"));
                    search_dirs.push(grandparent.join("Saved").join("Trace"));
                }
            }

            find_newest_trace_file(&search_dirs, launch_timestamp_secs).ok_or_else(|| {
                format!(
                    "Game process closed, but no trace capture file was found at '{}' or in the Unreal Trace Store.",
                    target_trace_p.to_string_lossy()
                )
            })?
        };

        // Run full trace analysis pipeline on the captured trace file
        run_trace_analysis_pipeline_sync(&app_clone, &resolved_trace_path, &insights_path, &eng_ver, &opts)
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
                "SELECT t.name, t.bucket, SUM(ft.excl_ms) as total_excl, SUM(ft.calls) as call_count,
                        COALESCE((
                            SELECT bg.median_excl_ms 
                            FROM baseline_global bg 
                            WHERE bg.timer_id = ft.timer_id
                        ), 0.0) as baseline_median
                 FROM frame_timer ft
                 JOIN timers t ON t.id = ft.timer_id
                 WHERE ft.frame_idx >= ?1 AND ft.frame_idx <= ?2
                 GROUP BY ft.timer_id, t.name, t.bucket
                 ORDER BY (total_excl - baseline_median) DESC
                 LIMIT 15",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(rusqlite::params![episode.frame_from, episode.frame_to], |row| {
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
                "SELECT t.bucket, SUM(ft.excl_ms) as total_excl
                 FROM frame_timer ft
                 JOIN timers t ON t.id = ft.timer_id
                 WHERE ft.frame_idx >= ?1 AND ft.frame_idx <= ?2
                 GROUP BY t.bucket
                 ORDER BY total_excl DESC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(rusqlite::params![episode.frame_from, episode.frame_to], |row| {
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
                        SUM(CASE WHEN t.kind = 'work' THEN ft.excl_ms ELSE 0 END) as busy_ms,
                        SUM(CASE WHEN t.kind = 'wait' THEN ft.excl_ms ELSE 0 END) as wait_ms
                 FROM frame_timer ft
                 JOIN threads th ON th.id = ft.thread_id
                 JOIN timers t ON t.id = ft.timer_id
                 WHERE ft.frame_idx >= ?1 AND ft.frame_idx <= ?2
                 GROUP BY th.name, th.role
                 ORDER BY busy_ms DESC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(rusqlite::params![episode.frame_from, episode.frame_to], |row| {
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
pub fn trace_get_bookmarks(
    app: AppHandle,
    trace_id: String,
) -> Result<Vec<TraceBookmark>, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    let db_path = get_cache_db_path(&app_data_dir, &trace_id)?;
    if !db_path.exists() {
        return Err(format!("Cache DB not found for trace ID: {}", trace_id));
    }
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
    query_bookmarks(&conn).map_err(|e| e.to_string())
}

pub fn compute_range_statistics(
    conn: &Connection,
    raw_start_s: f64,
    raw_end_s: f64,
) -> Result<RangeStatisticsResponse, rusqlite::Error> {
    use crate::trace::frames::calculate_percentile;

    let (start_s, end_s) = if (raw_end_s - raw_start_s).abs() < 0.02 {
        let center = raw_start_s.max(0.0);
        ((center - 0.5).max(0.0), center + 0.5)
    } else {
        (raw_start_s.min(raw_end_s).max(0.0), raw_start_s.max(raw_end_s))
    };
    let duration_s = end_s - start_s;

    // 1. Query frames in [start_s, end_s]
    let mut stmt = conn.prepare(
        "SELECT start_s, interval_ms, game_ms, render_ms, gpu_ms
         FROM frames
         WHERE start_s >= ?1 AND start_s <= ?2
         ORDER BY start_s ASC",
    )?;

    #[allow(dead_code)]
    struct FrameRow {
        start_s: f64,
        interval_ms: f64,
        game_ms: Option<f64>,
        render_ms: Option<f64>,
        gpu_ms: Option<f64>,
    }

    let frame_rows = stmt.query_map(rusqlite::params![start_s, end_s], |row| {
        Ok(FrameRow {
            start_s: row.get(0)?,
            interval_ms: row.get(1)?,
            game_ms: row.get(2)?,
            render_ms: row.get(3)?,
            gpu_ms: row.get(4)?,
        })
    })?;

    let mut frames: Vec<FrameRow> = Vec::new();
    for r in frame_rows {
        frames.push(r?);
    }

    // Fallback if no frames strictly inside range: try closest single frame using index
    if frames.is_empty() {
        let mut fallback_stmt = conn.prepare(
            "SELECT start_s, interval_ms, game_ms, render_ms, gpu_ms
             FROM frames
             WHERE start_s <= ?1
             ORDER BY start_s DESC
             LIMIT 1",
        )?;
        let mut fb_rows = fallback_stmt.query_map(rusqlite::params![start_s], |row| {
            Ok(FrameRow {
                start_s: row.get(0)?,
                interval_ms: row.get(1)?,
                game_ms: row.get(2)?,
                render_ms: row.get(3)?,
                gpu_ms: row.get(4)?,
            })
        })?;
        if let Some(r) = fb_rows.next() {
            if let Ok(f) = r {
                frames.push(f);
            }
        }

        if frames.is_empty() {
            let mut next_stmt = conn.prepare(
                "SELECT start_s, interval_ms, game_ms, render_ms, gpu_ms
                 FROM frames
                 WHERE start_s >= ?1
                 ORDER BY start_s ASC
                 LIMIT 1",
            )?;
            let mut next_rows = next_stmt.query_map(rusqlite::params![start_s], |row| {
                Ok(FrameRow {
                    start_s: row.get(0)?,
                    interval_ms: row.get(1)?,
                    game_ms: row.get(2)?,
                    render_ms: row.get(3)?,
                    gpu_ms: row.get(4)?,
                })
            })?;
            if let Some(r) = next_rows.next() {
                if let Ok(f) = r {
                    frames.push(f);
                }
            }
        }
    }

    let frame_count = frames.len();

    let target_fps: f64 = get_meta(conn, "target_fps")
        .ok()
        .flatten()
        .and_then(|s| s.parse().ok())
        .unwrap_or(60.0);
    let target_ms = 1000.0 / target_fps;

    let mut intervals: Vec<f64> = frames.iter().map(|f| f.interval_ms).collect();
    intervals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let min_ms = intervals.first().copied().unwrap_or(0.0);
    let max_ms = intervals.last().copied().unwrap_or(0.0);
    let median_ms = calculate_percentile(&intervals, 0.5);
    let p95_ms = calculate_percentile(&intervals, 0.95);
    let p99_ms = calculate_percentile(&intervals, 0.99);

    let over_budget_pct = if frame_count > 0 {
        let over_count = frames.iter().filter(|f| f.interval_ms > target_ms).count();
        (over_count as f64 / frame_count as f64) * 100.0
    } else {
        0.0
    };

    let budget_gap_ms = (median_ms - target_ms).max(0.0);

    // 2. Thread Medians & Active Work Times
    let mut game_times: Vec<f64> = frames.iter().filter_map(|f| f.game_ms).collect();
    game_times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median_game_ms = if game_times.is_empty() { 0.0 } else { calculate_percentile(&game_times, 0.5) };

    let mut render_times: Vec<f64> = frames.iter().filter_map(|f| f.render_ms).collect();
    render_times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median_render_ms = if render_times.is_empty() { 0.0 } else { calculate_percentile(&render_times, 0.5) };

    let mut gpu_times: Vec<f64> = frames.iter().filter_map(|f| f.gpu_ms).collect();
    gpu_times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median_gpu_ms = if gpu_times.is_empty() { 0.0 } else { calculate_percentile(&gpu_times, 0.5) };

    // 3. Top Timers Aggregation via Block Summary Pyramid & Edge Frames
    let mut top_timers = Vec::new();
    let mut thread_wait_sums: std::collections::HashMap<String, f64> = std::collections::HashMap::new();

    let frame_bounds: Option<(i64, i64)> = conn
        .query_row(
            "SELECT MIN(idx), MAX(idx) FROM frames WHERE start_s >= ?1 AND start_s <= ?2",
            rusqlite::params![start_s, end_s],
            |row| {
                let min_idx: Option<i64> = row.get(0)?;
                let max_idx: Option<i64> = row.get(1)?;
                Ok(min_idx.zip(max_idx))
            },
        )
        .ok()
        .flatten();

    if let Some((f_from, f_to)) = frame_bounds {
        let assembled_sums = assemble_range_timer_sums(conn, f_from, f_to).unwrap_or_default();

        if !assembled_sums.is_empty() {
            // Load timers metadata
            let mut timer_meta: std::collections::HashMap<i64, (String, String, String)> = std::collections::HashMap::new();
            if let Ok(mut stmt) = conn.prepare("SELECT id, name, bucket, kind FROM timers") {
                if let Ok(rows) = stmt.query_map([], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))
                }) {
                    for r in rows.flatten() {
                        timer_meta.insert(r.0, (r.1, r.2, r.3));
                    }
                }
            }

            // Load thread metadata
            let mut thread_meta: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
            if let Ok(mut stmt) = conn.prepare("SELECT id, role FROM threads") {
                if let Ok(rows) = stmt.query_map([], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?))
                }) {
                    for r in rows.flatten() {
                        thread_meta.insert(r.0, r.1.unwrap_or_else(|| "game".to_string()));
                    }
                }
            }

            let mut timer_entries = Vec::new();
            for ((th_id, timer_id), (sum_excl_ms, sum_calls)) in assembled_sums {
                let (name, bucket, kind) = if timer_id == 0 {
                    ("Other".to_string(), "Other".to_string(), "work".to_string())
                } else if let Some(meta) = timer_meta.get(&timer_id) {
                    meta.clone()
                } else {
                    ("Other".to_string(), "Other".to_string(), "work".to_string())
                };

                let thread_role = thread_meta.get(&th_id).cloned().unwrap_or_else(|| "game".to_string());

                if kind == "wait" || kind == "idle" {
                    *thread_wait_sums.entry(thread_role.clone()).or_insert(0.0) += sum_excl_ms;
                }

                let avg_ms_per_frame = if frame_count > 0 {
                    sum_excl_ms / (frame_count as f64)
                } else {
                    0.0
                };

                let share_of_budget_gap_pct = if budget_gap_ms > 0.001 {
                    Some(((avg_ms_per_frame / budget_gap_ms) * 100.0).clamp(0.0, 100.0))
                } else {
                    None
                };

                timer_entries.push(RangeTopTimer {
                    name,
                    bucket,
                    thread_role,
                    avg_ms_per_frame,
                    total_ms: sum_excl_ms,
                    call_count: sum_calls as usize,
                    share_of_budget_gap_pct,
                });
            }

            timer_entries.sort_by(|a, b| b.total_ms.partial_cmp(&a.total_ms).unwrap_or(std::cmp::Ordering::Equal));
            timer_entries.truncate(25);
            top_timers = timer_entries;
        }
    }

    if top_timers.is_empty() {
        if let Ok(mut stmt) = conn.prepare(
            "SELECT 
                CASE WHEN ft.timer_id = 0 THEN 'Other' ELSE COALESCE(t.name, 'Other') END as timer_name,
                CASE WHEN ft.timer_id = 0 THEN 'Other' ELSE COALESCE(t.bucket, 'Other') END as bucket_name,
                CASE WHEN ft.timer_id = 0 THEN 'work' ELSE COALESCE(t.kind, 'work') END as timer_kind,
                COALESCE(th.role, 'game') as thread_role,
                SUM(ft.excl_ms) as total_excl,
                SUM(ft.calls) as call_count
             FROM frame_timer ft
             JOIN frames f ON f.idx = ft.frame_idx
             LEFT JOIN timers t ON t.id = ft.timer_id
             LEFT JOIN threads th ON th.id = ft.thread_id
             WHERE f.start_s >= ?1 AND f.start_s <= ?2
             GROUP BY ft.timer_id, ft.thread_id
             ORDER BY total_excl DESC",
        ) {
            let rows = stmt.query_map(rusqlite::params![start_s, end_s], |row| {
                let name: String = row.get(0)?;
                let bucket: String = row.get(1)?;
                let kind: String = row.get(2)?;
                let thread_role: String = row.get(3)?;
                let total_excl: f64 = row.get(4)?;
                let call_count: i64 = row.get(5)?;
                Ok((name, bucket, kind, thread_role, total_excl, call_count as usize))
            });

            if let Ok(mapped_rows) = rows {
                for r in mapped_rows.flatten() {
                    let (name, bucket, kind, thread_role, total_excl, call_count) = r;
                    if kind == "wait" || kind == "idle" {
                        *thread_wait_sums.entry(thread_role.clone()).or_insert(0.0) += total_excl;
                    }

                    let avg_ms_per_frame = if frame_count > 0 {
                        total_excl / (frame_count as f64)
                    } else {
                        0.0
                    };

                    let share_of_budget_gap_pct = if budget_gap_ms > 0.001 {
                        Some(((avg_ms_per_frame / budget_gap_ms) * 100.0).clamp(0.0, 100.0))
                    } else {
                        None
                    };

                    if top_timers.len() < 25 {
                        top_timers.push(RangeTopTimer {
                            name,
                            bucket,
                            thread_role,
                            avg_ms_per_frame,
                            total_ms: total_excl,
                            call_count,
                            share_of_budget_gap_pct,
                        });
                    }
                }
            }
        }
    }

    // Determine limiting thread based on active compute time (excluding sleep/sync wait on other hardware)
    let avg_game_wait = thread_wait_sums.get("game").copied().unwrap_or(0.0) / (frame_count as f64).max(1.0);
    let avg_render_wait = thread_wait_sums.get("render").copied().unwrap_or(0.0) / (frame_count as f64).max(1.0);
    let active_game_ms = (median_game_ms - avg_game_wait).max(0.0);
    let active_render_ms = (median_render_ms - avg_render_wait).max(0.0);
    let active_gpu_ms = median_gpu_ms;

    let limiting_thread = if active_gpu_ms >= active_game_ms && active_gpu_ms >= active_render_ms && active_gpu_ms > 0.0 {
        "gpu"
    } else if active_game_ms >= active_render_ms && active_game_ms > 0.0 {
        "game"
    } else if active_render_ms > 0.0 {
        "render"
    } else if median_ms > 0.0 && active_gpu_ms == 0.0 && active_game_ms == 0.0 && active_render_ms == 0.0 {
        "idle"
    } else {
        "game"
    };

    let thread_medians = ThreadMedians {
        game_ms: median_game_ms,
        render_ms: median_render_ms,
        gpu_ms: median_gpu_ms,
        limiting_thread: limiting_thread.to_string(),
    };

    Ok(RangeStatisticsResponse {
        start_s,
        end_s,
        duration_s,
        frame_count,
        median_ms,
        p95_ms,
        p99_ms,
        min_ms,
        max_ms,
        over_budget_pct,
        budget_gap_ms,
        thread_medians,
        top_timers,
    })
}

#[tauri::command]
pub fn trace_analyze_range(
    app: AppHandle,
    trace_id: String,
    start_s: f64,
    end_s: f64,
) -> Result<RangeStatisticsResponse, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    let db_path = get_cache_db_path(&app_data_dir, &trace_id)?;
    if !db_path.exists() {
        return Err(format!("Cache DB not found for trace ID: {}", trace_id));
    }
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
    compute_range_statistics(&conn, start_s, end_s).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn trace_get_range_statistics(
    app: AppHandle,
    trace_id: String,
    start_s: f64,
    end_s: f64,
) -> Result<RangeStatisticsResponse, String> {
    trace_analyze_range(app, trace_id, start_s, end_s)
}

pub fn start_background_diagnosis_task(app: AppHandle, db_path: PathBuf, target_fps: f64) {
    tokio::task::spawn_blocking(move || {
        run_background_diagnosis_loop(&app, &db_path, target_fps);
    });
}

fn run_background_diagnosis_loop(app: &AppHandle, db_path: &Path, target_fps: f64) {
    loop {
        if IS_CANCELLED.load(Ordering::Relaxed) {
            break;
        }

        let mut conn = match Connection::open(db_path) {
            Ok(c) => c,
            Err(_) => break,
        };

        let total_chunks: usize = conn
            .query_row("SELECT COUNT(*) FROM chunk_state", [], |r| r.get(0))
            .unwrap_or(0);
        let done_chunks: usize = conn
            .query_row("SELECT COUNT(*) FROM chunk_state WHERE state = 'done'", [], |r| r.get(0))
            .unwrap_or(0);

        if total_chunks == 0 || done_chunks >= total_chunks {
            break;
        }

        let frontier_s = *FRONTIER_START_S.lock().unwrap();

        let target_chunk_id: Option<i64> = if let Some(s) = frontier_s {
            conn.query_row(
                "SELECT cs.chunk_id FROM chunk_state cs
                 JOIN frames f ON f.idx = cs.frame_from
                 WHERE f.start_s >= ?1 AND cs.state = 'queued'
                 ORDER BY cs.chunk_id ASC LIMIT 1",
                rusqlite::params![s],
                |r| r.get(0),
            )
            .ok()
        } else {
            None
        };

        let next_chunk_id: Option<i64> = target_chunk_id.or_else(|| {
            conn.query_row(
                "SELECT chunk_id FROM chunk_state WHERE state = 'queued' ORDER BY chunk_id ASC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .ok()
        });

        let chunk_id = match next_chunk_id {
            Some(id) => id,
            None => break,
        };

        let _ = conn.execute(
            "UPDATE chunk_state SET state = 'running' WHERE chunk_id = ?1",
            rusqlite::params![chunk_id],
        );

        match diagnose_chunk(&mut conn, chunk_id, target_fps) {
            Ok(_) => {
                let _ = app.emit("trace-analyzer:chunk-done", chunk_id);
                let _ = app.emit(
                    "trace-analyzer:diagnosis-progress",
                    serde_json::json!({
                        "doneChunks": done_chunks + 1,
                        "totalChunks": total_chunks,
                    }),
                );
            }
            Err(_) => {
                let _ = conn.execute(
                    "UPDATE chunk_state SET state = 'queued' WHERE chunk_id = ?1",
                    rusqlite::params![chunk_id],
                );
                break;
            }
        }
    }
}

#[tauri::command]
pub fn trace_set_frontier(start_s: f64) -> Result<(), String> {
    let mut frontier = FRONTIER_START_S.lock().map_err(|e| e.to_string())?;
    *frontier = Some(start_s);
    Ok(())
}

#[tauri::command]
pub fn trace_get_chunks(app: AppHandle, trace_id: String) -> Result<Vec<DbChunkState>, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    let db_path = get_cache_db_path(&app_data_dir, &trace_id)?;
    if !db_path.exists() {
        return Err(format!("Cache DB not found for trace ID: {}", trace_id));
    }
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT chunk_id, state, frame_from, frame_to, done_at FROM chunk_state ORDER BY chunk_id ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(DbChunkState {
                chunk_id: r.get(0)?,
                state: r.get(1)?,
                frame_from: r.get(2)?,
                frame_to: r.get(3)?,
                done_at: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut chunks = Vec::new();
    for r in rows.flatten() {
        chunks.push(r);
    }
    Ok(chunks)
}

#[tauri::command]
pub fn trace_get_issues(app: AppHandle, trace_id: String) -> Result<Vec<IssueWithOccurrences>, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    let db_path = get_cache_db_path(&app_data_dir, &trace_id)?;
    if !db_path.exists() {
        return Err(format!("Cache DB not found for trace ID: {}", trace_id));
    }
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    let mut issues = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT issue_id, rule_id, key_timer_id, thread_role, scale, first_frame, last_frame, occurrences_count, total_excess_ms, worst_excess_ms
                 FROM issue
                 ORDER BY worst_excess_ms DESC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |r| {
                Ok(DbIssue {
                    issue_id: r.get(0)?,
                    rule_id: r.get(1)?,
                    key_timer_id: r.get(2)?,
                    thread_role: r.get(3)?,
                    scale: r.get(4)?,
                    first_frame: r.get(5)?,
                    last_frame: r.get(6)?,
                    occurrences_count: r.get(7)?,
                    total_excess_ms: r.get(8)?,
                    worst_excess_ms: r.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?;

        for r in rows.flatten() {
            issues.push(r);
        }
    }

    let mut result = Vec::new();
    for issue in issues {
        let mut occ_stmt = conn
            .prepare(
                "SELECT occurrence_id, issue_id, chunk_id, frame_from, frame_to, peak_frame_ms, mean_excess_ms, sum_excess_ms, confidence, evidence_json
                 FROM occurrence
                 WHERE issue_id = ?1
                 ORDER BY frame_from ASC",
            )
            .map_err(|e| e.to_string())?;

        let occ_rows = occ_stmt
            .query_map(rusqlite::params![issue.issue_id], |r| {
                Ok(DbOccurrence {
                    occurrence_id: r.get(0)?,
                    issue_id: r.get(1)?,
                    chunk_id: r.get(2)?,
                    frame_from: r.get(3)?,
                    frame_to: r.get(4)?,
                    peak_frame_ms: r.get(5)?,
                    mean_excess_ms: r.get(6)?,
                    sum_excess_ms: r.get(7)?,
                    confidence: r.get(8)?,
                    evidence_json: r.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut occurrences = Vec::new();
        for o in occ_rows.flatten() {
            occurrences.push(o);
        }

        result.push(IssueWithOccurrences { issue, occurrences });
    }

    Ok(result)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_trace_timestamp_filename() {
        let name = generate_trace_timestamp_filename();
        assert!(name.ends_with(".utrace"));
        assert_eq!(name.len(), 22); // YYYYMMDD_HHMMSS.utrace is 8 + 1 + 6 + 7 = 22
        let digits_only: String = name.chars().filter(|c| c.is_ascii_digit()).collect();
        assert_eq!(digits_only.len(), 14); // 8 date digits + 6 time digits
    }

    #[test]
    fn test_get_default_trace_store_dir() {
        let dir = get_default_trace_store_dir();
        let path_str = dir.to_string_lossy().to_string();
        assert!(path_str.contains("UnrealEngine"));
        assert!(path_str.contains("UnrealTrace"));
        assert!(path_str.contains("Store"));
    }

    #[test]
    fn test_compute_range_statistics_in_memory() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();

        // Insert frames
        conn.execute(
            "INSERT INTO frames (idx, start_s, interval_ms, game_ms, render_ms, gpu_ms) VALUES 
             (0, 1.0, 16.0, 10.0, 8.0, 14.0),
             (1, 1.016, 20.0, 12.0, 10.0, 18.0),
             (2, 1.036, 14.0, 8.0, 6.0, 12.0),
             (3, 1.050, 30.0, 25.0, 10.0, 15.0)",
            [],
        ).unwrap();

        // Insert timers
        conn.execute(
            "INSERT INTO timers (id, name, bucket, kind) VALUES 
             (1, 'BP_Player::Tick', 'Blueprint', 'work'),
             (2, 'ShadowDepths', 'GPU', 'work'),
             (3, 'Slate::DrawWindows', 'UI / Slate', 'work')",
            [],
        ).unwrap();

        // Insert threads
        conn.execute(
            "INSERT INTO threads (id, name, role) VALUES 
             (1, 'GameThread', 'game'),
             (4, 'GPU', 'gpu')",
            [],
        ).unwrap();

        // Insert frame_timer rows
        conn.execute(
            "INSERT INTO frame_timer (frame_idx, thread_id, timer_id, excl_ms, calls, max_ms) VALUES
             (0, 1, 1, 15.0, 1, 15.0),
             (0, 4, 2, 20.0, 1, 20.0),
             (0, 1, 3, 5.0, 1, 5.0)",
            [],
        ).unwrap();

        let stats = compute_range_statistics(&conn, 1.0, 1.1).unwrap();
        assert_eq!(stats.frame_count, 4);
        assert!(stats.median_ms > 0.0);
        assert_eq!(stats.thread_medians.limiting_thread, "gpu");
        assert!(stats.thread_medians.gpu_ms > 0.0);
        assert!(!stats.top_timers.is_empty());
        assert_eq!(stats.top_timers[0].name, "ShadowDepths");
        assert_eq!(stats.top_timers[0].thread_role, "gpu");
        assert!(stats.top_timers[0].avg_ms_per_frame > 0.0);
    }
}
