use std::collections::HashMap;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::trace::rules::{load_compiled_rules, CompiledRule};
use crate::trace::store::{DbIssue, DbOccurrence};

pub const CHUNK_SIZE_FRAMES: usize = 512;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IssueWithOccurrences {
    pub issue: DbIssue,
    pub occurrences: Vec<DbOccurrence>,
}

#[derive(Debug, Clone)]
pub struct EvaluatedOccurrence {
    pub rule_id: String,
    pub key_timer_id: i64,
    pub thread_role: String,
    pub scale: String, // "spike" | "sustained"
    pub frame_from: i64,
    pub frame_to: i64,
    pub peak_frame_ms: f64,
    pub mean_excess_ms: f64,
    pub sum_excess_ms: f64,
    pub confidence: String,
    pub evidence_json: String,
}

pub struct FrameItem {
    pub idx: i64,
    pub interval_ms: f64,
    pub game_ms: f64,
    pub render_ms: f64,
    pub gpu_ms: f64,
}

pub struct TimerItem {
    pub thread_id: i64,
    pub timer_id: i64,
    pub excl_ms: f64,
    pub calls: i64,
    pub max_ms: f64,
}

pub fn init_chunk_states(conn: &mut Connection, total_frames: usize) -> Result<(), String> {
    if total_frames == 0 {
        return Ok(());
    }

    let num_chunks = (total_frames + CHUNK_SIZE_FRAMES - 1) / CHUNK_SIZE_FRAMES;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        // Reset any running states back to queued (crash recovery)
        tx.execute("UPDATE chunk_state SET state = 'queued' WHERE state = 'running'", [])
            .map_err(|e| e.to_string())?;

        let mut stmt = tx
            .prepare(
                "INSERT OR IGNORE INTO chunk_state (chunk_id, state, frame_from, frame_to, done_at)
                 VALUES (?1, 'queued', ?2, ?3, NULL)",
            )
            .map_err(|e| e.to_string())?;

        for c_idx in 0..num_chunks {
            let f_from = (c_idx * CHUNK_SIZE_FRAMES) as i64;
            let f_to = ((f_from as usize + CHUNK_SIZE_FRAMES).min(total_frames) - 1) as i64;
            stmt.execute(params![c_idx as i64, f_from, f_to])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(())
}

pub fn diagnose_chunk(
    conn: &mut Connection,
    chunk_id: i64,
    target_fps: f64,
) -> Result<usize, String> {
    let chunk_info: Option<(i64, i64)> = conn
        .query_row(
            "SELECT frame_from, frame_to FROM chunk_state WHERE chunk_id = ?1",
            params![chunk_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();

    let (frame_from, frame_to) = match chunk_info {
        Some(info) => info,
        None => return Err(format!("Chunk {} not found", chunk_id)),
    };

    let target_ms = 1000.0 / target_fps;

    // Load global baselines: (thread_id, timer_id) -> (median_ms, p95_ms, median_calls)
    let mut baselines: HashMap<(i64, i64), (f64, f64, f64)> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT thread_id, timer_id, median_excl_ms, p95_excl_ms, median_calls FROM baseline_global")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, f64>(2)?,
                    r.get::<_, f64>(3)?,
                    r.get::<_, f64>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rows.flatten() {
            baselines.insert((r.0, r.1), (r.2, r.3, r.4));
        }
    }

    // Load timer metadata
    let mut timer_meta: HashMap<i64, (String, String, String)> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, name, bucket, kind FROM timers")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rows.flatten() {
            timer_meta.insert(r.0, (r.1, r.2, r.3));
        }
    }

    // Load thread metadata
    let mut thread_roles: HashMap<i64, String> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, role FROM threads")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?)))
            .map_err(|e| e.to_string())?;
        for r in rows.flatten() {
            thread_roles.insert(r.0, r.1.unwrap_or_else(|| "game".to_string()));
        }
    }

    // Load frames in chunk context: [frame_from - 5, frame_to + 5]
    let ctx_from = (frame_from - 5).max(0);
    let ctx_to = frame_to + 5;

    let mut frames_map: HashMap<i64, FrameItem> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT idx, interval_ms, COALESCE(game_ms, 0.0), COALESCE(render_ms, 0.0), COALESCE(gpu_ms, 0.0) FROM frames WHERE idx >= ?1 AND idx <= ?2")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![ctx_from, ctx_to], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, f64>(1)?,
                    r.get::<_, f64>(2)?,
                    r.get::<_, f64>(3)?,
                    r.get::<_, f64>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rows.flatten() {
            frames_map.insert(
                r.0,
                FrameItem {
                    idx: r.0,
                    interval_ms: r.1,
                    game_ms: r.2,
                    render_ms: r.3,
                    gpu_ms: r.4,
                },
            );
        }
    }

    // Load frame_timer rows in context
    let mut frame_timers: HashMap<i64, Vec<TimerItem>> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT frame_idx, thread_id, timer_id, excl_ms, calls, max_ms FROM frame_timer WHERE frame_idx >= ?1 AND frame_idx <= ?2")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![ctx_from, ctx_to], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, f64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, f64>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rows.flatten() {
            frame_timers.entry(r.0).or_default().push(TimerItem {
                thread_id: r.1,
                timer_id: r.2,
                excl_ms: r.3,
                calls: r.4,
                max_ms: r.5,
            });
        }
    }

    let rules = load_compiled_rules();
    let mut raw_occurrences: Vec<EvaluatedOccurrence> = Vec::new();

    // 1. Per-frame test & Spike Analyzer (adjacent flagged frames with [first - 1, last + 3] context)
    let mut curr_spike_frames: Vec<i64> = Vec::new();

    for f_idx in frame_from..=frame_to {
        let f_item = match frames_map.get(&f_idx) {
            Some(f) => f,
            None => continue,
        };

        let is_over_budget = f_item.interval_ms > target_ms * 1.25;
        let mut has_timer_excess = false;

        if let Some(timers) = frame_timers.get(&f_idx) {
            for t in timers {
                let (base_ms, _, _) = baselines.get(&(t.thread_id, t.timer_id)).copied().unwrap_or((0.0, 0.0, 1.0));
                if t.excl_ms - base_ms >= 2.0 {
                    has_timer_excess = true;
                    break;
                }
            }
        }

        if is_over_budget || has_timer_excess {
            curr_spike_frames.push(f_idx);
        } else if !curr_spike_frames.is_empty() {
            // Process spike episode
            process_spike_episode(
                &curr_spike_frames,
                &frames_map,
                &frame_timers,
                &baselines,
                &timer_meta,
                &thread_roles,
                &rules,
                &mut raw_occurrences,
            );
            curr_spike_frames.clear();
        }
    }

    if !curr_spike_frames.is_empty() {
        process_spike_episode(
            &curr_spike_frames,
            &frames_map,
            &frame_timers,
            &baselines,
            &timer_meta,
            &thread_roles,
            &rules,
            &mut raw_occurrences,
        );
    }

    // 2. Sustained Analyzer: rolling window of ~120 frames (approx 2s at 60fps), hop of 30 frames
    let window_size = 120;
    let hop_size = 30;
    let mut w_start = frame_from;

    while w_start <= frame_to {
        let w_end = (w_start + window_size as i64 - 1).min(frame_to);
        if w_end - w_start + 1 >= 30 {
            process_sustained_window(
                w_start,
                w_end,
                target_ms,
                &frames_map,
                &frame_timers,
                &baselines,
                &timer_meta,
                &thread_roles,
                &rules,
                &mut raw_occurrences,
            );
        }
        w_start += hop_size as i64;
    }

    // 3. Merge intra-chunk occurrences with same signature and gap tolerance
    let merged_occurrences = merge_intra_chunk_occurrences(raw_occurrences);

    // 4. Save atomically to SQLite
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        // Delete previous occurrences for this chunk
        tx.execute("DELETE FROM occurrence WHERE chunk_id = ?1", params![chunk_id])
            .map_err(|e| e.to_string())?;

        let mut insert_occ = tx
            .prepare(
                "INSERT INTO occurrence (issue_id, chunk_id, frame_from, frame_to, peak_frame_ms, mean_excess_ms, sum_excess_ms, confidence, evidence_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )
            .map_err(|e| e.to_string())?;

        for occ in &merged_occurrences {
            // Find or create issue
            let issue_id: i64 = match tx.query_row(
                "SELECT issue_id FROM issue WHERE rule_id = ?1 AND key_timer_id = ?2 AND thread_role = ?3 AND scale = ?4",
                params![occ.rule_id, occ.key_timer_id, occ.thread_role, occ.scale],
                |r| r.get(0),
            ) {
                Ok(id) => {
                    tx.execute(
                        "UPDATE issue SET 
                            last_frame = MAX(last_frame, ?2), 
                            first_frame = MIN(first_frame, ?3),
                            occurrences_count = occurrences_count + 1,
                            total_excess_ms = total_excess_ms + ?4,
                            worst_excess_ms = MAX(worst_excess_ms, ?5)
                         WHERE issue_id = ?1",
                        params![id, occ.frame_to, occ.frame_from, occ.sum_excess_ms, occ.peak_frame_ms],
                    ).map_err(|e| e.to_string())?;
                    id
                }
                Err(_) => {
                    tx.execute(
                        "INSERT INTO issue (rule_id, key_timer_id, thread_role, scale, first_frame, last_frame, occurrences_count, total_excess_ms, worst_excess_ms)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8)",
                        params![
                            occ.rule_id,
                            occ.key_timer_id,
                            occ.thread_role,
                            occ.scale,
                            occ.frame_from,
                            occ.frame_to,
                            occ.sum_excess_ms,
                            occ.peak_frame_ms,
                        ],
                    ).map_err(|e| e.to_string())?;
                    tx.last_insert_rowid()
                }
            };

            insert_occ
                .execute(params![
                    issue_id,
                    chunk_id,
                    occ.frame_from,
                    occ.frame_to,
                    occ.peak_frame_ms,
                    occ.mean_excess_ms,
                    occ.sum_excess_ms,
                    occ.confidence,
                    occ.evidence_json,
                ])
                .map_err(|e| e.to_string())?;
        }

        let now_s = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();

        tx.execute(
            "UPDATE chunk_state SET state = 'done', done_at = ?2 WHERE chunk_id = ?1",
            params![chunk_id, now_s],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    // 5. Cross-chunk boundary stitching
    let _ = stitch_chunk_boundaries(conn, chunk_id);

    Ok(merged_occurrences.len())
}

fn process_spike_episode(
    spike_frames: &[i64],
    frames_map: &HashMap<i64, FrameItem>,
    frame_timers: &HashMap<i64, Vec<TimerItem>>,
    baselines: &HashMap<(i64, i64), (f64, f64, f64)>,
    timer_meta: &HashMap<i64, (String, String, String)>,
    thread_roles: &HashMap<i64, String>,
    rules: &[CompiledRule],
    output: &mut Vec<EvaluatedOccurrence>,
) {
    if spike_frames.is_empty() {
        return;
    }

    let first_f = *spike_frames.first().unwrap();
    let last_f = *spike_frames.last().unwrap();

    let ctx_from = (first_f - 1).max(0);
    let ctx_to = last_f + 3;

    let mut peak_frame_ms = 0.0f64;
    let mut total_excess_ms = 0.0f64;

    let mut timer_excess_map: HashMap<(i64, i64), f64> = HashMap::new();

    for f_idx in ctx_from..=ctx_to {
        if let Some(f) = frames_map.get(&f_idx) {
            peak_frame_ms = peak_frame_ms.max(f.interval_ms);
        }
        if let Some(timers) = frame_timers.get(&f_idx) {
            for t in timers {
                let (base_ms, _, _) = baselines.get(&(t.thread_id, t.timer_id)).copied().unwrap_or((0.0, 0.0, 1.0));
                let excess = (t.excl_ms - base_ms).max(0.0);
                if excess > 0.0 {
                    *timer_excess_map.entry((t.thread_id, t.timer_id)).or_insert(0.0) += excess;
                    total_excess_ms += excess;
                }
            }
        }
    }

    if total_excess_ms < 2.0 {
        return;
    }

    // Separate active work timers from idle/sync wait timers
    let mut work_timers: Vec<((i64, i64), f64)> = Vec::new();
    let mut wait_timers: Vec<((i64, i64), f64)> = Vec::new();

    for ((th_id, timer_id), excess) in timer_excess_map {
        let (timer_name, bucket, kind) = timer_meta.get(&timer_id).cloned().unwrap_or_else(|| ("Other".to_string(), "Other".to_string(), "work".to_string()));
        let role = thread_roles.get(&th_id).map(|s| s.as_str()).unwrap_or("game");

        let lower = timer_name.to_lowercase();
        let is_gpu_wait = lower.contains("reflex") || lower.contains("lowlatencysleep") || lower.contains("gpuwait") || lower.contains("rendercommandfence");

        if role == "gpu" || bucket == "GPU" {
            work_timers.push(((th_id, timer_id), excess));
        } else if is_gpu_wait || kind == "idle" {
            // Ignore idle sleep / GPU sync wait from active CPU culprit ranking
            continue;
        } else if kind == "wait" {
            wait_timers.push(((th_id, timer_id), excess));
        } else {
            work_timers.push(((th_id, timer_id), excess));
        }
    }

    work_timers.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    wait_timers.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let selected_timers = if !work_timers.is_empty() {
        work_timers.into_iter().take(2).collect::<Vec<_>>()
    } else {
        wait_timers.into_iter().take(2).collect::<Vec<_>>()
    };

    for ((th_id, timer_id), excess) in selected_timers {
        let (timer_name, bucket, kind) = timer_meta.get(&timer_id).cloned().unwrap_or_else(|| ("Other".to_string(), "Other".to_string(), "work".to_string()));
        let role = thread_roles.get(&th_id).cloned().unwrap_or_else(|| "game".to_string());

        let matched_rule = rules.iter().find(|r| {
            let role_ok = r.def.when.threads.is_empty() || r.def.when.threads.iter().any(|t| t == &role || (t == "cpu" && (role == "game" || role == "render" || role == "rhi")));
            role_ok && r.regexes.iter().any(|re| re.is_match(&timer_name))
        });

        let rule_id = matched_rule.map(|r| r.def.id.clone()).unwrap_or_else(|| {
            if role == "gpu" || bucket == "GPU" {
                "gpu-bound".to_string()
            } else if role == "render" || role == "rhi" {
                "render-cpu".to_string()
            } else if kind == "wait" {
                "taskgraph-wait".to_string()
            } else {
                "cpu-hitch".to_string()
            }
        });
        let count = (last_f - first_f + 1).max(1) as f64;

        output.push(EvaluatedOccurrence {
            rule_id,
            key_timer_id: timer_id,
            thread_role: role,
            scale: "spike".to_string(),
            frame_from: first_f,
            frame_to: last_f,
            peak_frame_ms,
            mean_excess_ms: excess / count,
            sum_excess_ms: excess,
            confidence: if excess >= 10.0 { "high".to_string() } else { "medium".to_string() },
            evidence_json: format!(r#"{{"timer":"{}","excessMs":{:.2}}}"#, timer_name, excess),
        });
    }
}

fn process_sustained_window(
    w_start: i64,
    w_end: i64,
    target_ms: f64,
    frames_map: &HashMap<i64, FrameItem>,
    frame_timers: &HashMap<i64, Vec<TimerItem>>,
    baselines: &HashMap<(i64, i64), (f64, f64, f64)>,
    timer_meta: &HashMap<i64, (String, String, String)>,
    thread_roles: &HashMap<i64, String>,
    rules: &[CompiledRule],
    output: &mut Vec<EvaluatedOccurrence>,
) {
    let frame_count = (w_end - w_start + 1) as f64;
    let mut sum_frame_ms = 0.0f64;
    let mut peak_frame_ms = 0.0f64;

    let mut timer_excess_map: HashMap<(i64, i64), f64> = HashMap::new();

    for f_idx in w_start..=w_end {
        if let Some(f) = frames_map.get(&f_idx) {
            sum_frame_ms += f.interval_ms;
            peak_frame_ms = peak_frame_ms.max(f.interval_ms);
        }
        if let Some(timers) = frame_timers.get(&f_idx) {
            for t in timers {
                let (base_ms, _, _) = baselines.get(&(t.thread_id, t.timer_id)).copied().unwrap_or((0.0, 0.0, 1.0));
                let excess = (t.excl_ms - base_ms).max(0.0);
                if excess > 0.0 {
                    *timer_excess_map.entry((t.thread_id, t.timer_id)).or_insert(0.0) += excess;
                }
            }
        }
    }

    let avg_frame_ms = sum_frame_ms / frame_count;
    if avg_frame_ms <= target_ms * 1.05 {
        return; // Steady and on-budget
    }

    let mut work_timers: Vec<((i64, i64), f64)> = Vec::new();
    let mut wait_timers: Vec<((i64, i64), f64)> = Vec::new();

    for ((th_id, timer_id), excess) in timer_excess_map {
        let (timer_name, bucket, kind) = timer_meta.get(&timer_id).cloned().unwrap_or_else(|| ("Other".to_string(), "Other".to_string(), "work".to_string()));
        let role = thread_roles.get(&th_id).map(|s| s.as_str()).unwrap_or("game");

        let lower = timer_name.to_lowercase();
        let is_gpu_wait = lower.contains("reflex") || lower.contains("lowlatencysleep") || lower.contains("gpuwait") || lower.contains("rendercommandfence");

        if role == "gpu" || bucket == "GPU" {
            work_timers.push(((th_id, timer_id), excess));
        } else if is_gpu_wait || kind == "idle" {
            // Ignore idle sleep / GPU sync wait from active CPU culprit ranking
            continue;
        } else if kind == "wait" {
            wait_timers.push(((th_id, timer_id), excess));
        } else {
            work_timers.push(((th_id, timer_id), excess));
        }
    }

    work_timers.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    wait_timers.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let selected_timers = if !work_timers.is_empty() {
        work_timers.into_iter().take(2).collect::<Vec<_>>()
    } else {
        wait_timers.into_iter().take(2).collect::<Vec<_>>()
    };

    for ((th_id, timer_id), excess) in selected_timers {
        let (timer_name, bucket, kind) = timer_meta.get(&timer_id).cloned().unwrap_or_else(|| ("Other".to_string(), "Other".to_string(), "work".to_string()));
        let role = thread_roles.get(&th_id).cloned().unwrap_or_else(|| "game".to_string());

        let matched_rule = rules.iter().find(|r| {
            let role_ok = r.def.when.threads.is_empty() || r.def.when.threads.iter().any(|t| t == &role || (t == "cpu" && (role == "game" || role == "render" || role == "rhi")));
            role_ok && r.regexes.iter().any(|re| re.is_match(&timer_name))
        });

        let rule_id = matched_rule.map(|r| r.def.id.clone()).unwrap_or_else(|| {
            if role == "gpu" || bucket == "GPU" {
                "gpu-bound".to_string()
            } else if role == "render" || role == "rhi" {
                "render-cpu".to_string()
            } else if kind == "wait" {
                "taskgraph-wait".to_string()
            } else {
                "sustained-cpu-bound".to_string()
            }
        });

        output.push(EvaluatedOccurrence {
            rule_id,
            key_timer_id: timer_id,
            thread_role: role,
            scale: "sustained".to_string(),
            frame_from: w_start,
            frame_to: w_end,
            peak_frame_ms,
            mean_excess_ms: excess / frame_count,
            sum_excess_ms: excess,
            confidence: "medium".to_string(),
            evidence_json: format!(r#"{{"timer":"{}","excessMs":{:.2}}}"#, timer_name, excess),
        });
    }
}

pub fn merge_intra_chunk_occurrences(
    mut occurrences: Vec<EvaluatedOccurrence>,
) -> Vec<EvaluatedOccurrence> {
    if occurrences.len() <= 1 {
        return occurrences;
    }

    // Sort by signature, then frame_from
    occurrences.sort_by(|a, b| {
        a.rule_id
            .cmp(&b.rule_id)
            .then_with(|| a.key_timer_id.cmp(&b.key_timer_id))
            .then_with(|| a.thread_role.cmp(&b.thread_role))
            .then_with(|| a.scale.cmp(&b.scale))
            .then_with(|| a.frame_from.cmp(&b.frame_from))
    });

    let mut merged = Vec::new();
    let mut curr = occurrences[0].clone();

    for next in occurrences.into_iter().skip(1) {
        let same_sig = curr.rule_id == next.rule_id
            && curr.key_timer_id == next.key_timer_id
            && curr.thread_role == next.thread_role
            && curr.scale == next.scale;

        let gap_tolerance = if curr.scale == "spike" { 2 } else { 35 };

        if same_sig && next.frame_from <= curr.frame_to + gap_tolerance {
            // Merge
            curr.frame_to = curr.frame_to.max(next.frame_to);
            curr.peak_frame_ms = curr.peak_frame_ms.max(next.peak_frame_ms);
            curr.sum_excess_ms += next.sum_excess_ms;
            let count = (curr.frame_to - curr.frame_from + 1).max(1) as f64;
            curr.mean_excess_ms = curr.sum_excess_ms / count;
        } else {
            merged.push(curr);
            curr = next;
        }
    }
    merged.push(curr);

    merged
}

pub fn stitch_chunk_boundaries(conn: &mut Connection, chunk_id: i64) -> Result<(), String> {
    // Check neighbors: chunk_id - 1 and chunk_id + 1
    for neighbor_id in [chunk_id - 1, chunk_id + 1] {
        if neighbor_id < 0 {
            continue;
        }
        let neighbor_state: Option<String> = conn
            .query_row(
                "SELECT state FROM chunk_state WHERE chunk_id = ?1",
                params![neighbor_id],
                |r| r.get(0),
            )
            .ok();

        if neighbor_state.as_deref() != Some("done") {
            continue;
        }

        // Fetch occurrences touching the border between chunk_id and neighbor_id
        let (left_chunk, right_chunk) = if chunk_id < neighbor_id {
            (chunk_id, neighbor_id)
        } else {
            (neighbor_id, chunk_id)
        };

        let left_border_frame: i64 = match conn.query_row(
            "SELECT frame_to FROM chunk_state WHERE chunk_id = ?1",
            params![left_chunk],
            |r| r.get(0),
        ) {
            Ok(f) => f,
            Err(_) => continue,
        };

        // Find occurrences from left chunk near border (within 2 frames)
        let mut left_occs = Vec::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT o.occurrence_id, o.issue_id, o.frame_from, o.frame_to, o.peak_frame_ms, o.sum_excess_ms,
                            i.rule_id, i.key_timer_id, i.thread_role, i.scale
                     FROM occurrence o
                     JOIN issue i ON i.issue_id = o.issue_id
                     WHERE o.chunk_id = ?1 AND o.frame_to >= ?2",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![left_chunk, left_border_frame - 2], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, f64>(4)?,
                        r.get::<_, f64>(5)?,
                        r.get::<_, String>(6)?,
                        r.get::<_, i64>(7)?,
                        r.get::<_, String>(8)?,
                        r.get::<_, String>(9)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            for r in rows.flatten() {
                left_occs.push(r);
            }
        }

        // Find occurrences from right chunk near border (within 2 frames)
        let right_border_frame = left_border_frame + 1;
        let mut right_occs = Vec::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT o.occurrence_id, o.issue_id, o.frame_from, o.frame_to, o.peak_frame_ms, o.sum_excess_ms,
                            i.rule_id, i.key_timer_id, i.thread_role, i.scale
                     FROM occurrence o
                     JOIN issue i ON i.issue_id = o.issue_id
                     WHERE o.chunk_id = ?1 AND o.frame_from <= ?2",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![right_chunk, right_border_frame + 2], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, f64>(4)?,
                        r.get::<_, f64>(5)?,
                        r.get::<_, String>(6)?,
                        r.get::<_, i64>(7)?,
                        r.get::<_, String>(8)?,
                        r.get::<_, String>(9)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            for r in rows.flatten() {
                right_occs.push(r);
            }
        }

        // Match and stitch identical signatures
        for l in &left_occs {
            for r in &right_occs {
                let same_sig = l.6 == r.6 && l.7 == r.7 && l.8 == r.8 && l.9 == r.9;
                let touches = (r.2 - l.3).abs() <= 3; // within 3 frames across boundary

                if same_sig && touches {
                    let new_from = l.2.min(r.2);
                    let new_to = l.3.max(r.3);
                    let new_peak = l.4.max(r.4);
                    let new_sum = l.5 + r.5;
                    let count = (new_to - new_from + 1).max(1) as f64;
                    let new_mean = new_sum / count;

                    // Stitch into left occurrence and remove right occurrence
                    let _ = conn.execute(
                        "UPDATE occurrence SET frame_from = ?1, frame_to = ?2, peak_frame_ms = ?3, sum_excess_ms = ?4, mean_excess_ms = ?5 WHERE occurrence_id = ?6",
                        params![new_from, new_to, new_peak, new_sum, new_mean, l.0],
                    );
                    let _ = conn.execute("DELETE FROM occurrence WHERE occurrence_id = ?1", params![r.0]);
                }
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace::store::init_db;

    #[test]
    fn test_merge_intra_chunk_occurrences() {
        let occs = vec![
            EvaluatedOccurrence {
                rule_id: "gc-hitch".to_string(),
                key_timer_id: 10,
                thread_role: "game".to_string(),
                scale: "spike".to_string(),
                frame_from: 10,
                frame_to: 11,
                peak_frame_ms: 50.0,
                mean_excess_ms: 30.0,
                sum_excess_ms: 60.0,
                confidence: "high".to_string(),
                evidence_json: "{}".to_string(),
            },
            EvaluatedOccurrence {
                rule_id: "gc-hitch".to_string(),
                key_timer_id: 10,
                thread_role: "game".to_string(),
                scale: "spike".to_string(),
                frame_from: 12,
                frame_to: 13,
                peak_frame_ms: 70.0,
                mean_excess_ms: 40.0,
                sum_excess_ms: 80.0,
                confidence: "high".to_string(),
                evidence_json: "{}".to_string(),
            },
        ];

        let merged = merge_intra_chunk_occurrences(occs);
        assert_eq!(merged.len(), 1, "Adjacent identical GC occurrences must merge");
        assert_eq!(merged[0].frame_from, 10);
        assert_eq!(merged[0].frame_to, 13);
        assert_eq!(merged[0].peak_frame_ms, 70.0);
        assert_eq!(merged[0].sum_excess_ms, 140.0);
    }

    #[test]
    fn test_chunk_boundary_stitching_order_invariance() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();

        // 2 chunks: Chunk 0 (0..511), Chunk 1 (512..1023)
        conn.execute("INSERT INTO chunk_state (chunk_id, state, frame_from, frame_to) VALUES (0, 'done', 0, 511)", []).unwrap();
        conn.execute("INSERT INTO chunk_state (chunk_id, state, frame_from, frame_to) VALUES (1, 'done', 512, 1023)", []).unwrap();

        conn.execute("INSERT INTO issue (issue_id, rule_id, key_timer_id, thread_role, scale, first_frame, last_frame, occurrences_count, total_excess_ms, worst_excess_ms) VALUES (1, 'gpu-bound', 20, 'gpu', 'sustained', 500, 530, 2, 100.0, 30.0)", []).unwrap();

        // Left occurrence touching chunk border at 511
        conn.execute("INSERT INTO occurrence (occurrence_id, issue_id, chunk_id, frame_from, frame_to, peak_frame_ms, mean_excess_ms, sum_excess_ms, confidence, evidence_json) VALUES (1, 1, 0, 500, 511, 25.0, 10.0, 50.0, 'high', '{}')", []).unwrap();
        // Right occurrence touching chunk border at 512
        conn.execute("INSERT INTO occurrence (occurrence_id, issue_id, chunk_id, frame_from, frame_to, peak_frame_ms, mean_excess_ms, sum_excess_ms, confidence, evidence_json) VALUES (2, 1, 1, 512, 530, 30.0, 12.0, 50.0, 'high', '{}')", []).unwrap();

        stitch_chunk_boundaries(&mut conn, 0).unwrap();

        let occ_count: i64 = conn.query_row("SELECT COUNT(*) FROM occurrence", [], |r| r.get(0)).unwrap();
        assert_eq!(occ_count, 1, "Stitching across chunks must combine border occurrences into 1");

        let (from, to, peak): (i64, i64, f64) = conn.query_row("SELECT frame_from, frame_to, peak_frame_ms FROM occurrence", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!(from, 500);
        assert_eq!(to, 530);
        assert_eq!(peak, 30.0);
    }
}
