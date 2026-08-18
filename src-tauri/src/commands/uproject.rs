//! UProject Helper - Cook, Package (BuildCookRun), Build (Compile only).
//! Step 13: Cook Content, Package, Build commands.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::commands::monitor;
use crate::commands::registry;
use crate::progress_parser::ToolMode;
use crate::running_process;
use crate::stream_processor::{self, process_streams};
use crate::utils::build_cmd;

/// Resolve engine root from UnrealEditor.exe path.
/// UnrealEditor.exe is at Engine/Binaries/Win64/UnrealEditor.exe
/// Engine root = parent of Engine folder = parent x4 from exe.
fn editor_path_to_engine_root(editor_path: &str) -> Option<std::path::PathBuf> {
    let mut p = Path::new(editor_path).to_path_buf();
    for _ in 0..4 {
        p = p.parent()?.to_path_buf();
    }
    Some(p)
}

/// Map UI platform (Win64, Linux, Mac) to Unreal cook target platform.
/// TargetPlatformManager expects Windows/Linux/Mac, not Win64.
fn platform_for_cook(platform: &str) -> &str {
    match platform {
        "Win64" => "Windows",
        _ => platform,
    }
}

fn default_game_ini_path(project_path: &str) -> Result<PathBuf, String> {
    let project_dir = Path::new(project_path)
        .parent()
        .ok_or("Could not resolve project directory")?;
    Ok(project_dir.join("Config").join("DefaultGame.ini"))
}

fn project_version_from_ini(contents: &str) -> Option<String> {
    contents.lines().find_map(|line| {
        let trimmed = line.trim();
        let value = trimmed.strip_prefix("ProjectVersion=")?;
        let version = value.trim();
        (!version.is_empty()).then(|| version.to_string())
    })
}

fn next_project_version(version: &str) -> Result<String, String> {
    let parts: Vec<&str> = version.trim().split('.').collect();
    if parts.len() != 3 || parts.iter().any(|part| part.is_empty() || !part.chars().all(|c| c.is_ascii_digit())) {
        return Err(format!("ProjectVersion must use major.minor.patch format, got '{}'.", version.trim()));
    }
    let patch = parts[2]
        .parse::<u32>()
        .map_err(|_| format!("ProjectVersion patch is too large: {}", parts[2]))?
        .checked_add(1)
        .ok_or("ProjectVersion patch cannot be incremented")?;
    Ok(format!("{}.{}.{}", parts[0], parts[1], patch))
}

fn replace_project_version(contents: &str, version: &str) -> Result<String, String> {
    let mut replaced = false;
    let mut output = String::with_capacity(contents.len() + version.len());
    for line in contents.split_inclusive('\n') {
        let line_without_newline = line.trim_end_matches(['\r', '\n']);
        if !replaced && line_without_newline.trim().starts_with("ProjectVersion=") {
            let prefix = &line[line_without_newline.len()..];
            let indentation = &line_without_newline[..line_without_newline.len() - line_without_newline.trim_start().len()];
            output.push_str(indentation);
            output.push_str("ProjectVersion=");
            output.push_str(version);
            output.push_str(prefix);
            replaced = true;
        } else {
            output.push_str(line);
        }
    }
    if replaced {
        Ok(output)
    } else {
        Err("DefaultGame.ini does not contain ProjectVersion".to_string())
    }
}

#[tauri::command]
pub fn get_project_version(project_path: String) -> Result<String, String> {
    let ini_path = default_game_ini_path(&project_path)?;
    let contents = fs::read_to_string(&ini_path)
        .map_err(|e| format!("Could not read {}: {}", ini_path.display(), e))?;
    project_version_from_ini(&contents)
        .ok_or_else(|| format!("ProjectVersion not found in {}", ini_path.display()))
}

fn update_project_version(project_path: &str, version: &str) -> Result<(), String> {
    if version.trim().is_empty() {
        return Err("New project version cannot be empty".to_string());
    }
    let ini_path = default_game_ini_path(project_path)?;
    let contents = fs::read_to_string(&ini_path)
        .map_err(|e| format!("Could not read {}: {}", ini_path.display(), e))?;
    let updated = replace_project_version(&contents, version.trim())?;
    fs::write(&ini_path, updated)
        .map_err(|e| format!("Could not update {}: {}", ini_path.display(), e))
}

/// Cook content: UnrealEditor-Cmd.exe "project.uproject" -run=cook -targetplatform=Windows -iterate -unattended -log
#[tauri::command]
pub async fn run_cook(
    project_path: String,
    platform: String,
    engine_path: String,
    app: AppHandle,
) -> Result<(), String> {
    if monitor::has_blocking_processes("uproject".to_string())? {
        return Err("Cannot cook: Unreal Engine is running. Close it first.".to_string());
    }

    let uproj = Path::new(&project_path);
    if !uproj.exists() || uproj.extension().map_or(true, |e| e != "uproject") {
        return Err("Invalid or missing .uproject file".to_string());
    }

    let editor_exe = Path::new(&engine_path);
    if !editor_exe.exists() {
        stream_processor::emit_log(&app, "[ERROR] Editor executable not found.", Some("red"));
        return Err("Engine path not found".to_string());
    }

    let editor_cmd = registry::get_editor_cmd_path(editor_exe)
        .ok_or("Invalid engine path")?
        .to_string_lossy()
        .to_string();
    if !Path::new(&editor_cmd).exists() {
        return Err(
            "Editor command-line executable not found (UnrealEditor-Cmd.exe or UE4Editor-Cmd.exe)"
                .to_string(),
        );
    }

    let cook_platform = platform_for_cook(&platform);
    let bin_dir = editor_exe.parent().ok_or("Invalid engine path")?;
    let cwd = bin_dir.to_str().ok_or("Invalid Binaries path")?.to_string();
    let args = vec![
        project_path.clone(),
        "-run=cook".to_string(),
        format!("-targetplatform={}", cook_platform),
        "-iterate".to_string(),
        "-unattended".to_string(),
        "-log".to_string(),
    ];

    stream_processor::emit_log(
        &app,
        &format!(
            "Running Cook for platform: {} (target: {})",
            platform, cook_platform
        ),
        Some("blue"),
    );
    stream_processor::emit_log(
        &app,
        &format!("Command: {} {}", editor_cmd, args.join(" ")),
        None,
    );

    let result = tokio::task::spawn_blocking({
        let app = app.clone();
        let editor_cmd = editor_cmd.clone();
        let cwd = cwd.clone();
        let args = args.clone();
        move || -> Result<(), String> {
            let mut cmd = build_cmd(&editor_cmd, &args, Some(&cwd));
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());

            let mut child = cmd.spawn().map_err(|e| e.to_string())?;
            running_process::set_running_pid(child.id());
            let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
            let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
            let stdout_reader = std::io::BufReader::new(stdout);
            let stderr_reader = std::io::BufReader::new(stderr);
            process_streams(stdout_reader, stderr_reader, app.clone(), ToolMode::Cook);

            let status = child.wait().map_err(|e| e.to_string())?;
            running_process::clear_running_pid();
            if status.success() {
                stream_processor::emit_log(&app, "Cook completed successfully!", Some("green"));
                Ok(())
            } else {
                stream_processor::emit_log(
                    &app,
                    &format!("Cook exited with code: {:?}", status.code()),
                    Some("red"),
                );
                Err("Cook failed".to_string())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    result
}

/// ResavePackages: UnrealEditor.exe "project.uproject" -run=ResavePackages [options] -unattended -log
/// Resaves packages/assets, fixes redirectors, optional autocheckout/autocheckin.
#[tauri::command]
pub async fn run_resave_packages(
    project_path: String,
    engine_path: String,
    fixup_redirects: bool,
    autocheckout: bool,
    project_only: bool,
    autocheckin: bool,
    app: AppHandle,
) -> Result<(), String> {
    if monitor::has_blocking_processes("uproject".to_string())? {
        return Err(
            "Cannot run ResavePackages: Unreal Engine is running. Close it first.".to_string(),
        );
    }

    let uproj = Path::new(&project_path);
    if !uproj.exists() || uproj.extension().map_or(true, |e| e != "uproject") {
        return Err("Invalid or missing .uproject file".to_string());
    }

    let editor_exe = Path::new(&engine_path);
    if !editor_exe.exists() {
        stream_processor::emit_log(&app, "[ERROR] Editor executable not found.", Some("red"));
        return Err("Engine path not found".to_string());
    }

    let bin_dir = editor_exe.parent().ok_or("Invalid engine path")?;
    let cwd = bin_dir.to_str().ok_or("Invalid Binaries path")?.to_string();

    let mut args = vec![project_path.clone(), "-run=ResavePackages".to_string()];
    if fixup_redirects {
        args.push("-fixupredirects".to_string());
    }
    if autocheckout {
        args.push("-autocheckout".to_string());
    }
    if project_only {
        args.push("-projectonly".to_string());
    }
    if autocheckin {
        args.push("-autocheckin".to_string());
    }
    args.push("-unattended".to_string());
    args.push("-log".to_string());

    stream_processor::emit_log(&app, "Running ResavePackages...", Some("blue"));
    stream_processor::emit_log(
        &app,
        &format!("Command: {} {}", engine_path, args.join(" ")),
        Some("gray"),
    );

    let result = tokio::task::spawn_blocking({
        let app = app.clone();
        let engine_path = engine_path.clone();
        let cwd = cwd.clone();
        let args = args.clone();
        move || -> Result<(), String> {
            let mut cmd = build_cmd(&engine_path, &args, Some(&cwd));
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());

            let mut child = cmd.spawn().map_err(|e| e.to_string())?;
            running_process::set_running_pid(child.id());
            let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
            let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
            let stdout_reader = std::io::BufReader::new(stdout);
            let stderr_reader = std::io::BufReader::new(stderr);
            process_streams(stdout_reader, stderr_reader, app.clone(), ToolMode::Generic);

            let status = child.wait().map_err(|e| e.to_string())?;
            running_process::clear_running_pid();
            if status.success() {
                stream_processor::emit_log(
                    &app,
                    "ResavePackages completed successfully!",
                    Some("green"),
                );
                Ok(())
            } else {
                stream_processor::emit_log(
                    &app,
                    &format!("ResavePackages exited with code: {:?}", status.code()),
                    Some("red"),
                );
                Err("ResavePackages failed".to_string())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    result
}

/// Package (BuildCookRun): RunUAT.bat BuildCookRun -project="path" -platform=Win64 -clientconfig=Development -build -cook -stage -pak -archive -archivedirectory="..."
#[tauri::command]
pub async fn run_package(
    project_path: String,
    platform: String,
    client_config: String,
    archive_directory: String,
    engine_path: String,
    bump_project_version: bool,
    project_version: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    if monitor::has_blocking_processes("uproject".to_string())? {
        return Err("Cannot package: Unreal Engine is running. Close it first.".to_string());
    }

    let uproj = Path::new(&project_path);
    if !uproj.exists() || uproj.extension().map_or(true, |e| e != "uproject") {
        return Err("Invalid or missing .uproject file".to_string());
    }

    let engine_root = editor_path_to_engine_root(&engine_path)
        .ok_or("Could not resolve engine root from editor path")?;
    let run_uat = engine_root
        .join("Engine")
        .join("Build")
        .join("BatchFiles")
        .join("RunUAT.bat");
    if !run_uat.exists() {
        return Err(format!("RunUAT.bat not found at {:?}", run_uat));
    }

    let batch_dir = run_uat.parent().ok_or("Invalid RunUAT path")?;
    let cwd: String = batch_dir
        .to_str()
        .ok_or("Invalid BatchFiles path")?
        .to_string();

    if bump_project_version {
        let current_version = get_project_version(project_path.clone())?;
        let version = match project_version.as_deref() {
            Some(version) => version.trim().to_string(),
            None => next_project_version(&current_version)?,
        };
        update_project_version(&project_path, &version)?;
        stream_processor::emit_log(
            &app,
            &format!("Updated ProjectVersion from {} to {} before packaging", current_version, version),
            Some("blue"),
        );
    }

    let args = vec![
        "BuildCookRun".to_string(),
        format!("-project={}", project_path),
        format!("-platform={}", platform),
        format!("-clientconfig={}", client_config),
        "-build".to_string(),
        "-cook".to_string(),
        "-stage".to_string(),
        "-pak".to_string(),
        "-archive".to_string(),
        format!("-archivedirectory={}", archive_directory),
    ];

    stream_processor::emit_log(
        &app,
        &format!(
            "Running Package (BuildCookRun) for platform: {}, config: {}",
            platform, client_config
        ),
        Some("blue"),
    );
    stream_processor::emit_log(
        &app,
        &format!("Archive directory: {}", archive_directory),
        None,
    );

    let run_uat_str = run_uat.to_string_lossy().to_string();
    let result = tokio::task::spawn_blocking({
        let app = app.clone();
        let run_uat_str = run_uat_str.clone();
        let cwd = cwd.clone();
        let args = args.clone();
        move || -> Result<(), String> {
            let mut cmd = build_cmd(&run_uat_str, &args, Some(&cwd));
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());

            let mut child = cmd.spawn().map_err(|e| e.to_string())?;
            running_process::set_running_pid(child.id());
            let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
            let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
            let stdout_reader = std::io::BufReader::new(stdout);
            let stderr_reader = std::io::BufReader::new(stderr);
            process_streams(stdout_reader, stderr_reader, app.clone(), ToolMode::Package);

            let status = child.wait().map_err(|e| e.to_string())?;
            running_process::clear_running_pid();
            if status.success() {
                stream_processor::emit_log(&app, "Package completed successfully!", Some("green"));
                Ok(())
            } else {
                stream_processor::emit_log(
                    &app,
                    &format!("Package exited with code: {:?}", status.code()),
                    Some("red"),
                );
                Err("Package failed".to_string())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    result
}

/// Archive (ZipProjectUp): RunUAT.bat ZipProjectUp -nocompileeditor -project="dir" -install="output.zip" -nocompile -nocompileuat
/// Creates a zip of the project source with minimal files (excludes Binaries, Intermediate, Saved, etc.).
#[tauri::command]
pub async fn run_archive(
    project_path: String,
    output_zip_path: String,
    engine_path: String,
    app: AppHandle,
) -> Result<(), String> {
    if monitor::has_blocking_processes("uproject".to_string())? {
        return Err("Cannot archive: Unreal Engine is running. Close it first.".to_string());
    }

    let uproj = Path::new(&project_path);
    if !uproj.exists() || uproj.extension().map_or(true, |e| e != "uproject") {
        return Err("Invalid or missing .uproject file".to_string());
    }

    let engine_root = editor_path_to_engine_root(&engine_path)
        .ok_or("Could not resolve engine root from editor path")?;
    let run_uat = engine_root
        .join("Engine")
        .join("Build")
        .join("BatchFiles")
        .join("RunUAT.bat");
    if !run_uat.exists() {
        return Err(format!("RunUAT.bat not found at {:?}", run_uat));
    }

    let batch_dir = run_uat.parent().ok_or("Invalid RunUAT path")?;
    let cwd: String = batch_dir
        .to_str()
        .ok_or("Invalid BatchFiles path")?
        .to_string();

    let args = vec![
        "ZipProjectUp".to_string(),
        "-nocompileeditor".to_string(),
        format!("-project={}", project_path),
        format!("-install={}", output_zip_path),
        "-nocompile".to_string(),
        "-nocompileuat".to_string(),
    ];

    stream_processor::emit_log(&app, "Running Archive (ZipProjectUp)...", Some("blue"));
    stream_processor::emit_log(
        &app,
        &format!("Project: {} -> {}", project_path, output_zip_path),
        None,
    );

    let run_uat_str = run_uat.to_string_lossy().to_string();
    let result = tokio::task::spawn_blocking({
        let app = app.clone();
        let run_uat_str = run_uat_str.clone();
        let cwd = cwd.clone();
        let args = args.clone();
        move || -> Result<(), String> {
            let mut cmd = build_cmd(&run_uat_str, &args, Some(&cwd));
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());

            let mut child = cmd.spawn().map_err(|e| e.to_string())?;
            running_process::set_running_pid(child.id());
            let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
            let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
            let stdout_reader = std::io::BufReader::new(stdout);
            let stderr_reader = std::io::BufReader::new(stderr);
            process_streams(stdout_reader, stderr_reader, app.clone(), ToolMode::Generic);

            let status = child.wait().map_err(|e| e.to_string())?;
            running_process::clear_running_pid();
            if status.success() {
                stream_processor::emit_log(&app, "Archive completed successfully!", Some("green"));
                Ok(())
            } else {
                stream_processor::emit_log(
                    &app,
                    &format!("Archive exited with code: {:?}", status.code()),
                    Some("red"),
                );
                Err("Archive failed".to_string())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    result
}

/// Build (Compile only): Build.bat {ProjectName}Editor Win64 Development -Project="path" -WaitMutex
/// C++ only - returns Err if !is_cpp.
#[tauri::command]
pub async fn run_build(
    project_path: String,
    engine_path: String,
    is_cpp: bool,
    app: AppHandle,
) -> Result<(), String> {
    if !is_cpp {
        return Err("Build is only for C++ projects (requires Source folder). This project has no C++ code.".to_string());
    }

    if monitor::has_blocking_processes("uproject".to_string())? {
        return Err("Cannot build: Unreal Engine is running. Close it first.".to_string());
    }

    let uproj = Path::new(&project_path);
    if !uproj.exists() || uproj.extension().map_or(true, |e| e != "uproject") {
        return Err("Invalid or missing .uproject file".to_string());
    }

    let project_name = uproj
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown")
        .to_string();

    let engine_root = editor_path_to_engine_root(&engine_path)
        .ok_or("Could not resolve engine root from editor path")?;
    let build_bat = engine_root
        .join("Engine")
        .join("Build")
        .join("BatchFiles")
        .join("Build.bat");
    if !build_bat.exists() {
        return Err(format!("Build.bat not found at {:?}", build_bat));
    }

    let batch_dir = build_bat.parent().ok_or("Invalid Build.bat path")?;
    let cwd: String = batch_dir
        .to_str()
        .ok_or("Invalid BatchFiles path")?
        .to_string();

    let target = format!("{}Editor", project_name);
    let args = vec![
        "/c".to_string(),
        "Build.bat".to_string(),
        target,
        "Win64".to_string(),
        "Development".to_string(),
        "-Project".to_string(),
        project_path.clone(),
        "-WaitMutex".to_string(),
    ];

    stream_processor::emit_log(
        &app,
        "Building project (Development Editor)...",
        Some("blue"),
    );
    stream_processor::emit_log(&app, &format!("Target: {}Editor", project_name), None);

    let result = tokio::task::spawn_blocking({
        let app = app.clone();
        let cwd = cwd.clone();
        let args = args.clone();
        move || -> Result<(), String> {
            let mut cmd = build_cmd("cmd", &args, Some(&cwd));
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());

            let mut child = cmd.spawn().map_err(|e| e.to_string())?;
            running_process::set_running_pid(child.id());
            let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
            let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
            let stdout_reader = std::io::BufReader::new(stdout);
            let stderr_reader = std::io::BufReader::new(stderr);
            process_streams(stdout_reader, stderr_reader, app.clone(), ToolMode::Build);

            let status = child.wait().map_err(|e| e.to_string())?;
            running_process::clear_running_pid();
            if status.success() {
                stream_processor::emit_log(&app, "Build completed successfully!", Some("green"));
                Ok(())
            } else {
                stream_processor::emit_log(
                    &app,
                    &format!("Build exited with code: {:?}", status.code()),
                    Some("red"),
                );
                Err("Build failed".to_string())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    result
}

#[cfg(test)]
mod tests {
    use super::{next_project_version, project_version_from_ini, replace_project_version};

    #[test]
    fn reads_project_version_from_default_game_ini() {
        assert_eq!(
            project_version_from_ini("[/Script/EngineSettings.GeneralProjectSettings]\r\nProjectVersion=1.2.3\r\n"),
            Some("1.2.3".to_string())
        );
    }

    #[test]
    fn replaces_project_version_preserving_line_endings() {
        let contents = "ProjectVersion=1.2.3\r\nOtherSetting=True\r\n";
        assert_eq!(
            replace_project_version(contents, "1.2.4").unwrap(),
            "ProjectVersion=1.2.4\r\nOtherSetting=True\r\n"
        );
    }

    #[test]
    fn rejects_ini_without_project_version() {
        assert!(replace_project_version("[/Script/EngineSettings.GeneralProjectSettings]\n", "1.0.0").is_err());
    }

    #[test]
    fn increments_project_version_patch() {
        assert_eq!(next_project_version("1.2.9").unwrap(), "1.2.10");
    }

    #[test]
    fn rejects_non_semver_project_version() {
        assert!(next_project_version("1.2").is_err());
    }
}
