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
    }
}
