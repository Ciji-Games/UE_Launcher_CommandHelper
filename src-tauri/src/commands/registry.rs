//! Windows registry commands - engine paths, UnrealVersionSelector
//! Step 5: Implement Windows registry & engine discovery

use std::collections::HashMap;
use std::path::Path;
use tauri::async_runtime::spawn_blocking;

#[cfg(windows)]
use winreg::enums::{HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
#[cfg(windows)]
use winreg::RegKey;

use crate::types::EngineEntry;

/// Build.version JSON structure (Engine/Build/Build.version)
#[derive(serde::Deserialize)]
struct BuildVersion {
    #[serde(rename = "MajorVersion")]
    major_version: Option<u16>,
    #[serde(rename = "MinorVersion")]
    minor_version: Option<u16>,
    #[serde(rename = "PatchVersion")]
    patch_version: Option<u16>,
}

/// Valid editor executable names (UE5: UnrealEditor.exe, UE4: UE4Editor.exe)
const UE5_EDITOR_EXE: &str = "UnrealEditor.exe";
const UE4_EDITOR_EXE: &str = "UE4Editor.exe";

/// Resolve editor path to engine root (InstalledDirectory).
/// UnrealEditor.exe / UE4Editor.exe is at Engine/Binaries/Win64/
fn editor_path_to_engine_root(editor_path: &Path) -> Option<std::path::PathBuf> {
    let mut p = editor_path.to_path_buf();
    for _ in 0..4 {
        p = p.parent()?.to_path_buf();
    }
    Some(p)
}

/// Locate editor executable (UnrealEditor.exe or UE4Editor.exe) in engine root.
fn find_editor_exe_in_root(engine_root: &Path) -> Option<std::path::PathBuf> {
    let bin64 = engine_root.join("Engine").join("Binaries").join("Win64");
    let ue5 = bin64.join(UE5_EDITOR_EXE);
    if ue5.exists() {
        return Some(ue5);
    }
    let ue4 = bin64.join(UE4_EDITOR_EXE);
    if ue4.exists() {
        return Some(ue4);
    }
    None
}

/// Epic Games Launcher installed manifest structure (LauncherInstalled.dat)
#[derive(serde::Deserialize)]
struct LauncherInstalledDat {
    #[serde(rename = "InstallationList")]
    installation_list: Option<Vec<LauncherInstalledApp>>,
}

#[derive(serde::Deserialize)]
struct LauncherInstalledApp {
    #[serde(rename = "InstallLocation")]
    install_location: Option<String>,
    #[serde(rename = "AppName")]
    app_name: Option<String>,
}

/// Scan Epic Games Launcher manifest file for all installed engine versions.
fn scan_launcher_installed_dat() -> Vec<(std::path::PathBuf, String)> {
    let mut results = Vec::new();
    let program_data = std::env::var("ProgramData")
        .or_else(|_| std::env::var("ALLUSERSPROFILE"))
        .unwrap_or_else(|_| r"C:\ProgramData".to_string());

    let dat_path = Path::new(&program_data)
        .join("Epic")
        .join("UnrealEngineLauncher")
        .join("LauncherInstalled.dat");

    if dat_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&dat_path) {
            if let Ok(dat) = serde_json::from_str::<LauncherInstalledDat>(&content) {
                if let Some(apps) = dat.installation_list {
                    for app in apps {
                        if let Some(loc) = app.install_location {
                            let path = Path::new(&loc);
                            if path.exists() && path.is_dir() {
                                let fallback = app.app_name.unwrap_or_default();
                                results.push((path.to_path_buf(), fallback));
                            }
                        }
                    }
                }
            }
        }
    }
    results
}

/// Compute a normalized key for an editor path, used for deduplication.
///
/// The same engine can be reported by the Launcher manifest, HKLM folder scan, and
/// the HKCU `Builds` registry, but with different string representations: the HKLM scan
/// builds the path with `Path::join` (all backslashes) while the `Builds` value
/// is stored by Epic with forward slashes (e.g. `C:/Program Files/Epic Games/UE_5.8`).
/// A plain (even case-insensitive) string compare treats these as different, so
/// the engine gets added twice.
///
/// Resolves canonical path and strips Windows extended-path prefix `\\?\` while normalizing
/// separators and casing.
fn engine_dedup_key(editor_path: &Path) -> String {
    let raw = std::fs::canonicalize(editor_path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| editor_path.to_string_lossy().to_string());
    raw.trim_start_matches(r"\\?\")
        .replace('/', "\\")
        .to_lowercase()
}

/// Resolve the command-line editor exe from the editor path.
/// UE4: UE4Editor.exe -> UE4Editor-Cmd.exe; UE5: UnrealEditor.exe -> UnrealEditor-Cmd.exe
pub fn get_editor_cmd_path(editor_path: &Path) -> Option<std::path::PathBuf> {
    let bin_dir = editor_path.parent()?;
    let name = editor_path.file_name()?.to_str()?;
    let cmd_name = if name.eq_ignore_ascii_case(UE4_EDITOR_EXE) {
        "UE4Editor-Cmd.exe"
    } else {
        "UnrealEditor-Cmd.exe"
    };
    Some(bin_dir.join(cmd_name))
}

/// Read full engine version (e.g. 5.7.1) from Engine/Build/Build.version.
/// Falls back to short_version if file is missing or unreadable.
fn read_engine_version_from_build_file(installed_dir: &Path, short_version: &str) -> String {
    let build_version_path = installed_dir
        .join("Engine")
        .join("Build")
        .join("Build.version");
    let content = match std::fs::read_to_string(&build_version_path) {
        Ok(c) => c,
        Err(_) => return short_version.to_string(),
    };
    let build: BuildVersion = match serde_json::from_str(&content) {
        Ok(b) => b,
        Err(_) => return short_version.to_string(),
    };
    match (
        build.major_version,
        build.minor_version,
        build.patch_version,
    ) {
        (Some(maj), Some(min), Some(patch)) => format!("{}.{}.{}", maj, min, patch),
        (Some(maj), Some(min), None) => format!("{}.{}", maj, min),
        _ => short_version.to_string(),
    }
}

/// Get UnrealVersionSelector.exe path from registry.
/// Registry: HKCR\Unreal.ProjectFile\shell\rungenproj → value "Icon"
/// Value format: "C:\...\UnrealVersionSelector.exe" (may have args; extract path up to .exe)
#[tauri::command]
pub fn get_unreal_version_selector_path() -> Result<Option<String>, String> {
    #[cfg(not(windows))]
    {
        let _ = ();
        return Ok(None);
    }

    #[cfg(windows)]
    {
        const REG_PATH: &str = r"Unreal.ProjectFile\shell\rungenproj";
        const VALUE_NAME: &str = "Icon";

        let hkcr = RegKey::predef(HKEY_CLASSES_ROOT);
        let key = match hkcr.open_subkey(REG_PATH) {
            Ok(k) => k,
            Err(_) => return Ok(None), // Key doesn't exist (e.g. UE not installed)
        };

        let value: String = match key.get_value(VALUE_NAME) {
            Ok(v) => v,
            Err(_) => return Ok(None),
        };

        if value.trim().is_empty() {
            return Ok(None);
        }

        // Remove any arguments after the .exe path (Icon value may have args)
        let value = value.trim_matches('"');
        if let Some(exe_index) = value.to_lowercase().find(".exe") {
            return Ok(Some(value[..exe_index + 4].to_string()));
        }
        Ok(Some(value.to_string()))
    }
}

/// Get installed Unreal Engine paths from registry.
/// Registry: HKLM\SOFTWARE\EpicGames\Unreal Engine\{Version}
/// Each subkey has InstalledDirectory → e.g. C:\Program Files\Epic Games\UE_5.4 or UE_4.27
/// Editor exe: UnrealEditor.exe (UE5) or UE4Editor.exe (UE4)
#[tauri::command]
pub async fn get_installed_engine_paths() -> Result<Vec<EngineEntry>, String> {
    spawn_blocking(discover_installed_engine_paths)
        .await
        .map_err(|e| format!("Engine discovery task failed: {}", e))?
}

pub(crate) fn discover_installed_engine_paths() -> Result<Vec<EngineEntry>, String> {
    #[cfg(not(windows))]
    {
        let _ = ();
        return Ok(vec![]);
    }

    #[cfg(windows)]
    {
        let mut engines = Vec::new();
        // Maps a canonicalized editor path to its index in `engines`, so the same
        // engine reported by Launcher manifest, HKLM scans, and HKCU `Builds`
        // registry is added only once. When the `Builds` scan re-finds an engine
        // already added, we backfill its GUID onto the existing entry
        // so projects with a GUID EngineAssociation can still resolve to it.
        let mut seen: HashMap<String, usize> = HashMap::new();

        // 1. Scan Epic Games Launcher manifest (LauncherInstalled.dat)
        // Discovers official engine installs across all drives and custom installation folders.
        for (install_dir, app_name) in scan_launcher_installed_dat() {
            if let Some(editor_path) = find_editor_exe_in_root(&install_dir) {
                let key = engine_dedup_key(&editor_path);
                if !seen.contains_key(&key) {
                    let version = read_engine_version_from_build_file(&install_dir, &app_name);
                    let editor_path_str = editor_path.to_string_lossy().to_string();
                    seen.insert(key, engines.len());
                    engines.push(EngineEntry {
                        version,
                        editor_path: editor_path_str,
                        display_name: None,
                        is_custom: false,
                        id: None,
                    });
                }
            }
        }

        // 2. Scan HKLM for officially installed engines across 32-bit and 64-bit registry keys
        const HKLM_PATHS: &[&str] = &[
            r"SOFTWARE\EpicGames\Unreal Engine",
            r"SOFTWARE\Epic Games\Unreal Engine",
            r"SOFTWARE\WOW6432Node\EpicGames\Unreal Engine",
            r"SOFTWARE\WOW6432Node\Epic Games\Unreal Engine",
        ];

        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        for reg_path in HKLM_PATHS {
            if let Ok(base_key) = hklm.open_subkey(reg_path) {
                // 2a. Check base INSTALLDIR value (scans subdirectories like UE_5.4)
                if let Ok(install_dir_base) = base_key.get_value::<String, _>("INSTALLDIR") {
                    let base_path = Path::new(&install_dir_base);
                    if base_path.exists() && base_path.is_dir() {
                        if let Ok(entries) = std::fs::read_dir(base_path) {
                            for entry in entries.filter_map(Result::ok) {
                                let path = entry.path();
                                if path.is_dir() {
                                    if let Some(folder_name) = path.file_name().and_then(|n| n.to_str()) {
                                        if folder_name.starts_with("UE_") {
                                            if let Some(editor_path) = find_editor_exe_in_root(&path) {
                                                let key = engine_dedup_key(&editor_path);
                                                if !seen.contains_key(&key) {
                                                    let version = read_engine_version_from_build_file(
                                                        &path,
                                                        folder_name,
                                                    );
                                                    let editor_path_str = editor_path.to_string_lossy().to_string();
                                                    seen.insert(key, engines.len());
                                                    engines.push(EngineEntry {
                                                        version,
                                                        editor_path: editor_path_str,
                                                        display_name: None,
                                                        is_custom: false,
                                                        id: None,
                                                    });
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // 2b. Enumerate per-version subkeys (e.g. 5.0, 5.1, 5.2, 5.3, 5.4, 5.5, 4.27)
                for subkey_name in base_key.enum_keys().filter_map(Result::ok) {
                    if let Ok(subkey) = base_key.open_subkey(&subkey_name) {
                        let install_dir: Option<String> = subkey
                            .get_value("InstalledDirectory")
                            .or_else(|_| subkey.get_value("INSTALLDIR"))
                            .or_else(|_| subkey.get_value("InstallDir"))
                            .ok();

                        if let Some(install_dir_str) = install_dir {
                            let path = Path::new(&install_dir_str);
                            if path.exists() && path.is_dir() {
                                if let Some(editor_path) = find_editor_exe_in_root(path) {
                                    let key = engine_dedup_key(&editor_path);
                                    if !seen.contains_key(&key) {
                                        let version = read_engine_version_from_build_file(
                                            path,
                                            &subkey_name,
                                        );
                                        let editor_path_str = editor_path.to_string_lossy().to_string();
                                        seen.insert(key, engines.len());
                                        engines.push(EngineEntry {
                                            version,
                                            editor_path: editor_path_str,
                                            display_name: None,
                                            is_custom: false,
                                            id: None,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // 3. Scan HKCU for "Builds" (GUID and version-based associations)
        const HKCU_BUILDS: &[&str] = &[
            r"Software\Epic Games\Unreal Engine\Builds",
            r"Software\EpicGames\Unreal Engine\Builds",
        ];

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        for reg_builds in HKCU_BUILDS {
            if let Ok(builds_key) = hkcu.open_subkey(reg_builds) {
                for (guid, path_val) in builds_key.enum_values().filter_map(Result::ok) {
                    let install_path_str = path_val.to_string();
                    let path = Path::new(&install_path_str);
                    if path.exists() && path.is_dir() {
                        if let Some(editor_path) = find_editor_exe_in_root(path) {
                            let key = engine_dedup_key(&editor_path);
                            match seen.get(&key) {
                                Some(&idx) => {
                                    // Already added by manifest or HKLM scan.
                                    // Backfill the GUID/ID so a project whose EngineAssociation
                                    // is this GUID can still resolve to the engine.
                                    if engines[idx].id.is_none() {
                                        engines[idx].id = Some(guid);
                                    }
                                }
                                None => {
                                    let has_installed_build = path
                                        .join("Engine")
                                        .join("Build")
                                        .join("InstalledBuild.txt")
                                        .exists();
                                    let is_custom = !has_installed_build;

                                    let version = read_engine_version_from_build_file(path, "Unknown");
                                    let editor_path_str = editor_path.to_string_lossy().to_string();
                                    seen.insert(key, engines.len());
                                    engines.push(EngineEntry {
                                        version,
                                        editor_path: editor_path_str,
                                        display_name: None,
                                        is_custom,
                                        id: Some(guid),
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        Ok(engines)
    }
}

/// Validate that a path points to a valid Unreal Engine installation.
/// Accepts either engine root (InstalledDirectory) or editor exe path (UnrealEditor.exe / UE4Editor.exe).
#[tauri::command]
pub fn validate_engine_path(path: String) -> Result<bool, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Ok(false);
    }
    let editor_path = if p.is_file() {
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.eq_ignore_ascii_case(UE5_EDITOR_EXE) || name.eq_ignore_ascii_case(UE4_EDITOR_EXE) {
            p.to_path_buf()
        } else {
            return Ok(false);
        }
    } else if p.is_dir() {
        let bin64 = p.join("Engine").join("Binaries").join("Win64");
        let ue5 = bin64.join(UE5_EDITOR_EXE);
        let ue4 = bin64.join(UE4_EDITOR_EXE);
        if ue5.exists() {
            ue5
        } else if ue4.exists() {
            ue4
        } else {
            return Ok(false);
        }
    } else {
        return Ok(false);
    };
    Ok(editor_path.exists())
}

/// Read engine version from Build.version given UnrealEditor.exe path.
#[tauri::command]
pub fn read_engine_version_from_path(editor_path: String) -> Result<String, String> {
    let path = Path::new(&editor_path);
    if !path.exists() {
        return Err("Path does not exist".to_string());
    }
    let engine_root = editor_path_to_engine_root(path)
        .ok_or_else(|| "Invalid editor path: could not resolve engine root".to_string())?;
    let version = read_engine_version_from_build_file(&engine_root, "Unknown");
    Ok(version)
}
