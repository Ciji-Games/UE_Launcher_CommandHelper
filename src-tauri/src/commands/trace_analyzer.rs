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
    build_block_pyramid, calculate_robust_stats, detect_episodes, save_episodes_to_db,
    AnalysisOptions,
};
use crate::trace::insights_cli::{InsightsCliSource, TraceCandidate};
use crate::trace::rules::{evaluate_and_save_findings, generate_verdict};
use crate::trace::source::TraceSource;
use crate::trace::store::{
    clear_cache, compute_cache_key, get_cache_db_path, get_cache_info, get_meta,
    init_db, query_all_processed_frames, query_bookmarks, query_episodes, query_findings, query_frame_buckets,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_weighted_fps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_over_budget_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frames_over_budget_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub regime_summary: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMedians {
    pub game_ms: f64,
    pub active_game_ms: f64,
    pub wait_game_ms: f64,
    pub render_ms: f64,
    pub active_render_ms: f64,
    pub wait_render_ms: f64,
    pub gpu_ms: f64,
    pub active_gpu_ms: f64,
    pub wait_gpu_ms: f64,
    pub limiting_thread: String, // "gpu" | "game" | "render" | "idle"
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RangeTopTimer {
    pub name: String,
    pub bucket: String,
    pub subsystem: String,
    pub path: String,
    pub thread_role: String,
    pub avg_ms_per_frame: f64,
    pub total_ms: f64,
    pub baseline_ms_per_frame: f64,
    pub call_count: usize,
    pub baseline_calls_per_frame: f64,
    pub is_wait: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue: Option<String>,
    pub share_of_thread_excess_pct: Option<f64>,
    pub share_of_budget_gap_pct: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RangeWaitEntry {
    pub thread: String,
    pub timer: String,
    pub avg_ms_per_frame: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RegimeChange {
    pub timestamp_s: f64,
    pub frame_idx: i64,
    pub from_median_ms: f64,
    pub to_median_ms: f64,
    pub description: String,
    pub top_deltas: Vec<String>,
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
    pub waiting_on: Vec<RangeWaitEntry>,
    pub findings: Vec<DbFinding>,
    pub regime_changes: Vec<RegimeChange>,
    pub sanity_flags: Vec<String>,
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
        if let Ok(mut conn) = Connection::open(&db_path) {
            let status = get_meta(&conn, "status").ok().flatten();
            let cached_index_ver: Option<i32> = get_meta(&conn, "index_version").ok().flatten().and_then(|s| s.parse().ok());
            if status.as_deref() == Some("done") && cached_index_ver == Some(SCHEMA_VERSION) {
                let current_analysis_ver = format!("rules_v4_fps_{:.1}", opts.target_fps);
                let cached_analysis_ver = get_meta(&conn, "analysis_version").ok().flatten();
                if cached_analysis_ver.as_deref() != Some(&current_analysis_ver) {
                    let _ = conn.execute("DELETE FROM issue", []);
                    let _ = conn.execute("DELETE FROM occurrence", []);
                    let _ = conn.execute("DELETE FROM episodes", []);
                    let _ = conn.execute("DELETE FROM findings", []);
                    let _ = conn.execute("UPDATE chunk_state SET state = 'queued', done_at = NULL", []);
                    let _ = set_meta(&conn, "analysis_version", &current_analysis_ver);
                    let _ = set_meta(&conn, "target_fps", &format!("{:.1}", opts.target_fps));

                    if let Ok(processed_frames) = query_all_processed_frames(&conn) {
                        let stats = calculate_robust_stats(&processed_frames);
                        let episodes = detect_episodes(&processed_frames, &stats, opts);
                        let _ = save_episodes_to_db(&mut conn, &episodes);
                        let _ = evaluate_and_save_findings(&mut conn, &episodes);
                    }
                }
                let _ = set_meta(&conn, "target_fps", &format!("{:.1}", opts.target_fps));
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
    set_meta(&conn, "analysis_version", &format!("rules_v4_fps_{:.1}", opts.target_fps)).map_err(|e| e.to_string())?;
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

    let time_weighted_fps = if stats.duration_s > 0.0 {
        Some(stats.total_frames as f64 / stats.duration_s)
    } else if stats.median_ms > 0.0 {
        Some(1000.0 / stats.median_ms)
    } else {
        None
    };

    let target_ms = 1000.0 / opts.target_fps;
    let total_interval_sum: f64 = processed_frames.iter().map(|f| f.interval_ms).sum();
    let over_budget_time: f64 = processed_frames.iter().filter(|f| f.interval_ms > target_ms).map(|f| f.interval_ms).sum();
    let time_over_budget_pct = if total_interval_sum > 0.0 {
        Some((over_budget_time / total_interval_sum) * 100.0)
    } else {
        Some(0.0)
    };

    let over_budget_frames = processed_frames.iter().filter(|f| f.interval_ms > target_ms).count();
    let frames_over_budget_pct = if stats.total_frames > 0 {
        Some((over_budget_frames as f64 / stats.total_frames as f64) * 100.0)
    } else {
        Some(0.0)
    };

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
        target_ms,
        hitch_count,
        slow_region_count,
        verdict,
        detected_channels,
        missing_channels,
        time_weighted_fps,
        time_over_budget_pct,
        frames_over_budget_pct,
        regime_summary: None,
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

    let target_ms = 1000.0 / opts.target_fps;
    let time_weighted_fps = if duration_s > 0.0 {
        Some(frame_count as f64 / duration_s)
    } else if median_ms > 0.0 {
        Some(1000.0 / median_ms)
    } else {
        None
    };

    let total_interval_sum: f64 = intervals.iter().sum();
    let over_budget_time: f64 = intervals.iter().filter(|&&intv| intv > target_ms).sum();
    let time_over_budget_pct = if total_interval_sum > 0.0 {
        Some((over_budget_time / total_interval_sum) * 100.0)
    } else {
        Some(0.0)
    };

    let over_budget_frames = intervals.iter().filter(|&&intv| intv > target_ms).count();
    let frames_over_budget_pct = if frame_count > 0 {
        Some((over_budget_frames as f64 / frame_count as f64) * 100.0)
    } else {
        Some(0.0)
    };

    let mut regime_summary: Option<String> = None;
    if let Ok(mut f_stmt) = conn.prepare("SELECT idx, start_s, interval_ms FROM frames ORDER BY idx ASC") {
        if let Ok(rows) = f_stmt.query_map([], |r| {
            Ok(crate::trace::regime::FrameTimePoint {
                idx: r.get(0)?,
                start_s: r.get(1)?,
                interval_ms: r.get(2)?,
            })
        }) {
            let chrono_frames: Vec<crate::trace::regime::FrameTimePoint> = rows.flatten().collect();
            let regimes = crate::trace::regime::detect_regimes(&chrono_frames, target_ms);
            if let Some(first_regime) = regimes.first() {
                let prev_med = first_regime.previous_median_ms.unwrap_or(0.0);
                let prev_fps = first_regime.previous_fps.unwrap_or(0.0);
                regime_summary = Some(format!(
                    "From {:.2}s: avg {:.1} ms vs {:.1} ms before (~{:.0} fps vs {:.0})",
                    first_regime.start_s, first_regime.avg_ms, prev_med, first_regime.fps, prev_fps
                ));
            }
        }
    }

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
        target_ms,
        hitch_count,
        slow_region_count,
        verdict,
        detected_channels,
        missing_channels,
        time_weighted_fps,
        time_over_budget_pct,
        frames_over_budget_pct,
        regime_summary,
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
        "SELECT idx, start_s, interval_ms, game_ms, render_ms, gpu_ms
         FROM frames
         WHERE start_s >= ?1 AND start_s <= ?2
         ORDER BY start_s ASC",
    )?;

    #[allow(dead_code)]
    struct FrameRow {
        idx: i64,
        start_s: f64,
        interval_ms: f64,
        game_ms: Option<f64>,
        render_ms: Option<f64>,
        gpu_ms: Option<f64>,
    }

    let frame_rows = stmt.query_map(rusqlite::params![start_s, end_s], |row| {
        Ok(FrameRow {
            idx: row.get(0)?,
            start_s: row.get(1)?,
            interval_ms: row.get(2)?,
            game_ms: row.get(3)?,
            render_ms: row.get(4)?,
            gpu_ms: row.get(5)?,
        })
    })?;

    let mut frames: Vec<FrameRow> = Vec::new();
    for r in frame_rows {
        frames.push(r?);
    }

    // Fallback if no frames strictly inside range: try closest single frame using index
    if frames.is_empty() {
        let mut fallback_stmt = conn.prepare(
            "SELECT idx, start_s, interval_ms, game_ms, render_ms, gpu_ms
             FROM frames
             WHERE start_s <= ?1
             ORDER BY start_s DESC
             LIMIT 1",
        )?;
        let mut fb_rows = fallback_stmt.query_map(rusqlite::params![start_s], |row| {
            Ok(FrameRow {
                idx: row.get(0)?,
                start_s: row.get(1)?,
                interval_ms: row.get(2)?,
                game_ms: row.get(3)?,
                render_ms: row.get(4)?,
                gpu_ms: row.get(5)?,
            })
        })?;
        if let Some(r) = fb_rows.next() {
            if let Ok(f) = r {
                frames.push(f);
            }
        }

        if frames.is_empty() {
            let mut next_stmt = conn.prepare(
                "SELECT idx, start_s, interval_ms, game_ms, render_ms, gpu_ms
                 FROM frames
                 WHERE start_s >= ?1
                 ORDER BY start_s ASC
                 LIMIT 1",
            )?;
            let mut next_rows = next_stmt.query_map(rusqlite::params![start_s], |row| {
                Ok(FrameRow {
                    idx: row.get(0)?,
                    start_s: row.get(1)?,
                    interval_ms: row.get(2)?,
                    game_ms: row.get(3)?,
                    render_ms: row.get(4)?,
                    gpu_ms: row.get(5)?,
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

    // 2. Thread Active & Wait Times per Frame (Item 5)
    let mut frame_waits: std::collections::HashMap<(i64, String), f64> = std::collections::HashMap::new();
    if let Ok(mut wait_stmt) = conn.prepare(
        "SELECT ft.frame_idx, th.role, SUM(ft.excl_ms)
         FROM frame_timer ft
         JOIN frames f ON f.idx = ft.frame_idx
         JOIN threads th ON th.id = ft.thread_id
         JOIN timers t ON t.id = ft.timer_id
         WHERE f.start_s >= ?1 AND f.start_s <= ?2
           AND (t.kind = 'wait' OR t.kind = 'idle')
         GROUP BY ft.frame_idx, th.role",
    ) {
        if let Ok(rows) = wait_stmt.query_map(rusqlite::params![start_s, end_s], |row| {
            let f_idx: i64 = row.get(0)?;
            let role: String = row.get(1)?;
            let wait_sum: f64 = row.get(2)?;
            Ok((f_idx, role, wait_sum))
        }) {
            for r in rows.flatten() {
                let (f_idx, role, wait_sum) = r;
                frame_waits.insert((f_idx, role), wait_sum);
            }
        }
    }

    let mut game_times: Vec<f64> = frames.iter().filter_map(|f| f.game_ms).collect();
    game_times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median_game_ms = if game_times.is_empty() { 0.0 } else { calculate_percentile(&game_times, 0.5) };

    let mut active_game_times: Vec<f64> = frames.iter().map(|f| {
        let wall = f.game_ms.unwrap_or(0.0);
        let wait = frame_waits.get(&(f.idx, "game".to_string())).copied().unwrap_or(0.0);
        (wall - wait).max(0.0)
    }).collect();
    active_game_times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let active_game_ms = if active_game_times.is_empty() { 0.0 } else { calculate_percentile(&active_game_times, 0.5) };

    let mut wait_game_times: Vec<f64> = frames.iter().map(|f| {
        frame_waits.get(&(f.idx, "game".to_string())).copied().unwrap_or(0.0)
    }).collect();
    wait_game_times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let wait_game_ms = if wait_game_times.is_empty() { 0.0 } else { calculate_percentile(&wait_game_times, 0.5) };

    let mut render_times: Vec<f64> = frames.iter().filter_map(|f| f.render_ms).collect();
    render_times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median_render_ms = if render_times.is_empty() { 0.0 } else { calculate_percentile(&render_times, 0.5) };

    let mut active_render_times: Vec<f64> = frames.iter().map(|f| {
        let wall = f.render_ms.unwrap_or(0.0);
        let wait = frame_waits.get(&(f.idx, "render".to_string())).copied().unwrap_or(0.0);
        (wall - wait).max(0.0)
    }).collect();
    active_render_times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let active_render_ms = if active_render_times.is_empty() { 0.0 } else { calculate_percentile(&active_render_times, 0.5) };

    let mut wait_render_times: Vec<f64> = frames.iter().map(|f| {
        frame_waits.get(&(f.idx, "render".to_string())).copied().unwrap_or(0.0)
    }).collect();
    wait_render_times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let wait_render_ms = if wait_render_times.is_empty() { 0.0 } else { calculate_percentile(&wait_render_times, 0.5) };

    let mut gpu_times: Vec<f64> = frames.iter().filter_map(|f| f.gpu_ms).collect();
    gpu_times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median_gpu_ms = if gpu_times.is_empty() { 0.0 } else { calculate_percentile(&gpu_times, 0.5) };

    let mut active_gpu_times: Vec<f64> = frames.iter().map(|f| {
        let wall = f.gpu_ms.unwrap_or(0.0);
        let wait = frame_waits.get(&(f.idx, "gpu".to_string())).copied().unwrap_or(0.0);
        (wall - wait).max(0.0)
    }).collect();
    active_gpu_times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let active_gpu_ms = if active_gpu_times.is_empty() { 0.0 } else { calculate_percentile(&active_gpu_times, 0.5) };

    let mut wait_gpu_times: Vec<f64> = frames.iter().map(|f| {
        frame_waits.get(&(f.idx, "gpu".to_string())).copied().unwrap_or(0.0)
    }).collect();
    wait_gpu_times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let wait_gpu_ms = if wait_gpu_times.is_empty() { 0.0 } else { calculate_percentile(&wait_gpu_times, 0.5) };

    let limiting_thread_str = if active_gpu_ms >= active_game_ms && active_gpu_ms >= active_render_ms && active_gpu_ms > 0.0 {
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
        active_game_ms,
        wait_game_ms,
        render_ms: median_render_ms,
        active_render_ms,
        wait_render_ms,
        gpu_ms: median_gpu_ms,
        active_gpu_ms,
        wait_gpu_ms,
        limiting_thread: limiting_thread_str.to_string(),
    };

    // 3. Top Timers Aggregation & Wait Separation
    let mut top_timers = Vec::new();
    let mut waiting_on = Vec::new();
    let mut thread_wait_sums: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    let mut thread_work_excess: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    let mut all_raw_work_timers = Vec::new();

    let subsystems = crate::trace::subsystem::load_subsystems();

    if let Ok(mut stmt) = conn.prepare(
        "SELECT 
            CASE WHEN ft.timer_id = 0 THEN 'Other' ELSE COALESCE(t.name, 'Other') END as timer_name,
            CASE WHEN ft.timer_id = 0 THEN 'Other' ELSE COALESCE(t.bucket, 'Other') END as bucket_name,
            CASE WHEN ft.timer_id = 0 THEN 'work' ELSE COALESCE(t.kind, 'work') END as timer_kind,
            CASE WHEN ft.timer_id = 0 THEN 'Other' ELSE COALESCE(t.path, t.name, 'Other') END as timer_path,
            COALESCE(th.name, 'GameThread') as thread_name,
            COALESCE(th.role, 'game') as thread_role,
            SUM(ft.excl_ms) as total_excl,
            SUM(ft.calls) as call_count,
            COALESCE(b.median_excl_ms, 0.0) as base_ms,
            COALESCE(b.median_calls, 0.0) as base_calls
         FROM frame_timer ft
         JOIN frames f ON f.idx = ft.frame_idx
         LEFT JOIN timers t ON t.id = ft.timer_id
         LEFT JOIN threads th ON th.id = ft.thread_id
         LEFT JOIN baseline_global b ON b.thread_id = ft.thread_id AND b.timer_id = ft.timer_id
         WHERE f.start_s >= ?1 AND f.start_s <= ?2
         GROUP BY ft.timer_id, ft.thread_id
         ORDER BY total_excl DESC",
    ) {
        if let Ok(rows) = stmt.query_map(rusqlite::params![start_s, end_s], |row| {
            let name: String = row.get(0)?;
            let bucket: String = row.get(1)?;
            let kind: String = row.get(2)?;
            let path: String = row.get(3)?;
            let thread_name: String = row.get(4)?;
            let thread_role: String = row.get(5)?;
            let total_excl: f64 = row.get(6)?;
            let call_count: i64 = row.get(7)?;
            let base_ms: f64 = row.get(8)?;
            let base_calls: f64 = row.get(9)?;
            Ok((name, bucket, kind, path, thread_name, thread_role, total_excl, call_count as usize, base_ms, base_calls))
        }) {
            for r in rows.flatten() {
                let (name, bucket, kind, path, thread_name, thread_role, total_excl, call_count, base_ms, base_calls) = r;
                let is_wait = crate::trace::diagnosis::is_wait_timer(&name, &kind);
                let avg_ms_per_frame = if frame_count > 0 { total_excl / (frame_count as f64) } else { 0.0 };
                let excess_ms = (avg_ms_per_frame - base_ms).max(0.0);
                let subsystem = crate::trace::subsystem::classify(&subsystems, &name, &path);

                let queue = if thread_role == "gpu" {
                    let lower = thread_name.to_lowercase();
                    if lower.contains("compute") {
                        Some("compute".to_string())
                    } else {
                        Some("graphics".to_string())
                    }
                } else {
                    None
                };

                if is_wait {
                    *thread_wait_sums.entry(thread_role.clone()).or_insert(0.0) += total_excl;
                    if avg_ms_per_frame >= 0.1 {
                        waiting_on.push(RangeWaitEntry {
                            thread: thread_role.clone(),
                            timer: name,
                            avg_ms_per_frame,
                        });
                    }
                } else {
                    *thread_work_excess.entry(thread_role.clone()).or_insert(0.0) += excess_ms;
                    all_raw_work_timers.push((name, bucket, subsystem, path, thread_role, avg_ms_per_frame, total_excl, base_ms, call_count, base_calls, queue, excess_ms));
                }
            }

            waiting_on.sort_by(|a, b| b.avg_ms_per_frame.partial_cmp(&a.avg_ms_per_frame).unwrap_or(std::cmp::Ordering::Equal));
            waiting_on.truncate(10);

            let limiting_work_excess = thread_work_excess.get(&thread_medians.limiting_thread).copied().unwrap_or(0.0);

            for (name, bucket, subsystem, path, thread_role, avg_ms_per_frame, total_excl, base_ms, call_count, base_calls, queue, excess_ms) in &all_raw_work_timers {
                let share_of_thread_excess_pct = if limiting_work_excess > 0.001 {
                    Some(((excess_ms / limiting_work_excess) * 100.0).clamp(0.0, 999.0))
                } else {
                    None
                };
                let share_of_budget_gap_pct = if budget_gap_ms > 0.001 {
                    Some(((avg_ms_per_frame / budget_gap_ms) * 100.0).clamp(0.0, 999.0))
                } else {
                    None
                };

                top_timers.push(RangeTopTimer {
                    name: name.clone(),
                    bucket: bucket.clone(),
                    subsystem: subsystem.clone(),
                    path: path.clone(),
                    thread_role: thread_role.clone(),
                    avg_ms_per_frame: *avg_ms_per_frame,
                    total_ms: *total_excl,
                    baseline_ms_per_frame: *base_ms,
                    call_count: *call_count,
                    baseline_calls_per_frame: *base_calls,
                    is_wait: false,
                    queue: queue.clone(),
                    share_of_thread_excess_pct,
                    share_of_budget_gap_pct,
                });
            }

            top_timers.sort_by(|a, b| b.total_ms.partial_cmp(&a.total_ms).unwrap_or(std::cmp::Ordering::Equal));
            top_timers.truncate(30);
        }
    }

    let limiting_work_excess = thread_work_excess.get(&thread_medians.limiting_thread).copied().unwrap_or(0.0);

    let mut findings = Vec::new();
    let mut sanity_flags = Vec::new();

    let f_from = frames.first().map(|f| f.idx).unwrap_or(0);
    let f_to = frames.last().map(|f| f.idx).unwrap_or(0);

    let range_hitch_count: usize = conn.query_row(
        "SELECT COUNT(*) FROM episodes WHERE kind = 'hitch' AND start_s <= ?2 AND end_s >= ?1",
        rusqlite::params![start_s, end_s],
        |r| r.get(0),
    ).unwrap_or(0);

    // Check sanity: individual thread exclusive totals vs frame intervals (Item 9)
    if let Ok(mut sanity_stmt) = conn.prepare(
        "SELECT f.idx, f.interval_ms, th.name, th.role, SUM(ft.excl_ms) as thread_excl
         FROM frame_timer ft
         JOIN frames f ON f.idx = ft.frame_idx
         JOIN threads th ON th.id = ft.thread_id
         WHERE f.start_s >= ?1 AND f.start_s <= ?2
         GROUP BY f.idx, th.id
         HAVING thread_excl > (f.interval_ms * 1.35 + 2.0)
         LIMIT 5"
    ) {
        if let Ok(rows) = sanity_stmt.query_map(rusqlite::params![start_s, end_s], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, f64>(4)?))
        }) {
            for r in rows.flatten() {
                sanity_flags.push(format!(
                    "Frame #{}: thread '{}' ({}) exclusive duration ({:.1} ms) exceeded frame interval ({:.1} ms).",
                    r.0, r.2, r.3, r.4, r.1
                ));
            }
        }
    }

    // Query overlapping issues & occurrences for selection (Item 3)
    let mut issue_map: std::collections::HashMap<i64, (DbIssue, Vec<DbOccurrence>)> = std::collections::HashMap::new();
    if let Ok(mut occ_stmt) = conn.prepare(
        "SELECT o.occurrence_id, o.issue_id, o.chunk_id, o.frame_from, o.frame_to, o.start_s, o.end_s,
                o.peak_frame_ms, o.mean_excess_ms, o.sum_excess_ms, o.confidence, o.evidence_json,
                i.rule_id, i.key_timer_id, i.thread_role, i.scale, i.first_frame, i.last_frame, i.occurrences_count, i.total_excess_ms, i.worst_excess_ms
         FROM occurrence o
         JOIN issue i ON i.issue_id = o.issue_id
         WHERE o.end_s >= ?1 AND o.start_s <= ?2"
    ) {
        if let Ok(rows) = occ_stmt.query_map(rusqlite::params![start_s, end_s], |r| {
            let occ = DbOccurrence {
                occurrence_id: r.get(0)?,
                issue_id: r.get(1)?,
                chunk_id: r.get(2)?,
                frame_from: r.get(3)?,
                frame_to: r.get(4)?,
                start_s: r.get(5)?,
                end_s: r.get(6)?,
                peak_frame_ms: r.get(7)?,
                mean_excess_ms: r.get(8)?,
                sum_excess_ms: r.get(9)?,
                confidence: r.get(10)?,
                evidence_json: r.get(11)?,
            };
            let iss = DbIssue {
                issue_id: r.get(1)?,
                rule_id: r.get(12)?,
                key_timer_id: r.get(13)?,
                thread_role: r.get(14)?,
                scale: r.get(15)?,
                first_frame: r.get(16)?,
                last_frame: r.get(17)?,
                occurrences_count: r.get(18)?,
                total_excess_ms: r.get(19)?,
                worst_excess_ms: r.get(20)?,
            };
            Ok((iss, occ))
        }) {
            for r in rows.flatten() {
                let entry = issue_map.entry(r.0.issue_id).or_insert((r.0, Vec::new()));
                entry.1.push(r.1);
            }
        }
    }

    let compiled_rules = crate::trace::rules::load_compiled_rules();

    for (issue_id, (issue, occs)) in issue_map {
        let matched_rule = compiled_rules.iter().find(|r| r.def.id == issue.rule_id);
        let rule_title = matched_rule.map(|r| r.def.title.clone()).unwrap_or_else(|| issue.rule_id.clone());

        // Extract primary culprit timer information from occs or DB timers table
        let mut culprit_timer = String::new();
        let mut culprit_path = String::new();
        let mut calls_per_frame_opt: Option<f64> = None;
        let mut observed_ms_opt: Option<f64> = None;
        let mut base_ms_opt: Option<f64> = None;
        let mut views_per_frame_opt: Option<f64> = None;
        let mut base_views_per_frame_opt: Option<f64> = None;

        // Try extracting from the occurrence with the largest sum_excess_ms
        if let Some(best_occ) = occs.iter().max_by(|a, b| a.sum_excess_ms.partial_cmp(&b.sum_excess_ms).unwrap_or(std::cmp::Ordering::Equal)) {
            if let Ok(ev) = serde_json::from_str::<serde_json::Value>(&best_occ.evidence_json) {
                if let Some(leaves) = ev.get("leaves").and_then(|v| v.as_array()) {
                    if let Some(first_leaf) = leaves.first() {
                        if let Some(t) = first_leaf.get("timer").and_then(|v| v.as_str()) {
                            culprit_timer = t.to_string();
                        }
                        if let Some(p) = first_leaf.get("path").and_then(|v| v.as_str()) {
                            culprit_path = p.to_string();
                        }
                        calls_per_frame_opt = first_leaf.get("callsPerFrame").and_then(|v| v.as_f64());
                        observed_ms_opt = first_leaf.get("msPerFrame").and_then(|v| v.as_f64());
                        base_ms_opt = first_leaf.get("baselineMsPerFrame").and_then(|v| v.as_f64());
                    }
                } else {
                    if let Some(t) = ev.get("timer").and_then(|v| v.as_str()) {
                        culprit_timer = t.to_string();
                    }
                    if let Some(p) = ev.get("path").and_then(|v| v.as_str()) {
                        culprit_path = p.to_string();
                    }
                    calls_per_frame_opt = ev.get("callsPerFrame").and_then(|v| v.as_f64());
                    observed_ms_opt = ev.get("observedMsPerFrame").and_then(|v| v.as_f64());
                    base_ms_opt = ev.get("baselineMsPerFrame").and_then(|v| v.as_f64());
                }

                views_per_frame_opt = ev.get("viewsPerFrame").and_then(|v| v.as_f64());
                base_views_per_frame_opt = ev.get("baselineViewsPerFrame").and_then(|v| v.as_f64());
            }
        }

        // If not found from evidence JSON, query timers table by issue.key_timer_id
        if culprit_timer.is_empty() || culprit_timer == "Other" {
            if let Ok((name, path)) = conn.query_row(
                "SELECT name, path FROM timers WHERE id = ?1",
                rusqlite::params![issue.key_timer_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            ) {
                culprit_timer = name;
                if culprit_path.is_empty() {
                    culprit_path = path;
                }
            }
        }

        // Formulate dynamic culprit title
        let finding_title = if !culprit_timer.is_empty() && culprit_timer != "Other" && culprit_timer != "Unprofiled Execution" {
            let views = views_per_frame_opt.unwrap_or(0.0);
            let base_views = base_views_per_frame_opt.unwrap_or(0.0);

            if issue.rule_id == "gpu-shadow-views" {
                if views > 0.0 {
                    format!("GPU Shadow Views: {:.0} views/frame (baseline {:.0}) — {}", views, base_views, culprit_timer)
                } else {
                    format!("GPU Shadow Views: {}", culprit_timer)
                }
            } else if issue.rule_id == "gpu-nanite" {
                if views >= 3.0 && views >= 3.0 * base_views.max(1.0) {
                    format!("GPU Nanite Rasterization: {:.0} views/frame (baseline {:.0}) — {}", views, base_views, culprit_timer)
                } else {
                    format!("GPU Nanite Rasterization: {}", culprit_timer)
                }
            } else if issue.rule_id == "gpu-niagara-fx" {
                format!("GPU Niagara & Particle Simulation: {}", culprit_timer)
            } else if issue.rule_id == "gpu-lumen" {
                format!("GPU Lumen GI & Reflections: {}", culprit_timer)
            } else if issue.rule_id == "gpu-vsm-shadows" {
                format!("GPU Virtual Shadow Maps (VSM): {}", culprit_timer)
            } else if issue.rule_id == "gpu-basepass" {
                format!("GPU BasePass & G-Buffer Shading: {}", culprit_timer)
            } else if issue.rule_id == "gpu-postprocess" {
                format!("GPU Post-Processing & Upscaling: {}", culprit_timer)
            } else if issue.rule_id == "gpu-direct-lighting" {
                format!("GPU Direct Lighting: {}", culprit_timer)
            } else if issue.rule_id == "gpu-translucency" {
                format!("GPU Translucent Surface Rendering: {}", culprit_timer)
            } else if issue.rule_id == "gpu-bound" {
                let lower = culprit_timer.to_lowercase();
                if lower.contains("fxsystem") || lower.contains("niagara") || lower.contains("compute") {
                    format!("GPU Compute Pass: {}", culprit_timer)
                } else {
                    format!("GPU Rendering Pass: {}", culprit_timer)
                }
            } else if issue.rule_id == "render-cpu" {
                if views >= 3.0 {
                    format!("Render Thread issuing {:.0} views/frame: {}", views, culprit_timer)
                } else {
                    format!("Render Thread CPU Bottleneck: {}", culprit_timer)
                }
            } else if issue.rule_id == "cpu-hitch" {
                if issue.scale == "spike" {
                    format!("CPU Execution Spike: {} ({})", culprit_timer, issue.thread_role)
                } else {
                    format!("Sustained CPU Overhead: {} ({})", culprit_timer, issue.thread_role)
                }
            } else if issue.rule_id == "taskgraph-wait" {
                format!("TaskGraph Worker Stall: {}", culprit_timer)
            } else {
                format!("{}: {}", rule_title, culprit_timer)
            }
        } else {
            rule_title
        };

        // Numbers strictly clipped to selection with exact SQLite aggregations (FR-2)
        let mut selection_excess_sum = 0.0f64;
        let mut selection_frames = 0usize;
        let mut sub_occurrences: Vec<serde_json::Value> = Vec::new();
        let mut is_approximate = false;

        for occ in &occs {
            let occ_start = occ.frame_from.max(f_from);
            let occ_end = occ.frame_to.min(f_to);
            if occ_start <= occ_end {
                let occ_clipped_frames = (occ_end - occ_start + 1) as usize;
                let mut occ_excess_ms = 0.0f64;
                let mut occ_peak_frame_ms = 0.0f64;
                let mut exact_found = false;

                // Query exact timer excess and peak frame time from frame_timer and frames with thread role filter (Item 6)
                if issue.key_timer_id != 0 {
                    let exact_query_res: Result<(f64, f64), rusqlite::Error> = conn.query_row(
                        "SELECT 
                            COALESCE(SUM(MAX(0.0, ft.excl_ms - COALESCE(b.median_excl_ms, 0.0))), 0.0),
                            COALESCE(MAX(f.interval_ms), 0.0)
                         FROM frame_timer ft
                         JOIN frames f ON f.idx = ft.frame_idx
                         JOIN threads th ON th.id = ft.thread_id
                         LEFT JOIN baseline_global b ON b.timer_id = ft.timer_id AND b.thread_id = ft.thread_id
                         WHERE ft.frame_idx >= ?1 AND ft.frame_idx <= ?2 AND ft.timer_id = ?3
                           AND (th.role = ?4 OR ?4 = '' OR ?4 = 'general')",
                        rusqlite::params![occ_start, occ_end, issue.key_timer_id, issue.thread_role],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    );

                    if let Ok((exact_sum, peak)) = exact_query_res {
                        if exact_sum > 0.0 {
                            occ_excess_ms = exact_sum;
                            occ_peak_frame_ms = peak;
                            exact_found = true;
                        }
                    }
                }

                if !exact_found {
                    if issue.key_timer_id != 0 {
                        is_approximate = true;
                    }
                    let occ_total_count = (occ.frame_to - occ.frame_from + 1).max(1) as f64;
                    let fraction = (occ_clipped_frames as f64 / occ_total_count).clamp(0.0, 1.0);
                    occ_excess_ms = occ.sum_excess_ms * fraction;
                    occ_peak_frame_ms = occ.peak_frame_ms;
                }

                if occ_peak_frame_ms <= 0.0 {
                    if let Ok(peak) = conn.query_row(
                        "SELECT COALESCE(MAX(interval_ms), 0.0) FROM frames WHERE idx >= ?1 AND idx <= ?2",
                        rusqlite::params![occ_start, occ_end],
                        |r| r.get(0),
                    ) {
                        occ_peak_frame_ms = peak;
                    }
                }

                selection_excess_sum += occ_excess_ms;
                selection_frames += occ_clipped_frames;

                let occ_start_s = frames.iter().find(|f| f.idx == occ_start).map(|f| f.start_s).unwrap_or(occ.start_s);
                let occ_end_s = frames.iter().find(|f| f.idx == occ_end).map(|f| f.start_s + f.interval_ms / 1000.0).unwrap_or(occ.end_s);

                sub_occurrences.push(serde_json::json!({
                    "occurrenceId": occ.occurrence_id,
                    "frameFrom": occ_start,
                    "frameTo": occ_end,
                    "startS": occ_start_s,
                    "endS": occ_end_s,
                    "peakMs": occ_peak_frame_ms,
                    "excessMs": occ_excess_ms,
                    "meanExcessMs": if occ_clipped_frames > 0 { occ_excess_ms / occ_clipped_frames as f64 } else { 0.0 },
                }));
            }
        }

        if selection_excess_sum < 0.5 || selection_frames == 0 {
            continue;
        }

        let explains_ms_per_frame = if frame_count > 0 {
            selection_excess_sum / (frame_count as f64)
        } else {
            0.0
        };

        if explains_ms_per_frame < 0.1 {
            continue;
        }

        if budget_gap_ms <= 0.001 && issue.scale == "sustained" {
            continue;
        }

        if budget_gap_ms <= 0.001 && issue.scale == "spike" && explains_ms_per_frame < 0.3 && range_hitch_count == 0 {
            continue;
        }

        // Share reference is limiting thread's work excess (Item 2)
        let of_excess_ms_per_frame = if limiting_work_excess > 0.001 {
            limiting_work_excess
        } else {
            explains_ms_per_frame
        };

        let share_of_excess = if of_excess_ms_per_frame > 0.001 {
            explains_ms_per_frame / of_excess_ms_per_frame
        } else {
            1.0
        };

        let mut data_quality_flag = false;
        if of_excess_ms_per_frame > 0.001 && explains_ms_per_frame > of_excess_ms_per_frame * 1.10 {
            data_quality_flag = true;
        }

        let fraction_of_frames_affected = selection_frames as f64 / frame_count.max(1) as f64;

        let mut confidence = if share_of_excess < 0.10 {
            "low"
        } else if share_of_excess >= 0.40 && fraction_of_frames_affected >= 0.50 {
            "high"
        } else {
            "medium"
        };

        let has_sanity_violation = !sanity_flags.is_empty();
        if has_sanity_violation || data_quality_flag {
            if confidence == "high" {
                confidence = "medium";
            }
        }

        let rule_fix_likelihood = matched_rule
            .map(|r| r.def.fix_likelihood.as_str())
            .unwrap_or("low");

        let fix_likelihood = if matched_rule.is_none() {
            "low"
        } else {
            match confidence {
                "low" => {
                    if rule_fix_likelihood == "high" {
                        "medium"
                    } else {
                        rule_fix_likelihood
                    }
                }
                "medium" | "high" => rule_fix_likelihood,
                _ => "low",
            }
        };

        let fixes = matched_rule.map(|r| r.def.fixes.clone()).unwrap_or_default();
        let verify = matched_rule.map(|r| r.def.verify.clone()).unwrap_or_else(|| "Re-capture the trace to confirm reduced execution time.".to_string());
        let caveats = matched_rule.map(|r| r.def.caveats.clone()).unwrap_or_default();

        let share_pct = (share_of_excess * 100.0).clamp(0.0, 999.0);
        let evidence_label = if !culprit_timer.is_empty() && culprit_timer != "Other" {
            if !culprit_path.is_empty() && culprit_path != culprit_timer {
                format!("{}: {:.1} ms/frame excess ({:.0}% of thread excess) [Path: {}]", culprit_timer, explains_ms_per_frame, share_pct, culprit_path)
            } else {
                format!("{}: {:.1} ms/frame excess ({:.0}% of thread excess)", culprit_timer, explains_ms_per_frame, share_pct)
            }
        } else {
            format!("{:.1} ms/frame excess ({:.0}% of thread excess)", explains_ms_per_frame, share_pct)
        };

        let mut ev_obj = serde_json::json!({
            "label": evidence_label,
            "value": format!("{:.1} ms", explains_ms_per_frame),
            "isKey": true
        });
        if !culprit_timer.is_empty() && culprit_timer != "Other" {
            ev_obj["timer"] = serde_json::Value::String(culprit_timer.clone());
        }
        if !culprit_path.is_empty() && culprit_path != "Other" {
            ev_obj["path"] = serde_json::Value::String(culprit_path.clone());
        }
        if let Some(c) = calls_per_frame_opt {
            ev_obj["callsPerFrame"] = serde_json::json!(c);
        }
        if let Some(o) = observed_ms_opt {
            ev_obj["observedMsPerFrame"] = serde_json::json!(o);
        }
        if let Some(b) = base_ms_opt {
            ev_obj["baselineMsPerFrame"] = serde_json::json!(b);
        }
        if budget_gap_ms > 0.001 {
            ev_obj["overBudgetMs"] = serde_json::json!(budget_gap_ms);
        }
        if is_approximate {
            ev_obj["isApproximate"] = serde_json::json!(true);
        }

        let mut evidence_arr = vec![ev_obj];
        for sub in &sub_occurrences {
            let occ_id = sub["occurrenceId"].as_i64().unwrap_or(0);
            let f_from = sub["frameFrom"].as_i64().unwrap_or(0);
            let f_to = sub["frameTo"].as_i64().unwrap_or(0);
            let exc_ms = sub["excessMs"].as_f64().unwrap_or(0.0);
            let s_s = sub["startS"].as_f64().unwrap_or(0.0);
            let e_s = sub["endS"].as_f64().unwrap_or(0.0);
            let peak_ms = sub["peakMs"].as_f64().unwrap_or(0.0);

            evidence_arr.push(serde_json::json!({
                "label": format!("Occurrence #{} (Frames {}..{})", occ_id, f_from, f_to),
                "value": format!("+{:.1} ms", exc_ms),
                "note": format!("{:.2}s – {:.2}s, Peak: {:.1} ms", s_s, e_s, peak_ms),
                "thread": issue.thread_role,
                "isKey": false
            }));
        }

        let payload_json = serde_json::json!({
            "title": finding_title,
            "scale": issue.scale,
            "explainsMs": explains_ms_per_frame,
            "ofExcessMs": of_excess_ms_per_frame,
            "overBudgetMs": if budget_gap_ms > 0.001 { Some(budget_gap_ms) } else { None },
            "isApproximate": is_approximate,
            "matchConfidence": confidence,
            "fixLikelihood": fix_likelihood,
            "fixes": fixes,
            "verify": verify,
            "caveats": caveats,
            "episodeIds": occs.iter().map(|o| o.occurrence_id).collect::<Vec<_>>(),
            "evidence": evidence_arr,
            "occurrences": sub_occurrences
        }).to_string();

        let match_conf_val = if confidence == "high" { 0.9 } else if confidence == "medium" { 0.6 } else { 0.3 };
        let episode_ids_vec: Vec<i64> = occs.iter().map(|o| o.occurrence_id).collect();

        findings.push(DbFinding {
            id: issue_id,
            rule_id: issue.rule_id,
            rank: explains_ms_per_frame,
            match_confidence: match_conf_val,
            fix_likelihood: fix_likelihood.to_string(),
            episode_ids: episode_ids_vec,
            payload: payload_json,
        });
    }

    // Sustained absolute-cost fallback for all-slow captures (Item 7)
    if findings.is_empty() && budget_gap_ms > 0.5 {
        let limiting_role = &thread_medians.limiting_thread;
        let mut limiting_work_timers: Vec<_> = all_raw_work_timers
            .iter()
            .filter(|t| t.4 == *limiting_role && t.5 >= 0.5)
            .cloned()
            .collect();
        limiting_work_timers.sort_by(|a, b| b.5.partial_cmp(&a.5).unwrap_or(std::cmp::Ordering::Equal));

        if let Some(top_timer) = limiting_work_timers.first() {
            let (name, _bucket, _subsystem, path, _thread_role, avg_ms_per_frame, _total_excl, base_ms, call_count, _base_calls, _queue, _excess_ms) = top_timer;
            let active_thread_time = match limiting_role.as_str() {
                "gpu" => thread_medians.active_gpu_ms,
                "game" => thread_medians.active_game_ms,
                "render" => thread_medians.active_render_ms,
                _ => median_ms,
            };
            let share_of_active_pct = if active_thread_time > 0.001 {
                ((avg_ms_per_frame / active_thread_time) * 100.0).clamp(0.0, 100.0)
            } else {
                0.0
            };
            let thread_display = match limiting_role.as_str() {
                "gpu" => "GPU",
                "render" => "RenderThread",
                _ => "GameThread",
            };

            let matched_rule = compiled_rules.iter().find(|r| {
                let thread_match = r.def.when.threads.is_empty() || r.def.when.threads.iter().any(|t| t == limiting_role || t == "any");
                let timer_match = r.regexes.iter().any(|re| re.is_match(name)) || r.path_regexes.iter().any(|re| re.is_match(path));
                thread_match && timer_match
            }).or_else(|| {
                compiled_rules.iter().find(|r| {
                    r.regexes.iter().any(|re| re.is_match(name)) || r.path_regexes.iter().any(|re| re.is_match(path))
                })
            });

            let rule_id = matched_rule.map(|r| r.def.id.clone()).unwrap_or_else(|| {
                if limiting_role == "gpu" {
                    "gpu-bound".to_string()
                } else if limiting_role == "render" {
                    "render-cpu".to_string()
                } else {
                    "cpu-hitch".to_string()
                }
            });

            let finding_title = matched_rule.map(|r| r.def.title.clone()).unwrap_or_else(|| {
                format!("Sustained {} Work: {}", thread_display, name)
            });

            let confidence = "medium";
            let rule_fix_likelihood = matched_rule.map(|r| r.def.fix_likelihood.as_str()).unwrap_or("low");
            let fix_likelihood = if rule_fix_likelihood == "high" { "medium" } else { rule_fix_likelihood };

            let fixes = matched_rule.map(|r| r.def.fixes.clone()).unwrap_or_default();
            let verify = matched_rule.map(|r| r.def.verify.clone()).unwrap_or_else(|| "Re-capture the trace to confirm reduced execution time.".to_string());
            let caveats = matched_rule.map(|r| r.def.caveats.clone()).unwrap_or_default();

            let evidence_label = format!(
                "{}: costs {:.1} ms/frame ({:.0}% of {} time); no faster period in this capture to compare with",
                name, avg_ms_per_frame, share_of_active_pct, thread_display
            );

            let mut ev_obj = serde_json::json!({
                "label": evidence_label,
                "value": format!("{:.1} ms", avg_ms_per_frame),
                "isKey": true,
                "timer": name,
                "callsPerFrame": call_count,
                "observedMsPerFrame": avg_ms_per_frame,
                "baselineMsPerFrame": base_ms,
                "overBudgetMs": budget_gap_ms,
            });
            if !path.is_empty() && path != name {
                ev_obj["path"] = serde_json::json!(path);
            }

            let payload_json = serde_json::json!({
                "title": finding_title,
                "scale": "sustained",
                "explainsMs": avg_ms_per_frame,
                "ofExcessMs": budget_gap_ms,
                "overBudgetMs": budget_gap_ms,
                "isApproximate": false,
                "matchConfidence": confidence,
                "fixLikelihood": fix_likelihood,
                "fixes": fixes,
                "verify": verify,
                "caveats": caveats,
                "episodeIds": Vec::<i64>::new(),
                "evidence": vec![ev_obj],
                "occurrences": Vec::<serde_json::Value>::new()
            }).to_string();

            findings.push(DbFinding {
                id: 999999,
                rule_id,
                rank: *avg_ms_per_frame,
                match_confidence: 0.6,
                fix_likelihood: fix_likelihood.to_string(),
                episode_ids: Vec::new(),
                payload: payload_json,
            });
        }
    }

    // Detect Regime Changes using unified time-based regime detector
    let mut regime_changes = Vec::new();
    let frame_time_points: Vec<crate::trace::regime::FrameTimePoint> = frames
        .iter()
        .map(|f| crate::trace::regime::FrameTimePoint {
            idx: f.idx,
            start_s: f.start_s,
            interval_ms: f.interval_ms,
        })
        .collect();

    let detected_regimes = crate::trace::regime::detect_regimes(&frame_time_points, target_ms);
    for reg in detected_regimes {
        let prev_med = reg.previous_median_ms.unwrap_or(0.0);
        let delta_ms = reg.median_ms - prev_med;
        let desc = format!(
            "at {:.2} s frame time {:.1} -> {:.1} ms ({:+.1} ms/frame)",
            reg.start_s, prev_med, reg.median_ms, delta_ms
        );

        let before_from = (reg.frame_from - 100).max(0);
        let before_to = (reg.frame_from - 1).max(0);
        let top_deltas = crate::trace::regime::calculate_regime_top_deltas(
            conn,
            before_from,
            before_to,
            reg.frame_from,
            reg.frame_to,
        );

        regime_changes.push(RegimeChange {
            timestamp_s: reg.start_s,
            frame_idx: reg.frame_from,
            from_median_ms: prev_med,
            to_median_ms: reg.median_ms,
            description: desc,
            top_deltas,
        });
    }

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
        waiting_on,
        findings,
        regime_changes,
        sanity_flags,
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
                "SELECT occurrence_id, issue_id, chunk_id, frame_from, frame_to, start_s, end_s, peak_frame_ms, mean_excess_ms, sum_excess_ms, confidence, evidence_json
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
                    start_s: r.get(5)?,
                    end_s: r.get(6)?,
                    peak_frame_ms: r.get(7)?,
                    mean_excess_ms: r.get(8)?,
                    sum_excess_ms: r.get(9)?,
                    confidence: r.get(10)?,
                    evidence_json: r.get(11)?,
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

    #[test]
    fn test_culprit_attribution_and_sanity_concurrency() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();

        // Insert frames
        conn.execute(
            "INSERT INTO frames (idx, start_s, interval_ms, game_ms, render_ms, gpu_ms) VALUES 
             (0, 10.0, 30.0, 10.0, 28.0, 12.0),
             (1, 10.033, 32.0, 10.0, 30.0, 12.0)",
            [],
        ).unwrap();

        // Insert timers with paths
        conn.execute(
            "INSERT INTO timers (id, name, bucket, kind, path) VALUES 
             (10, 'NodeAndClusterCull', 'Rendering', 'work', 'LaunchVisibilityTasks > WaitUntilTasksComplete > NodeAndClusterCull')",
            [],
        ).unwrap();

        // Insert threads
        conn.execute(
            "INSERT INTO threads (id, name, role) VALUES 
             (2, 'RenderThread 0', 'render')",
            [],
        ).unwrap();

        // Insert frame_timer
        conn.execute(
            "INSERT INTO frame_timer (frame_idx, thread_id, timer_id, excl_ms, calls, max_ms) VALUES
             (0, 2, 10, 25.0, 1, 25.0),
             (1, 2, 10, 26.0, 1, 26.0)",
            [],
        ).unwrap();

        // Insert issue & occurrence
        conn.execute(
            "INSERT INTO issue (issue_id, rule_id, key_timer_id, thread_role, scale, first_frame, last_frame, occurrences_count, total_excess_ms, worst_excess_ms)
             VALUES (1, 'cpu-hitch', 10, 'render', 'spike', 0, 1, 1, 51.0, 26.0)",
            [],
        ).unwrap();

        let ev_json = r#"{"timer":"NodeAndClusterCull","path":"LaunchVisibilityTasks > WaitUntilTasksComplete > NodeAndClusterCull","excessMs":51.0,"shareOfExcess":0.85,"callsPerFrame":1.0,"observedMsPerFrame":25.5,"baselineMsPerFrame":0.5,"sanityViolation":false}"#;
        conn.execute(
            "INSERT INTO occurrence (occurrence_id, issue_id, chunk_id, frame_from, frame_to, start_s, end_s, peak_frame_ms, mean_excess_ms, sum_excess_ms, confidence, evidence_json)
             VALUES (101, 1, 0, 0, 1, 10.0, 10.065, 32.0, 25.5, 51.0, 'high', ?1)",
            rusqlite::params![ev_json],
        ).unwrap();

        let stats = compute_range_statistics(&conn, 10.0, 10.1).unwrap();
        assert_eq!(stats.findings.len(), 1);
        let f = &stats.findings[0];
        assert_eq!(f.rule_id, "cpu-hitch");

        let payload: serde_json::Value = serde_json::from_str(&f.payload).unwrap();
        assert_eq!(payload["title"], "CPU Execution Spike: NodeAndClusterCull (render)");
        assert_eq!(payload["matchConfidence"], "high");

        let ev = &payload["evidence"][0];
        assert_eq!(ev["timer"], "NodeAndClusterCull");
        assert!(ev["label"].as_str().unwrap().contains("NodeAndClusterCull"));
        assert!(ev["label"].as_str().unwrap().contains("LaunchVisibilityTasks"));
    }

    #[test]
    fn test_smooth_range_produces_no_findings() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();

        // Insert smooth frames (all ~13.5 ms, well under 16.7 ms target budget)
        conn.execute(
            "INSERT INTO frames (idx, start_s, interval_ms, game_ms, render_ms, gpu_ms) VALUES 
             (10, 13.0, 13.5, 10.0, 8.0, 12.0),
             (11, 13.016, 13.6, 10.0, 8.0, 12.0),
             (12, 13.032, 13.4, 10.0, 8.0, 12.0)",
            [],
        ).unwrap();

        // Insert an issue that happened elsewhere (at frame 400, 20.0s)
        conn.execute(
            "INSERT INTO issue (issue_id, rule_id, key_timer_id, thread_role, scale, first_frame, last_frame, occurrences_count, total_excess_ms, worst_excess_ms)
             VALUES (1, 'cpu-hitch', 10, 'game', 'spike', 400, 401, 1, 50.0, 50.0)",
            [],
        ).unwrap();

        let ev_json = r#"{"timer":"UWorld_SendAllEndOfFrameUpdates","path":"FEngineLoop::Tick > SendAllEndOfFrameUpdates","excessMs":50.0,"shareOfExcess":0.80,"callsPerFrame":1.0,"observedMsPerFrame":45.0,"baselineMsPerFrame":2.0,"sanityViolation":false}"#;
        conn.execute(
            "INSERT INTO occurrence (occurrence_id, issue_id, chunk_id, frame_from, frame_to, start_s, end_s, peak_frame_ms, mean_excess_ms, sum_excess_ms, confidence, evidence_json)
             VALUES (101, 1, 0, 400, 401, 20.0, 20.05, 55.0, 50.0, 50.0, 'high', ?1)",
            rusqlite::params![ev_json],
        ).unwrap();

        let stats = compute_range_statistics(&conn, 13.0, 13.1).unwrap();
        assert_eq!(stats.frame_count, 3);
        assert!(stats.median_ms < 16.7);
        assert_eq!(stats.findings.len(), 0);
    }

    #[test]
    fn test_gpu_bound_range_selection_with_reflex_wait() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();

        // 10 frames of 50ms (GPU bound at 50ms, Game Thread 45ms is mostly ReflexSleep wait)
        for i in 0..10 {
            conn.execute(
                "INSERT INTO frames (idx, start_s, interval_ms, game_ms, render_ms, gpu_ms) VALUES (?1, ?2, 50.0, 48.0, 10.0, 50.0)",
                rusqlite::params![i, 20.0 + (i as f64 * 0.050)],
            ).unwrap();
        }

        // Insert threads: GameThread (id=1, role='game'), GPU (id=4, role='gpu')
        conn.execute("INSERT INTO threads (id, name, role) VALUES (1, 'GameThread', 'game'), (4, 'GPU', 'gpu')", []).unwrap();

        // Insert timers:
        // 10: ReflexSleep (kind='wait')
        // 20: FXSystemPreRender (kind='work', bucket='GPU')
        // 21: VirtualShadowMap (kind='work', bucket='GPU')
        conn.execute(
            "INSERT INTO timers (id, name, bucket, kind, path) VALUES
             (10, 'ReflexSleep', 'Synchronization', 'wait', 'ReflexSleep'),
             (20, 'FXSystemPreRender', 'GPU', 'work', 'SceneRender > FXSystemPreRender'),
             (21, 'VirtualShadowMap', 'GPU', 'work', 'SceneRender > VirtualShadowMap')",
            [],
        ).unwrap();

        for i in 0..10 {
            // GameThread: 40ms ReflexSleep + 8ms Game Work
            conn.execute(
                "INSERT INTO frame_timer (frame_idx, thread_id, timer_id, excl_ms, calls, max_ms) VALUES (?1, 1, 10, 40.0, 1, 40.0)",
                rusqlite::params![i],
            ).unwrap();
            // GPU: 30ms Niagara FX + 15ms VSM Shadows + 5ms BasePass
            conn.execute(
                "INSERT INTO frame_timer (frame_idx, thread_id, timer_id, excl_ms, calls, max_ms) VALUES
                 (?1, 4, 20, 30.0, 1, 30.0),
                 (?1, 4, 21, 15.0, 1, 15.0)",
                rusqlite::params![i],
            ).unwrap();
        }

        // Insert issues and occurrences for Niagara and Shadows
        conn.execute(
            "INSERT INTO issue (issue_id, rule_id, key_timer_id, thread_role, scale, first_frame, last_frame, occurrences_count, total_excess_ms, worst_excess_ms) VALUES
             (1, 'gpu-niagara-fx', 20, 'gpu', 'sustained', 0, 9, 1, 280.0, 50.0),
             (2, 'gpu-vsm-shadows', 21, 'gpu', 'sustained', 0, 9, 1, 130.0, 50.0)",
            [],
        ).unwrap();

        let ev_niagara = r#"{"timer":"FXSystemPreRender","path":"SceneRender > FXSystemPreRender","excessMs":280.0,"shareOfExcess":0.60,"callsPerFrame":1.0,"observedMsPerFrame":30.0,"baselineMsPerFrame":2.0,"sanityViolation":false}"#;
        let ev_vsm = r#"{"timer":"VirtualShadowMap","path":"SceneRender > VirtualShadowMap","excessMs":130.0,"shareOfExcess":0.30,"callsPerFrame":1.0,"observedMsPerFrame":15.0,"baselineMsPerFrame":2.0,"sanityViolation":false}"#;

        conn.execute(
            "INSERT INTO occurrence (occurrence_id, issue_id, chunk_id, frame_from, frame_to, start_s, end_s, peak_frame_ms, mean_excess_ms, sum_excess_ms, confidence, evidence_json) VALUES
             (101, 1, 0, 0, 9, 20.0, 20.5, 50.0, 28.0, 280.0, 'high', ?1),
             (102, 2, 0, 0, 9, 20.0, 20.5, 50.0, 13.0, 130.0, 'high', ?2)",
            rusqlite::params![ev_niagara, ev_vsm],
        ).unwrap();

        let stats = compute_range_statistics(&conn, 20.0, 20.5).unwrap();
        assert_eq!(stats.frame_count, 10);
        assert_eq!(stats.thread_medians.limiting_thread, "gpu", "Must attribute bottleneck to GPU despite ReflexSleep on GameThread");
        assert_eq!(stats.findings.len(), 2);

        let titles: Vec<String> = stats.findings.iter().map(|f| {
            let p: serde_json::Value = serde_json::from_str(&f.payload).unwrap();
            p["title"].as_str().unwrap().to_string()
        }).collect();

        assert!(titles.contains(&"GPU Niagara & Particle Simulation: FXSystemPreRender".to_string()));
        assert!(titles.contains(&"GPU Virtual Shadow Maps (VSM): VirtualShadowMap".to_string()));
    }

    #[test]
    fn test_range_clipping_recomputes_evidence_metrics() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();

        // 10 frames (0.0s to 0.5s, 50ms each)
        for i in 0..10 {
            conn.execute(
                "INSERT INTO frames (idx, start_s, interval_ms, game_ms, render_ms, gpu_ms) VALUES (?1, ?2, 50.0, 10.0, 10.0, 50.0)",
                rusqlite::params![i, i as f64 * 0.050],
            ).unwrap();
        }

        conn.execute("INSERT INTO threads (id, name, role) VALUES (4, 'GPU', 'gpu')", []).unwrap();
        conn.execute("INSERT INTO timers (id, name, bucket, kind, path) VALUES (20, 'FXSystemPreRender', 'GPU', 'work', 'FXSystemPreRender')", []).unwrap();
        conn.execute("INSERT INTO baseline_global (thread_id, timer_id, median_excl_ms, p95_excl_ms, median_calls, samples) VALUES (4, 20, 2.0, 2.0, 1, 10)", []).unwrap();

        for i in 0..10 {
            conn.execute(
                "INSERT INTO frame_timer (frame_idx, thread_id, timer_id, excl_ms, calls, max_ms) VALUES (?1, 4, 20, 30.0, 1, 30.0)",
                rusqlite::params![i],
            ).unwrap();
        }

        conn.execute(
            "INSERT INTO issue (issue_id, rule_id, key_timer_id, thread_role, scale, first_frame, last_frame, occurrences_count, total_excess_ms, worst_excess_ms) VALUES
             (1, 'gpu-niagara-fx', 20, 'gpu', 'sustained', 0, 9, 1, 280.0, 50.0)",
            [],
        ).unwrap();

        let ev_niagara = r#"{"timer":"FXSystemPreRender","path":"FXSystemPreRender","excessMs":280.0,"shareOfExcess":0.60,"callsPerFrame":1.0,"observedMsPerFrame":30.0,"baselineMsPerFrame":2.0,"sanityViolation":false}"#;
        conn.execute(
            "INSERT INTO occurrence (occurrence_id, issue_id, chunk_id, frame_from, frame_to, start_s, end_s, peak_frame_ms, mean_excess_ms, sum_excess_ms, confidence, evidence_json) VALUES
             (101, 1, 0, 0, 9, 0.0, 0.5, 50.0, 28.0, 280.0, 'high', ?1)",
            rusqlite::params![ev_niagara],
        ).unwrap();

        // Select half of the range: 0.0s to 0.24s (frames 0..4, 5 frames)
        let stats = compute_range_statistics(&conn, 0.0, 0.24).unwrap();
        assert_eq!(stats.frame_count, 5);
        assert_eq!(stats.findings.len(), 1);

        let p: serde_json::Value = serde_json::from_str(&stats.findings[0].payload).unwrap();
        assert_eq!(p["matchConfidence"], "high");
        let explains_ms = p["explainsMs"].as_f64().unwrap();
        // Excess is 28.0 ms/frame
        assert!((explains_ms - 28.0).abs() < 0.5);
    }

    #[test]
    fn test_low_explained_share_caps_likelihood() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();

        for i in 0..10 {
            conn.execute(
                "INSERT INTO frames (idx, start_s, interval_ms, game_ms, render_ms, gpu_ms) VALUES (?1, ?2, 60.0, 10.0, 10.0, 60.0)",
                rusqlite::params![i, i as f64 * 0.060],
            ).unwrap();
        }

        conn.execute("INSERT INTO threads (id, name, role) VALUES (4, 'GPU', 'gpu')", []).unwrap();
        conn.execute("INSERT INTO timers (id, name, bucket, kind, path) VALUES (20, 'SmallPass', 'GPU', 'work', 'SmallPass')", []).unwrap();
        conn.execute("INSERT INTO timers (id, name, bucket, kind, path) VALUES (21, 'MainPass', 'GPU', 'work', 'MainPass')", []).unwrap();
        conn.execute("INSERT INTO baseline_global (thread_id, timer_id, median_excl_ms, p95_excl_ms, median_calls, samples) VALUES (4, 20, 0.5, 0.5, 1, 10)", []).unwrap();
        conn.execute("INSERT INTO baseline_global (thread_id, timer_id, median_excl_ms, p95_excl_ms, median_calls, samples) VALUES (4, 21, 1.0, 1.0, 1, 10)", []).unwrap();

        for i in 0..10 {
            // SmallPass explains 2.0 ms excess
            conn.execute(
                "INSERT INTO frame_timer (frame_idx, thread_id, timer_id, excl_ms, calls, max_ms) VALUES (?1, 4, 20, 2.5, 1, 2.5)",
                rusqlite::params![i],
            ).unwrap();
            // MainPass explains 40.0 ms excess, so total GPU work excess = 42.0 ms
            conn.execute(
                "INSERT INTO frame_timer (frame_idx, thread_id, timer_id, excl_ms, calls, max_ms) VALUES (?1, 4, 21, 41.0, 1, 41.0)",
                rusqlite::params![i],
            ).unwrap();
        }

        conn.execute(
            "INSERT INTO issue (issue_id, rule_id, key_timer_id, thread_role, scale, first_frame, last_frame, occurrences_count, total_excess_ms, worst_excess_ms) VALUES
             (1, 'gpu-bound', 20, 'gpu', 'sustained', 0, 9, 1, 20.0, 60.0)",
            [],
        ).unwrap();

        let ev_small = r#"{"timer":"SmallPass","path":"SmallPass","excessMs":20.0,"shareOfExcess":0.05,"callsPerFrame":1.0,"observedMsPerFrame":2.5,"baselineMsPerFrame":0.5,"sanityViolation":false}"#;
        conn.execute(
            "INSERT INTO occurrence (occurrence_id, issue_id, chunk_id, frame_from, frame_to, start_s, end_s, peak_frame_ms, mean_excess_ms, sum_excess_ms, confidence, evidence_json) VALUES
             (101, 1, 0, 0, 9, 0.0, 0.6, 60.0, 2.0, 20.0, 'high', ?1)",
            rusqlite::params![ev_small],
        ).unwrap();

        let stats = compute_range_statistics(&conn, 0.0, 0.6).unwrap();
        assert_eq!(stats.findings.len(), 1);
        let p: serde_json::Value = serde_json::from_str(&stats.findings[0].payload).unwrap();

        // Share of excess is 2.0 / 42.0 = ~4.76% (< 10%) -> confidence is low
        assert_eq!(p["matchConfidence"], "low");
        // gpu-bound has fix_likelihood "high", lowered to at most one level above "low" -> "medium"
        assert_eq!(p["fixLikelihood"], "medium");
        assert_eq!(stats.findings[0].fix_likelihood, "medium");
    }

    #[test]
    fn test_issue_grouped_clipped_occurrences() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();

        for i in 0..20 {
            conn.execute(
                "INSERT INTO frames (idx, start_s, interval_ms, game_ms, render_ms, gpu_ms) VALUES (?1, ?2, 50.0, 10.0, 10.0, 50.0)",
                rusqlite::params![i, i as f64 * 0.050],
            ).unwrap();
        }

        conn.execute("INSERT INTO threads (id, name, role) VALUES (4, 'GPU', 'gpu')", []).unwrap();
        conn.execute("INSERT INTO timers (id, name, bucket, kind, path) VALUES (30, 'ShadowDepths', 'GPU', 'work', 'SceneRender > ShadowDepths')", []).unwrap();
        conn.execute("INSERT INTO baseline_global (thread_id, timer_id, median_excl_ms, p95_excl_ms, median_calls, samples) VALUES (4, 30, 1.0, 1.0, 1, 20)", []).unwrap();

        for i in 0..20 {
            conn.execute(
                "INSERT INTO frame_timer (frame_idx, thread_id, timer_id, excl_ms, calls, max_ms) VALUES (?1, 4, 30, 21.0, 6, 21.0)",
                rusqlite::params![i],
            ).unwrap();
        }

        // Single issue 1 with 2 occurrences: frames 0..5 and frames 10..15
        conn.execute(
            "INSERT INTO issue (issue_id, rule_id, key_timer_id, thread_role, scale, first_frame, last_frame, occurrences_count, total_excess_ms, worst_excess_ms) VALUES
             (1, 'gpu-shadow-views', 30, 'gpu', 'sustained', 0, 15, 2, 240.0, 50.0)",
            [],
        ).unwrap();

        let ev_shadow = r#"{"timer":"ShadowDepths","path":"SceneRender > ShadowDepths","excessMs":120.0,"shareOfExcess":0.60,"callsPerFrame":6.0,"observedMsPerFrame":21.0,"baselineMsPerFrame":1.0,"sanityViolation":false}"#;
        conn.execute(
            "INSERT INTO occurrence (occurrence_id, issue_id, chunk_id, frame_from, frame_to, start_s, end_s, peak_frame_ms, mean_excess_ms, sum_excess_ms, confidence, evidence_json) VALUES
             (201, 1, 0, 0, 5, 0.0, 0.3, 50.0, 20.0, 120.0, 'high', ?1),
             (202, 1, 0, 10, 15, 0.5, 0.8, 50.0, 20.0, 120.0, 'high', ?2)",
            rusqlite::params![ev_shadow, ev_shadow],
        ).unwrap();

        // Select range covering both occurrences (frames 0..19, 0.0s to 1.0s)
        let stats = compute_range_statistics(&conn, 0.0, 1.0).unwrap();

        // Must produce exactly 1 finding for issue 1 with both occurrences grouped
        assert_eq!(stats.findings.len(), 1);
        assert_eq!(stats.findings[0].id, 1);

        let p: serde_json::Value = serde_json::from_str(&stats.findings[0].payload).unwrap();
        let occurrences = p["occurrences"].as_array().unwrap();
        assert_eq!(occurrences.len(), 2);
        assert_eq!(occurrences[0]["occurrenceId"], 201);
        assert_eq!(occurrences[1]["occurrenceId"], 202);

        // Sub-occurrence excess is exactly 6 frames * 20.0 ms = 120.0 ms
        assert_eq!(occurrences[0]["excessMs"], 120.0);
        assert_eq!(occurrences[1]["excessMs"], 120.0);
    }

    #[test]
    fn test_scenario_s9_all_slow_sustained_gpu_absolute_cost() {
        // Test S9: every frame about 35 ms (no fast period), GPU SceneRender dominant.
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();

        for i in 0..30 {
            conn.execute(
                "INSERT INTO frames (idx, start_s, interval_ms, game_ms, render_ms, gpu_ms) VALUES (?1, ?2, 35.0, 10.0, 10.0, 35.0)",
                rusqlite::params![i, i as f64 * 0.035],
            ).unwrap();
        }

        conn.execute("INSERT INTO threads (id, name, role) VALUES (4, 'GPU', 'gpu')", []).unwrap();
        conn.execute("INSERT INTO timers (id, name, bucket, kind, path) VALUES (50, 'SceneRender', 'GPU', 'work', 'SceneRender')", []).unwrap();
        // Baseline matches observed (no fast period -> excess = 0)
        conn.execute("INSERT INTO baseline_global (thread_id, timer_id, median_excl_ms, p95_excl_ms, median_calls, samples) VALUES (4, 50, 30.0, 30.0, 1, 30)", []).unwrap();

        for i in 0..30 {
            conn.execute(
                "INSERT INTO frame_timer (frame_idx, thread_id, timer_id, excl_ms, calls, max_ms) VALUES (?1, 4, 50, 30.0, 1, 30.0)",
                rusqlite::params![i],
            ).unwrap();
        }

        let stats = compute_range_statistics(&conn, 0.0, 1.05).unwrap();
        assert_eq!(stats.frame_count, 30);
        assert!(stats.budget_gap_ms > 0.0, "Budget gap should be > 0 (35ms vs 16.6ms target)");
        assert_eq!(stats.findings.len(), 1, "Should produce absolute-cost finding");

        let f = &stats.findings[0];
        let p: serde_json::Value = serde_json::from_str(&f.payload).unwrap();
        assert_eq!(p["matchConfidence"], "medium");
        let ev_label = p["evidence"][0]["label"].as_str().unwrap();
        assert!(ev_label.contains("costs 30.0 ms/frame") || ev_label.contains("costs 30 ms/frame"), "Label was: {}", ev_label);
        assert!(ev_label.contains("no faster period in this capture to compare with"), "Label was: {}", ev_label);
    }

    #[test]
    fn test_scenario_steady_gpu_bound_after_fast_period() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();

        // 20 normal frames (16.6ms) + 20 slow frames (40ms)
        for i in 0..20 {
            conn.execute(
                "INSERT INTO frames (idx, start_s, interval_ms, game_ms, render_ms, gpu_ms) VALUES (?1, ?2, 16.6, 12.0, 10.0, 15.0)",
                rusqlite::params![i, i as f64 * 0.0166],
            ).unwrap();
        }
        for i in 20..40 {
            conn.execute(
                "INSERT INTO frames (idx, start_s, interval_ms, game_ms, render_ms, gpu_ms) VALUES (?1, ?2, 40.0, 12.0, 10.0, 38.0)",
                rusqlite::params![i, 0.332 + (i - 20) as f64 * 0.040],
            ).unwrap();
        }

        conn.execute("INSERT INTO threads (id, name, role) VALUES (4, 'GPU', 'gpu')", []).unwrap();
        conn.execute("INSERT INTO timers (id, name, bucket, kind, path) VALUES (60, 'LumenScreenProbeGather', 'GPU', 'work', 'LumenScreenProbeGather')", []).unwrap();
        conn.execute("INSERT INTO baseline_global (thread_id, timer_id, median_excl_ms, p95_excl_ms, median_calls, samples) VALUES (4, 60, 2.0, 2.0, 1, 20)", []).unwrap();

        for i in 0..20 {
            conn.execute("INSERT INTO frame_timer (frame_idx, thread_id, timer_id, excl_ms, calls, max_ms) VALUES (?1, 4, 60, 2.0, 1, 2.0)", rusqlite::params![i]).unwrap();
        }
        for i in 20..40 {
            conn.execute("INSERT INTO frame_timer (frame_idx, thread_id, timer_id, excl_ms, calls, max_ms) VALUES (?1, 4, 60, 25.0, 1, 25.0)", rusqlite::params![i]).unwrap();
        }

        conn.execute(
            "INSERT INTO issue (issue_id, rule_id, key_timer_id, thread_role, scale, first_frame, last_frame, occurrences_count, total_excess_ms, worst_excess_ms) VALUES
             (1, 'gpu-lumen', 60, 'gpu', 'sustained', 20, 39, 1, 460.0, 40.0)",
            [],
        ).unwrap();

        let ev_lumen = r#"{"timer":"LumenScreenProbeGather","path":"LumenScreenProbeGather","excessMs":460.0,"shareOfExcess":0.80,"callsPerFrame":1.0,"observedMsPerFrame":25.0,"baselineMsPerFrame":2.0,"sanityViolation":false}"#;
        conn.execute(
            "INSERT INTO occurrence (occurrence_id, issue_id, chunk_id, frame_from, frame_to, start_s, end_s, peak_frame_ms, mean_excess_ms, sum_excess_ms, confidence, evidence_json) VALUES
             (301, 1, 0, 20, 39, 0.332, 1.132, 40.0, 23.0, 460.0, 'high', ?1)",
            rusqlite::params![ev_lumen],
        ).unwrap();

        let stats = compute_range_statistics(&conn, 0.332, 1.132).unwrap();
        assert_eq!(stats.findings.len(), 1);
        let f = &stats.findings[0];
        assert_eq!(f.rule_id, "gpu-lumen");
        let p: serde_json::Value = serde_json::from_str(&f.payload).unwrap();
        assert_eq!(p["matchConfidence"], "high");
    }

    #[test]
    fn test_scenario_repeating_gc_hitch() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();

        for i in 0..100 {
            let interval = if i % 20 == 0 && i > 0 { 60.0 } else { 16.6 };
            let game_ms = if i % 20 == 0 && i > 0 { 55.0 } else { 12.0 };
            conn.execute(
                "INSERT INTO frames (idx, start_s, interval_ms, game_ms, render_ms, gpu_ms) VALUES (?1, ?2, ?3, ?4, 10.0, 10.0)",
                rusqlite::params![i, i as f64 * 0.0166, interval, game_ms],
            ).unwrap();
        }

        conn.execute("INSERT INTO threads (id, name, role) VALUES (1, 'GameThread', 'game')", []).unwrap();
        conn.execute("INSERT INTO timers (id, name, bucket, kind, path) VALUES (70, 'CollectGarbage', 'GC', 'work', 'CollectGarbage')", []).unwrap();
        conn.execute("INSERT INTO baseline_global (thread_id, timer_id, median_excl_ms, p95_excl_ms, median_calls, samples) VALUES (1, 70, 0.0, 0.0, 0, 96)", []).unwrap();

        for i in 0..100 {
            let gc_ms = if i % 20 == 0 && i > 0 { 40.0 } else { 0.0 };
            if gc_ms > 0.0 {
                conn.execute("INSERT INTO frame_timer (frame_idx, thread_id, timer_id, excl_ms, calls, max_ms) VALUES (?1, 1, 70, ?2, 1, ?2)", rusqlite::params![i, gc_ms]).unwrap();
            }
        }

        conn.execute(
            "INSERT INTO issue (issue_id, rule_id, key_timer_id, thread_role, scale, first_frame, last_frame, occurrences_count, total_excess_ms, worst_excess_ms) VALUES
             (1, 'gc-hitch', 70, 'game', 'spike', 20, 80, 4, 160.0, 60.0)",
            [],
        ).unwrap();

        let ev_gc = r#"{"timer":"CollectGarbage","path":"CollectGarbage","excessMs":160.0,"shareOfExcess":0.90,"callsPerFrame":1.0,"observedMsPerFrame":40.0,"baselineMsPerFrame":0.0,"sanityViolation":false}"#;
        conn.execute(
            "INSERT INTO occurrence (occurrence_id, issue_id, chunk_id, frame_from, frame_to, start_s, end_s, peak_frame_ms, mean_excess_ms, sum_excess_ms, confidence, evidence_json) VALUES
             (401, 1, 0, 20, 80, 0.33, 1.33, 60.0, 40.0, 160.0, 'high', ?1)",
            rusqlite::params![ev_gc],
        ).unwrap();

        let stats = compute_range_statistics(&conn, 0.0, 1.66).unwrap();
        assert_eq!(stats.findings.len(), 1);
        assert_eq!(stats.findings[0].rule_id, "gc-hitch");
    }

    #[test]
    fn test_scenario_within_budget_range_no_findings() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();

        // 50 smooth frames at 15.0ms (under 16.67ms target)
        for i in 0..50 {
            conn.execute(
                "INSERT INTO frames (idx, start_s, interval_ms, game_ms, render_ms, gpu_ms) VALUES (?1, ?2, 15.0, 10.0, 10.0, 14.0)",
                rusqlite::params![i, i as f64 * 0.015],
            ).unwrap();
        }

        let stats = compute_range_statistics(&conn, 0.0, 0.75).unwrap();
        assert_eq!(stats.frame_count, 50);
        assert_eq!(stats.budget_gap_ms, 0.0);
        assert_eq!(stats.over_budget_pct, 0.0);
        assert_eq!(stats.findings.len(), 0, "Smooth within-budget range should produce no findings");
    }
}
