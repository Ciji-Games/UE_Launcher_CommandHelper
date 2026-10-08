//! Project-related commands - analyse_uproject, get_project_thumbnail_path, etc.
//! Step 6 & 7 implementation

use std::path::Path;
use tauri::async_runtime::spawn_blocking;
use walkdir::WalkDir;

use crate::commands::registry;
use crate::types::{EngineEntry, ProjectInfo};

#[derive(serde::Deserialize)]
struct UProjectJson {
    #[serde(rename = "EngineAssociation")]
    engine_association: Option<String>,
}

fn parse_semver(ver: &str) -> (u32, u32, u32) {
    let parts: Vec<u32> = ver
        .split('.')
        .filter_map(|p| p.parse::<u32>().ok())
        .collect();
    (
        *parts.get(0).unwrap_or(&0),
        *parts.get(1).unwrap_or(&0),
        *parts.get(2).unwrap_or(&0),
    )
}

/// Match an engine association string against discovered engines.
/// Handles GUIDs (with or without braces), full versions, Major.Minor ("5.4"),
/// and Major-only ("5") associations.
pub(crate) fn match_engine<'a>(
    engine_association: &str,
    engines: &'a [EngineEntry],
) -> Option<&'a EngineEntry> {
    let assoc = engine_association.trim();
    if assoc.is_empty() || assoc.eq_ignore_ascii_case("Unknown") {
        return None;
    }

    let clean_guid = assoc.trim_matches('{').trim_matches('}');

    // 1. Exact GUID / ID match (with or without braces, case-insensitive)
    for engine in engines {
        if let Some(id) = &engine.id {
            let clean_id = id.trim_matches('{').trim_matches('}');
            if clean_id.eq_ignore_ascii_case(clean_guid) {
                return Some(engine);
            }
        }
    }

    let clean_assoc = assoc
        .strip_prefix("UE_")
        .or_else(|| assoc.strip_prefix("ue_"))
        .unwrap_or(assoc);

    // 2. Exact version match (e.g. "5.4.4" == "5.4.4")
    for engine in engines {
        if engine.version.eq_ignore_ascii_case(clean_assoc) {
            return Some(engine);
        }
    }

    // 3. Major.Minor prefix match (e.g. "5.4" matches "5.4.4")
    let mut minor_matches: Vec<&'a EngineEntry> = engines
        .iter()
        .filter(|e| {
            if clean_assoc.is_empty() {
                return false;
            }
            if e.version.starts_with(clean_assoc) {
                let next_char = e.version.as_bytes().get(clean_assoc.len());
                next_char.is_none() || next_char == Some(&b'.')
            } else {
                false
            }
        })
        .collect();
    if !minor_matches.is_empty() {
        minor_matches.sort_by_key(|e| parse_semver(&e.version));
        return minor_matches.last().copied();
    }

    // 4. Major-only match (e.g. "5" matches "5.4.4" or "5.5.0")
    if clean_assoc.chars().all(|c| c.is_ascii_digit()) {
        let prefix = format!("{}.", clean_assoc);
        let mut major_matches: Vec<&'a EngineEntry> = engines
            .iter()
            .filter(|e| e.version == clean_assoc || e.version.starts_with(&prefix))
            .collect();
        if !major_matches.is_empty() {
            major_matches.sort_by_key(|e| parse_semver(&e.version));
            return major_matches.last().copied();
        }
    }

    // 5. Match by editor path
    for engine in engines {
        if engine.editor_path.eq_ignore_ascii_case(assoc) {
            return Some(engine);
        }
    }

    None
}

/// Analyse a .uproject file and return ProjectInfo.
/// Mirrors Form1.AnalyseUprojectFile from UECommandHelper.
#[tauri::command]
pub async fn analyse_uproject(path: String) -> Result<ProjectInfo, String> {
    spawn_blocking(move || analyse_uproject_impl(path))
        .await
        .map_err(|e| format!("Project scan task failed: {}", e))?
}

fn analyse_uproject_impl(path: String) -> Result<ProjectInfo, String> {
    let uproj_path = Path::new(&path);
    if !uproj_path.exists() || uproj_path.extension().map_or(true, |e| e != "uproject") {
        return Err("Invalid or missing .uproject file".to_string());
    }

    let project_name = uproj_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown")
        .to_string();

    let project_dir = uproj_path.parent().ok_or("Invalid project path")?;

    // Parse EngineAssociation from .uproject JSON
    let engine_version = {
        let content = std::fs::read_to_string(uproj_path)
            .map_err(|e| format!("Failed to read .uproject: {}", e))?;
        let json: UProjectJson = serde_json::from_str(&content).unwrap_or(UProjectJson {
            engine_association: None,
        });
        json.engine_association
            .unwrap_or_else(|| "Unknown".to_string())
    };

    let maps = scan_maps_for_project_dir(project_dir);

    // Check for Source/ folder → is_cpp
    let source_dir = project_dir.join("Source");
    let is_cpp = source_dir.exists();

    // Match engine path from registry (project may have "5.7", engine "5.7.1", "5", or a GUID)
    let installed_engines = registry::discover_installed_engine_paths()
        .ok()
        .unwrap_or_default();

    let matched_engine = match_engine(&engine_version, &installed_engines);

    let engine_install_path = matched_engine
        .map(|e| e.editor_path.clone())
        .unwrap_or_else(|| "Unknown".to_string());

    let final_engine_version = matched_engine
        .map(|e| e.version.clone())
        .unwrap_or(engine_version);

    Ok(ProjectInfo {
        project_path: path,
        project_name,
        engine_version: final_engine_version,
        engine_install_path,
        is_cpp,
        maps,
    })
}

/// Resolve project thumbnail path. Returns first existing:
/// 1. {projectDir}/{projectName}.png
/// 2. {projectDir}/Saved/AutoScreenshot.png
/// Mirrors LauncherBtn.LoadPicture from UECommandHelper.
#[tauri::command]
pub fn get_project_thumbnail_path(project_path: String) -> Result<Option<String>, String> {
    let path = Path::new(&project_path);
    let project_dir = path.parent().ok_or("Invalid project path")?;
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");

    // 1. .png next to .uproject
    let png_next = project_dir.join(format!("{}.png", stem));
    if png_next.exists() {
        return Ok(Some(png_next.to_string_lossy().to_string()));
    }

    // 2. Saved/AutoScreenshot.png
    let screenshot = project_dir.join("Saved").join("AutoScreenshot.png");
    if screenshot.exists() {
        return Ok(Some(screenshot.to_string_lossy().to_string()));
    }

    Ok(None)
}

/// Filter a list of paths to only those that exist. Returns paths that exist.
#[tauri::command]
pub async fn filter_existing_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    spawn_blocking(move || filter_existing_paths_impl(paths))
        .await
        .map_err(|e| format!("Path validation task failed: {}", e))?
}

fn filter_existing_paths_impl(paths: Vec<String>) -> Result<Vec<String>, String> {
    Ok(paths.into_iter().filter(|p| Path::new(p).exists()).collect())
}

fn scan_maps_for_project_dir(project_dir: &Path) -> Vec<String> {
    let content_dir = project_dir.join("Content");
    if !content_dir.exists() {
        return vec![];
    }
    WalkDir::new(&content_dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map_or(false, |ext| ext == "umap"))
        .map(|e| {
            let rel = e.path().strip_prefix(&content_dir).unwrap_or(e.path());
            let path_str = rel.with_extension("").to_string_lossy().replace('\\', "/");
            format!("/Game/{}", path_str)
        })
        .collect()
}

/// Scan Content/ for *.umap files and return map paths in /Game/... format.
/// Used to refresh maps when project still exists (new or deleted maps).
#[tauri::command]
pub async fn scan_project_maps(project_path: String) -> Result<Vec<String>, String> {
    spawn_blocking(move || scan_project_maps_impl(project_path))
        .await
        .map_err(|e| format!("Map scan task failed: {}", e))?
}

fn scan_project_maps_impl(project_path: String) -> Result<Vec<String>, String> {
    let path = Path::new(&project_path);
    if !path.exists() || path.extension().map_or(true, |e| e != "uproject") {
        return Err("Invalid or missing .uproject file".to_string());
    }
    let project_dir = path.parent().ok_or("Invalid project path")?;
    Ok(scan_maps_for_project_dir(project_dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_match_engine_by_guid() {
        let engines = vec![
            EngineEntry {
                version: "5.4.4".to_string(),
                editor_path: r"D:\Epic Games\UE_5.4\Engine\Binaries\Win64\UnrealEditor.exe".to_string(),
                display_name: None,
                is_custom: false,
                id: Some("{12345678-ABCD-EF01-2345-6789ABCDEF01}".to_string()),
            },
        ];

        // Match with braces
        let matched = match_engine("{12345678-ABCD-EF01-2345-6789ABCDEF01}", &engines);
        assert!(matched.is_some());
        assert_eq!(matched.unwrap().version, "5.4.4");

        // Match without braces, lowercase
        let matched_lower = match_engine("12345678-abcd-ef01-2345-6789abcdef01", &engines);
        assert!(matched_lower.is_some());
        assert_eq!(matched_lower.unwrap().version, "5.4.4");
    }

    #[test]
    fn test_match_engine_by_version_formats() {
        let engines = vec![
            EngineEntry {
                version: "5.3.2".to_string(),
                editor_path: r"C:\Program Files\Epic Games\UE_5.3\Engine\Binaries\Win64\UnrealEditor.exe".to_string(),
                display_name: None,
                is_custom: false,
                id: None,
            },
            EngineEntry {
                version: "5.4.4".to_string(),
                editor_path: r"D:\Epic Games\UE_5.4\Engine\Binaries\Win64\UnrealEditor.exe".to_string(),
                display_name: None,
                is_custom: false,
                id: None,
            },
        ];

        // Exact match
        assert_eq!(match_engine("5.4.4", &engines).unwrap().editor_path, engines[1].editor_path);

        // Major.Minor match
        assert_eq!(match_engine("5.4", &engines).unwrap().editor_path, engines[1].editor_path);
        assert_eq!(match_engine("UE_5.4", &engines).unwrap().editor_path, engines[1].editor_path);

        // Major-only match ("5" should resolve to latest 5.x)
        assert_eq!(match_engine("5", &engines).unwrap().version, "5.4.4");
        assert_eq!(match_engine("UE_5", &engines).unwrap().version, "5.4.4");

        // Unknown / empty associations
        assert!(match_engine("", &engines).is_none());
        assert!(match_engine("Unknown", &engines).is_none());
        assert!(match_engine("6.0", &engines).is_none());
    }
}
