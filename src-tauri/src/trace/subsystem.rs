use regex::Regex;
use serde::Deserialize;

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RawSubsystem {
    id: String,
    label: Option<String>,
    #[serde(default)]
    r#match: Vec<String>,
    #[serde(default)]
    view_counter: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct CompiledSubsystem {
    pub id: String,
    pub label: String,
    pub match_regexes: Vec<Regex>,
    pub view_counter_regexes: Vec<Regex>,
}

pub fn load_subsystems() -> Vec<CompiledSubsystem> {
    let raw_json = include_str!("../../resources/trace/subsystems.json");
    let raw_subsystems: Vec<RawSubsystem> =
        serde_json::from_str(raw_json).expect("Failed to parse subsystems.json");

    raw_subsystems
        .into_iter()
        .map(|r| {
            let match_regexes = r
                .r#match
                .iter()
                .filter_map(|p| Regex::new(p).ok())
                .collect();
            let view_counter_regexes = r
                .view_counter
                .iter()
                .filter_map(|p| Regex::new(p).ok())
                .collect();
            CompiledSubsystem {
                label: r.label.unwrap_or_else(|| r.id.clone()),
                id: r.id,
                match_regexes,
                view_counter_regexes,
            }
        })
        .collect()
}

pub fn classify(subsystems: &[CompiledSubsystem], name: &str, path: &str) -> String {
    let name_trimmed = name.trim();
    if name_trimmed.is_empty() {
        return "other".to_string();
    }

    // Build candidates list: first `name`, then ancestors from nearest to farthest
    let mut candidates = vec![name_trimmed];

    let path_parts: Vec<&str> = if !path.is_empty() {
        path.split(" > ")
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect()
    } else {
        Vec::new()
    };

    // If path ends with name, take ancestors before it in reverse
    if !path_parts.is_empty() {
        let mut ancestors: Vec<&str> = path_parts.clone();
        if let Some(last) = ancestors.last() {
            if *last == name_trimmed {
                ancestors.pop();
            }
        }
        for ancestor in ancestors.into_iter().rev() {
            if ancestor != name_trimmed {
                candidates.push(ancestor);
            }
        }
    }

    for candidate in candidates {
        for sub in subsystems {
            if sub.id == "other" {
                continue;
            }
            for re in &sub.match_regexes {
                if re.is_match(candidate) {
                    return sub.id.clone();
                }
            }
        }
    }

    "other".to_string()
}

pub fn is_view_counter(subsystems: &[CompiledSubsystem], subsystem_id: &str, timer_name: &str) -> bool {
    if let Some(sub) = subsystems.iter().find(|s| s.id == subsystem_id) {
        for re in &sub.view_counter_regexes {
            if re.is_match(timer_name) {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_subsystems() {
        let subsystems = load_subsystems();
        assert!(!subsystems.is_empty());
        assert!(subsystems.iter().any(|s| s.id == "nanite"));
        assert!(subsystems.iter().any(|s| s.id == "shadow-depths"));
        assert!(subsystems.iter().any(|s| s.id == "niagara"));
        assert!(subsystems.iter().any(|s| s.id == "other"));
    }

    #[test]
    fn test_classify_path_and_leaf() {
        let subsystems = load_subsystems();

        // 1. Direct leaf match for Nanite
        assert_eq!(
            classify(
                &subsystems,
                "MainPass",
                "Frame > SceneRender > Nanite::VisBuffer > Nanite::DrawGeometry > MainPass"
            ),
            "nanite"
        );

        // 2. Ancestor match for ShadowDepths
        assert_eq!(
            classify(
                &subsystems,
                "Face",
                "Frame > SceneRender > ShadowDepths > Cubemap > Nanite Cubemap > Face"
            ),
            "shadow-depths"
        );

        // 3. Fallback / Wait
        assert_eq!(classify(&subsystems, "ReflexSleep", ""), "other");

        // 4. Niagara simulation
        assert_eq!(
            classify(&subsystems, "FXSystemPreRender", "Frame > FXSystemPreRender"),
            "niagara"
        );

        // 5. NodeAndClusterCull leaf
        assert_eq!(
            classify(&subsystems, "NodeAndClusterCull", "Frame > SceneRender > NodeAndClusterCull"),
            "nanite"
        );
    }

    #[test]
    fn test_view_counter() {
        let subsystems = load_subsystems();
        assert!(is_view_counter(&subsystems, "nanite", "Nanite::DrawGeometry"));
        assert!(!is_view_counter(&subsystems, "nanite", "MainPass"));
        assert!(is_view_counter(&subsystems, "shadow-depths", "Face"));
        assert!(is_view_counter(&subsystems, "shadow-depths", "RenderDepthForLight"));
    }
}
