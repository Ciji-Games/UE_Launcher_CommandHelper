use regex::Regex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::trace::store::{DbEpisode, DbFinding};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixSuggestionDef {
    pub text: String,
    pub effort: String, // "high" | "medium" | "low"
    pub cvars_or_apis: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleWhen {
    pub timers: Vec<String>,
    pub threads: Vec<String>,
    pub min_excess_ms: f64,
    pub min_share_of_excess: f64,
    pub expects_periodic: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleDef {
    pub id: String,
    pub title: String,
    pub applies_to: Vec<String>, // "hitch", "slow_region"
    pub when: RuleWhen,
    pub specificity: f64,
    pub fix_likelihood: String,
    pub fix_rationale: String,
    pub evidence_template: String,
    pub fixes: Vec<FixSuggestionDef>,
    pub verify: String,
    pub caveats: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub label: String,
    pub value_ms: Option<f64>,
    pub baseline_ms: Option<f64>,
    pub calls: Option<usize>,
    pub thread: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelSuggestion {
    pub badge: String,
    pub channel_flags: String,
    pub description: String,
    pub missing_channels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindingPayload {
    pub title: String,
    pub match_confidence: String, // "high" | "medium" | "low"
    pub match_score: f64,
    pub fix_likelihood: String,
    pub explains_ms: f64,
    pub of_excess_ms: f64,
    pub evidence: Vec<Evidence>,
    pub fixes: Vec<FixSuggestionDef>,
    pub verify: String,
    pub caveats: Vec<String>,
    pub episode_ids: Vec<i64>,
    pub period_s: Option<f64>,
    pub channel_suggestion: Option<ChannelSuggestion>,
}

pub fn load_all_rules() -> Vec<RuleDef> {
    let raw_rules = [
        include_str!("../../resources/trace/rules/gc_hitch.json"),
        include_str!("../../resources/trace/rules/shader_compile.json"),
        include_str!("../../resources/trace/rules/pso_hitch.json"),
        include_str!("../../resources/trace/rules/sync_load.json"),
        include_str!("../../resources/trace/rules/spawn_burst.json"),
        include_str!("../../resources/trace/rules/bp_tick.json"),
        include_str!("../../resources/trace/rules/physics_cpu.json"),
        include_str!("../../resources/trace/rules/animation_cpu.json"),
        include_str!("../../resources/trace/rules/editor_overhead.json"),
        include_str!("../../resources/trace/rules/ui_slate.json"),
        include_str!("../../resources/trace/rules/gpu_bound.json"),
        include_str!("../../resources/trace/rules/render_cpu.json"),
        include_str!("../../resources/trace/rules/unattributed_gap.json"),
        include_str!("../../resources/trace/rules/frame_limiter.json"),
    ];

    let mut rules = Vec::new();
    for json_str in raw_rules {
        if let Ok(rule) = serde_json::from_str::<RuleDef>(json_str) {
            rules.push(rule);
        }
    }
    rules
}

pub struct CompiledRule {
    pub def: RuleDef,
    pub regexes: Vec<Regex>,
}

pub fn load_compiled_rules() -> Vec<CompiledRule> {
    let rules = load_all_rules();
    let mut compiled = Vec::new();
    for r in rules {
        let mut regexes = Vec::new();
        for p in &r.when.timers {
            if let Ok(re) = Regex::new(p) {
                regexes.push(re);
            }
        }
        compiled.push(CompiledRule { def: r, regexes });
    }
    compiled
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
struct EpisodeRuleMatch {
    rule_id: String,
    episode_id: i64,
    matched_excess_ms: f64,
    explainable_excess_ms: f64,
    is_periodic: bool,
    matched_timers: Vec<(String, f64, f64, usize)>, // (timer_name, episode_ms, baseline_ms, calls)
}

pub fn detect_trace_channels(conn: &Connection) -> (Vec<String>, Vec<String>) {
    let mut detected = Vec::new();

    // 1. frame
    let frame_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM frames", [], |r| r.get(0))
        .unwrap_or(0);
    if frame_count > 0 {
        detected.push("frame".to_string());
    }

    // 2. gpu
    let gpu_frames: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM frames WHERE gpu_ms IS NOT NULL AND gpu_ms > 0",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let gpu_threads: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM threads WHERE role = 'gpu' OR name LIKE '%GPU%'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let gpu_timers: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM timers WHERE bucket = 'GPU' OR name LIKE '%GPU%'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if gpu_frames > 0 || gpu_threads > 0 || gpu_timers > 0 {
        detected.push("gpu".to_string());
    }

    // 3. cpu
    let cpu_timers: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM timers WHERE bucket NOT IN ('GPU', 'Idle') AND name NOT IN ('Frame')",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let cpu_threads: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM threads WHERE role = 'game' OR name LIKE '%GameThread%'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if cpu_timers > 0 || cpu_threads > 0 {
        detected.push("cpu".to_string());
    }

    // 4. loadtime
    let load_timers: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM timers WHERE bucket = 'Loading' OR name LIKE '%AsyncLoading%' OR name LIKE '%StaticLoadObject%' OR name LIKE '%FAsyncLoading%' OR name LIKE '%PackageLoader%' OR name LIKE '%LoadPackage%' OR name LIKE '%Serialize%' OR name LIKE '%CreateExport%'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if load_timers > 0 {
        detected.push("loadtime".to_string());
    }

    // 5. memory
    let mem_timers: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM timers WHERE name LIKE '%LLM%' OR name LIKE '%FMalloc%' OR name LIKE '%Memory%' OR name LIKE '%TrackedMemory%'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if mem_timers > 0 {
        detected.push("memory".to_string());
    }

    // 6. counters
    let counter_timers: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM timers WHERE name LIKE '%Stat_%' OR name LIKE '%Counter_%' OR name LIKE '%VisiblePrimitives%' OR name LIKE '%DrawCalls%' OR name LIKE '%Triangles%'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if counter_timers > 0 {
        detected.push("counters".to_string());
    }

    // 7. bookmark
    let bookmark_timers: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM timers WHERE name LIKE '%Bookmark%' OR name LIKE '%Marker%' OR name LIKE '%NamedRegion%'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if bookmark_timers > 0 {
        detected.push("bookmark".to_string());
    }

    // 8. log
    let log_timers: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM timers WHERE name LIKE '%Log%' OR name LIKE '%FOutputDevice%'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if log_timers > 0 {
        detected.push("log".to_string());
    }

    // 9. animation
    let anim_timers: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM timers WHERE bucket = 'Animation' OR name LIKE '%AnimGraph%' OR name LIKE '%EvaluateAnimation%' OR name LIKE '%IKRig%' OR name LIKE '%ControlRig%'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if anim_timers > 0 {
        detected.push("animation".to_string());
    }

    // 10. physics
    let phys_timers: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM timers WHERE bucket = 'Physics' OR name LIKE '%Chaos%' OR name LIKE '%PhysicsScene%' OR name LIKE '%SolveConstraints%'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if phys_timers > 0 {
        detected.push("physics".to_string());
    }

    let standard_channels = ["cpu", "gpu", "frame", "loadtime", "memory", "counters", "bookmark", "log"];
    let missing: Vec<String> = standard_channels
        .iter()
        .filter(|&&ch| !detected.iter().any(|d| d == ch))
        .map(|&ch| ch.to_string())
        .collect();

    (detected, missing)
}

pub fn evaluate_and_save_findings(
    conn: &mut Connection,
    episodes: &[DbEpisode],
) -> Result<Vec<DbFinding>, String> {
    let compiled_rules = load_compiled_rules();
    let (detected_channels, _) = detect_trace_channels(conn);
    let mut findings: Vec<DbFinding> = Vec::new();
    let mut next_finding_id: i64 = 1;

    // 1. In-memory preload of timer details
    let mut timer_names = std::collections::HashMap::new();
    let mut timer_buckets = std::collections::HashMap::new();
    let mut timer_kinds = std::collections::HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, name, bucket, kind FROM timers")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rows {
            let (id, name, bucket, kind) = r.map_err(|e| e.to_string())?;
            timer_names.insert(id, name);
            timer_buckets.insert(id, bucket);
            timer_kinds.insert(id, kind);
        }
    }

    // 2. In-memory preload of thread roles
    let mut thread_roles = std::collections::HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, role FROM threads")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        for r in rows {
            let (id, role) = r.map_err(|e| e.to_string())?;
            thread_roles.insert(id, role);
        }
    }

    // 3. In-memory preload of baseline stats
    let mut baseline_stats: std::collections::HashMap<(String, i64), f64> = std::collections::HashMap::new();
    let mut global_baselines: std::collections::HashMap<i64, f64> = std::collections::HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT scope, timer_id, median_excl_ms FROM baseline_stats")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, f64>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rows {
            let (scope, timer_id, median_ms) = r.map_err(|e| e.to_string())?;
            if scope == "global" {
                global_baselines.insert(timer_id, median_ms);
            }
            baseline_stats.insert((scope, timer_id), median_ms);
        }
    }

    // 4. In-memory preload and aggregation of window events
    let mut episode_timer_aggregates: std::collections::HashMap<i64, std::collections::HashMap<i64, (f64, usize)>> = std::collections::HashMap::new();
    let mut episode_thread_busy: std::collections::HashMap<i64, std::collections::HashMap<String, f64>> = std::collections::HashMap::new();
    let mut episode_idle_ms: std::collections::HashMap<i64, f64> = std::collections::HashMap::new();
    let mut episode_total_ms: std::collections::HashMap<i64, f64> = std::collections::HashMap::new();

    {
        let mut stmt = conn
            .prepare("SELECT window_id, thread_id, timer_id, excl_ms FROM window_events WHERE window_id > 0")
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, f64>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        for r in rows {
            let (win_id, th_id, timer_id, excl) = r.map_err(|e| e.to_string())?;
            let role = thread_roles.get(&th_id).cloned().unwrap_or_else(|| "other".to_string());
            let kind = timer_kinds.get(&timer_id).cloned().unwrap_or_else(|| "work".to_string());

            *episode_total_ms.entry(win_id).or_insert(0.0) += excl;
            if kind == "idle" {
                *episode_idle_ms.entry(win_id).or_insert(0.0) += excl;
            } else if kind == "work" {
                *episode_thread_busy
                    .entry(win_id)
                    .or_default()
                    .entry(role)
                    .or_insert(0.0) += excl;
            }

            let timer_entry = episode_timer_aggregates
                .entry(win_id)
                .or_default()
                .entry(timer_id)
                .or_insert((0.0, 0));
            timer_entry.0 += excl;
            timer_entry.1 += 1;
        }
    }

    // 5. Update Bound-By classification in batch
    let mut episode_bound_by: std::collections::HashMap<i64, &'static str> = std::collections::HashMap::new();
    for ep in episodes {
        let total_window_ms = episode_total_ms.get(&ep.id).copied().unwrap_or(0.0);
        let idle_ms = episode_idle_ms.get(&ep.id).copied().unwrap_or(0.0);
        let thread_busy = episode_thread_busy.get(&ep.id);

        let game_busy = thread_busy.and_then(|m| m.get("game")).copied().unwrap_or(0.0);
        let render_busy = thread_busy.and_then(|m| m.get("render")).copied().unwrap_or(0.0);
        let gpu_busy = thread_busy.and_then(|m| m.get("gpu")).copied().unwrap_or(0.0);
        let rhi_busy = thread_busy.and_then(|m| m.get("rhi")).copied().unwrap_or(0.0);

        let bound_by = if total_window_ms > 0.0 && idle_ms > total_window_ms * 0.4 {
            "idle_limited"
        } else if gpu_busy > game_busy && gpu_busy > render_busy && gpu_busy > 5.0 {
            "gpu"
        } else if render_busy > game_busy && render_busy > 5.0 {
            "render"
        } else if rhi_busy > game_busy && rhi_busy > 5.0 {
            "rhi"
        } else if game_busy >= 3.0 {
            "game"
        } else {
            "unattributed"
        };

        episode_bound_by.insert(ep.id, bound_by);
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("UPDATE episodes SET bound_by = ?1 WHERE id = ?2")
            .map_err(|e| e.to_string())?;
        for (ep_id, bound_by) in &episode_bound_by {
            stmt.execute(params![bound_by, ep_id]).map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    // 6. Evaluate Rules across episodes
    let mut matches_by_rule: std::collections::HashMap<String, Vec<EpisodeRuleMatch>> = std::collections::HashMap::new();

    for ep in episodes {
        let explainable_excess_ms = (ep.peak_ms - ep.median_ms.min(16.6)).max(1.0);
        let empty_map = std::collections::HashMap::new();
        let ep_timers = episode_timer_aggregates.get(&ep.id).unwrap_or(&empty_map);

        for rule in &compiled_rules {
            if !rule.def.applies_to.iter().any(|k| k == &ep.kind) {
                continue;
            }

            if rule.def.id == "unattributed-gap" {
                // Special evaluation for unattributed gap
                let mut sum_profiled_ms = 0.0;
                for (tid, (sum_ms, _)) in ep_timers {
                    if let Some(kind) = timer_kinds.get(tid) {
                        if kind == "work" {
                            sum_profiled_ms += sum_ms;
                        }
                    }
                }
                let gap_ms = (explainable_excess_ms - sum_profiled_ms).max(0.0);
                let share = (gap_ms / explainable_excess_ms).clamp(0.0, 1.0);

                if gap_ms >= rule.def.when.min_excess_ms && share >= rule.def.when.min_share_of_excess {
                    matches_by_rule
                        .entry(rule.def.id.clone())
                        .or_default()
                        .push(EpisodeRuleMatch {
                            rule_id: rule.def.id.clone(),
                            episode_id: ep.id,
                            matched_excess_ms: gap_ms,
                            explainable_excess_ms,
                            is_periodic: ep.periodic_group.is_some(),
                            matched_timers: vec![("Unaccounted CPU gap".to_string(), gap_ms, 0.0, 1)],
                        });
                }
                continue;
            }

            let mut matched_excess_ms = 0.0;
            let mut matched_timer_details = Vec::new();

            for (tid, (sum_ms, count)) in ep_timers {
                let timer_name = timer_names.get(tid).cloned().unwrap_or_default();
                let matches_pattern = rule.regexes.iter().any(|re| re.is_match(&timer_name));

                if matches_pattern {
                    let ep_scope = format!("episode:{}", ep.id);
                    let baseline_median = baseline_stats
                        .get(&(ep_scope, *tid))
                        .or_else(|| global_baselines.get(tid))
                        .copied()
                        .unwrap_or(0.0);

                    let excess = (sum_ms - baseline_median).max(0.0);
                    // High-signal noise filter: ignore negligible sub-millisecond timer excess (< 2.0 ms)
                    if excess >= 2.0 && (excess / explainable_excess_ms) >= 0.05 {
                        matched_excess_ms += excess;
                        matched_timer_details.push((timer_name, *sum_ms, baseline_median, *count));
                    }
                }
            }

            let share = (matched_excess_ms / explainable_excess_ms).clamp(0.0, 1.0);
            if matched_excess_ms >= rule.def.when.min_excess_ms && share >= rule.def.when.min_share_of_excess {
                matches_by_rule
                    .entry(rule.def.id.clone())
                    .or_default()
                    .push(EpisodeRuleMatch {
                        rule_id: rule.def.id.clone(),
                        episode_id: ep.id,
                        matched_excess_ms,
                        explainable_excess_ms,
                        is_periodic: ep.periodic_group.is_some(),
                        matched_timers: matched_timer_details,
                    });
            }
        }
    }

    // 7. Aggregate and Deduplicate Findings by Rule
    for rule in &compiled_rules {
        if let Some(rule_matches) = matches_by_rule.get(&rule.def.id) {
            if rule_matches.is_empty() {
                continue;
            }

            let mut episode_ids: Vec<i64> = rule_matches.iter().map(|m| m.episode_id).collect();
            episode_ids.sort_unstable();
            episode_ids.dedup();

            let total_explains_ms: f64 = rule_matches.iter().map(|m| m.matched_excess_ms).sum();
            let total_of_excess_ms: f64 = rule_matches.iter().map(|m| m.explainable_excess_ms).sum();
            let avg_explains_ms = total_explains_ms / (rule_matches.len() as f64);
            let avg_of_excess_ms = total_of_excess_ms / (rule_matches.len() as f64);

            let has_periodic = rule_matches.iter().any(|m| m.is_periodic);

            // Aggregate timer statistics across episodes to find the top culprit scopes
            let mut aggregated_timers: std::collections::HashMap<String, (f64, f64, usize, usize)> = std::collections::HashMap::new();
            for m in rule_matches {
                for (name, tms, bms, calls) in &m.matched_timers {
                    let entry = aggregated_timers
                        .entry(name.clone())
                        .or_insert((0.0, 0.0, 0, 0));
                    entry.0 += tms;
                    entry.1 += bms;
                    entry.2 += calls;
                    entry.3 += 1; // Occurrence count
                }
            }

            let mut timer_ranks: Vec<(String, f64, f64, usize, f64)> = aggregated_timers
                .into_iter()
                .map(|(name, (sum_tms, sum_bms, calls, count))| {
                    let avg_tms = sum_tms / (count as f64);
                    let avg_bms = sum_bms / (count as f64);
                    let excess = (avg_tms - avg_bms).max(0.0);
                    (name, avg_tms, avg_bms, calls / count, excess)
                })
                .collect();

            // Sort by excess ms descending and cap at top 4 evidence scopes
            timer_ranks.sort_by(|a, b| b.4.partial_cmp(&a.4).unwrap_or(std::cmp::Ordering::Equal));
            let top_evidence_timers = timer_ranks.into_iter().take(4).collect::<Vec<_>>();

            let mut evidence = Vec::new();
            for (tname, tms, bms, calls, _excess) in top_evidence_timers {
                let periodic_clause = if has_periodic && rule.def.when.expects_periodic {
                    " (recurs periodically across trace)"
                } else {
                    ""
                };

                let share_pct = if avg_of_excess_ms > 0.0 {
                    ((tms - bms).max(0.0) / avg_of_excess_ms * 100.0).clamp(0.0, 100.0)
                } else {
                    0.0
                };

                let label = if rule.def.id == "unattributed-gap" {
                    format!(
                        "The GameThread spent {:.1} ms with no active profiled Unreal scopes ({:.0}% of extra frame time).",
                        tms, share_pct
                    )
                } else {
                    rule.def
                        .evidence_template
                        .replace("{timer}", &tname)
                        .replace("{ms}", &format!("{:.1}", tms))
                        .replace("{baseline_ms}", &format!("{:.1}", bms))
                        .replace("{share}", &format!("{:.0}", share_pct))
                        .replace("{thread}", "GameThread")
                        .replace("{periodic_clause}", periodic_clause)
                };

                evidence.push(Evidence {
                    label,
                    value_ms: Some(tms),
                    baseline_ms: Some(bms),
                    calls: Some(calls),
                    thread: Some("GameThread".to_string()),
                    note: None,
                });
            }

            let coverage = if total_of_excess_ms > 0.0 {
                (total_explains_ms / total_of_excess_ms).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let specificity = rule.def.specificity;
            let significance = (avg_explains_ms / 33.3).clamp(0.0, 1.0);
            let recurrence = if has_periodic && rule.def.when.expects_periodic {
                1.0
            } else if episode_ids.len() >= 2 {
                0.8
            } else {
                0.5
            };

            let match_score = (0.45 * coverage + 0.25 * specificity + 0.15 * significance + 0.15 * recurrence).clamp(0.0, 1.0);
            if match_score < 0.25 || evidence.is_empty() {
                continue;
            }

            let match_confidence = if match_score >= 0.70 {
                "high"
            } else if match_score >= 0.40 {
                "medium"
            } else {
                "low"
            };

            let rank = total_explains_ms * match_score;
            let channel_suggestion = match rule.def.id.as_str() {
                "unattributed-gap" => Some(ChannelSuggestion {
                    badge: "Need more details?".to_string(),
                    channel_flags: "-trace=cpu,loadtime,counters".to_string(),
                    description: "GameThread execution occurred outside active profiled Unreal scopes. Capture with -trace=cpu,loadtime,counters and enable 'Blueprint CPU Profiling' in Project Settings to pinpoint exact Blueprint events, actor ticks, and synchronous package loads.".to_string(),
                    missing_channels: ["cpu", "loadtime", "counters"]
                        .iter()
                        .filter(|&&c| !detected_channels.iter().any(|d| d == c))
                        .map(|&c| c.to_string())
                        .collect(),
                }),
                "gpu-bound" if !detected_channels.iter().any(|d| d == "counters") => Some(ChannelSuggestion {
                    badge: "Need more details?".to_string(),
                    channel_flags: "-trace=gpu,counters".to_string(),
                    description: "GPU stage duration outlasted CPU threads. Enable -trace=gpu,counters to break down sub-pass rendering costs (Lumen, Nanite, Shadows, TSR) and draw call counts.".to_string(),
                    missing_channels: vec!["counters".to_string()],
                }),
                "gc-hitch" if !detected_channels.iter().any(|d| d == "memory") || !detected_channels.iter().any(|d| d == "counters") => Some(ChannelSuggestion {
                    badge: "Need more details?".to_string(),
                    channel_flags: "-trace=memory,counters".to_string(),
                    description: "Enable -trace=memory,counters to correlate garbage collection sweeps with memory allocation spikes and track UObject growth over time.".to_string(),
                    missing_channels: ["memory", "counters"]
                        .iter()
                        .filter(|&&c| !detected_channels.iter().any(|d| d == c))
                        .map(|&c| c.to_string())
                        .collect(),
                }),
                "sync-load" if !detected_channels.iter().any(|d| d == "loadtime") => Some(ChannelSuggestion {
                    badge: "Need more details?".to_string(),
                    channel_flags: "-trace=loadtime,file".to_string(),
                    description: "Enable -trace=loadtime,file to record exact .uasset package paths, disk read latency, and async loading stalls.".to_string(),
                    missing_channels: vec!["loadtime".to_string(), "file".to_string()],
                }),
                "shader-compile" | "pso-hitch" if !detected_channels.iter().any(|d| d == "counters") || !detected_channels.iter().any(|d| d == "loadtime") => Some(ChannelSuggestion {
                    badge: "Need more details?".to_string(),
                    channel_flags: "-trace=loadtime,counters".to_string(),
                    description: "Enable -trace=loadtime,counters to trace async shader compilation worker queues and PSO precache misses.".to_string(),
                    missing_channels: ["loadtime", "counters"]
                        .iter()
                        .filter(|&&c| !detected_channels.iter().any(|d| d == c))
                        .map(|&c| c.to_string())
                        .collect(),
                }),
                "physics-cpu" if !detected_channels.iter().any(|d| d == "physics") || !detected_channels.iter().any(|d| d == "counters") => Some(ChannelSuggestion {
                    badge: "Need more details?".to_string(),
                    channel_flags: "-trace=cpu,physics,counters".to_string(),
                    description: "Enable -trace=cpu,physics,counters to inspect individual Chaos solver iterations and rigid body query costs.".to_string(),
                    missing_channels: ["physics", "counters"]
                        .iter()
                        .filter(|&&c| !detected_channels.iter().any(|d| d == c))
                        .map(|&c| c.to_string())
                        .collect(),
                }),
                "animation-cpu" if !detected_channels.iter().any(|d| d == "animation") => Some(ChannelSuggestion {
                    badge: "Need more details?".to_string(),
                    channel_flags: "-trace=cpu,animation".to_string(),
                    description: "Enable -trace=cpu,animation to inspect individual AnimGraph nodes and ControlRig evaluation times.".to_string(),
                    missing_channels: vec!["animation".to_string()],
                }),
                "bp-tick" => Some(ChannelSuggestion {
                    badge: "Need more details?".to_string(),
                    channel_flags: "-trace=cpu".to_string(),
                    description: "Turn on 'Blueprint CPU Profiling' in Project Settings → Engine → General Settings (or execute 'stat namedevents' in console) to attribute individual Blueprint events and nodes.".to_string(),
                    missing_channels: Vec::new(),
                }),
                _ => None,
            };

            let payload = FindingPayload {
                title: rule.def.title.clone(),
                match_confidence: match_confidence.to_string(),
                match_score,
                fix_likelihood: rule.def.fix_likelihood.clone(),
                explains_ms: total_explains_ms,
                of_excess_ms: total_of_excess_ms,
                evidence,
                fixes: rule.def.fixes.clone(),
                verify: rule.def.verify.clone(),
                caveats: rule.def.caveats.clone(),
                episode_ids: episode_ids.clone(),
                period_s: None,
                channel_suggestion,
            };

            findings.push(DbFinding {
                id: next_finding_id,
                rule_id: rule.def.id.clone(),
                rank,
                match_confidence: match_score,
                fix_likelihood: rule.def.fix_likelihood.clone(),
                episode_ids,
                payload: serde_json::to_string(&payload).unwrap_or_default(),
            });
            next_finding_id += 1;
        }
    }

    // Sort findings by rank descending
    findings.sort_by(|a, b| b.rank.partial_cmp(&a.rank).unwrap_or(std::cmp::Ordering::Equal));

    // Persist to findings table in SQLite
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        tx.execute("DELETE FROM findings", []).map_err(|e| e.to_string())?;

        let mut stmt = tx
            .prepare(
                "INSERT INTO findings (id, rule_id, rank, match_confidence, fix_likelihood, episode_ids, payload)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .map_err(|e| e.to_string())?;

        for f in &findings {
            stmt.execute(params![
                f.id,
                &f.rule_id,
                f.rank,
                f.match_confidence,
                &f.fix_likelihood,
                serde_json::to_string(&f.episode_ids).unwrap_or_default(),
                &f.payload,
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(findings)
}

pub fn generate_verdict(
    total_frames: usize,
    median_ms: f64,
    hitch_count: usize,
    slow_region_count: usize,
    findings: &[DbFinding],
) -> String {
    if total_frames == 0 {
        return "No frame data available to analyze.".to_string();
    }

    let fps = if median_ms > 0.0 { (1000.0 / median_ms).round() as i32 } else { 0 };

    if findings.is_empty() {
        if hitch_count == 0 && slow_region_count == 0 {
            return format!("Stable performance: running smoothly at median {} fps with no severe hitches.", fps);
        } else {
            return format!(
                "Median {} fps with {} hitch(es) and {} slow region(s); no single dominant root cause identified.",
                fps, hitch_count, slow_region_count
            );
        }
    }

    let top = &findings[0];
    let top_payload: Option<FindingPayload> = serde_json::from_str(&top.payload).ok();

    if let Some(p) = top_payload {
        let confidence_str = match p.match_confidence.as_str() {
            "high" => "high confidence",
            "medium" => "moderate confidence",
            _ => "low confidence",
        };
        format!(
            "Median {} fps ({} hitches, {} slow regions). Primary bottleneck: {} ({}; fix likelihood: {}).",
            fps, hitch_count, slow_region_count, p.title, confidence_str, p.fix_likelihood
        )
    } else {
        format!("Median {} fps with {} detected performance episodes.", fps, hitch_count + slow_region_count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace::store::init_db;

    #[test]
    fn test_load_all_rules() {
        let rules = load_all_rules();
        assert_eq!(rules.len(), 14);
        assert!(rules.iter().any(|r| r.id == "gc-hitch"));
        assert!(rules.iter().any(|r| r.id == "sync-load"));
        assert!(rules.iter().any(|r| r.id == "shader-compile"));
        assert!(rules.iter().any(|r| r.id == "pso-hitch"));
        assert!(rules.iter().any(|r| r.id == "bp-tick"));
        assert!(rules.iter().any(|r| r.id == "physics-cpu"));
        assert!(rules.iter().any(|r| r.id == "animation-cpu"));
        assert!(rules.iter().any(|r| r.id == "editor-overhead"));
        assert!(rules.iter().any(|r| r.id == "ui-slate-overhead"));
        assert!(rules.iter().any(|r| r.id == "gpu-bound"));
        assert!(rules.iter().any(|r| r.id == "render-cpu"));
        assert!(rules.iter().any(|r| r.id == "unattributed-gap"));
        assert!(rules.iter().any(|r| r.id == "spawn-burst"));
        assert!(rules.iter().any(|r| r.id == "frame-limiter"));
    }

    #[test]
    fn test_evaluate_findings_in_memory() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();

        // Seed threads
        conn.execute("INSERT INTO threads (id, name, role) VALUES (1, 'GameThread', 'game')", []).unwrap();
        // Seed timers
        conn.execute("INSERT INTO timers (id, name, bucket, kind) VALUES (10, 'CollectGarbage', 'GC', 'work')", []).unwrap();
        conn.execute("INSERT INTO timers (id, name, bucket, kind) VALUES (11, 'PerformReachabilityAnalysis', 'GC', 'work')", []).unwrap();
        conn.execute("INSERT INTO timers (id, name, bucket, kind) VALUES (20, 'Slate::DrawWindows', 'UI / Slate', 'work')", []).unwrap();

        // Seed episode
        let episode = DbEpisode {
            id: 1,
            kind: "hitch".to_string(),
            start_s: 10.0,
            end_s: 10.1,
            frame_from: 100,
            frame_to: 101,
            peak_ms: 100.0,
            median_ms: 16.6,
            bound_by: "unattributed".to_string(),
            periodic_group: Some(1),
        };
        conn.execute(
            "INSERT INTO episodes (id, kind, start_s, end_s, frame_from, frame_to, peak_ms, median_ms, bound_by, periodic_group)
             VALUES (1, 'hitch', 10.0, 10.1, 100, 101, 100.0, 16.6, 'unattributed', 1)",
            [],
        ).unwrap();

        // Seed window_events for episode 1: CollectGarbage took 70ms
        conn.execute(
            "INSERT INTO window_events (window_id, thread_id, timer_id, start_s, end_s, depth, excl_ms)
             VALUES (1, 1, 10, 10.0, 10.07, 0, 70.0)",
            [],
        ).unwrap();

        // Seed baseline_stats
        conn.execute(
            "INSERT INTO baseline_stats (scope, thread_id, timer_id, median_excl_ms, p95_excl_ms, median_calls, samples)
             VALUES ('global', 1, 10, 0.0, 0.0, 1.0, 10)",
            [],
        ).unwrap();

        let findings = evaluate_and_save_findings(&mut conn, &[episode]).unwrap();
        assert!(!findings.is_empty());
        let gc_finding = findings.iter().find(|f| f.rule_id == "gc-hitch").unwrap();
        assert!(gc_finding.match_confidence >= 0.70); // High confidence
        assert_eq!(gc_finding.episode_ids, vec![1]);

        let payload: FindingPayload = serde_json::from_str(&gc_finding.payload).unwrap();
        assert_eq!(payload.evidence.len(), 1);
        assert!(payload.evidence[0].label.contains("CollectGarbage took 70.0 ms"));
    }
}
