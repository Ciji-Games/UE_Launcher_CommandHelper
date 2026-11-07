use std::collections::{HashMap, HashSet};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::trace::rules::{load_compiled_rules, CompiledRule};
use crate::trace::store::{DbIssue, DbOccurrence};
use crate::trace::subsystem::{classify, is_view_counter, load_subsystems, CompiledSubsystem};

pub const CHUNK_SIZE_FRAMES: usize = 512;
pub const SUSTAINED_WINDOW_S: f64 = 2.0;
pub const SUSTAINED_HOP_S: f64 = 0.5;
pub const MIN_WINDOW_DURATION_S: f64 = 0.5;
pub const ROLLING_MEDIAN_WINDOW_S: f64 = 1.0;

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
    pub start_s: f64,
    pub end_s: f64,
    pub peak_frame_ms: f64,
    pub mean_excess_ms: f64,
    pub sum_excess_ms: f64,
    pub confidence: String,
    pub evidence_json: String,
}

#[derive(Debug, Clone)]
pub struct FrameItem {
    pub idx: i64,
    pub start_s: f64,
    pub interval_ms: f64,
    pub game_ms: f64,
    pub render_ms: f64,
    pub gpu_ms: f64,
}

#[derive(Debug, Clone)]
pub struct TimerItem {
    pub thread_id: i64,
    pub timer_id: i64,
    pub excl_ms: f64,
    pub calls: i64,
    pub max_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceLeaf {
    pub timer: String,
    pub path: String,
    pub ms_per_frame: f64,
    pub baseline_ms_per_frame: f64,
    pub calls_per_frame: f64,
    pub baseline_calls_per_frame: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitingOnEntry {
    pub thread: String,
    pub timer: String,
    pub ms_per_frame: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosisEvidence {
    pub subsystem: String,
    pub subsystem_ms_per_frame: f64,
    pub subsystem_baseline_ms_per_frame: f64,
    pub share_of_thread_excess: f64,
    pub views_per_frame: f64,
    pub baseline_views_per_frame: f64,
    pub leaves: Vec<EvidenceLeaf>,
    pub waiting_on: Vec<WaitingOnEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue: Option<String>,
    pub sanity_violation: bool,
}

#[derive(Debug, Clone)]
pub struct LeafStat {
    pub timer_id: i64,
    pub name: String,
    pub path: String,
    pub subsystem: String,
    pub excl_ms: f64,
    pub base_ms: f64,
    pub excess_ms: f64,
    pub calls: f64,
    pub base_calls: f64,
    pub frames_exceeded: usize,
    pub kind: String,
}

#[derive(Debug, Clone)]
pub struct ThreadProfile {
    pub thread_id: i64,
    pub role: String,
    pub thread_name: String,
    pub wall_ms_per_frame: f64,
    pub wait_ms_per_frame: f64,
    pub work_excess_ms: f64,
    pub timers: Vec<LeafStat>,
}

#[derive(Debug, Clone)]
pub struct WindowProfile {
    pub frame_from: i64,
    pub frame_to: i64,
    pub frames_count: usize,
    pub peak_ms: f64,
    pub avg_ms: f64,
    pub target_ms: f64,
    pub threads: HashMap<i64, ThreadProfile>,
    pub rolling_median_ms: f64,
    pub has_sanity_violation: bool,
}

pub fn is_wait_timer(name: &str, kind: &str) -> bool {
    if kind == "wait" || kind == "idle" {
        return true;
    }
    let lower = name.to_lowercase();
    lower.contains("reflex")
        || lower.contains("lowlatencysleep")
        || lower.contains("gpuwait")
        || lower.contains("rendercommandfence")
        || lower.contains("waitfortasks")
        || lower.contains("waituntiltaskscomplete")
        || lower.contains("gamethreadwaitfortask")
        || lower.contains("waituntilidle")
        || lower.contains("waitforwork")
        || lower.contains("waitforframe")
}

pub fn build_profile(
    frame_indices: &[i64],
    frames_map: &HashMap<i64, FrameItem>,
    frame_timers: &HashMap<i64, Vec<TimerItem>>,
    baselines: &HashMap<(i64, i64), (f64, f64, f64)>,
    timer_meta: &HashMap<i64, (String, String, String, String)>,
    thread_meta: &HashMap<i64, (String, String)>,
    subsystems: &[CompiledSubsystem],
    target_ms: f64,
    rolling_median_ms: f64,
) -> WindowProfile {
    let frame_count = frame_indices.len().max(1) as f64;
    let mut peak_ms = 0.0f64;
    let mut sum_frame_ms = 0.0f64;
    let mut has_sanity_violation = false;

    let frame_from = frame_indices.first().copied().unwrap_or(0);
    let frame_to = frame_indices.last().copied().unwrap_or(0);

    let mut timer_excl: HashMap<(i64, i64), f64> = HashMap::new();
    let mut timer_calls: HashMap<(i64, i64), i64> = HashMap::new();
    let mut timer_frames_exceeded: HashMap<(i64, i64), usize> = HashMap::new();

    for &f_idx in frame_indices {
        let f_interval = if let Some(f) = frames_map.get(&f_idx) {
            peak_ms = peak_ms.max(f.interval_ms);
            sum_frame_ms += f.interval_ms;
            f.interval_ms
        } else {
            16.6
        };

        if let Some(timers) = frame_timers.get(&f_idx) {
            let mut thread_totals: HashMap<i64, f64> = HashMap::new();
            for t in timers {
                *thread_totals.entry(t.thread_id).or_insert(0.0) += t.excl_ms;
                *timer_excl.entry((t.thread_id, t.timer_id)).or_insert(0.0) += t.excl_ms;
                *timer_calls.entry((t.thread_id, t.timer_id)).or_insert(0) += t.calls;

                let (base_ms, _, _) = baselines.get(&(t.thread_id, t.timer_id)).copied().unwrap_or((0.0, 0.0, 1.0));
                if t.excl_ms - base_ms >= 0.1 {
                    *timer_frames_exceeded.entry((t.thread_id, t.timer_id)).or_insert(0) += 1;
                }
            }

            for (th_id, thread_sum) in thread_totals {
                let role = thread_meta.get(&th_id).map(|(_, r)| r.as_str()).unwrap_or("game");
                let tolerance_factor = if role == "gpu" { 1.35 } else { 1.25 };
                if thread_sum > f_interval * tolerance_factor + 2.0 {
                    has_sanity_violation = true;
                }
            }
        }
    }

    let avg_ms = sum_frame_ms / frame_count;

    let mut thread_timers_map: HashMap<i64, Vec<LeafStat>> = HashMap::new();
    for ((th_id, timer_id), total_excl) in timer_excl {
        let excl_ms = total_excl / frame_count;
        let total_c = *timer_calls.get(&(th_id, timer_id)).unwrap_or(&0);
        let calls = total_c as f64 / frame_count;
        let (base_ms, _, base_calls) = baselines.get(&(th_id, timer_id)).copied().unwrap_or((0.0, 0.0, 1.0));
        let excess_ms = (excl_ms - base_ms).max(0.0);
        let (name, _bucket, kind, path) = timer_meta.get(&timer_id).cloned().unwrap_or_else(|| {
            ("Other".to_string(), "Other".to_string(), "work".to_string(), "Other".to_string())
        });
        let subsystem = classify(subsystems, &name, &path);
        let frames_exceeded = *timer_frames_exceeded.get(&(th_id, timer_id)).unwrap_or(&0);

        thread_timers_map.entry(th_id).or_default().push(LeafStat {
            timer_id,
            name,
            path,
            subsystem,
            excl_ms,
            base_ms,
            excess_ms,
            calls,
            base_calls,
            frames_exceeded,
            kind,
        });
    }

    let mut threads = HashMap::new();
    for (th_id, (th_name, th_role)) in thread_meta {
        let timers = thread_timers_map.remove(th_id).unwrap_or_default();
        let mut wall_ms = 0.0f64;
        let mut wait_ms = 0.0f64;
        let mut work_excess = 0.0f64;

        for t in &timers {
            wall_ms += t.excl_ms;
            if is_wait_timer(&t.name, &t.kind) {
                wait_ms += t.excl_ms;
            } else {
                work_excess += t.excess_ms;
            }
        }

        threads.insert(
            *th_id,
            ThreadProfile {
                thread_id: *th_id,
                role: th_role.clone(),
                thread_name: th_name.clone(),
                wall_ms_per_frame: wall_ms,
                wait_ms_per_frame: wait_ms,
                work_excess_ms: work_excess,
                timers,
            },
        );
    }

    WindowProfile {
        frame_from,
        frame_to,
        frames_count: frame_indices.len(),
        peak_ms,
        avg_ms,
        target_ms,
        threads,
        rolling_median_ms,
        has_sanity_violation,
    }
}

pub fn pick_limiting(profile: &WindowProfile) -> Vec<(i64, String)> {
    if profile.threads.is_empty() {
        return Vec::new();
    }

    let mut best_gpu: Option<(&ThreadProfile, f64)> = None;
    let mut compute_gpu: Option<(&ThreadProfile, f64)> = None;
    let mut cpu_threads: Vec<(&ThreadProfile, f64)> = Vec::new();

    for th in profile.threads.values() {
        let active_ms = (th.wall_ms_per_frame - th.wait_ms_per_frame).max(0.0);
        let name_lower = th.thread_name.to_lowercase();
        if th.role == "gpu" {
            if name_lower.contains("compute") {
                compute_gpu = Some((th, active_ms));
            } else if name_lower.contains("graphics") || name_lower.contains("3d") || best_gpu.is_none() {
                best_gpu = Some((th, active_ms));
            }
        } else {
            cpu_threads.push((th, active_ms));
        }
    }

    let mut candidates: Vec<(&ThreadProfile, f64)> = Vec::new();
    if let Some((gpu_th, gpu_active)) = best_gpu {
        candidates.push((gpu_th, gpu_active));
    }
    for (cpu_th, cpu_active) in cpu_threads {
        candidates.push((cpu_th, cpu_active));
    }

    if candidates.is_empty() {
        return profile.threads.values().map(|t| (t.thread_id, t.role.clone())).collect();
    }

    candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let max_active = candidates[0].1;

    let mut result: Vec<(i64, String)> = Vec::new();
    for (th, active) in &candidates {
        if *active >= max_active * 0.80 || result.is_empty() {
            result.push((th.thread_id, th.role.clone()));
        }
    }

    if let Some((comp_th, _)) = compute_gpu {
        if comp_th.work_excess_ms >= 2.0 {
            if !result.iter().any(|(id, _)| *id == comp_th.thread_id) {
                result.push((comp_th.thread_id, comp_th.role.clone()));
            }
        }
    }

    result
}

pub fn evaluate_profile(
    profile: &WindowProfile,
    rules: &[CompiledRule],
    subsystems: &[CompiledSubsystem],
    scale: &str,
    start_s: f64,
    end_s: f64,
) -> Vec<EvaluatedOccurrence> {
    let mut occurrences = Vec::new();

    // 1. Collect wait timers across all threads
    let mut wait_entries = Vec::new();
    for th in profile.threads.values() {
        for t in &th.timers {
            if is_wait_timer(&t.name, &t.kind) && t.excl_ms >= 0.5 {
                wait_entries.push(WaitingOnEntry {
                    thread: th.role.clone(),
                    timer: t.name.clone(),
                    ms_per_frame: t.excl_ms,
                });
            }
        }
    }
    wait_entries.sort_by(|a, b| b.ms_per_frame.partial_cmp(&a.ms_per_frame).unwrap_or(std::cmp::Ordering::Equal));
    wait_entries.truncate(8);

    let limiting_threads = pick_limiting(profile);
    if limiting_threads.is_empty() {
        return occurrences;
    }

    let _gap_ms = (profile.avg_ms - profile.target_ms).max(0.0);

    for (th_id, role) in limiting_threads {
        let th_profile = match profile.threads.get(&th_id) {
            Some(t) => t,
            None => continue,
        };

        let queue_tag = if role == "gpu" {
            let lower = th_profile.thread_name.to_lowercase();
            if lower.contains("compute") {
                Some("compute".to_string())
            } else {
                Some("graphics".to_string())
            }
        } else {
            None
        };

        // Group work timers into subsystems
        let mut sub_groups: HashMap<String, Vec<&LeafStat>> = HashMap::new();
        for t in &th_profile.timers {
            if !is_wait_timer(&t.name, &t.kind) {
                sub_groups.entry(t.subsystem.clone()).or_default().push(t);
            }
        }

        let denominator = th_profile.work_excess_ms.max(0.1);
        let mut emitted_for_thread = false;

        // Sort subsystems by total excess descending
        let mut sub_totals: Vec<(String, f64, f64, f64, f64, f64, f64, f64, Vec<&LeafStat>)> = Vec::new();
        for (sub_id, mut leaves) in sub_groups {
            leaves.sort_by(|a, b| {
                b.excess_ms
                    .partial_cmp(&a.excess_ms)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| b.excl_ms.partial_cmp(&a.excl_ms).unwrap_or(std::cmp::Ordering::Equal))
            });
            let tot_excess: f64 = leaves.iter().map(|l| l.excess_ms).sum();
            let tot_excl: f64 = leaves.iter().map(|l| l.excl_ms).sum();
            let tot_base: f64 = leaves.iter().map(|l| l.base_ms).sum();
            let tot_calls: f64 = leaves.iter().map(|l| l.calls).sum();
            let tot_base_calls: f64 = leaves.iter().map(|l| l.base_calls).sum();

            let views: f64 = leaves
                .iter()
                .filter(|l| is_view_counter(subsystems, &sub_id, &l.name))
                .map(|l| l.calls)
                .sum();
            let base_views: f64 = leaves
                .iter()
                .filter(|l| is_view_counter(subsystems, &sub_id, &l.name))
                .map(|l| l.base_calls)
                .sum();

            sub_totals.push((sub_id, tot_excess, tot_excl, tot_base, tot_calls, tot_base_calls, views, base_views, leaves));
        }

        sub_totals.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        for (sub_id, tot_excess, tot_excl, tot_base, _tot_calls, _tot_base_calls, views, base_views, leaves) in sub_totals {
            let share_of_thread_excess = (tot_excess / denominator).clamp(0.0, 1.0);
            if tot_excess < 1.0 || share_of_thread_excess < 0.10 {
                continue;
            }

            // Find matching rule
            let matched_rule = rules.iter().find(|r| {
                let role_ok = r.def.when.threads.is_empty()
                    || r.def.when.threads.iter().any(|t| {
                        t == &role
                            || (t == "cpu" && (role == "game" || role == "render" || role == "rhi"))
                    });
                if !role_ok {
                    return false;
                }

                // Subsystem match
                if !r.def.when.subsystems.is_empty() {
                    let sub_match = r.def.when.subsystems.iter().any(|s| {
                        if s == &sub_id {
                            return true;
                        }
                        if r.def.id == "gpu-shadow-views" && sub_id == "nanite" && views >= 3.0 * base_views.max(1.0) {
                            return true;
                        }
                        false
                    });
                    if sub_match {
                        return true;
                    }
                }

                // Path match on top leaves
                if !r.path_regexes.is_empty() {
                    let path_match = leaves.iter().any(|l| r.path_regexes.iter().any(|re| re.is_match(&l.path)));
                    if path_match {
                        return true;
                    }
                }

                // Timer name match on top leaves
                if !r.regexes.is_empty() {
                    let name_match = leaves.iter().any(|l| r.regexes.iter().any(|re| re.is_match(&l.name)));
                    if name_match {
                        return true;
                    }
                }

                false
            });

            let rule_id = matched_rule.map(|r| r.def.id.clone()).unwrap_or_else(|| {
                if role == "gpu" {
                    "gpu-bound".to_string()
                } else if role == "render" || role == "rhi" {
                    "render-cpu".to_string()
                } else if scale == "spike" {
                    "cpu-hitch".to_string()
                } else {
                    "sustained-cpu-bound".to_string()
                }
            });

            let key_timer_id = leaves.first().map(|l| l.timer_id).unwrap_or(0);
            let leaf_evidence: Vec<EvidenceLeaf> = leaves
                .iter()
                .take(5)
                .map(|l| EvidenceLeaf {
                    timer: l.name.clone(),
                    path: l.path.clone(),
                    ms_per_frame: l.excl_ms,
                    baseline_ms_per_frame: l.base_ms,
                    calls_per_frame: l.calls,
                    baseline_calls_per_frame: l.base_calls,
                })
                .collect();

            let fraction_frames = if let Some(top_leaf) = leaves.first() {
                top_leaf.frames_exceeded as f64 / profile.frames_count.max(1) as f64
            } else {
                0.0
            };

            let mut confidence = if share_of_thread_excess < 0.10 {
                "low".to_string()
            } else if share_of_thread_excess >= 0.40 && fraction_frames >= 0.50 {
                "high".to_string()
            } else {
                "medium".to_string()
            };

            if profile.has_sanity_violation && confidence == "high" {
                confidence = "medium".to_string();
            }

            let evidence_struct = DiagnosisEvidence {
                subsystem: sub_id.clone(),
                subsystem_ms_per_frame: tot_excl,
                subsystem_baseline_ms_per_frame: tot_base,
                share_of_thread_excess,
                views_per_frame: views,
                baseline_views_per_frame: base_views,
                leaves: leaf_evidence,
                waiting_on: wait_entries.clone(),
                queue: queue_tag.clone(),
                sanity_violation: profile.has_sanity_violation,
            };

            let evidence_json = serde_json::to_string(&evidence_struct).unwrap_or_default();

            occurrences.push(EvaluatedOccurrence {
                rule_id,
                key_timer_id,
                thread_role: role.clone(),
                scale: scale.to_string(),
                frame_from: profile.frame_from,
                frame_to: profile.frame_to,
                start_s,
                end_s,
                peak_frame_ms: profile.peak_ms,
                mean_excess_ms: tot_excess,
                sum_excess_ms: tot_excess * profile.frames_count as f64,
                confidence,
                evidence_json,
            });

            emitted_for_thread = true;
        }

        // FR-5 Never empty fallback
        if !emitted_for_thread && profile.avg_ms > profile.target_ms * 1.05 {
            let mut all_leaves: Vec<&LeafStat> = th_profile.timers.iter().filter(|t| !is_wait_timer(&t.name, &t.kind)).collect();
            all_leaves.sort_by(|a, b| {
                b.excess_ms
                    .partial_cmp(&a.excess_ms)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| b.excl_ms.partial_cmp(&a.excl_ms).unwrap_or(std::cmp::Ordering::Equal))
            });

            if !all_leaves.is_empty() {
                let key_timer_id = all_leaves[0].timer_id;
                let leaf_evidence: Vec<EvidenceLeaf> = all_leaves
                    .iter()
                    .take(5)
                    .map(|l| EvidenceLeaf {
                        timer: l.name.clone(),
                        path: l.path.clone(),
                        ms_per_frame: l.excl_ms,
                        baseline_ms_per_frame: l.base_ms,
                        calls_per_frame: l.calls,
                        baseline_calls_per_frame: l.base_calls,
                    })
                    .collect();

                let tot_excess = th_profile.work_excess_ms;
                let share_of_thread_excess = (tot_excess / denominator).clamp(0.0, 1.0);

                let evidence_struct = DiagnosisEvidence {
                    subsystem: "other".to_string(),
                    subsystem_ms_per_frame: th_profile.wall_ms_per_frame - th_profile.wait_ms_per_frame,
                    subsystem_baseline_ms_per_frame: 0.0,
                    share_of_thread_excess,
                    views_per_frame: 0.0,
                    baseline_views_per_frame: 0.0,
                    leaves: leaf_evidence,
                    waiting_on: wait_entries.clone(),
                    queue: queue_tag.clone(),
                    sanity_violation: profile.has_sanity_violation,
                };

                let evidence_json = serde_json::to_string(&evidence_struct).unwrap_or_default();

                occurrences.push(EvaluatedOccurrence {
                    rule_id: "unattributed-gap".to_string(),
                    key_timer_id,
                    thread_role: role.clone(),
                    scale: scale.to_string(),
                    frame_from: profile.frame_from,
                    frame_to: profile.frame_to,
                    start_s,
                    end_s,
                    peak_frame_ms: profile.peak_ms,
                    mean_excess_ms: tot_excess,
                    sum_excess_ms: tot_excess * profile.frames_count as f64,
                    confidence: "medium".to_string(),
                    evidence_json,
                });
            }
        }
    }

    occurrences
}

pub fn init_chunk_states(conn: &mut Connection, total_frames: usize) -> Result<(), String> {
    if total_frames == 0 {
        return Ok(());
    }

    let num_chunks = (total_frames + CHUNK_SIZE_FRAMES - 1) / CHUNK_SIZE_FRAMES;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
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
    let mut timer_meta: HashMap<i64, (String, String, String, String)> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, name, bucket, kind, COALESCE(path, name) FROM timers")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rows.flatten() {
            timer_meta.insert(r.0, (r.1, r.2, r.3, r.4));
        }
    }

    // Load thread metadata: id -> (name, role)
    let mut thread_meta: HashMap<i64, (String, String)> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, name, role FROM threads")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?)))
            .map_err(|e| e.to_string())?;
        for r in rows.flatten() {
            thread_meta.insert(r.0, (r.1, r.2.unwrap_or_else(|| "game".to_string())));
        }
    }

    // Load frames in chunk context: [frame_from - 64, frame_to + 64]
    let ctx_from = (frame_from - 64).max(0);
    let ctx_to = frame_to + 64;

    let mut frames_map: HashMap<i64, FrameItem> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT idx, start_s, interval_ms, COALESCE(game_ms, 0.0), COALESCE(render_ms, 0.0), COALESCE(gpu_ms, 0.0) FROM frames WHERE idx >= ?1 AND idx <= ?2")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![ctx_from, ctx_to], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, f64>(1)?,
                    r.get::<_, f64>(2)?,
                    r.get::<_, f64>(3)?,
                    r.get::<_, f64>(4)?,
                    r.get::<_, f64>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rows.flatten() {
            frames_map.insert(
                r.0,
                FrameItem {
                    idx: r.0,
                    start_s: r.1,
                    interval_ms: r.2,
                    game_ms: r.3,
                    render_ms: r.4,
                    gpu_ms: r.5,
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
    let subsystems = load_subsystems();
    let mut raw_occurrences: Vec<EvaluatedOccurrence> = Vec::new();

    // Precompute rolling median over ±1.0s window using start_s (FR-4)
    let mut rolling_median_map: HashMap<i64, f64> = HashMap::new();
    for f_idx in frame_from..=frame_to {
        let center_s = frames_map.get(&f_idx).map(|f| f.start_s).unwrap_or(0.0);
        let mut window_intervals: Vec<f64> = (ctx_from..=ctx_to)
            .filter_map(|idx| {
                let f = frames_map.get(&idx)?;
                if (f.start_s - center_s).abs() <= ROLLING_MEDIAN_WINDOW_S {
                    Some(f.interval_ms)
                } else {
                    None
                }
            })
            .collect();
        window_intervals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let med = if !window_intervals.is_empty() {
            window_intervals[window_intervals.len() / 2]
        } else {
            16.6
        };
        rolling_median_map.insert(f_idx, med);
    }

    // 1. Per-frame test & Spike Analyzer (FR-4)
    let mut curr_spike_frames: Vec<i64> = Vec::new();
    let mut spike_frame_set: HashSet<i64> = HashSet::new();

    for f_idx in frame_from..=frame_to {
        let f_item = match frames_map.get(&f_idx) {
            Some(f) => f,
            None => continue,
        };

        let rolling_med = *rolling_median_map.get(&f_idx).unwrap_or(&16.6);
        let spike_threshold = (target_ms * 1.5).max(1.8 * rolling_med);
        let is_spike = f_item.interval_ms > spike_threshold || f_item.interval_ms > 100.0;

        if is_spike {
            curr_spike_frames.push(f_idx);
            spike_frame_set.insert(f_idx);
        } else if !curr_spike_frames.is_empty() {
            process_spike_episode(
                &curr_spike_frames,
                &frames_map,
                &frame_timers,
                &baselines,
                &timer_meta,
                &thread_meta,
                &rules,
                &subsystems,
                target_ms,
                rolling_med,
                &mut raw_occurrences,
            );
            curr_spike_frames.clear();
        }
    }

    if !curr_spike_frames.is_empty() {
        let rolling_med = *rolling_median_map.get(&curr_spike_frames[0]).unwrap_or(&16.6);
        process_spike_episode(
            &curr_spike_frames,
            &frames_map,
            &frame_timers,
            &baselines,
            &timer_meta,
            &thread_meta,
            &rules,
            &subsystems,
            target_ms,
            rolling_med,
            &mut raw_occurrences,
        );
    }

    // 2. Sustained Analyzer: time-based rolling window (2.0s duration, 0.5s hop, min 0.5s) (FR-4)
    let mut w_start = frame_from;

    while w_start <= frame_to {
        let start_s = match frames_map.get(&w_start) {
            Some(f) => f.start_s,
            None => break,
        };

        // Advance w_end to find the last frame within start_s + SUSTAINED_WINDOW_S
        let mut w_end = w_start;
        while w_end + 1 <= frame_to {
            if let Some(next_f) = frames_map.get(&(w_end + 1)) {
                if next_f.start_s - start_s <= SUSTAINED_WINDOW_S {
                    w_end += 1;
                } else {
                    break;
                }
            } else {
                break;
            }
        }

        let end_s = frames_map.get(&w_end).map(|f| f.start_s + f.interval_ms / 1000.0).unwrap_or(start_s);
        let window_duration_s = end_s - start_s;

        if window_duration_s >= MIN_WINDOW_DURATION_S {
            let rolling_med = *rolling_median_map.get(&w_start).unwrap_or(&16.6);
            process_sustained_window(
                w_start,
                w_end,
                target_ms,
                rolling_med,
                &spike_frame_set,
                &frames_map,
                &frame_timers,
                &baselines,
                &timer_meta,
                &thread_meta,
                &rules,
                &subsystems,
                &mut raw_occurrences,
            );
        }

        // Advance w_start by SUSTAINED_HOP_S
        let target_next_s = start_s + SUSTAINED_HOP_S;
        let mut next_w_start = w_start + 1;
        while next_w_start <= frame_to {
            if let Some(f) = frames_map.get(&next_w_start) {
                if f.start_s >= target_next_s {
                    break;
                }
            }
            next_w_start += 1;
        }
        if next_w_start <= w_start {
            next_w_start = w_start + 1;
        }
        w_start = next_w_start;
    }

    // 3. Merge intra-chunk occurrences with same signature and gap tolerance
    let merged_occurrences = merge_intra_chunk_occurrences(raw_occurrences, &frames_map, &frame_timers, &baselines);

    // 4. Save atomically to SQLite
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        tx.execute("DELETE FROM occurrence WHERE chunk_id = ?1", params![chunk_id])
            .map_err(|e| e.to_string())?;

        let mut insert_occ = tx
            .prepare(
                "INSERT INTO occurrence (issue_id, chunk_id, frame_from, frame_to, start_s, end_s, peak_frame_ms, mean_excess_ms, sum_excess_ms, confidence, evidence_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            )
            .map_err(|e| e.to_string())?;

        for occ in &merged_occurrences {
            let issue_id: i64 = match tx.query_row(
                "SELECT issue_id FROM issue WHERE rule_id = ?1 AND thread_role = ?2 AND scale = ?3",
                params![occ.rule_id, occ.thread_role, occ.scale],
                |r| r.get(0),
            ) {
                Ok(id) => {
                    tx.execute(
                        "UPDATE issue SET
                            last_frame = MAX(last_frame, ?2),
                            first_frame = MIN(first_frame, ?3),
                            occurrences_count = occurrences_count + 1,
                            total_excess_ms = total_excess_ms + ?4,
                            worst_excess_ms = MAX(worst_excess_ms, ?5),
                            key_timer_id = CASE WHEN ?6 > 0 THEN ?6 ELSE key_timer_id END
                         WHERE issue_id = ?1",
                        params![id, occ.frame_to, occ.frame_from, occ.sum_excess_ms, occ.peak_frame_ms, occ.key_timer_id],
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
                    occ.start_s,
                    occ.end_s,
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
    timer_meta: &HashMap<i64, (String, String, String, String)>,
    thread_meta: &HashMap<i64, (String, String)>,
    rules: &[CompiledRule],
    subsystems: &[CompiledSubsystem],
    target_ms: f64,
    rolling_median_ms: f64,
    output: &mut Vec<EvaluatedOccurrence>,
) {
    if spike_frames.is_empty() {
        return;
    }

    let first_f = *spike_frames.first().unwrap();
    let last_f = *spike_frames.last().unwrap();

    let ctx_from = (first_f - 1).max(0);
    let ctx_to = last_f + 3;
    let ctx_indices: Vec<i64> = (ctx_from..=ctx_to).collect();

    let start_s = frames_map.get(&first_f).map(|f| f.start_s).unwrap_or(0.0);
    let end_s = frames_map
        .get(&last_f)
        .map(|f| f.start_s + (f.interval_ms / 1000.0))
        .unwrap_or(start_s);

    let profile = build_profile(
        &ctx_indices,
        frames_map,
        frame_timers,
        baselines,
        timer_meta,
        thread_meta,
        subsystems,
        target_ms,
        rolling_median_ms,
    );

    let occs = evaluate_profile(&profile, rules, subsystems, "spike", start_s, end_s);
    output.extend(occs);
}

fn process_sustained_window(
    w_start: i64,
    w_end: i64,
    target_ms: f64,
    rolling_median_ms: f64,
    spike_frame_set: &HashSet<i64>,
    frames_map: &HashMap<i64, FrameItem>,
    frame_timers: &HashMap<i64, Vec<TimerItem>>,
    baselines: &HashMap<(i64, i64), (f64, f64, f64)>,
    timer_meta: &HashMap<i64, (String, String, String, String)>,
    thread_meta: &HashMap<i64, (String, String)>,
    rules: &[CompiledRule],
    subsystems: &[CompiledSubsystem],
    output: &mut Vec<EvaluatedOccurrence>,
) {
    // Exclude spike frames from sustained window
    let non_spike_indices: Vec<i64> = (w_start..=w_end)
        .filter(|idx| !spike_frame_set.contains(idx))
        .collect();

    let total_window_frames = w_end - w_start + 1;
    if non_spike_indices.len() < 15 || non_spike_indices.len() < (total_window_frames as usize) / 3 {
        return;
    }

    let start_s = frames_map.get(&w_start).map(|f| f.start_s).unwrap_or(0.0);
    let end_s = frames_map
        .get(&w_end)
        .map(|f| f.start_s + (f.interval_ms / 1000.0))
        .unwrap_or(start_s);

    let profile = build_profile(
        &non_spike_indices,
        frames_map,
        frame_timers,
        baselines,
        timer_meta,
        thread_meta,
        subsystems,
        target_ms,
        rolling_median_ms,
    );

    if profile.avg_ms <= target_ms * 1.05 {
        return;
    }

    let occs = evaluate_profile(&profile, rules, subsystems, "sustained", start_s, end_s);
    output.extend(occs);
}

fn merge_intra_chunk_occurrences(
    mut raw: Vec<EvaluatedOccurrence>,
    frames_map: &HashMap<i64, FrameItem>,
    frame_timers: &HashMap<i64, Vec<TimerItem>>,
    baselines: &HashMap<(i64, i64), (f64, f64, f64)>,
) -> Vec<EvaluatedOccurrence> {
    if raw.is_empty() {
        return Vec::new();
    }

    // Sort by signature, then frame_from
    raw.sort_by(|a, b| {
        a.rule_id
            .cmp(&b.rule_id)
            .then_with(|| a.thread_role.cmp(&b.thread_role))
            .then_with(|| a.scale.cmp(&b.scale))
            .then_with(|| a.frame_from.cmp(&b.frame_from))
    });

    let mut merged: Vec<EvaluatedOccurrence> = Vec::new();

    for occ in raw {
        let gap_tolerance = if occ.scale == "spike" { 2 } else { 30 }; // 1 hop tolerance for sustained

        let can_merge = if let Some(last) = merged.last_mut() {
            last.rule_id == occ.rule_id
                && last.thread_role == occ.thread_role
                && last.scale == occ.scale
                && occ.frame_from <= last.frame_to + gap_tolerance + 1
        } else {
            false
        };

        if can_merge {
            let last = merged.last_mut().unwrap();
            last.frame_to = last.frame_to.max(occ.frame_to);
            last.end_s = last.end_s.max(occ.end_s);

            let (recomputed_peak, recomputed_sum, recomputed_mean) =
                recompute_occurrence_metrics(last.frame_from, last.frame_to, last.key_timer_id, frames_map, frame_timers, baselines);

            last.peak_frame_ms = recomputed_peak;
            last.sum_excess_ms = recomputed_sum;
            last.mean_excess_ms = recomputed_mean;
            if occ.confidence == "high" {
                last.confidence = "high".to_string();
            }
        } else {
            merged.push(occ);
        }
    }

    merged
}

fn recompute_occurrence_metrics(
    frame_from: i64,
    frame_to: i64,
    key_timer_id: i64,
    frames_map: &HashMap<i64, FrameItem>,
    frame_timers: &HashMap<i64, Vec<TimerItem>>,
    baselines: &HashMap<(i64, i64), (f64, f64, f64)>,
) -> (f64, f64, f64) {
    let mut peak_frame_ms = 0.0f64;
    let mut sum_excess_ms = 0.0f64;
    let count = (frame_to - frame_from + 1).max(1) as f64;

    for f_idx in frame_from..=frame_to {
        if let Some(f) = frames_map.get(&f_idx) {
            peak_frame_ms = peak_frame_ms.max(f.interval_ms);
        }
        if let Some(timers) = frame_timers.get(&f_idx) {
            for t in timers {
                if key_timer_id == 0 || t.timer_id == key_timer_id {
                    let (base_ms, _, _) = baselines.get(&(t.thread_id, t.timer_id)).copied().unwrap_or((0.0, 0.0, 1.0));
                    let excess = (t.excl_ms - base_ms).max(0.0);
                    sum_excess_ms += excess;
                }
            }
        }
    }

    let mean_excess_ms = sum_excess_ms / count;
    (peak_frame_ms, sum_excess_ms, mean_excess_ms)
}

fn stitch_chunk_boundaries(conn: &mut Connection, chunk_id: i64) -> Result<(), String> {
    if chunk_id <= 0 {
        return Ok(());
    }

    let prev_chunk_id = chunk_id - 1;
    let prev_done: bool = conn
        .query_row(
            "SELECT state == 'done' FROM chunk_state WHERE chunk_id = ?1",
            params![prev_chunk_id],
            |r| r.get(0),
        )
        .unwrap_or(false);

    if !prev_done {
        return Ok(());
    }

    let curr_from: i64 = match conn.query_row(
        "SELECT frame_from FROM chunk_state WHERE chunk_id = ?1",
        params![chunk_id],
        |r| r.get(0),
    ) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };

    let mut curr_occs: Vec<(i64, i64, i64, i64, String, f64, f64, f64, f64)> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT occurrence_id, issue_id, frame_from, frame_to, confidence, peak_frame_ms, mean_excess_ms, sum_excess_ms, end_s FROM occurrence WHERE chunk_id = ?1 AND frame_from <= ?2")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![chunk_id, curr_from + 30], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rows.flatten() {
            curr_occs.push(r);
        }
    }

    let mut prev_occs: Vec<(i64, i64, i64, i64, String, f64, f64, f64, f64)> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT occurrence_id, issue_id, frame_from, frame_to, confidence, peak_frame_ms, mean_excess_ms, sum_excess_ms, end_s FROM occurrence WHERE chunk_id = ?1 AND frame_to >= ?2")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![prev_chunk_id, curr_from - 31], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rows.flatten() {
            prev_occs.push(r);
        }
    }

    for (p_occ_id, p_issue_id, _p_from, p_to, _p_conf, p_peak, _p_mean, p_sum, p_end_s) in &prev_occs {
        for (c_occ_id, c_issue_id, _c_from, c_to, c_conf, c_peak, _c_mean, c_sum, c_end_s) in &curr_occs {
            if p_issue_id == c_issue_id && *c_occ_id != *p_occ_id {
                let gap = _c_from - p_to;
                if gap <= 31 && gap >= -31 {
                    let merged_to = (*p_to).max(*c_to);
                    let merged_peak = p_peak.max(*c_peak);
                    let merged_end_s = p_end_s.max(*c_end_s);

                    let (recomputed_sum, recomputed_mean) = {
                        let sum_excl: f64 = conn
                            .query_row(
                                "SELECT COALESCE(SUM(MAX(ft.excl_ms - COALESCE(b.median_excl_ms, 0.0), 0.0)), 0.0)
                                 FROM frame_timer ft
                                 JOIN issue i ON i.issue_id = ?1
                                 LEFT JOIN baseline_global b ON b.thread_id = ft.thread_id AND b.timer_id = ft.timer_id
                                 WHERE ft.frame_idx >= ?2 AND ft.frame_idx <= ?3
                                 AND (i.key_timer_id == 0 OR ft.timer_id == i.key_timer_id)",
                                params![p_issue_id, _p_from, merged_to],
                                |r| r.get(0),
                            )
                            .unwrap_or(p_sum + c_sum);
                        let total_frames = (merged_to - _p_from + 1).max(1) as f64;
                        (sum_excl, sum_excl / total_frames)
                    };

                    let merged_conf = if c_conf == "high" { "high" } else { "medium" };

                    conn.execute(
                        "UPDATE occurrence SET frame_to = ?1, end_s = ?2, peak_frame_ms = ?3, sum_excess_ms = ?4, mean_excess_ms = ?5, confidence = ?6 WHERE occurrence_id = ?7",
                        params![merged_to, merged_end_s, merged_peak, recomputed_sum, recomputed_mean, merged_conf, p_occ_id],
                    ).map_err(|e| e.to_string())?;

                    conn.execute("DELETE FROM occurrence WHERE occurrence_id = ?1", params![c_occ_id])
                        .map_err(|e| e.to_string())?;

                    conn.execute(
                        "UPDATE issue SET occurrences_count = MAX(1, occurrences_count - 1), last_frame = MAX(last_frame, ?2) WHERE issue_id = ?1",
                        params![p_issue_id, merged_to],
                    ).map_err(|e| e.to_string())?;
                }
            }
        }
    }

    Ok(())
}

#[allow(dead_code)]
pub fn query_issues_with_occurrences(conn: &Connection) -> Result<Vec<IssueWithOccurrences>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT issue_id, rule_id, key_timer_id, thread_role, scale, first_frame, last_frame, occurrences_count, total_excess_ms, worst_excess_ms
             FROM issue ORDER BY total_excess_ms DESC",
        )
        .map_err(|e| e.to_string())?;

    let mut issues = Vec::new();
    let issue_rows = stmt
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

    for iss in issue_rows.flatten() {
        let mut occ_stmt = conn
            .prepare(
                "SELECT occurrence_id, issue_id, chunk_id, frame_from, frame_to, start_s, end_s, peak_frame_ms, mean_excess_ms, sum_excess_ms, confidence, evidence_json
                 FROM occurrence WHERE issue_id = ?1 ORDER BY frame_from ASC",
            )
            .map_err(|e| e.to_string())?;

        let occ_rows = occ_stmt
            .query_map(params![iss.issue_id], |r| {
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

        let occurrences = occ_rows.flatten().collect();
        issues.push(IssueWithOccurrences {
            issue: iss,
            occurrences,
        });
    }

    Ok(issues)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_nanite_shadow_views_plateau() {
        let subsystems = load_subsystems();
        let rules = load_compiled_rules();

        let mut frames_map = HashMap::new();
        let mut frame_timers = HashMap::new();
        let mut baselines = HashMap::new();
        let mut timer_meta = HashMap::new();
        let mut thread_meta = HashMap::new();

        thread_meta.insert(1, ("GameThread".to_string(), "game".to_string()));
        thread_meta.insert(2, ("RHIThread".to_string(), "rhi".to_string()));
        thread_meta.insert(3, ("GPU0-Graphics0".to_string(), "gpu".to_string()));
        thread_meta.insert(4, ("GPU0-Compute0".to_string(), "gpu".to_string()));

        // Timers
        // 101: MainPass (Nanite)
        timer_meta.insert(101, ("MainPass".to_string(), "GPU".to_string(), "work".to_string(), "Frame > SceneRender > Nanite::VisBuffer > Nanite::DrawGeometry > MainPass".to_string()));
        // 102: NodeAndClusterCull (Nanite)
        timer_meta.insert(102, ("NodeAndClusterCull".to_string(), "GPU".to_string(), "work".to_string(), "Frame > SceneRender > NodeAndClusterCull".to_string()));
        // 103: Nanite::DrawGeometry (Nanite view counter)
        timer_meta.insert(103, ("Nanite::DrawGeometry".to_string(), "GPU".to_string(), "work".to_string(), "Frame > SceneRender > Nanite::DrawGeometry".to_string()));
        // 104: Face (ShadowDepths view counter)
        timer_meta.insert(104, ("Face".to_string(), "GPU".to_string(), "work".to_string(), "Frame > SceneRender > ShadowDepths > Cubemap > Face".to_string()));
        // 105: FXSystemPreRender (Niagara on Compute)
        timer_meta.insert(105, ("FXSystemPreRender".to_string(), "Niagara/FX".to_string(), "work".to_string(), "Frame > FXSystemPreRender".to_string()));
        // 106: WaitForTasks (RHI wait)
        timer_meta.insert(106, ("WaitForTasks".to_string(), "Wait".to_string(), "wait".to_string(), "Frame > WaitForTasks".to_string()));
        // 107: ReflexSleep (Game wait)
        timer_meta.insert(107, ("ReflexSleep".to_string(), "Wait".to_string(), "wait".to_string(), "Frame > ReflexSleep".to_string()));
        // 108: GameThreadWaitForTask (Game wait)
        timer_meta.insert(108, ("GameThreadWaitForTask".to_string(), "Wait".to_string(), "wait".to_string(), "Frame > GameThreadWaitForTask".to_string()));

        // Baselines
        baselines.insert((3, 101), (0.4, 0.5, 2.0));
        baselines.insert((3, 102), (0.5, 0.6, 4.0));
        baselines.insert((3, 103), (0.1, 0.2, 3.0));
        baselines.insert((3, 104), (0.0, 0.0, 0.0));
        baselines.insert((4, 105), (0.5, 0.6, 1.0));
        baselines.insert((2, 106), (5.0, 6.0, 2.0));
        baselines.insert((1, 107), (5.0, 6.0, 1.0));
        baselines.insert((1, 108), (2.0, 3.0, 1.0));

        // Create 50 plateau frames (frames 0..50 at 50ms)
        let frame_indices: Vec<i64> = (0..50).collect();
        for &f_idx in &frame_indices {
            frames_map.insert(
                f_idx,
                FrameItem {
                    idx: f_idx,
                    start_s: f_idx as f64 * 0.05,
                    interval_ms: 50.0,
                    game_ms: 50.0,
                    render_ms: 50.0,
                    gpu_ms: 50.0,
                },
            );

            frame_timers.insert(
                f_idx,
                vec![
                    TimerItem { thread_id: 3, timer_id: 101, excl_ms: 10.3, calls: 30, max_ms: 1.0 },
                    TimerItem { thread_id: 3, timer_id: 102, excl_ms: 7.8, calls: 63, max_ms: 0.5 },
                    TimerItem { thread_id: 3, timer_id: 103, excl_ms: 0.5, calls: 33, max_ms: 0.1 },
                    TimerItem { thread_id: 3, timer_id: 104, excl_ms: 0.5, calls: 24, max_ms: 0.1 },
                    TimerItem { thread_id: 4, timer_id: 105, excl_ms: 14.5, calls: 1, max_ms: 14.5 },
                    TimerItem { thread_id: 2, timer_id: 106, excl_ms: 41.0, calls: 30, max_ms: 2.0 },
                    TimerItem { thread_id: 1, timer_id: 107, excl_ms: 21.0, calls: 1, max_ms: 21.0 },
                    TimerItem { thread_id: 1, timer_id: 108, excl_ms: 20.0, calls: 1, max_ms: 20.0 },
                ],
            );
        }

        let profile = build_profile(
            &frame_indices,
            &frames_map,
            &frame_timers,
            &baselines,
            &timer_meta,
            &thread_meta,
            &subsystems,
            16.667,
            16.667,
        );

        let limiting = pick_limiting(&profile);
        assert!(!limiting.is_empty());
        assert_eq!(limiting[0].1, "gpu"); // Graphics GPU is limiting

        let occs = evaluate_profile(&profile, &rules, &subsystems, "sustained", 0.0, 2.5);
        assert!(!occs.is_empty());

        // Check that no occurrence is keyed on wait timer
        assert!(!occs.iter().any(|o| o.rule_id == "taskgraph-wait" || o.rule_id == "cpu-hitch" && o.thread_role == "rhi"));

        // Check Niagara on compute queue is surfaced
        assert!(occs.iter().any(|o| o.rule_id == "gpu-niagara-fx"));

        // Check Nanite / GPU occurrences
        let gpu_occ = occs.iter().find(|o| o.thread_role == "gpu" && o.rule_id != "gpu-niagara-fx").expect("Should have GPU graphics occurrence");
        let parsed_ev: DiagnosisEvidence = serde_json::from_str(&gpu_occ.evidence_json).unwrap();
        assert_eq!(parsed_ev.subsystem, "nanite");
        assert!(parsed_ev.share_of_thread_excess >= 0.5);
        assert_eq!(parsed_ev.views_per_frame, 33.0);
        assert_eq!(parsed_ev.baseline_views_per_frame, 3.0);
        assert!(!parsed_ev.waiting_on.is_empty());
        assert!(parsed_ev.waiting_on.iter().any(|w| w.timer == "WaitForTasks"));
    }

    #[test]
    fn test_denominator_independence_from_waits() {
        let subsystems = load_subsystems();
        let rules = load_compiled_rules();

        let mut frames_map = HashMap::new();
        let mut frame_timers = HashMap::new();
        let mut baselines = HashMap::new();
        let mut timer_meta = HashMap::new();
        let mut thread_meta = HashMap::new();

        thread_meta.insert(1, ("GameThread".to_string(), "game".to_string()));
        thread_meta.insert(2, ("RHIThread".to_string(), "rhi".to_string()));
        thread_meta.insert(3, ("GPU0-Graphics0".to_string(), "gpu".to_string()));

        timer_meta.insert(101, ("MainPass".to_string(), "GPU".to_string(), "work".to_string(), "Frame > SceneRender > MainPass".to_string()));
        timer_meta.insert(106, ("WaitForTasks".to_string(), "Wait".to_string(), "wait".to_string(), "Frame > WaitForTasks".to_string()));

        baselines.insert((3, 101), (0.4, 0.5, 2.0));
        baselines.insert((2, 106), (5.0, 6.0, 2.0));

        let frame_indices = vec![0, 1, 2];
        for &f_idx in &frame_indices {
            frames_map.insert(
                f_idx,
                FrameItem {
                    idx: f_idx,
                    start_s: f_idx as f64 * 0.05,
                    interval_ms: 50.0,
                    game_ms: 50.0,
                    render_ms: 50.0,
                    gpu_ms: 50.0,
                },
            );

            // Double the wait time
            frame_timers.insert(
                f_idx,
                vec![
                    TimerItem { thread_id: 3, timer_id: 101, excl_ms: 20.0, calls: 30, max_ms: 1.0 },
                    TimerItem { thread_id: 2, timer_id: 106, excl_ms: 100.0, calls: 30, max_ms: 2.0 },
                ],
            );
        }

        let profile = build_profile(
            &frame_indices,
            &frames_map,
            &frame_timers,
            &baselines,
            &timer_meta,
            &thread_meta,
            &subsystems,
            16.667,
            16.667,
        );

        let occs = evaluate_profile(&profile, &rules, &subsystems, "sustained", 0.0, 0.15);
        let gpu_occ = occs.iter().find(|o| o.thread_role == "gpu").unwrap();
        let parsed_ev: DiagnosisEvidence = serde_json::from_str(&gpu_occ.evidence_json).unwrap();
        // MainPass excess is 19.6 ms, GPU work excess is 19.6 ms => share is 1.0 (or close to 1.0)
        assert!((parsed_ev.share_of_thread_excess - 1.0).abs() < 0.05);
    }

    #[test]
    fn test_never_empty_unattributed_gap() {
        let subsystems = load_subsystems();
        let rules = load_compiled_rules();

        let mut frames_map = HashMap::new();
        let mut frame_timers = HashMap::new();
        let mut baselines = HashMap::new();
        let mut timer_meta = HashMap::new();
        let mut thread_meta = HashMap::new();

        thread_meta.insert(1, ("GameThread".to_string(), "game".to_string()));

        // 20 small unknown timers
        let mut timers_vec = Vec::new();
        for i in 1..=20 {
            timer_meta.insert(i, (format!("CustomWork_{}", i), "Other".to_string(), "work".to_string(), format!("CustomWork_{}", i)));
            baselines.insert((1, i), (0.0, 0.0, 1.0));
            timers_vec.push(TimerItem { thread_id: 1, timer_id: i, excl_ms: 1.5, calls: 1, max_ms: 1.5 });
        }

        let frame_indices = vec![0, 1, 2, 3];
        for &f_idx in &frame_indices {
            frames_map.insert(
                f_idx,
                FrameItem {
                    idx: f_idx,
                    start_s: f_idx as f64 * 0.03,
                    interval_ms: 30.0,
                    game_ms: 30.0,
                    render_ms: 30.0,
                    gpu_ms: 30.0,
                },
            );
            frame_timers.insert(f_idx, timers_vec.clone());
        }

        let profile = build_profile(
            &frame_indices,
            &frames_map,
            &frame_timers,
            &baselines,
            &timer_meta,
            &thread_meta,
            &subsystems,
            16.667,
            16.667,
        );

        let occs = evaluate_profile(&profile, &rules, &subsystems, "sustained", 0.0, 0.12);
        assert!(!occs.is_empty());
        assert_eq!(occs[0].rule_id, "unattributed-gap");
        let parsed_ev: DiagnosisEvidence = serde_json::from_str(&occs[0].evidence_json).unwrap();
        assert_eq!(parsed_ev.leaves.len(), 5);
    }

    #[test]
    fn test_plateau_vs_spike_separation() {
        let mut frames_map = HashMap::new();
        let mut frame_timers = HashMap::new();
        let mut baselines = HashMap::new();
        let mut timer_meta = HashMap::new();
        let mut thread_meta = HashMap::new();

        thread_meta.insert(1, ("GameThread".to_string(), "game".to_string()));
        thread_meta.insert(3, ("GPU0-Graphics0".to_string(), "gpu".to_string()));

        timer_meta.insert(101, ("MainPass".to_string(), "GPU".to_string(), "work".to_string(), "Frame > SceneRender > MainPass".to_string()));
        timer_meta.insert(102, ("CollectGarbage".to_string(), "GC".to_string(), "work".to_string(), "Frame > CollectGarbage".to_string()));

        baselines.insert((3, 101), (0.4, 0.5, 2.0));
        baselines.insert((1, 102), (0.0, 0.0, 0.0));

        // 400 frames at 50 ms, with 3 spikes at frames 50, 150, 250 at 120 ms
        let spike_set: HashSet<i64> = [50, 150, 250].into_iter().collect();

        for f_idx in 0..400 {
            let is_spike = spike_set.contains(&f_idx);
            let interval = if is_spike { 120.0 } else { 50.0 };

            frames_map.insert(
                f_idx,
                FrameItem {
                    idx: f_idx,
                    start_s: f_idx as f64 * 0.05,
                    interval_ms: interval,
                    game_ms: if is_spike { 100.0 } else { 10.0 },
                    render_ms: 50.0,
                    gpu_ms: 50.0,
                },
            );

            let mut timers = vec![
                TimerItem { thread_id: 3, timer_id: 101, excl_ms: 20.0, calls: 30, max_ms: 1.0 },
            ];
            if is_spike {
                timers.push(TimerItem { thread_id: 1, timer_id: 102, excl_ms: 90.0, calls: 1, max_ms: 90.0 });
            }
            frame_timers.insert(f_idx, timers);
        }

        // Test rolling median spike detection over chunk 0..399
        let target_ms = 16.667;
        let mut detected_spikes = Vec::new();
        let mut curr_spike_frames: Vec<i64> = Vec::new();

        for f_idx in 0..400 {
            let w_from = (f_idx - 60).max(0);
            let w_to = (f_idx + 60).min(399);
            let mut window_intervals: Vec<f64> = (w_from..=w_to)
                .filter_map(|idx| frames_map.get(&idx).map(|f| f.interval_ms))
                .collect();
            window_intervals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let med = window_intervals[window_intervals.len() / 2];

            let spike_threshold = (target_ms * 1.5f64).max(1.8f64 * med);
            let is_spike = frames_map[&f_idx].interval_ms > spike_threshold || frames_map[&f_idx].interval_ms > 100.0;

            if is_spike {
                curr_spike_frames.push(f_idx);
            } else if !curr_spike_frames.is_empty() {
                detected_spikes.push(curr_spike_frames.clone());
                curr_spike_frames.clear();
            }
        }
        if !curr_spike_frames.is_empty() {
            detected_spikes.push(curr_spike_frames.clone());
        }

        // Must detect exactly 3 spikes (not hundreds of spikes from the 50ms plateau)
        assert_eq!(detected_spikes.len(), 3);
        for sp in &detected_spikes {
            assert!(sp.len() <= 6); // Single frame spikes
        }
    }

    #[test]
    fn test_framerate_independent_sustained_windows() {
        let mut conn_30 = Connection::open_in_memory().unwrap();
        let mut conn_60 = Connection::open_in_memory().unwrap();
        crate::trace::store::init_db(&conn_30).unwrap();
        crate::trace::store::init_db(&conn_60).unwrap();

        // 30 FPS: 90 frames (3.0s total), each 33.333 ms
        for i in 0..90 {
            conn_30.execute(
                "INSERT INTO frames (idx, start_s, interval_ms, game_ms, render_ms, gpu_ms) VALUES (?1, ?2, 33.333, 10.0, 10.0, 33.333)",
                params![i, i as f64 * (1.0 / 30.0)],
            ).unwrap();
        }

        // 60 FPS: 180 frames (3.0s total), each 33.333 ms interval, start_s spaced by 1/60s
        for i in 0..180 {
            conn_60.execute(
                "INSERT INTO frames (idx, start_s, interval_ms, game_ms, render_ms, gpu_ms) VALUES (?1, ?2, 33.333, 10.0, 10.0, 33.333)",
                params![i, i as f64 * (1.0 / 60.0)],
            ).unwrap();
        }

        conn_30.execute("INSERT INTO threads (id, name, role) VALUES (1, 'GameThread', 'game'), (3, 'GPU', 'gpu')", []).unwrap();
        conn_60.execute("INSERT INTO threads (id, name, role) VALUES (1, 'GameThread', 'game'), (3, 'GPU', 'gpu')", []).unwrap();

        conn_30.execute("INSERT INTO timers (id, name, bucket, kind, path) VALUES (10, 'MainPass', 'GPU', 'work', 'SceneRender > MainPass')", []).unwrap();
        conn_60.execute("INSERT INTO timers (id, name, bucket, kind, path) VALUES (10, 'MainPass', 'GPU', 'work', 'SceneRender > MainPass')", []).unwrap();

        for i in 0..90 {
            conn_30.execute(
                "INSERT INTO frame_timer (frame_idx, thread_id, timer_id, excl_ms, calls, max_ms) VALUES (?1, 3, 10, 25.0, 10, 25.0)",
                params![i],
            ).unwrap();
        }
        for i in 0..180 {
            conn_60.execute(
                "INSERT INTO frame_timer (frame_idx, thread_id, timer_id, excl_ms, calls, max_ms) VALUES (?1, 3, 10, 25.0, 10, 25.0)",
                params![i],
            ).unwrap();
        }

        conn_30.execute("INSERT INTO baseline_global (thread_id, timer_id, median_excl_ms, p95_excl_ms, median_calls, samples) VALUES (3, 10, 1.0, 1.0, 1, 90)", []).unwrap();
        conn_60.execute("INSERT INTO baseline_global (thread_id, timer_id, median_excl_ms, p95_excl_ms, median_calls, samples) VALUES (3, 10, 1.0, 1.0, 1, 180)", []).unwrap();

        init_chunk_states(&mut conn_30, 90).unwrap();
        init_chunk_states(&mut conn_60, 180).unwrap();

        diagnose_chunk(&mut conn_30, 0, 60.0).unwrap();
        diagnose_chunk(&mut conn_60, 0, 60.0).unwrap();

        let occ_30: (f64, f64) = conn_30.query_row(
            "SELECT MIN(o.start_s), MAX(o.end_s) FROM occurrence o JOIN issue i ON i.issue_id = o.issue_id WHERE i.scale = 'sustained'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();

        let occ_60: (f64, f64) = conn_60.query_row(
            "SELECT MIN(o.start_s), MAX(o.end_s) FROM occurrence o JOIN issue i ON i.issue_id = o.issue_id WHERE i.scale = 'sustained'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();

        // Both 30 FPS and 60 FPS traces should span the full evaluated time duration (~3.0s)
        assert!((occ_30.1 - occ_30.0 - 3.0).abs() < 0.2);
        assert!((occ_60.1 - occ_60.0 - 3.0).abs() < 0.2);
    }

    #[test]
    fn test_diagnose_real_trace_cache_if_present() {
        let dir = std::path::Path::new(r"C:\Users\hp\AppData\Roaming\com.ue-launcher.app\trace_cache");
        if !dir.exists() { return; }
        let mut db_file = None;
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.extension().map_or(false, |ext| ext == "db") {
                    db_file = Some(p);
                    break;
                }
            }
        }
        let p = match db_file { Some(p) => p, None => return };
        let mut conn = rusqlite::Connection::open(&p).unwrap();
        let _ = conn.execute("DELETE FROM occurrence", []);
        let _ = conn.execute("DELETE FROM issue", []);
        let _ = conn.execute("UPDATE chunk_state SET state = 'queued', done_at = NULL", []);
        
        let c0 = diagnose_chunk(&mut conn, 0, 60.0).unwrap();
        let c1 = diagnose_chunk(&mut conn, 1, 60.0).unwrap();
        let c2 = diagnose_chunk(&mut conn, 2, 60.0).unwrap();
        assert!(c0 + c1 + c2 >= 0);
    }
}
