//! Project-related commands - analyse_uproject, get_project_thumbnail_path, etc.
//! Step 6 & 7 implementation

use std::path::Path;
use tauri::async_runtime::spawn_blocking;
use walkdir::WalkDir;

use crate::commands::registry;
use crate::types::ProjectInfo;

#[derive(serde::Deserialize)]
struct UProjectJson {
    #[serde(rename = "EngineAssociation")]
    engine_association: Option<String>,
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

    // Match engine path from registry (project may have "5.7", engine "5.7.1", or a GUID)
    // Require version boundary to avoid "4" matching "41.0.0"
    let installed_engines = registry::discover_installed_engine_paths()
        .ok()
        .unwrap_or_default();

    let matched_engine = installed_engines.iter().find(|e| {
        if engine_version.is_empty() || engine_version == "Unknown" {
            return false;
        }
        // Match by GUID (id) if available
        if let Some(id) = &e.id {
            if id == &engine_version {
                return true;
            }
        }
        // Match by version string
        e.version == engine_version
            || (engine_version.len() <= e.version.len()
                && e.version.starts_with(&engine_version)
                && (e.version.len() == engine_version.len()
                    || e.version.as_bytes().get(engine_version.len()) == Some(&b'.')))
    });

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
