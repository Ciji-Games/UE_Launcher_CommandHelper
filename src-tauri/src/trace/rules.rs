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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RuleWhen {
    pub timers: Vec<String>,
    pub threads: Vec<String>,
    pub min_excess_ms: f64,
    pub min_share_of_excess: f64,
    pub expects_periodic: bool,
    #[serde(default)]
    pub requires_bound_by: Option<String>,
    #[serde(default)]
    pub min_call_multiplier: Option<f64>,
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

pub fn format_timer_display_name(tname: &str, rule_id: &str) -> String {
    if tname == "Frame" && rule_id == "gpu-bound" {
        return "GPU total frame duration".to_string();
    }
    if let Some(rest) = tname.strip_prefix("ExecuteUbergraph_") {
        return format!("Blueprint '{}' (ExecuteUbergraph)", rest);
    }
    if tname.starts_with("Function ") {
        let after = &tname["Function ".len()..];
        if let Some((asset_path, func_name)) = after.split_once(':') {
            let asset_name = asset_path
                .split('/')
                .last()
                .unwrap_or(asset_path)
                .trim_end_matches("_C")
                .trim_end_matches(".Default__")
                .split('.')
                .last()
                .unwrap_or(asset_path);
            return format!("Blueprint '{}' ({})", asset_name, func_name);
        }
    }
    if tname.contains("_C::") {
        let mut parts = tname.split("_C::");
        if let (Some(asset_part), Some(func_name)) = (parts.next(), parts.next()) {
            let asset_name = asset_part.split('/').last().unwrap_or(asset_part);
            if asset_name.starts_with("WBP_") || asset_name.contains("Widget") {
                return format!("Widget '{}' ({})", asset_name, func_name);
            } else {
                return format!("Blueprint '{}' ({})", asset_name, func_name);
            }
        }
    }
    if let Some(rest) = tname.strip_prefix("LoadPackage ") {
        return format!("Package '{}' (LoadPackage)", rest.trim());
    }
    if let Some(rest) = tname.strip_prefix("LoadPackage:") {
        return format!("Package '{}' (LoadPackage)", rest.trim());
    }
    if let Some(rest) = tname.strip_prefix("Serialize ") {
        return format!("Package '{}' (Serialize)", rest.trim());
    }
    if let Some(rest) = tname.strip_prefix("Serialize:") {
        return format!("Package '{}' (Serialize)", rest.trim());
    }
    if let Some(rest) = tname.strip_prefix("PostLoad ") {
        return format!("Package '{}' (PostLoad)", rest.trim());
    }
    if let Some(rest) = tname.strip_prefix("PostLoad:") {
        return format!("Package '{}' (PostLoad)", rest.trim());
    }
    if let Some(rest) = tname.strip_prefix("CreateExport ") {
        return format!("Export '{}' (CreateExport)", rest.trim());
    }
    if tname.starts_with("/Game/") || tname.starts_with("/Engine/") {
        return format!("Package '{}'", tname);
    }
    if (tname.starts_with("WBP_") || tname.starts_with("BP_")) && !tname.contains("::") {
        if tname.starts_with("WBP_") {
            return format!("Widget '{}'", tname);
        } else {
            return format!("Blueprint '{}'", tname);
        }
    }
    tname.to_string()
}

pub fn load_all_rules() -> Vec<RuleDef> {
    let raw_rules = [
        include_str!("../../resources/trace/rules/gc_hitch.json"),
        include_str!("../../resources/trace/rules/shader_compile.json"),
        include_str!("../../resources/trace/rules/pso_hitch.json"),
        include_str!("../../resources/trace/rules/sync_load.json"),
        include_str!("../../resources/trace/rules/async_load_finalization.json"),
        include_str!("../../resources/trace/rules/spawn_burst.json"),
        include_str!("../../resources/trace/rules/bp_tick.json"),
        include_str!("../../resources/trace/rules/physics_cpu.json"),
        include_str!("../../resources/trace/rules/animation_cpu.json"),
        include_str!("../../resources/trace/rules/editor_overhead.json"),
        include_str!("../../resources/trace/rules/ui_slate.json"),
        include_str!("../../resources/trace/rules/gpu_bound.json"),
        include_str!("../../resources/trace/rules/render_cpu.json"),
        include_str!("../../resources/trace/rules/render_flush.json"),
        include_str!("../../resources/trace/rules/level_streaming.json"),
        include_str!("../../resources/trace/rules/unattributed_gap.json"),
        include_str!("../../resources/trace/rules/frame_limiter.json"),
        include_str!("../../resources/trace/rules/inconclusive.json"),
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

pub fn detect_is_editor_build(conn: &Connection) -> bool {
    let editor_timers: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM timers WHERE bucket = 'Editor' OR kind = 'editor_only' OR name LIKE '%Editor%' OR name LIKE '%UEditorEngine%'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let editor_threads: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM threads WHERE name LIKE '%Editor%' OR name LIKE '%UnrealEd%'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    editor_timers > 0 || editor_threads > 0
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
            "SELECT (SELECT COUNT(*) FROM bookmarks) + (SELECT COUNT(*) FROM timers WHERE name LIKE '%Bookmark%' OR name LIKE '%NamedRegion%')",
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
    let is_editor_build = detect_is_editor_build(conn);
    let (detected_channels, _) = detect_trace_channels(conn);
    let mut findings: Vec<DbFinding> = Vec::new();
    let mut next_finding_id: i64 = 1;

    // 0. Compute capture baseline median frame time from frames table
    let capture_median_ms: f64 = {
        let mut intervals = Vec::new();
        if let Ok(mut stmt) = conn.prepare("SELECT interval_ms FROM frames WHERE interval_ms > 0") {
            if let Ok(rows) = stmt.query_map([], |r| r.get::<_, f64>(0)) {
                for intv in rows.flatten() {
                    intervals.push(intv);
                }
            }
        }
        if !intervals.is_empty() {
            intervals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            crate::trace::frames::calculate_percentile(&intervals, 0.5)
        } else {
            16.6
        }
    };

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

    // 3. In-memory preload of baseline stats: (scope, thread_id, timer_id) -> (median_ms, median_calls)
    let mut baseline_stats: std::collections::HashMap<(String, i64, i64), (f64, f64)> = std::collections::HashMap::new();
    let mut global_baselines: std::collections::HashMap<(i64, i64), (f64, f64)> = std::collections::HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT scope, thread_id, timer_id, median_excl_ms, median_calls FROM baseline_stats")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<f64>>(3)?,
                    row.get::<_, Option<f64>>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rows {
            let (scope, th_opt, tid_opt, med_opt, calls_opt) = r.map_err(|e| e.to_string())?;
            if let (Some(th_id), Some(tid)) = (th_opt, tid_opt) {
                let med = med_opt.unwrap_or(0.0);
                let calls = calls_opt.unwrap_or(1.0);
                if scope == "global" {
                    global_baselines.insert((th_id, tid), (med, calls));
                }
                baseline_stats.insert((scope, th_id, tid), (med, calls));
            }
        }
    }

    // 4. In-memory preload and aggregation of window events: ep_id -> (timer_id, thread_id) -> (sum_ms, count)
    let mut episode_timer_aggregates: std::collections::HashMap<i64, std::collections::HashMap<(i64, i64), (f64, usize)>> = std::collections::HashMap::new();
    let mut episode_window_spans: std::collections::HashMap<i64, (f64, f64)> = std::collections::HashMap::new();
    let mut episode_idle_ms: std::collections::HashMap<i64, f64> = std::collections::HashMap::new();
    let mut episode_total_ms: std::collections::HashMap<i64, f64> = std::collections::HashMap::new();

    {
        let mut stmt = conn
            .prepare("SELECT window_id, thread_id, timer_id, start_s, end_s, excl_ms FROM window_events WHERE window_id > 0")
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, f64>(3)?,
                    row.get::<_, f64>(4)?,
                    row.get::<_, f64>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        for r in rows {
            let (win_id, th_id, timer_id, start_s, end_s, excl) = r.map_err(|e| e.to_string())?;
            let kind = timer_kinds.get(&timer_id).cloned().unwrap_or_else(|| "work".to_string());

            *episode_total_ms.entry(win_id).or_insert(0.0) += excl;
            if kind == "idle" {
                *episode_idle_ms.entry(win_id).or_insert(0.0) += excl;
            }

            let span = episode_window_spans.entry(win_id).or_insert((start_s, end_s));
            if start_s < span.0 {
                span.0 = start_s;
            }
            if end_s > span.1 {
                span.1 = end_s;
            }

            let timer_entry = episode_timer_aggregates
                .entry(win_id)
                .or_default()
                .entry((timer_id, th_id))
                .or_insert((0.0, 0));
            timer_entry.0 += excl;
            timer_entry.1 += 1;
        }
    }

    // 5. Update Bound-By classification in batch
    let mut episode_bound_by: std::collections::HashMap<i64, &'static str> = std::collections::HashMap::new();
    let mut episode_num_frames: std::collections::HashMap<i64, f64> = std::collections::HashMap::new();

    for ep in episodes {
        let total_window_ms = episode_total_ms.get(&ep.id).copied().unwrap_or(0.0);
        let idle_ms = episode_idle_ms.get(&ep.id).copied().unwrap_or(0.0);
        let ep_timers = episode_timer_aggregates.get(&ep.id);

        let frame_interval_s = capture_median_ms / 1000.0;
        let num_frames = if let Some(&(min_s, max_s)) = episode_window_spans.get(&ep.id) {
            let dur = (max_s - min_s + frame_interval_s * 0.8).max(0.001);
            (dur / frame_interval_s).round().max(1.0)
        } else {
            1.0
        };
        episode_num_frames.insert(ep.id, num_frames);

        let ep_scope = format!("episode:{}", ep.id);
        let mut thread_excess: std::collections::HashMap<String, f64> = std::collections::HashMap::new();

        if let Some(timers) = ep_timers {
            for (&(tid, th_id), &(sum_ms, _)) in timers {
                let kind = timer_kinds.get(&tid).map(|s| s.as_str()).unwrap_or("work");
                if kind == "wait" || kind == "idle" {
                    continue;
                }

                let role = thread_roles.get(&th_id).cloned().unwrap_or_else(|| "other".to_string());
                let (base_ms, _) = baseline_stats
                    .get(&(ep_scope.clone(), th_id, tid))
                    .or_else(|| global_baselines.get(&(th_id, tid)))
                    .copied()
                    .unwrap_or((0.0, 1.0));

                let excess = (sum_ms - base_ms * num_frames).max(0.0);
                *thread_excess.entry(role).or_insert(0.0) += excess;
            }
        }

        let game_excess = thread_excess.get("game").copied().unwrap_or(0.0);
        let render_excess = thread_excess.get("render").copied().unwrap_or(0.0);
        let gpu_excess = thread_excess.get("gpu").copied().unwrap_or(0.0);
        let rhi_excess = thread_excess.get("rhi").copied().unwrap_or(0.0);

        let bound_by = if total_window_ms > 0.0 && idle_ms > total_window_ms * 0.4 {
            "idle_limited"
        } else if gpu_excess > game_excess && gpu_excess > render_excess && gpu_excess >= 4.0 {
            "gpu"
        } else if render_excess > game_excess && render_excess >= 4.0 {
            "render"
        } else if rhi_excess > game_excess && rhi_excess >= 4.0 {
            "rhi"
        } else if game_excess >= 3.0 {
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
        let target_frame_ms = if ep.median_ms > 0.0 { ep.median_ms } else { 16.6 };
        let explainable_excess_ms = (ep.peak_ms - target_frame_ms).max(1.0);
        let num_frames = episode_num_frames.get(&ep.id).copied().unwrap_or(1.0);
        let empty_map = std::collections::HashMap::new();
        let ep_timers = episode_timer_aggregates.get(&ep.id).unwrap_or(&empty_map);
        let ep_bound_by = episode_bound_by.get(&ep.id).copied().unwrap_or("unattributed");

        for rule in &compiled_rules {
            if rule.def.id == "inconclusive" {
                continue;
            }

            if !rule.def.applies_to.iter().any(|k| k == &ep.kind) {
                continue;
            }

            // requires_bound_by gating
            if let Some(ref req) = rule.def.when.requires_bound_by {
                match req.as_str() {
                    "gpu" if ep_bound_by != "gpu" => continue,
                    "cpu" if !(ep_bound_by == "game" || ep_bound_by == "render" || ep_bound_by == "rhi") => continue,
                    "game" if ep_bound_by != "game" => continue,
                    "render" if ep_bound_by != "render" => continue,
                    _ => {}
                }
            }

            // Frame limiter rule only applies if the episode was actually classified as idle_limited
            if rule.def.id == "frame-limiter" && ep_bound_by != "idle_limited" {
                continue;
            }

            if rule.def.id == "unattributed-gap" {
                // Calculate unaccounted gap on GameThread (ignoring Frame root container)
                let ep_scope = format!("episode:{}", ep.id);
                let mut sum_profiled_ms = 0.0;
                for (&(tid, th_id), &(sum_ms, _)) in ep_timers {
                    let role = thread_roles.get(&th_id).map(|s| s.as_str()).unwrap_or("other");
                    let tname = timer_names.get(&tid).map(|s| s.as_str()).unwrap_or("");
                    if role == "game" && tname != "Frame" {
                        let kind = timer_kinds.get(&tid).map(|s| s.as_str()).unwrap_or("work");
                        if kind == "work" {
                            let (base_ms, _) = baseline_stats
                                .get(&(ep_scope.clone(), th_id, tid))
                                .or_else(|| global_baselines.get(&(th_id, tid)))
                                .copied()
                                .unwrap_or((0.0, 1.0));
                            let excess = (sum_ms - base_ms * num_frames).max(0.0);
                            sum_profiled_ms += excess;
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
            let ep_scope = format!("episode:{}", ep.id);

            for (&(tid, th_id), &(sum_ms, count)) in ep_timers {
                let role = thread_roles.get(&th_id).cloned().unwrap_or_else(|| "other".to_string());
                if !rule.def.when.threads.is_empty()
                    && !rule.def.when.threads.iter().any(|t| t == &role || (t == "cpu" && (role == "game" || role == "render" || role == "rhi")))
                {
                    continue;
                }

                let timer_name = timer_names.get(&tid).cloned().unwrap_or_default();
                let matches_pattern = rule.regexes.iter().any(|re| re.is_match(&timer_name));

                if matches_pattern {
                    let (base_ms, base_calls) = baseline_stats
                        .get(&(ep_scope.clone(), th_id, tid))
                        .or_else(|| global_baselines.get(&(th_id, tid)))
                        .copied()
                        .unwrap_or((0.0, 1.0));

                    if let Some(mult) = rule.def.when.min_call_multiplier {
                        if (count as f64) < base_calls * num_frames * mult {
                            continue;
                        }
                    }

                    let excess = (sum_ms - base_ms * num_frames).max(0.0);
                    // High-signal noise filter: ignore negligible sub-millisecond timer excess (< 2.0 ms)
                    if excess >= 2.0 && (excess / explainable_excess_ms) >= 0.05 {
                        matched_excess_ms += excess;
                        matched_timer_details.push((timer_name, sum_ms, base_ms * num_frames, count));
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

    // If specific non-gap rules matched, suppress unattributed-gap when specific rules explain enough excess
    let has_specific_matches = matches_by_rule
        .iter()
        .any(|(id, m)| id != "unattributed-gap" && id != "frame-limiter" && !m.is_empty());
    if has_specific_matches {
        matches_by_rule.remove("unattributed-gap");
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

            let default_thread_name = if rule.def.when.threads.iter().any(|t| t == "gpu") {
                "GPU"
            } else if rule.def.when.threads.iter().any(|t| t == "render") {
                "RenderThread"
            } else if rule.def.when.threads.iter().any(|t| t == "rhi") {
                "RHIThread"
            } else {
                "GameThread"
            };

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

                let display_timer_name = format_timer_display_name(&tname, &rule.def.id);

                let label = if rule.def.id == "unattributed-gap" {
                    format!(
                        "The GameThread spent {:.1} ms with no active profiled Unreal scopes ({:.0}% of extra frame time).",
                        tms, share_pct
                    )
                } else {
                    rule.def
                        .evidence_template
                        .replace("{timer}", &display_timer_name)
                        .replace("{ms}", &format!("{:.1}", tms))
                        .replace("{baseline_ms}", &format!("{:.1}", bms))
                        .replace("{share}", &format!("{:.0}", share_pct))
                        .replace("{thread}", default_thread_name)
                        .replace("{periodic_clause}", periodic_clause)
                };

                evidence.push(Evidence {
                    label,
                    value_ms: Some(tms),
                    baseline_ms: Some(bms),
                    calls: Some(calls),
                    thread: Some(default_thread_name.to_string()),
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

            let base_confidence = if match_score >= 0.70 {
                "high"
            } else if match_score >= 0.40 {
                "medium"
            } else {
                "low"
            };

            let match_confidence = if is_editor_build {
                match base_confidence {
                    "high" => "medium",
                    "medium" => "low",
                    _ => "low",
                }
            } else {
                base_confidence
            };

            // Frame limiter is an informational signal representing headroom; give it low rank so actual bottlenecks take priority
            let rank = if rule.def.id == "frame-limiter" {
                0.01 * match_score
            } else if is_editor_build && rule.def.id == "editor-overhead" {
                10000.0 * match_score
            } else {
                total_explains_ms * match_score
            };
            let channel_suggestion = match rule.def.id.as_str() {
                "unattributed-gap" => Some(ChannelSuggestion {
                    badge: "Need more details?".to_string(),
                    channel_flags: "-trace=cpu,loadtime,counters -cpuprofilertrace".to_string(),
                    description: "GameThread execution occurred outside active profiled Unreal scopes. Capture with -trace=cpu,loadtime,counters -cpuprofilertrace to pinpoint exact Blueprint events, actor ticks, and synchronous package loads.".to_string(),
                    missing_channels: ["cpu", "loadtime", "counters"]
                        .iter()
                        .filter(|&&c| !detected_channels.iter().any(|d| d == c))
                        .map(|&c| c.to_string())
                        .collect(),
                }),
                "async-load-finalization" => Some(ChannelSuggestion {
                    badge: "Need more details?".to_string(),
                    channel_flags: "-trace=loadtime,file -cpuprofilertrace".to_string(),
                    description: "Asset load finalization stalled the GameThread. Enable -trace=loadtime,file -cpuprofilertrace to correlate package loads with PostLoad execution.".to_string(),
                    missing_channels: ["loadtime", "file"]
                        .iter()
                        .filter(|&&c| !detected_channels.iter().any(|d| d == c))
                        .map(|&c| c.to_string())
                        .collect(),
                }),
                "render-flush" => Some(ChannelSuggestion {
                    badge: "Need more details?".to_string(),
                    channel_flags: "-trace=cpu,counters".to_string(),
                    description: "GameThread stalled on a render fence. Enable -trace=cpu,counters to diagnose RenderThread and GPU bottlenecks.".to_string(),
                    missing_channels: if !detected_channels.iter().any(|d| d == "counters") { vec!["counters".to_string()] } else { Vec::new() },
                }),
                "level-streaming" => Some(ChannelSuggestion {
                    badge: "Need more details?".to_string(),
                    channel_flags: "-trace=loadtime,world -cpuprofilertrace".to_string(),
                    description: "Level streaming or World Partition updates stalled the GameThread. Enable -trace=loadtime,world to trace cell activations.".to_string(),
                    missing_channels: vec!["loadtime".to_string()],
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
                "sync-load" => Some(ChannelSuggestion {
                    badge: "Need more details?".to_string(),
                    channel_flags: "-trace=loadtime,file -cpuprofilertrace".to_string(),
                    description: "Synchronous loading stalled the GameThread. Capture with -trace=loadtime,file -cpuprofilertrace to record exact .uasset package paths, disk read latency, and async loading stalls.".to_string(),
                    missing_channels: ["loadtime", "file"]
                        .iter()
                        .filter(|&&c| !detected_channels.iter().any(|d| d == c))
                        .map(|&c| c.to_string())
                        .collect(),
                }),
                "ui-slate-overhead" | "ui-slate" => Some(ChannelSuggestion {
                    badge: "Need more details?".to_string(),
                    channel_flags: "-trace=cpu -cpuprofilertrace".to_string(),
                    description: "Slate recorded generic container sweeps (Slate::Prepass / Slate::TickPlatform). Launch with -cpuprofilertrace (and execute 'Slate.EnableWidgetScopeCycleCounters 1' in development builds) to isolate specific UMG widget hierarchies (WBP_*).".to_string(),
                    missing_channels: if !detected_channels.iter().any(|d| d == "cpu") { vec!["cpu".to_string()] } else { Vec::new() },
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
                    channel_flags: "-trace=cpu -cpuprofilertrace".to_string(),
                    description: "Turn on 'Blueprint CPU Profiling' in Project Settings → Engine → General Settings (or launch with -cpuprofilertrace) to isolate individual Blueprint graphs, functions, and tick events.".to_string(),
                    missing_channels: if !detected_channels.iter().any(|d| d == "cpu") { vec!["cpu".to_string()] } else { Vec::new() },
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

    // 8. If no rule cleared thresholds, emit a single 'inconclusive' finding
    if findings.is_empty() {
        let total_excess: f64 = episodes.iter().map(|ep| (ep.peak_ms - ep.median_ms).max(0.0)).sum();
        let inconclusive_payload = FindingPayload {
            title: "Inconclusive performance anomaly".to_string(),
            match_confidence: "low".to_string(),
            match_score: 0.0,
            fix_likelihood: "low".to_string(),
            explains_ms: 0.0,
            of_excess_ms: total_excess,
            evidence: vec![Evidence {
                label: "No profiled timer exceeded baseline thresholds sufficiently to establish a root cause.".to_string(),
                value_ms: None,
                baseline_ms: None,
                calls: None,
                thread: None,
                note: Some("The hitch may be caused by uninstrumented code, OS scheduling preemption, or hardware throttling.".to_string()),
            }],
            fixes: vec![FixSuggestionDef {
                text: "Re-capture the trace with full engine channels enabled (-trace=cpu,gpu,frame,loadtime).".to_string(),
                effort: "low".to_string(),
                cvars_or_apis: None,
            }],
            verify: "Inspect thread timeline in Unreal Insights to look for timing gaps.".to_string(),
            caveats: vec![],
            episode_ids: episodes.iter().map(|e| e.id).collect(),
            period_s: None,
            channel_suggestion: None,
        };

        findings.push(DbFinding {
            id: next_finding_id,
            rule_id: "inconclusive".to_string(),
            rank: 0.0,
            match_confidence: 0.0,
            fix_likelihood: "low".to_string(),
            episode_ids: episodes.iter().map(|e| e.id).collect(),
            payload: serde_json::to_string(&inconclusive_payload).unwrap_or_default(),
        });
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

    let primary_finding = findings.iter().find(|f| f.rule_id != "frame-limiter").or_else(|| findings.first());

    if let Some(top) = primary_finding {
        let top_payload: Option<FindingPayload> = serde_json::from_str(&top.payload).ok();
        if let Some(p) = top_payload {
            if top.rule_id == "frame-limiter" {
                format!(
                    "Median {} fps ({} hitches, {} slow regions). Target framerate maintained with available performance headroom.",
                    fps, hitch_count, slow_region_count
                )
            } else {
                let confidence_str = match p.match_confidence.as_str() {
                    "high" => "high confidence",
                    "medium" => "moderate confidence",
                    _ => "low confidence",
                };
                format!(
                    "Median {} fps ({} hitches, {} slow regions). Primary bottleneck: {} ({}; fix likelihood: {}).",
                    fps, hitch_count, slow_region_count, p.title, confidence_str, p.fix_likelihood
                )
            }
        } else {
            format!("Median {} fps with {} detected performance episodes.", fps, hitch_count + slow_region_count)
        }
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
        assert_eq!(rules.len(), 18);
        assert!(rules.iter().any(|r| r.id == "gc-hitch"));
        assert!(rules.iter().any(|r| r.id == "sync-load"));
        assert!(rules.iter().any(|r| r.id == "async-load-finalization"));
        assert!(rules.iter().any(|r| r.id == "shader-compile"));
        assert!(rules.iter().any(|r| r.id == "pso-hitch"));
        assert!(rules.iter().any(|r| r.id == "bp-tick"));
        assert!(rules.iter().any(|r| r.id == "physics-cpu"));
        assert!(rules.iter().any(|r| r.id == "animation-cpu"));
        assert!(rules.iter().any(|r| r.id == "editor-overhead"));
        assert!(rules.iter().any(|r| r.id == "ui-slate-overhead"));
        assert!(rules.iter().any(|r| r.id == "gpu-bound"));
        assert!(rules.iter().any(|r| r.id == "render-cpu"));
        assert!(rules.iter().any(|r| r.id == "render-flush"));
        assert!(rules.iter().any(|r| r.id == "level-streaming"));
        assert!(rules.iter().any(|r| r.id == "unattributed-gap"));
        assert!(rules.iter().any(|r| r.id == "spawn-burst"));
        assert!(rules.iter().any(|r| r.id == "frame-limiter"));
        assert!(rules.iter().any(|r| r.id == "inconclusive"));
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
        assert_eq!(payload.match_confidence, "high");
    }

    #[test]
    fn test_editor_demotion() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();

        conn.execute("INSERT INTO threads (id, name, role) VALUES (1, 'GameThread', 'game')", []).unwrap();
        conn.execute("INSERT INTO timers (id, name, bucket, kind) VALUES (1, 'CollectGarbage', 'GC', 'work')", []).unwrap();
        conn.execute("INSERT INTO timers (id, name, bucket, kind) VALUES (2, 'UEditorEngine::Tick', 'Editor', 'editor_only')", []).unwrap();

        let episode = DbEpisode {
            id: 1,
            kind: "hitch".to_string(),
            start_s: 1.0,
            end_s: 1.1,
            frame_from: 100,
            frame_to: 101,
            peak_ms: 100.0,
            median_ms: 16.6,
            bound_by: "unattributed".to_string(),
            periodic_group: Some(1),
        };
        conn.execute(
            "INSERT INTO episodes (id, kind, start_s, end_s, frame_from, frame_to, peak_ms, median_ms, bound_by, periodic_group)
             VALUES (1, 'hitch', 1.0, 1.1, 100, 101, 100.0, 16.6, 'unattributed', 1)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO window_events (window_id, thread_id, timer_id, start_s, end_s, depth, excl_ms)
             VALUES (1, 1, 1, 1.0, 1.07, 0, 70.0)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO baseline_stats (scope, thread_id, timer_id, median_excl_ms, p95_excl_ms, median_calls, samples)
             VALUES ('global', 1, 1, 0.0, 0.0, 1.0, 10)",
            [],
        ).unwrap();

        let findings = evaluate_and_save_findings(&mut conn, &[episode]).unwrap();
        assert!(!findings.is_empty());
        let gc_finding = findings.iter().find(|f| f.rule_id == "gc-hitch").unwrap();
        let payload: FindingPayload = serde_json::from_str(&gc_finding.payload).unwrap();
        // Base confidence would be high, but demoted to medium due to editor build
        assert_eq!(payload.match_confidence, "medium");
    }

    #[test]
    fn test_format_timer_display_name() {
        assert_eq!(
            format_timer_display_name("Frame", "gpu-bound"),
            "GPU total frame duration"
        );
        assert_eq!(
            format_timer_display_name("ExecuteUbergraph_WBP_InventoryMenu", "bp-tick"),
            "Blueprint 'WBP_InventoryMenu' (ExecuteUbergraph)"
        );
        assert_eq!(
            format_timer_display_name("WBP_HealthBar_C::Tick", "ui-slate-overhead"),
            "Widget 'WBP_HealthBar' (Tick)"
        );
        assert_eq!(
            format_timer_display_name("BP_Enemy_C::ReceiveTick", "bp-tick"),
            "Blueprint 'BP_Enemy' (ReceiveTick)"
        );
        assert_eq!(
            format_timer_display_name("Function /Game/UI/WBP_Menu.WBP_Menu_C:Construct", "bp-tick"),
            "Blueprint 'WBP_Menu' (Construct)"
        );
        assert_eq!(
            format_timer_display_name("LoadPackage /Game/Maps/Level01", "sync-load"),
            "Package '/Game/Maps/Level01' (LoadPackage)"
        );
        assert_eq!(
            format_timer_display_name("Serialize /Game/Textures/T_Atlas", "sync-load"),
            "Package '/Game/Textures/T_Atlas' (Serialize)"
        );
        assert_eq!(
            format_timer_display_name("/Game/Characters/SK_Hero", "sync-load"),
            "Package '/Game/Characters/SK_Hero'"
        );
    }

    struct BaselineEntry {
        thread_id: i64,
        timer_name: &'static str,
        ms_per_frame: f64,
        calls_per_frame: usize,
    }

    const BASELINE_ENTRIES: &[BaselineEntry] = &[
        // Thread 1: GameThread (role: 'game')
        BaselineEntry { thread_id: 1, timer_name: "Frame", ms_per_frame: 0.15, calls_per_frame: 1 },
        BaselineEntry { thread_id: 1, timer_name: "Tick_Engine", ms_per_frame: 0.3, calls_per_frame: 1 },
        BaselineEntry { thread_id: 1, timer_name: "Slate::Tick (Time and Widgets)", ms_per_frame: 0.4, calls_per_frame: 1 },
        BaselineEntry { thread_id: 1, timer_name: "Slate::Prepass", ms_per_frame: 1.6, calls_per_frame: 1 },
        BaselineEntry { thread_id: 1, timer_name: "Slate_PaintSlowPath", ms_per_frame: 1.3, calls_per_frame: 1 },
        BaselineEntry { thread_id: 1, timer_name: "FEngineLoop_UpdateTimeAndHandleMaxTickRate", ms_per_frame: 8.2, calls_per_frame: 1 },
        BaselineEntry { thread_id: 1, timer_name: "WaitForTasks", ms_per_frame: 1.9, calls_per_frame: 3 },
        BaselineEntry { thread_id: 1, timer_name: "ExecuteUbergraph_BP_EnemyAI", ms_per_frame: 1.2, calls_per_frame: 6 },
        // Thread 2: RenderThread (role: 'render')
        BaselineEntry { thread_id: 2, timer_name: "InitViews", ms_per_frame: 1.5, calls_per_frame: 1 },
        BaselineEntry { thread_id: 2, timer_name: "GatherDynamicMeshElements", ms_per_frame: 0.9, calls_per_frame: 1 },
        BaselineEntry { thread_id: 2, timer_name: "WaitForTasks", ms_per_frame: 2.0, calls_per_frame: 4 },
        // Thread 4: GPU (role: 'gpu')
        BaselineEntry { thread_id: 4, timer_name: "Frame", ms_per_frame: 6.3, calls_per_frame: 1 },
        BaselineEntry { thread_id: 4, timer_name: "Scene", ms_per_frame: 3.0, calls_per_frame: 1 },
        BaselineEntry { thread_id: 4, timer_name: "LumenScreenProbeGather", ms_per_frame: 0.7, calls_per_frame: 1 },
        BaselineEntry { thread_id: 4, timer_name: "ShadowDepths", ms_per_frame: 0.5, calls_per_frame: 1 },
        BaselineEntry { thread_id: 4, timer_name: "Nanite::VisBuffer", ms_per_frame: 0.6, calls_per_frame: 1 },
    ];

    struct ScenarioContext {
        conn: Connection,
        timer_map: std::collections::HashMap<(i64, String), i64>,
        next_timer_id: i64,
    }

    impl ScenarioContext {
        fn new() -> Self {
            let conn = Connection::open_in_memory().unwrap();
            init_db(&conn).unwrap();

            // Seed threads
            conn.execute("INSERT INTO threads (id, name, role) VALUES (1, 'GameThread', 'game')", []).unwrap();
            conn.execute("INSERT INTO threads (id, name, role) VALUES (2, 'RenderThread', 'render')", []).unwrap();
            conn.execute("INSERT INTO threads (id, name, role) VALUES (4, 'GPU', 'gpu')", []).unwrap();

            // Seed sample frames to satisfy channel detection
            for i in 0..10 {
                conn.execute(
                    "INSERT INTO frames (idx, engine_frame, start_s, interval_ms, game_ms, render_ms, gpu_ms)
                     VALUES (?1, ?2, ?3, 16.6, 12.0, 10.0, 14.0)",
                    params![i, 1000 + i, (i as f64) * 0.0166],
                ).unwrap();
            }

            let bucket_rules = crate::trace::buckets::get_compiled_bucket_rules();
            let mut timer_map = std::collections::HashMap::new();
            let mut next_timer_id = 1;

            // Seed baseline timers
            for entry in BASELINE_ENTRIES {
                let key = (entry.thread_id, entry.timer_name.to_string());
                if !timer_map.contains_key(&key) {
                    let tid = next_timer_id;
                    next_timer_id += 1;
                    let (bucket, kind) = crate::trace::buckets::classify_timer(entry.timer_name, &bucket_rules);
                    conn.execute(
                        "INSERT INTO timers (id, name, bucket, kind) VALUES (?1, ?2, ?3, ?4)",
                        params![tid, entry.timer_name, bucket, kind],
                    ).unwrap();
                    timer_map.insert(key, tid);
                }

                let tid = timer_map[&(entry.thread_id, entry.timer_name.to_string())];
                conn.execute(
                    "INSERT INTO baseline_stats (scope, thread_id, timer_id, median_excl_ms, p95_excl_ms, median_calls, samples)
                     VALUES ('global', ?1, ?2, ?3, ?3, ?4, 10)",
                    params![entry.thread_id, tid, entry.ms_per_frame, entry.calls_per_frame as f64],
                ).unwrap();
            }

            Self {
                conn,
                timer_map,
                next_timer_id,
            }
        }

        fn get_or_create_timer(&mut self, thread_id: i64, timer_name: &str) -> i64 {
            let key = (thread_id, timer_name.to_string());
            if let Some(&tid) = self.timer_map.get(&key) {
                return tid;
            }
            let tid = self.next_timer_id;
            self.next_timer_id += 1;
            let bucket_rules = crate::trace::buckets::get_compiled_bucket_rules();
            let (bucket, kind) = crate::trace::buckets::classify_timer(timer_name, &bucket_rules);
            self.conn.execute(
                "INSERT INTO timers (id, name, bucket, kind) VALUES (?1, ?2, ?3, ?4)",
                params![tid, timer_name, bucket, kind],
            ).unwrap();
            self.timer_map.insert(key, tid);
            tid
        }

        fn seed_baseline_window_frames(&mut self, window_id: i64, num_frames: usize) {
            for f in 0..num_frames {
                let start_base = (f as f64) * 0.0166;
                for entry in BASELINE_ENTRIES {
                    let tid = self.timer_map[&(entry.thread_id, entry.timer_name.to_string())];
                    for call_idx in 0..entry.calls_per_frame {
                        let excl = entry.ms_per_frame / (entry.calls_per_frame as f64);
                        let s = start_base + (call_idx as f64) * 0.001;
                        self.conn.execute(
                            "INSERT INTO window_events (window_id, thread_id, timer_id, start_s, end_s, depth, excl_ms)
                             VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)",
                            params![window_id, entry.thread_id, tid, s, s + (excl / 1000.0), excl],
                        ).unwrap();
                    }
                }
            }
        }

        fn add_event(&mut self, window_id: i64, thread_id: i64, timer_name: &str, excl_ms: f64) {
            let tid = self.get_or_create_timer(thread_id, timer_name);
            self.conn.execute(
                "INSERT INTO window_events (window_id, thread_id, timer_id, start_s, end_s, depth, excl_ms)
                 VALUES (?1, ?2, ?3, 0.0, ?4, 0, ?5)",
                params![window_id, thread_id, tid, excl_ms / 1000.0, excl_ms],
            ).unwrap();
        }

        fn evaluate(&mut self, episode: DbEpisode) -> (Vec<DbFinding>, String) {
            self.conn.execute(
                "INSERT INTO episodes (id, kind, start_s, end_s, frame_from, frame_to, peak_ms, median_ms, bound_by, periodic_group)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    episode.id,
                    episode.kind,
                    episode.start_s,
                    episode.end_s,
                    episode.frame_from,
                    episode.frame_to,
                    episode.peak_ms,
                    episode.median_ms,
                    episode.bound_by,
                    episode.periodic_group,
                ],
            ).unwrap();

            let findings = evaluate_and_save_findings(&mut self.conn, &[episode.clone()]).unwrap();
            let bound_by: String = self.conn.query_row(
                "SELECT bound_by FROM episodes WHERE id = ?1",
                params![episode.id],
                |r| r.get(0),
            ).unwrap();

            (findings, bound_by)
        }
    }

    #[test]
    fn test_scenario_s1_cpu_stall() {
        let mut ctx = ScenarioContext::new();
        ctx.seed_baseline_window_frames(1, 6);
        // Injected: Thread 1 Frame extra 70ms stall
        ctx.add_event(1, 1, "Frame", 70.0);

        let ep = DbEpisode {
            id: 1,
            kind: "hitch".to_string(),
            start_s: 1.0,
            end_s: 1.1,
            frame_from: 100,
            frame_to: 101,
            peak_ms: 100.0,
            median_ms: 16.6,
            bound_by: "unattributed".to_string(),
            periodic_group: None,
        };

        let (findings, bound_by) = ctx.evaluate(ep);
        assert!(bound_by == "game" || bound_by == "unattributed", "bound_by was {}", bound_by);
        let rule_ids: Vec<&str> = findings.iter().map(|f| f.rule_id.as_str()).collect();
        assert_eq!(rule_ids, vec!["unattributed-gap"]);
    }

    #[test]
    fn test_scenario_s2_gc_pause() {
        let mut ctx = ScenarioContext::new();
        ctx.seed_baseline_window_frames(1, 6);
        // Injected: Thread 1 CollectGarbage 20ms, PerformReachabilityAnalysis 45ms, IncrementalPurgeGarbage 5ms
        ctx.add_event(1, 1, "CollectGarbage", 20.0);
        ctx.add_event(1, 1, "PerformReachabilityAnalysis", 45.0);
        ctx.add_event(1, 1, "IncrementalPurgeGarbage", 5.0);

        let ep = DbEpisode {
            id: 1,
            kind: "hitch".to_string(),
            start_s: 1.0,
            end_s: 1.1,
            frame_from: 100,
            frame_to: 101,
            peak_ms: 100.0,
            median_ms: 16.6,
            bound_by: "unattributed".to_string(),
            periodic_group: Some(1),
        };

        let (findings, bound_by) = ctx.evaluate(ep);
        assert_eq!(bound_by, "game");
        let rule_ids: Vec<&str> = findings.iter().map(|f| f.rule_id.as_str()).collect();
        assert_eq!(rule_ids, vec!["gc-hitch"]);
    }

    #[test]
    fn test_scenario_s3_heavy_gpu_region() {
        let mut ctx = ScenarioContext::new();
        // S3: 20 normal frames where GPU has Frame 14ms, LumenScreenProbeGather 3.5ms, ShadowDepths 2.5ms
        for f in 0..20 {
            let start_base = (f as f64) * 0.033;
            // CPU baseline
            for entry in BASELINE_ENTRIES.iter().filter(|e| e.thread_id != 4) {
                let tid = ctx.timer_map[&(entry.thread_id, entry.timer_name.to_string())];
                ctx.conn.execute(
                    "INSERT INTO window_events (window_id, thread_id, timer_id, start_s, end_s, depth, excl_ms)
                     VALUES (1, ?1, ?2, ?3, ?4, 0, ?5)",
                    params![entry.thread_id, tid, start_base, start_base + 0.001, entry.ms_per_frame],
                ).unwrap();
            }
            // GPU heavy
            let t_gpu_frame = ctx.get_or_create_timer(4, "Frame");
            let t_lumen = ctx.get_or_create_timer(4, "LumenScreenProbeGather");
            let t_shadow = ctx.get_or_create_timer(4, "ShadowDepths");
            let t_scene = ctx.get_or_create_timer(4, "Scene");
            let t_nanite = ctx.get_or_create_timer(4, "Nanite::VisBuffer");

            ctx.conn.execute("INSERT INTO window_events (window_id, thread_id, timer_id, start_s, end_s, depth, excl_ms) VALUES (1, 4, ?1, ?2, ?2, 0, 14.0)", params![t_gpu_frame, start_base]).unwrap();
            ctx.conn.execute("INSERT INTO window_events (window_id, thread_id, timer_id, start_s, end_s, depth, excl_ms) VALUES (1, 4, ?1, ?2, ?2, 0, 3.5)", params![t_lumen, start_base]).unwrap();
            ctx.conn.execute("INSERT INTO window_events (window_id, thread_id, timer_id, start_s, end_s, depth, excl_ms) VALUES (1, 4, ?1, ?2, ?2, 0, 2.5)", params![t_shadow, start_base]).unwrap();
            ctx.conn.execute("INSERT INTO window_events (window_id, thread_id, timer_id, start_s, end_s, depth, excl_ms) VALUES (1, 4, ?1, ?2, ?2, 0, 3.0)", params![t_scene, start_base]).unwrap();
            ctx.conn.execute("INSERT INTO window_events (window_id, thread_id, timer_id, start_s, end_s, depth, excl_ms) VALUES (1, 4, ?1, ?2, ?2, 0, 0.6)", params![t_nanite, start_base]).unwrap();
        }

        let ep = DbEpisode {
            id: 1,
            kind: "slow_region".to_string(),
            start_s: 1.0,
            end_s: 1.66,
            frame_from: 100,
            frame_to: 120,
            peak_ms: 50.0,
            median_ms: 30.0,
            bound_by: "unattributed".to_string(),
            periodic_group: None,
        };

        let (findings, bound_by) = ctx.evaluate(ep);
        assert_eq!(bound_by, "gpu");
        let rule_ids: Vec<&str> = findings.iter().map(|f| f.rule_id.as_str()).collect();
        assert_eq!(rule_ids, vec!["gpu-bound"]);
    }

    #[test]
    fn test_scenario_s4_blueprint_hitch() {
        let mut ctx = ScenarioContext::new();
        ctx.seed_baseline_window_frames(1, 6);
        // Baseline for ReceiveTick: 0.1ms
        let tid = ctx.get_or_create_timer(1, "Function /Game/Characters/BP_Enemy.BP_Enemy_C:ReceiveTick");
        ctx.conn.execute(
            "INSERT INTO baseline_stats (scope, thread_id, timer_id, median_excl_ms, p95_excl_ms, median_calls, samples)
             VALUES ('global', 1, ?1, 0.1, 0.1, 1.0, 10)",
            params![tid],
        ).unwrap();

        // Injected: 35ms ReceiveTick
        ctx.add_event(1, 1, "Function /Game/Characters/BP_Enemy.BP_Enemy_C:ReceiveTick", 35.0);

        let ep = DbEpisode {
            id: 1,
            kind: "hitch".to_string(),
            start_s: 1.0,
            end_s: 1.1,
            frame_from: 100,
            frame_to: 101,
            peak_ms: 100.0,
            median_ms: 16.6,
            bound_by: "unattributed".to_string(),
            periodic_group: None,
        };

        let (findings, bound_by) = ctx.evaluate(ep);
        assert_eq!(bound_by, "game");
        let rule_ids: Vec<&str> = findings.iter().map(|f| f.rule_id.as_str()).collect();
        assert_eq!(rule_ids, vec!["bp-tick"]);
    }

    #[test]
    fn test_scenario_s5_post_load_work() {
        let mut ctx = ScenarioContext::new();
        ctx.seed_baseline_window_frames(1, 6);
        // Injected: Thread 1 PostLoad 40ms
        ctx.add_event(1, 1, "PostLoad", 40.0);

        let ep = DbEpisode {
            id: 1,
            kind: "hitch".to_string(),
            start_s: 1.0,
            end_s: 1.1,
            frame_from: 100,
            frame_to: 101,
            peak_ms: 100.0,
            median_ms: 16.6,
            bound_by: "unattributed".to_string(),
            periodic_group: None,
        };

        let (findings, bound_by) = ctx.evaluate(ep);
        assert_eq!(bound_by, "game");
        let rule_ids: Vec<&str> = findings.iter().map(|f| f.rule_id.as_str()).collect();
        assert_eq!(rule_ids, vec!["async-load-finalization"]);
    }

    #[test]
    fn test_golden_trace_fixture_regression() {
        let mut ctx = ScenarioContext::new();
        ctx.seed_baseline_window_frames(1, 6);

        // Seed recorded multi-culprit trace episode: GameThread GC pause + Blueprint tick surge
        ctx.add_event(1, 1, "CollectGarbage", 48.0);
        ctx.add_event(1, 1, "PerformReachabilityAnalysis", 22.0);

        let ep = DbEpisode {
            id: 1,
            kind: "hitch".to_string(),
            start_s: 2.0,
            end_s: 2.1,
            frame_from: 120,
            frame_to: 121,
            peak_ms: 85.0,
            median_ms: 16.6,
            bound_by: "unattributed".to_string(),
            periodic_group: Some(1),
        };

        let (findings, bound_by) = ctx.evaluate(ep);
        assert_eq!(bound_by, "game");
        assert!(!findings.is_empty());
        assert_eq!(findings[0].rule_id, "gc-hitch");
        assert!(findings[0].payload.contains("CollectGarbage"));
    }

    #[test]
    fn test_scenario_s6_pso_hitch() {
        let mut ctx = ScenarioContext::new();
        ctx.seed_baseline_window_frames(1, 6);
        // Injected: Thread 2 CreateGraphicsPipelineState 30ms, PSOPrecache 12ms
        ctx.add_event(1, 2, "CreateGraphicsPipelineState", 30.0);
        ctx.add_event(1, 2, "PSOPrecache", 12.0);

        let ep = DbEpisode {
            id: 1,
            kind: "hitch".to_string(),
            start_s: 1.0,
            end_s: 1.1,
            frame_from: 100,
            frame_to: 101,
            peak_ms: 100.0,
            median_ms: 16.6,
            bound_by: "unattributed".to_string(),
            periodic_group: None,
        };

        let (findings, bound_by) = ctx.evaluate(ep);
        assert_eq!(bound_by, "render");
        let rule_ids: Vec<&str> = findings.iter().map(|f| f.rule_id.as_str()).collect();
        assert_eq!(rule_ids, vec!["pso-hitch"]);
    }

    #[test]
    fn test_scenario_s7_render_thread_hitch() {
        let mut ctx = ScenarioContext::new();
        ctx.seed_baseline_window_frames(1, 6);
        // Injected: Thread 2 InitViews 60ms
        ctx.add_event(1, 2, "InitViews", 60.0);

        let ep = DbEpisode {
            id: 1,
            kind: "hitch".to_string(),
            start_s: 1.0,
            end_s: 1.1,
            frame_from: 100,
            frame_to: 101,
            peak_ms: 100.0,
            median_ms: 16.6,
            bound_by: "unattributed".to_string(),
            periodic_group: None,
        };

        let (findings, bound_by) = ctx.evaluate(ep);
        assert_eq!(bound_by, "render");
        let rule_ids: Vec<&str> = findings.iter().map(|f| f.rule_id.as_str()).collect();
        assert_eq!(rule_ids, vec!["render-cpu"]);
    }

    #[test]
    fn test_scenario_s8_inconclusive() {
        let mut ctx = ScenarioContext::new();
        ctx.seed_baseline_window_frames(1, 6);
        // Nothing extra added

        let ep = DbEpisode {
            id: 1,
            kind: "hitch".to_string(),
            start_s: 1.0,
            end_s: 1.1,
            frame_from: 100,
            frame_to: 101,
            peak_ms: 40.0,
            median_ms: 40.0,
            bound_by: "unattributed".to_string(),
            periodic_group: None,
        };

        let (findings, bound_by) = ctx.evaluate(ep);
        assert_eq!(bound_by, "unattributed");
        let rule_ids: Vec<&str> = findings.iter().map(|f| f.rule_id.as_str()).collect();
        assert_eq!(rule_ids, vec!["inconclusive"]);
    }
}
