use regex::Regex;
use rusqlite::{params, Connection};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct BucketRuleDef {
    pub pattern: String,
    pub bucket: String,
    pub kind: String, // "work" | "wait" | "idle" | "editor_only"
}

pub struct CompiledBucketRule {
    pub regex: Regex,
    pub bucket: String,
    pub kind: String,
}

pub fn get_compiled_bucket_rules() -> Vec<CompiledBucketRule> {
    const BUCKETS_JSON: &str = include_str!("../../resources/trace/buckets.json");
    let defs: Vec<BucketRuleDef> = serde_json::from_str(BUCKETS_JSON).unwrap_or_default();

    let mut compiled = Vec::with_capacity(defs.len());
    for d in defs {
        if let Ok(re) = Regex::new(&d.pattern) {
            compiled.push(CompiledBucketRule {
                regex: re,
                bucket: d.bucket,
                kind: d.kind,
            });
        }
    }
    compiled
}

pub fn classify_timer(name: &str, rules: &[CompiledBucketRule]) -> (String, String) {
    for r in rules {
        if r.regex.is_match(name) {
            return (r.bucket.clone(), r.kind.clone());
        }
    }
    ("Other".to_string(), "work".to_string())
}

pub fn map_bucket_to_fixed_category(bucket: &str) -> &'static str {
    match bucket {
        "GPU" | "Render CPU" | "RHI" | "ShaderCompile/PSO" | "Niagara/FX" => "Rendering & GPU",
        "Blueprint" | "Spawning" => "Blueprints & Script",
        "UI / Slate" => "UI & Slate",
        "GC" => "Garbage Collection",
        "Animation" | "Physics" => "Animation & Physics",
        "Loading" | "Streaming" => "Asset Loading & Streaming",
        _ => "Other / Engine System",
    }
}

pub fn update_timers_classification(conn: &mut Connection) -> Result<(), String> {
    let rules = get_compiled_bucket_rules();

    let mut timers: Vec<(i64, String)> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, name FROM timers")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?;
        for r in rows {
            timers.push(r.map_err(|e| e.to_string())?);
        }
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut update_stmt = tx
            .prepare("UPDATE timers SET bucket = ?1, kind = ?2 WHERE id = ?3")
            .map_err(|e| e.to_string())?;

        for (id, name) in timers {
            let (bucket, kind) = classify_timer(&name, &rules);
            update_stmt
                .execute(params![bucket, kind, id])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_timer_classification() {
        let rules = get_compiled_bucket_rules();
        assert!(!rules.is_empty());

        let (b1, k1) = classify_timer("CollectGarbage", &rules);
        assert_eq!(b1, "GC");
        assert_eq!(k1, "work");

        let (b2, k2) = classify_timer("WaitForTasks", &rules);
        assert_eq!(b2, "Wait");
        assert_eq!(k2, "wait");

        let (b3, k3) = classify_timer("FEngineLoop_UpdateTimeAndHandleMaxTickRate", &rules);
        assert_eq!(b3, "Idle");
        assert_eq!(k3, "idle");

        let (b4, k4) = classify_timer("Slate::DrawWindows", &rules);
        assert_eq!(b4, "UI / Slate");
        assert_eq!(k4, "work");

        let (b_ed, k_ed) = classify_timer("UEditorEngine::Tick", &rules);
        assert_eq!(b_ed, "Editor");
        assert_eq!(k_ed, "editor_only");

        let (b5, k5) = classify_timer("StaticLoadObject", &rules);
        assert_eq!(b5, "Loading");
        assert_eq!(k5, "work");

        let (b_bp, k_bp) = classify_timer("Function /Game/Characters/BP_Enemy.BP_Enemy_C:ReceiveTick", &rules);
        assert_eq!(b_bp, "Blueprint");
        assert_eq!(k_bp, "work");

        let (b_pso, k_pso) = classify_timer("PSOPrecache", &rules);
        assert_eq!(b_pso, "ShaderCompile/PSO");
        assert_eq!(k_pso, "work");

        let (b_lumen, k_lumen) = classify_timer("LumenScreenProbeGather", &rules);
        assert_eq!(b_lumen, "GPU");
        assert_eq!(k_lumen, "work");

        let (b_views, k_views) = classify_timer("InitViews", &rules);
        assert_eq!(b_views, "Render CPU");
        assert_eq!(k_views, "work");

        // Specific UE rendering timers requested by user
        let (b_scene, _) = classify_timer("Scene Render", &rules);
        assert_eq!(b_scene, "GPU");
        assert_eq!(map_bucket_to_fixed_category(&b_scene), "Rendering & GPU");

        let (b_scenerender, _) = classify_timer("SceneRender", &rules);
        assert_eq!(b_scenerender, "GPU");
        assert_eq!(map_bucket_to_fixed_category(&b_scenerender), "Rendering & GPU");

        let (b_cas, _) = classify_timer("Contrast Adaptive Shading", &rules);
        assert_eq!(b_cas, "GPU");
        assert_eq!(map_bucket_to_fixed_category(&b_cas), "Rendering & GPU");

        let (b_cas2, _) = classify_timer("ContrastAdaptiveSharpening", &rules);
        assert_eq!(b_cas2, "GPU");
        assert_eq!(map_bucket_to_fixed_category(&b_cas2), "Rendering & GPU");

        let (b_cas3, _) = classify_timer("CAS", &rules);
        assert_eq!(b_cas3, "GPU");
        assert_eq!(map_bucket_to_fixed_category(&b_cas3), "Rendering & GPU");

        let (b_pdraw, _) = classify_timer("Parallel Draw", &rules);
        assert_eq!(b_pdraw, "Render CPU");
        assert_eq!(map_bucket_to_fixed_category(&b_pdraw), "Rendering & GPU");

        let (b_pdraw2, _) = classify_timer("ParallelDraw", &rules);
        assert_eq!(b_pdraw2, "Render CPU");
        assert_eq!(map_bucket_to_fixed_category(&b_pdraw2), "Rendering & GPU");

        let (b_vsm, _) = classify_timer("VirtualShadowMap", &rules);
        assert_eq!(b_vsm, "GPU");
        assert_eq!(map_bucket_to_fixed_category(&b_vsm), "Rendering & GPU");

        let (b_tsr, _) = classify_timer("TemporalSuperResolution", &rules);
        assert_eq!(b_tsr, "GPU");
        assert_eq!(map_bucket_to_fixed_category(&b_tsr), "Rendering & GPU");

        let (b_tonemap, _) = classify_timer("Tonemap", &rules);
        assert_eq!(b_tonemap, "GPU");
        assert_eq!(map_bucket_to_fixed_category(&b_tonemap), "Rendering & GPU");

        let (b_rhi, _) = classify_timer("FRHICommandListExecutor::ExecuteList", &rules);
        assert_eq!(b_rhi, "RHI");
        assert_eq!(map_bucket_to_fixed_category(&b_rhi), "Rendering & GPU");

        let (b_wp, _) = classify_timer("WorldPartitionStreaming", &rules);
        assert_eq!(b_wp, "Streaming");
        assert_eq!(map_bucket_to_fixed_category(&b_wp), "Asset Loading & Streaming");

        assert_eq!(map_bucket_to_fixed_category("GPU"), "Rendering & GPU");
        assert_eq!(map_bucket_to_fixed_category("Render CPU"), "Rendering & GPU");
        assert_eq!(map_bucket_to_fixed_category("Blueprint"), "Blueprints & Script");
        assert_eq!(map_bucket_to_fixed_category("UI / Slate"), "UI & Slate");
        assert_eq!(map_bucket_to_fixed_category("GC"), "Garbage Collection");
        assert_eq!(map_bucket_to_fixed_category("Animation"), "Animation & Physics");
        assert_eq!(map_bucket_to_fixed_category("Loading"), "Asset Loading & Streaming");
        assert_eq!(map_bucket_to_fixed_category("Other"), "Other / Engine System");
    }
}
