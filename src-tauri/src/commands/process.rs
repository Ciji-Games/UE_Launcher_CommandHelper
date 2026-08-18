//! Process utilities - spawn, kill, run_command, open_file
//! Reuses pattern from webdev launcher

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tauri::AppHandle;
use serde::Serialize;

use crate::running_process;
use crate::stream_processor;
use crate::utils::{build_cmd, kill_pid};

/// Stop the currently running tool (Cook, Package, Build, etc.).
/// Uses taskkill /T /F to terminate the process and its child tree.
#[tauri::command]
pub fn stop_running_process(app: AppHandle) -> Result<(), String> {
    let pid = running_process::take_running_pid().ok_or("No process is currently running.")?;
    kill_pid(pid)?;
    stream_processor::emit_log(&app, "Process stopped by user.", Some("orange"));
    stream_processor::emit_progress(&app, 100, 0);
    Ok(())
}

/// Launch a project with a specific map. Spawns UnrealEditor.exe with project_path and map_path.
/// Uses cmd /c start so the editor opens in a visible window.
#[tauri::command]
pub fn launch_project_with_map(
    project_path: String,
    map_path: String,
    engine_path: String,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        if engine_path == "Unknown" || !std::path::Path::new(&engine_path).exists() {
            return Err(
                "Engine path not found. Ensure the project uses an installed engine.".to_string(),
            );
        }
        // start "" "exe" "arg1" "arg2" - empty title, then exe and args
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &engine_path, &project_path, &map_path])
            .creation_flags(0x0800_0000u32) // CREATE_NO_WINDOW for cmd
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let _ = (project_path, map_path, engine_path);
        return Err("launch_project_with_map is only supported on Windows".to_string());
    }
    Ok(())
}

/// Open a .uproject file with Rider, bypassing default file association.
/// If rider_path is provided and exists, use it. Otherwise search common install locations.
/// Falls back to open_file with .sln if Rider is not found.
#[tauri::command]
pub fn open_uproject_with_rider(
    uproject_path: String,
    rider_path: Option<String>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let rider_exe = rider_path
            .filter(|p| std::path::Path::new(p).exists())
            .or_else(find_rider_exe);

        match rider_exe {
            Some(exe) => {
                std::process::Command::new("cmd")
                    .args(["/c", "start", "", &exe, &uproject_path])
                    .creation_flags(0x0800_0000u32) // CREATE_NO_WINDOW
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
            None => {
                // Fallback: open .sln with default association
                let sln_path = if uproject_path.to_lowercase().ends_with(".uproject") {
                    uproject_path[..uproject_path.len() - 9].to_string() + ".sln"
                } else {
                    uproject_path + ".sln"
                };
                return open_file(sln_path);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (uproject_path, rider_path);
        return Err("open_uproject_with_rider is only supported on Windows".to_string());
    }
    Ok(())
}

/// Launch preferred IDE for a C++ project.
/// - rider => opens .uproject in Rider
/// - visual_studio => opens .sln in selected devenv.exe (or shell association fallback)
#[tauri::command]
pub fn launch_ide_for_project(
    uproject_path: String,
    ide_kind: String,
    ide_exe_path: Option<String>,
) -> Result<(), String> {
    let sln_path = if uproject_path.to_lowercase().ends_with(".uproject") {
        uproject_path[..uproject_path.len() - 9].to_string() + ".sln"
    } else {
        uproject_path.clone() + ".sln"
    };

    #[cfg(windows)]
    {
        let kind = ide_kind.to_lowercase();
        if kind == "rider" {
            return open_uproject_with_rider(uproject_path, ide_exe_path);
        }
        if kind == "visual_studio" {
            let vs_exe = ide_exe_path.filter(|p| std::path::Path::new(p).exists());
            if let Some(exe) = vs_exe {
                std::process::Command::new("cmd")
                    .args(["/c", "start", "", &exe, &sln_path])
                    .creation_flags(0x0800_0000u32)
                    .spawn()
                    .map_err(|e| e.to_string())?;
                return Ok(());
            }
            return open_file(sln_path);
        }
        return open_file(sln_path);
    }
    #[cfg(not(windows))]
    {
        let _ = (uproject_path, ide_kind, ide_exe_path, sln_path);
        Err("launch_ide_for_project is only supported on Windows".to_string())
    }
}

#[cfg(windows)]
fn find_rider_exe() -> Option<String> {
    use std::path::Path;

    let local_app_data = std::env::var("LOCALAPPDATA").ok()?;
    let program_files = std::env::var("PROGRAMFILES").ok()?;
    let program_files_x86 = std::env::var("PROGRAMFILES(X86)").unwrap_or_default();

    let toolbox_roots = [
        format!("{}\\JetBrains\\Toolbox\\apps\\Rider", local_app_data),
        format!("{}\\JetBrains\\Toolbox\\apps\\Rider\\ch-0", local_app_data),
    ];
    for root in &toolbox_roots {
        let root_path = Path::new(root);
        if !root_path.exists() {
            continue;
        }
        if let Some(p) = scan_rider_under(root_path) {
            return Some(p);
        }
    }

    let search_bases = [
        format!("{}\\Programs", local_app_data),
        format!("{}\\JetBrains", program_files),
        format!("{}\\JetBrains", program_files_x86),
    ];

    for base in &search_bases {
        let base_path = Path::new(base);
        if !base_path.exists() {
            continue;
        }
        let entries = match std::fs::read_dir(base_path) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            let path = entry.path();
            if name.contains("rider") && path.is_dir() {
                let bin64 = path.join("bin").join("rider64.exe");
                let bin = path.join("bin").join("rider.exe");
                if bin64.exists() {
                    return Some(bin64.to_string_lossy().to_string());
                }
                if bin.exists() {
                    return Some(bin.to_string_lossy().to_string());
                }
            }
        }
    }
    None
}

#[cfg(windows)]
fn scan_rider_under(root: &std::path::Path) -> Option<String> {
    let mut stack = vec![root.to_path_buf()];
    for _ in 0..4 {
        let mut next = Vec::new();
        while let Some(dir) = stack.pop() {
            let bin64 = dir.join("bin").join("rider64.exe");
            if bin64.exists() {
                return Some(bin64.to_string_lossy().to_string());
            }
            let bin = dir.join("bin").join("rider.exe");
            if bin.exists() {
                return Some(bin.to_string_lossy().to_string());
            }
            let entries = match std::fs::read_dir(&dir) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                if path.is_dir() {
                    next.push(path);
                }
            }
        }
        stack = next;
    }
    None
}

/// Open a file with the default application (e.g. .uproject → UnrealVersionSelector, .sln → VS/Rider).
/// Uses shell association on Windows.
#[tauri::command]
pub fn open_file(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &path])
            .creation_flags(0x0800_0000u32) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        return Err("open_file is only supported on Windows".to_string());
    }
    Ok(())
}

/// Open a project-related folder in Windows Explorer.
#[derive(Serialize)]
pub struct ProjectFolderAvailability {
    pub project: bool,
    pub screenshots: bool,
    pub savegames: bool,
    pub packaged: bool,
    pub logs: bool,
}

fn project_folder_target(project_path: &str, folder: &str) -> Result<std::path::PathBuf, String> {
    let project_file = std::path::Path::new(project_path);
    let project_dir = project_file.parent().ok_or("Invalid project path")?;
    let project_name = project_file.file_stem().and_then(|s| s.to_str()).ok_or("Invalid project name")?;
    match folder {
        "project" => Ok(project_dir.to_path_buf()),
        "screenshots" => Ok(project_dir.join("Saved").join("Screenshots").join("WindowsEditor")),
        "savegames" => Ok(project_dir.join("Saved").join("SaveGames")),
        "logs" => Ok(project_dir.join("Saved").join("Logs")),
        "packaged" => Ok(std::path::PathBuf::from(std::env::var("LOCALAPPDATA").map_err(|_| "LOCALAPPDATA is unavailable")?).join(project_name).join("Saved")),
        _ => Err("Unknown project folder".to_string()),
    }
}

/// Return whether each project-related folder exists as a directory.
#[tauri::command]
pub fn get_project_folder_availability(project_path: String) -> Result<ProjectFolderAvailability, String> {
    Ok(ProjectFolderAvailability {
        project: project_folder_target(&project_path, "project")?.is_dir(),
        screenshots: project_folder_target(&project_path, "screenshots")?.is_dir(),
        savegames: project_folder_target(&project_path, "savegames")?.is_dir(),
        packaged: project_folder_target(&project_path, "packaged")?.is_dir(),
        logs: project_folder_target(&project_path, "logs")?.is_dir(),
    })
}

#[tauri::command]
pub fn open_project_folder(project_path: String, folder: String) -> Result<(), String> {
    let target = project_folder_target(&project_path, &folder)?;
    #[cfg(windows)]
    std::process::Command::new("explorer.exe").arg(&target).creation_flags(0x0800_0000u32).spawn().map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    return Err("open_project_folder is only supported on Windows".to_string());
    Ok(())
}

#[tauri::command]
pub fn run_command(command: String, args: Vec<String>, cwd: Option<String>) -> Result<(), String> {
    let cwd_ref = cwd.as_deref();
    let mut cmd = build_cmd(&command, &args, cwd_ref);
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn kill_process(pid: u32) -> Result<(), String> {
    kill_pid(pid)
}
