use std::fs;
use std::path::{Path, PathBuf};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use crate::trace::csv_ingest::ProcessedFrame;

pub const SCHEMA_VERSION: i32 = 13;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FramePoint {
    pub t: f64,
    pub frame_ms: f64,
    pub game_ms: Option<f64>,
    pub render_ms: Option<f64>,
    pub gpu_ms: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FrameBucket {
    pub t0: f64,
    pub t1: f64,
    pub min_ms: f64,
    pub max_ms: f64,
    pub avg_ms: f64,
    pub count: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbEpisode {
    pub id: i64,
    pub kind: String, // "hitch" | "slow_region"
    pub start_s: f64,
    pub end_s: f64,
    pub frame_from: i64,
    pub frame_to: i64,
    pub peak_ms: f64,
    pub median_ms: f64,
    pub bound_by: String, // "game" | "render" | "rhi" | "gpu" | "idle_limited" | "unattributed"
    pub periodic_group: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbFrameTimer {
    pub frame_idx: i64,
    pub thread_id: i64,
    pub timer_id: i64,
    pub excl_ms: f64,
    pub calls: i64,
    pub max_ms: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbIndexSlice {
    pub slice_id: i64,
    pub frame_from: i64,
    pub frame_to: i64,
    pub start_s: f64,
    pub end_s: f64,
    pub state: String,
    pub rows: i64,
    pub export_ms: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbBaselineGlobal {
    pub thread_id: i64,
    pub timer_id: i64,
    pub median_excl_ms: f64,
    pub p95_excl_ms: f64,
    pub median_calls: f64,
    pub samples: i64,
    pub present_frames: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbBlockProfile {
    pub level: i32,
    pub block_idx: i64,
    pub thread_id: i64,
    pub timer_id: i64,
    pub sum_excl_ms: f64,
    pub sum_calls: i64,
    pub normal_frames: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbBlockFrames {
    pub level: i32,
    pub block_idx: i64,
    pub frames: i64,
    pub spike_frames: i64,
    pub sum_frame_ms: f64,
    pub over_budget_frames: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbIssue {
    pub issue_id: i64,
    pub rule_id: String,
    pub key_timer_id: i64,
    pub thread_role: String,
    pub scale: String, // "spike" | "sustained"
    pub first_frame: i64,
    pub last_frame: i64,
    pub occurrences_count: i64,
    pub total_excess_ms: f64,
    pub worst_excess_ms: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbOccurrence {
    pub occurrence_id: i64,
    pub issue_id: i64,
    pub chunk_id: i64,
    pub frame_from: i64,
    pub frame_to: i64,
    pub start_s: f64,
    pub end_s: f64,
    pub peak_frame_ms: f64,
    pub mean_excess_ms: f64,
    pub sum_excess_ms: f64,
    pub confidence: String,
    pub evidence_json: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbChunkState {
    pub chunk_id: i64,
    pub state: String, // "queued" | "running" | "done"
    pub frame_from: i64,
    pub frame_to: i64,
    pub done_at: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbFinding {
    pub id: i64,
    pub rule_id: String,
    pub rank: f64,
    pub match_confidence: f64,
    pub fix_likelihood: String,
    pub episode_ids: Vec<i64>,
    pub payload: String, // JSON payload containing evidence, fixes, etc.
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TraceBookmark {
    pub id: i64,
    pub name: String,
    pub start_s: f64,
    pub duration_s: f64,
    pub thread_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo {
    pub total_files: usize,
    pub total_size_bytes: u64,
    pub cache_dir: String,
}

pub fn get_cache_dir(app_data_dir: &Path) -> Result<PathBuf, String> {
    let cache_dir = app_data_dir.join("trace_cache");
    if !cache_dir.exists() {
        fs::create_dir_all(&cache_dir)
            .map_err(|e| format!("Failed to create trace cache dir: {}", e))?;
    }
    Ok(cache_dir)
}

pub fn compute_cache_key(
    canonical_path: &Path,
    size_bytes: u64,
    modified_time_sec: u64,
    engine_version: &str,
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(canonical_path.to_string_lossy().to_lowercase().as_bytes());
    hasher.update(&size_bytes.to_le_bytes());
    hasher.update(&modified_time_sec.to_le_bytes());
    hasher.update(&SCHEMA_VERSION.to_le_bytes());
    hasher.update(engine_version.as_bytes());
    hasher.finalize().to_hex().to_string()
}

pub fn get_cache_db_path(app_data_dir: &Path, cache_key: &str) -> Result<PathBuf, String> {
    let cache_dir = get_cache_dir(app_data_dir)?;
    Ok(cache_dir.join(format!("{}.db", cache_key)))
}

pub fn init_db(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;

        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS threads (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            role TEXT
        );

        CREATE TABLE IF NOT EXISTS timers (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            bucket TEXT,
            kind TEXT,
            parent_id INTEGER,
            path TEXT
        );

        CREATE TABLE IF NOT EXISTS frames (
            idx INTEGER PRIMARY KEY,
            engine_frame INTEGER,
            start_s REAL NOT NULL,
            interval_ms REAL NOT NULL,
            game_ms REAL,
            render_ms REAL,
            gpu_ms REAL
        );
        CREATE INDEX IF NOT EXISTS idx_frames_start ON frames(start_s);

        CREATE TABLE IF NOT EXISTS frame_timer (
            frame_idx INTEGER NOT NULL,
            thread_id INTEGER NOT NULL,
            timer_id INTEGER NOT NULL,
            excl_ms REAL NOT NULL,
            calls INTEGER NOT NULL,
            max_ms REAL NOT NULL,
            PRIMARY KEY(frame_idx, thread_id, timer_id)
        );
        CREATE INDEX IF NOT EXISTS idx_frame_timer_thread ON frame_timer(thread_id, timer_id);

        CREATE TABLE IF NOT EXISTS index_slices (
            slice_id INTEGER PRIMARY KEY,
            frame_from INTEGER NOT NULL,
            frame_to INTEGER NOT NULL,
            start_s REAL NOT NULL,
            end_s REAL NOT NULL,
            state TEXT NOT NULL,
            rows INTEGER NOT NULL,
            export_ms REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS baseline_global (
            thread_id INTEGER NOT NULL,
            timer_id INTEGER NOT NULL,
            median_excl_ms REAL NOT NULL,
            p95_excl_ms REAL NOT NULL,
            median_calls REAL NOT NULL,
            samples INTEGER NOT NULL,
            present_frames INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(thread_id, timer_id)
        );

        CREATE TABLE IF NOT EXISTS block_profile (
            level INTEGER NOT NULL,
            block_idx INTEGER NOT NULL,
            thread_id INTEGER NOT NULL,
            timer_id INTEGER NOT NULL,
            sum_excl_ms REAL NOT NULL,
            sum_calls INTEGER NOT NULL,
            normal_frames INTEGER NOT NULL,
            PRIMARY KEY(level, block_idx, thread_id, timer_id)
        );

        CREATE TABLE IF NOT EXISTS block_frames (
            level INTEGER NOT NULL,
            block_idx INTEGER NOT NULL,
            frames INTEGER NOT NULL,
            spike_frames INTEGER NOT NULL,
            sum_frame_ms REAL NOT NULL,
            over_budget_frames INTEGER NOT NULL,
            PRIMARY KEY(level, block_idx)
        );

        CREATE TABLE IF NOT EXISTS issue (
            issue_id INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_id TEXT NOT NULL,
            key_timer_id INTEGER NOT NULL,
            thread_role TEXT NOT NULL,
            scale TEXT NOT NULL,
            first_frame INTEGER NOT NULL,
            last_frame INTEGER NOT NULL,
            occurrences_count INTEGER NOT NULL,
            total_excess_ms REAL NOT NULL,
            worst_excess_ms REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS occurrence (
            occurrence_id INTEGER PRIMARY KEY AUTOINCREMENT,
            issue_id INTEGER NOT NULL REFERENCES issue(issue_id),
            chunk_id INTEGER NOT NULL,
            frame_from INTEGER NOT NULL,
            frame_to INTEGER NOT NULL,
            start_s REAL NOT NULL DEFAULT 0.0,
            end_s REAL NOT NULL DEFAULT 0.0,
            peak_frame_ms REAL NOT NULL,
            mean_excess_ms REAL NOT NULL,
            sum_excess_ms REAL NOT NULL,
            confidence TEXT NOT NULL,
            evidence_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_occurrence_chunk ON occurrence(chunk_id);
        CREATE INDEX IF NOT EXISTS idx_occurrence_frames ON occurrence(frame_from, frame_to);

        CREATE TABLE IF NOT EXISTS chunk_state (
            chunk_id INTEGER PRIMARY KEY,
            state TEXT NOT NULL,
            frame_from INTEGER NOT NULL,
            frame_to INTEGER NOT NULL,
            done_at REAL
        );

        CREATE TABLE IF NOT EXISTS episodes (
            id INTEGER PRIMARY KEY,
            kind TEXT NOT NULL,
            start_s REAL NOT NULL,
            end_s REAL NOT NULL,
            frame_from INTEGER,
            frame_to INTEGER,
            peak_ms REAL,
            median_ms REAL,
            bound_by TEXT,
            periodic_group INTEGER
        );

        CREATE TABLE IF NOT EXISTS findings (
            id INTEGER PRIMARY KEY,
            rule_id TEXT NOT NULL,
            rank REAL NOT NULL,
            match_confidence REAL NOT NULL,
            fix_likelihood TEXT NOT NULL,
            episode_ids TEXT NOT NULL,
            payload TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS bookmarks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            start_s REAL NOT NULL,
            duration_s REAL NOT NULL,
            thread_id INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_bookmarks_start ON bookmarks(start_s);
        ",
    )?;
    Ok(())
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        params![key, value],
    )?;
    Ok(())
}

pub fn get_meta(conn: &Connection, key: &str) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        "SELECT value FROM meta WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
}

pub fn get_cache_info(app_data_dir: &Path) -> Result<CacheInfo, String> {
    let cache_dir = get_cache_dir(app_data_dir)?;
    let mut total_files = 0;
    let mut total_size_bytes = 0;

    if let Ok(entries) = fs::read_dir(&cache_dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    total_files += 1;
                    total_size_bytes += meta.len();
                }
            }
        }
    }

    Ok(CacheInfo {
        total_files,
        total_size_bytes,
        cache_dir: cache_dir.to_string_lossy().to_string(),
    })
}

pub fn clear_cache(app_data_dir: &Path, specific_key: Option<&str>) -> Result<(), String> {
    let cache_dir = get_cache_dir(app_data_dir)?;
    if let Some(key) = specific_key {
        let db_path = cache_dir.join(format!("{}.db", key));
        if db_path.exists() {
            let _ = fs::remove_file(&db_path);
            let _ = fs::remove_file(cache_dir.join(format!("{}.db-wal", key)));
            let _ = fs::remove_file(cache_dir.join(format!("{}.db-shm", key)));
        }
        let temp_dir = app_data_dir.join("temp_trace").join(key);
        if temp_dir.exists() {
            let _ = fs::remove_dir_all(&temp_dir);
        }
    } else {
        if let Ok(entries) = fs::read_dir(&cache_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let _ = fs::remove_file(path);
                }
            }
        }
        let temp_trace_dir = app_data_dir.join("temp_trace");
        if temp_trace_dir.exists() {
            let _ = fs::remove_dir_all(&temp_trace_dir);
        }
    }
    Ok(())
}

pub fn query_frame_points(
    conn: &Connection,
    start_s: f64,
    end_s: f64,
    max_items: usize,
) -> Result<Vec<FramePoint>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT start_s, interval_ms, game_ms, render_ms, gpu_ms 
         FROM frames 
         WHERE start_s >= ?1 AND start_s <= ?2 
         ORDER BY start_s ASC 
         LIMIT ?3",
    )?;

    let rows = stmt.query_map(params![start_s, end_s, max_items as i64], |row| {
        Ok(FramePoint {
            t: row.get(0)?,
            frame_ms: row.get(1)?,
            game_ms: row.get(2)?,
            render_ms: row.get(3)?,
            gpu_ms: row.get(4)?,
        })
    })?;

    let mut points = Vec::new();
    for r in rows {
        points.push(r?);
    }
    Ok(points)
}

pub fn query_frame_buckets(
    conn: &Connection,
    start_s: f64,
    end_s: f64,
    bucket_count: usize,
) -> Result<Vec<FrameBucket>, rusqlite::Error> {
    if bucket_count == 0 || end_s <= start_s {
        return Ok(Vec::new());
    }

    let bucket_duration = (end_s - start_s) / (bucket_count as f64);
    let mut stmt = conn.prepare(
        "SELECT 
            CAST((start_s - ?1) / ?2 AS INTEGER) AS b_idx,
            MIN(interval_ms),
            MAX(interval_ms),
            AVG(interval_ms),
            COUNT(*)
         FROM frames
         WHERE start_s >= ?1 AND start_s <= ?3
         GROUP BY b_idx
         ORDER BY b_idx ASC",
    )?;

    let rows = stmt.query_map(params![start_s, bucket_duration, end_s], |row| {
        let b_idx: i64 = row.get(0)?;
        let t0 = start_s + (b_idx as f64) * bucket_duration;
        let t1 = t0 + bucket_duration;
        let min_ms: f64 = row.get(1)?;
        let max_ms: f64 = row.get(2)?;
        let avg_ms: f64 = row.get(3)?;
        let count: i64 = row.get(4)?;

        Ok(FrameBucket {
            t0,
            t1,
            min_ms,
            max_ms,
            avg_ms,
            count: count as usize,
        })
    })?;

    let mut buckets = Vec::new();
    for r in rows {
        buckets.push(r?);
    }
    Ok(buckets)
}

pub fn query_all_processed_frames(conn: &Connection) -> Result<Vec<ProcessedFrame>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT idx, engine_frame, start_s, interval_ms, game_ms, render_ms, gpu_ms 
         FROM frames 
         ORDER BY idx ASC",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(ProcessedFrame {
            idx: row.get(0)?,
            engine_frame: row.get(1)?,
            start_s: row.get(2)?,
            interval_ms: row.get(3)?,
            game_ms: row.get(4)?,
            render_ms: row.get(5)?,
            gpu_ms: row.get(6)?,
        })
    })?;

    let mut frames = Vec::new();
    for r in rows {
        frames.push(r?);
    }
    Ok(frames)
}

pub fn query_episodes(conn: &Connection) -> Result<Vec<DbEpisode>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, start_s, end_s, frame_from, frame_to, peak_ms, median_ms, bound_by, periodic_group 
         FROM episodes ORDER BY start_s ASC",
    )?;

    let rows = stmt.query_map([], |row| {
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
    })?;

    let mut episodes = Vec::new();
    for r in rows {
        episodes.push(r?);
    }
    Ok(episodes)
}

pub fn query_findings(conn: &Connection) -> Result<Vec<DbFinding>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, rule_id, rank, match_confidence, fix_likelihood, episode_ids, payload 
         FROM findings ORDER BY rank DESC",
    )?;

    let rows = stmt.query_map([], |row| {
        let ep_ids_raw: String = row.get(5)?;
        let ep_ids: Vec<i64> = serde_json::from_str(&ep_ids_raw).unwrap_or_default();
        Ok(DbFinding {
            id: row.get(0)?,
            rule_id: row.get(1)?,
            rank: row.get(2)?,
            match_confidence: row.get(3)?,
            fix_likelihood: row.get(4)?,
            episode_ids: ep_ids,
            payload: row.get(6)?,
        })
    })?;

    let mut findings = Vec::new();
    for r in rows {
        findings.push(r?);
    }
    Ok(findings)
}

pub fn query_bookmarks(conn: &Connection) -> Result<Vec<TraceBookmark>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT b.id, b.name, b.start_s, b.duration_s, t.name as thread_name
         FROM bookmarks b
         LEFT JOIN threads t ON b.thread_id = t.id
         ORDER BY b.start_s ASC",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(TraceBookmark {
            id: row.get(0)?,
            name: row.get(1)?,
            start_s: row.get(2)?,
            duration_s: row.get(3)?,
            thread_name: row.get(4)?,
        })
    })?;

    let mut raw_bookmarks = Vec::new();
    for r in rows {
        let bm: TraceBookmark = r?;
        if !crate::trace::csv_ingest::is_valid_bookmark(&bm.name, bm.start_s) {
            continue;
        }
        raw_bookmarks.push(bm);
    }

    let mut bookmarks: Vec<TraceBookmark> = Vec::new();
    for bm in raw_bookmarks {
        let bm_lower = bm.name.to_ascii_lowercase();
        let mut merged = false;
        for existing in bookmarks.iter_mut().rev() {
            if (bm.start_s - existing.start_s).abs() > 0.1 {
                break;
            }
            if existing.name.to_ascii_lowercase() == bm_lower {
                existing.duration_s = existing.duration_s.max(bm.duration_s);
                if existing.thread_name.is_none() && bm.thread_name.is_some() {
                    existing.thread_name = bm.thread_name.clone();
                }
                merged = true;
                break;
            }
        }
        if !merged {
            bookmarks.push(bm);
        }
    }

    Ok(bookmarks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cache_info_and_clear_cache() {
        let unique_name = format!("test_cache_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        let app_data_dir = std::env::temp_dir().join(unique_name);
        fs::create_dir_all(&app_data_dir).unwrap();

        let cache_dir = get_cache_dir(&app_data_dir).unwrap();
        assert!(cache_dir.is_dir());

        // Create sample db files
        let db1 = cache_dir.join("key1.db");
        let db1_wal = cache_dir.join("key1.db-wal");
        let db2 = cache_dir.join("key2.db");
        fs::write(&db1, b"sample db 1 content").unwrap();
        fs::write(&db1_wal, b"wal").unwrap();
        fs::write(&db2, b"sample db 2 content").unwrap();

        let info = get_cache_info(&app_data_dir).unwrap();
        assert_eq!(info.total_files, 3);
        assert!(info.total_size_bytes > 0);

        // Clear specific key
        clear_cache(&app_data_dir, Some("key1")).unwrap();
        assert!(!db1.exists());
        assert!(!db1_wal.exists());
        assert!(db2.exists());

        // Clear all
        clear_cache(&app_data_dir, None).unwrap();
        assert!(!db2.exists());
        let info_after = get_cache_info(&app_data_dir).unwrap();
        assert_eq!(info_after.total_files, 0);
        assert_eq!(info_after.total_size_bytes, 0);

        let _ = fs::remove_dir_all(&app_data_dir);
    }
}
