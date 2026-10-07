//! Include and Module Finder commands for Unreal Engine headers and Build.cs modules.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IncludeEntry {
    pub id: i64,
    pub header_name: String,
    pub include_path: String,
    pub module_name: String,
    pub scope: String, // "engine", "engine_plugin", "project", "project_plugin"
    pub plugin_name: Option<String>,
    pub file_path: String,
    pub relative_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub engine_version: String,
    pub engine_indexed: bool,
    pub engine_header_count: usize,
    pub engine_module_count: usize,
    pub engine_last_scanned: Option<String>,
    pub project_indexed: bool,
    pub project_header_count: usize,
    pub project_module_count: usize,
    pub project_last_scanned: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgressPayload {
    pub stage: String, // "discovering_modules", "indexing_headers", "finalizing"
    pub current_count: usize,
    pub total_estimated: Option<usize>,
    pub current_file: Option<String>,
}

struct ModuleInfo {
    name: String,
    dir: PathBuf,
    scope: String,
    plugin_name: Option<String>,
}

struct RawHeaderRecord {
    header_name: String,
    include_path: String,
    module_name: String,
    scope: String,
    plugin_name: Option<String>,
    file_path: String,
    relative_path: String,
}

fn get_db_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let db_dir = base_dir.join("include_indices");
    if !db_dir.exists() {
        fs::create_dir_all(&db_dir)
            .map_err(|e| format!("Failed to create include_indices dir: {}", e))?;
    }
    Ok(db_dir)
}

fn sanitize_identifier(input: &str) -> String {
    input
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

fn hash_path(path: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    path.to_lowercase().hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn get_engine_db_path(app: &AppHandle, engine_version: &str) -> Result<PathBuf, String> {
    let db_dir = get_db_dir(app)?;
    let safe_ver = sanitize_identifier(engine_version);
    Ok(db_dir.join(format!("engine_{}.db", safe_ver)))
}

fn get_project_db_path(app: &AppHandle, project_path: &str) -> Result<PathBuf, String> {
    let db_dir = get_db_dir(app)?;
    let hash = hash_path(project_path);
    let stem = Path::new(project_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("project");
    let safe_stem = sanitize_identifier(stem);
    Ok(db_dir.join(format!("project_{}_{}.db", safe_stem, &hash[..8])))
}

fn init_sqlite_db(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;

        CREATE TABLE IF NOT EXISTS headers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            header_name TEXT NOT NULL,
            include_path TEXT NOT NULL,
            module_name TEXT NOT NULL,
            scope TEXT NOT NULL,
            plugin_name TEXT,
            file_path TEXT NOT NULL,
            relative_path TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_headers_header_name ON headers(header_name);
        CREATE INDEX IF NOT EXISTS idx_headers_module_name ON headers(module_name);
        CREATE INDEX IF NOT EXISTS idx_headers_include_path ON headers(include_path);
        CREATE INDEX IF NOT EXISTS idx_headers_scope ON headers(scope);
        ",
    )?;
    Ok(())
}

fn read_db_stats(db_path: &Path) -> Option<(usize, usize, Option<String>)> {
    if !db_path.exists() {
        return None;
    }
    let conn = Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;

    let header_count: usize = conn
        .query_row("SELECT COUNT(*) FROM headers", [], |row| row.get(0))
        .unwrap_or(0);
    let module_count: usize = conn
        .query_row(
            "SELECT COUNT(DISTINCT module_name) FROM headers",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let last_scanned: Option<String> = conn
        .query_row(
            "SELECT value FROM metadata WHERE key = 'last_scanned'",
            [],
            |row| row.get(0),
        )
        .optional()
        .unwrap_or(None);

    Some((header_count, module_count, last_scanned))
}

fn normalize_slashes(p: &str) -> String {
    p.replace('\\', "/")
}

fn is_header_file(path: &Path) -> bool {
    let file_name = match path.file_name().and_then(|n| n.to_str()) {
        Some(name) => name.to_lowercase(),
        None => return false,
    };

    // Exclude Unreal Engine generated headers (*.generated.h, *.gen.h)
    if file_name.ends_with(".generated.h") || file_name.ends_with(".gen.h") {
        return false;
    }

    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        matches!(
            ext.to_lowercase().as_str(),
            "h" | "hpp" | "hxx" | "inl" | "inc"
        )
    } else {
        false
    }
}

/// Calculate standard include path for a header file relative to its module root.
/// E.g.
/// - `.../Runtime/Engine/Public/Kismet/GameplayStatics.h` -> `Kismet/GameplayStatics.h`
/// - `.../Runtime/Engine/Classes/GameFramework/Actor.h` -> `GameFramework/Actor.h`
/// - `.../Runtime/Engine/Private/Kismet/Foo.h` -> `Kismet/Foo.h`
/// - `.../Runtime/Engine/SomeFolder/Bar.h` -> `SomeFolder/Bar.h`
fn calculate_include_path(file_path: &Path, module_dir: &Path) -> String {
    let norm_file = normalize_slashes(&file_path.to_string_lossy());
    let norm_module = normalize_slashes(&module_dir.to_string_lossy());

    // Check for standard subfolders
    for marker in &["/Public/", "/Classes/", "/Private/"] {
        if let Some(pos) = norm_file.to_lowercase().find(&marker.to_lowercase()) {
            let sub = &norm_file[pos + marker.len()..];
            if !sub.is_empty() {
                return sub.to_string();
            }
        }
    }

    // Fallback: relative to module directory
    if norm_file.starts_with(&norm_module) {
        let rel = norm_file[norm_module.len()..]
            .trim_start_matches('/')
            .to_string();
        if !rel.is_empty() {
            return rel;
        }
    }

    // Default to file name
    file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string()
}

/// Discovers all `.Build.cs` files in the given directory roots
fn discover_modules(
    search_roots: &[(PathBuf, &str, Option<String>)], // (root_path, scope, plugin_name)
) -> Vec<ModuleInfo> {
    let mut modules = Vec::new();

    for (root, scope, default_plugin) in search_roots {
        if !root.exists() {
            continue;
        }

        for entry in WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if !entry.file_type().is_file() {
                continue;
            }

            let file_name = entry.file_name().to_string_lossy();
            if file_name.ends_with(".Build.cs") {
                let module_name = file_name
                    .strip_suffix(".Build.cs")
                    .unwrap_or(&file_name)
                    .to_string();

                let module_dir = match path.parent() {
                    Some(p) => p.to_path_buf(),
                    None => continue,
                };

                let mut current_scope = scope.to_string();
                let mut plugin_name = default_plugin.clone();

                // If scope is engine or project, check if this module is inside a Plugins directory
                let norm_path = normalize_slashes(&path.to_string_lossy());
                if plugin_name.is_none() {
                    if let Some(pos) = norm_path.find("/Plugins/") {
                        let after_plugins = &norm_path[pos + "/Plugins/".len()..];
                        let parts: Vec<&str> = after_plugins.split('/').collect();
                        if !parts.is_empty() {
                            plugin_name = Some(parts[0].to_string());
                            current_scope = if *scope == "project" {
                                "project_plugin".to_string()
                            } else {
                                "engine_plugin".to_string()
                            };
                        }
                    }
                }

                modules.push(ModuleInfo {
                    name: module_name,
                    dir: module_dir,
                    scope: current_scope,
                    plugin_name,
                });
            }
        }
    }

    // Sort module directories by path length descending so submodules match before parent directories
    modules.sort_by(|a, b| b.dir.as_os_str().len().cmp(&a.dir.as_os_str().len()));
    modules
}

/// Collects headers from search roots and associates them with discovered modules
fn index_headers_from_roots(
    search_roots: &[(PathBuf, &str, Option<String>)],
    modules: &[ModuleInfo],
    base_root_for_relative: &Path,
    app: &AppHandle,
) -> Vec<RawHeaderRecord> {
    let mut records = Vec::new();
    let mut scanned_count = 0;
    let mut last_progress_report = Instant::now();

    for (root, default_scope, default_plugin) in search_roots {
        if !root.exists() {
            continue;
        }

        for entry in WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if !entry.file_type().is_file() || !is_header_file(path) {
                continue;
            }

            scanned_count += 1;
            if last_progress_report.elapsed().as_millis() > 100 {
                last_progress_report = Instant::now();
                let _ = app.emit(
                    "include-finder:progress",
                    ScanProgressPayload {
                        stage: "indexing_headers".to_string(),
                        current_count: scanned_count,
                        total_estimated: None,
                        current_file: Some(entry.file_name().to_string_lossy().to_string()),
                    },
                );
            }

            let header_name = match entry.file_name().to_str() {
                Some(name) => name.to_string(),
                None => continue,
            };

            // Find matching module
            let matched_module = modules.iter().find(|m| path.starts_with(&m.dir));

            let (module_name, scope, plugin_name, include_path) = match matched_module {
                Some(m) => {
                    let inc = calculate_include_path(path, &m.dir);
                    (
                        m.name.clone(),
                        m.scope.clone(),
                        m.plugin_name.clone(),
                        inc,
                    )
                }
                None => {
                    // Fallback to parent directory stem as module name
                    let parent_stem = path
                        .parent()
                        .and_then(|p| p.file_name())
                        .and_then(|s| s.to_str())
                        .unwrap_or("UnknownModule")
                        .to_string();
                    let inc = header_name.clone();
                    (
                        parent_stem,
                        default_scope.to_string(),
                        default_plugin.clone(),
                        inc,
                    )
                }
            };

            let file_path_str = normalize_slashes(&path.to_string_lossy());
            let norm_base = normalize_slashes(&base_root_for_relative.to_string_lossy());
            let rel_path = if file_path_str.starts_with(&norm_base) {
                file_path_str[norm_base.len()..]
                    .trim_start_matches('/')
                    .to_string()
            } else {
                file_path_str.clone()
            };

            records.push(RawHeaderRecord {
                header_name,
                include_path,
                module_name,
                scope,
                plugin_name,
                file_path: file_path_str,
                relative_path: rel_path,
            });
        }
    }

    records
}

fn save_records_to_sqlite(
    db_path: &Path,
    records: &[RawHeaderRecord],
    root_path_str: &str,
) -> Result<(), String> {
    // Write into temporary DB file and rename for atomicity
    let temp_db_path = db_path.with_extension("db.tmp");
    if temp_db_path.exists() {
        let _ = fs::remove_file(&temp_db_path);
    }

    let mut conn = Connection::open(&temp_db_path)
        .map_err(|e| format!("Failed to open temp sqlite db: {}", e))?;

    init_sqlite_db(&conn).map_err(|e| format!("Failed to init sqlite db schema: {}", e))?;

    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start transaction: {}", e))?;

    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO headers (header_name, include_path, module_name, scope, plugin_name, file_path, relative_path)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .map_err(|e| format!("Failed to prepare insert statement: {}", e))?;

        for r in records {
            stmt.execute(params![
                r.header_name,
                r.include_path,
                r.module_name,
                r.scope,
                r.plugin_name,
                r.file_path,
                r.relative_path
            ])
            .map_err(|e| format!("Failed to insert header record: {}", e))?;
        }
    }

    let now_str = chrono_or_simple_timestamp();
    tx.execute(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_scanned', ?1)",
        params![now_str],
    )
    .map_err(|e| format!("Failed to update metadata: {}", e))?;

    tx.execute(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('root_path', ?1)",
        params![root_path_str],
    )
    .map_err(|e| format!("Failed to update metadata root_path: {}", e))?;

    tx.commit()
        .map_err(|e| format!("Failed to commit transaction: {}", e))?;

    drop(conn);

    if db_path.exists() {
        let _ = fs::remove_file(db_path);
    }
    fs::rename(&temp_db_path, db_path)
        .map_err(|e| format!("Failed to replace final database: {}", e))?;

    Ok(())
}

fn chrono_or_simple_timestamp() -> String {
    use std::time::SystemTime;
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Return ISO 8601-like string or unix timestamp formatted
    format!("{}", now)
}

#[tauri::command]
pub async fn get_include_index_status(
    engine_version: String,
    project_path: Option<String>,
    app: AppHandle,
) -> Result<IndexStatus, String> {
    let engine_db = get_engine_db_path(&app, &engine_version)?;
    let engine_stats = read_db_stats(&engine_db);

    let (engine_indexed, engine_header_count, engine_module_count, engine_last_scanned) =
        match engine_stats {
            Some((h, m, t)) => (h > 0, h, m, t),
            None => (false, 0, 0, None),
        };

    let (project_indexed, project_header_count, project_module_count, project_last_scanned) =
        if let Some(ref proj_p) = project_path {
            let proj_db = get_project_db_path(&app, proj_p)?;
            match read_db_stats(&proj_db) {
                Some((h, m, t)) => (h > 0, h, m, t),
                None => (false, 0, 0, None),
            }
        } else {
            (false, 0, 0, None)
        };

    Ok(IndexStatus {
        engine_version,
        engine_indexed,
        engine_header_count,
        engine_module_count,
        engine_last_scanned,
        project_indexed,
        project_header_count,
        project_module_count,
        project_last_scanned,
    })
}

#[tauri::command]
pub async fn scan_engine_includes(
    engine_root: String,
    engine_version: String,
    app: AppHandle,
) -> Result<IndexStatus, String> {
    let app_clone = app.clone();
    let engine_root_buf = PathBuf::from(&engine_root);

    tokio::task::spawn_blocking(move || {
        let _ = app_clone.emit(
            "include-finder:progress",
            ScanProgressPayload {
                stage: "discovering_modules".to_string(),
                current_count: 0,
                total_estimated: None,
                current_file: None,
            },
        );

        // Resolve Engine Source and Plugins directories
        let mut search_roots: Vec<(PathBuf, &str, Option<String>)> = Vec::new();

        let engine_source = if engine_root_buf.join("Engine/Source").exists() {
            engine_root_buf.join("Engine/Source")
        } else if engine_root_buf.join("Source").exists() {
            engine_root_buf.join("Source")
        } else {
            engine_root_buf.clone()
        };
        search_roots.push((engine_source, "engine", None));

        let engine_plugins = if engine_root_buf.join("Engine/Plugins").exists() {
            Some(engine_root_buf.join("Engine/Plugins"))
        } else if engine_root_buf.join("Plugins").exists() {
            Some(engine_root_buf.join("Plugins"))
        } else {
            None
        };

        if let Some(plugins_dir) = engine_plugins {
            search_roots.push((plugins_dir, "engine_plugin", None));
        }

        let modules = discover_modules(&search_roots);
        let records = index_headers_from_roots(&search_roots, &modules, &engine_root_buf, &app_clone);

        let _ = app_clone.emit(
            "include-finder:progress",
            ScanProgressPayload {
                stage: "finalizing".to_string(),
                current_count: records.len(),
                total_estimated: Some(records.len()),
                current_file: None,
            },
        );

        let engine_db = get_engine_db_path(&app_clone, &engine_version)?;
        save_records_to_sqlite(&engine_db, &records, &engine_root)?;

        let stats = read_db_stats(&engine_db).unwrap_or((records.len(), modules.len(), None));

        Ok(IndexStatus {
            engine_version,
            engine_indexed: stats.0 > 0,
            engine_header_count: stats.0,
            engine_module_count: stats.1,
            engine_last_scanned: stats.2,
            project_indexed: false,
            project_header_count: 0,
            project_module_count: 0,
            project_last_scanned: None,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn scan_project_includes(
    project_path: String,
    app: AppHandle,
) -> Result<IndexStatus, String> {
    let app_clone = app.clone();
    let p_path = PathBuf::from(&project_path);
    let project_root = if p_path.is_file() {
        p_path.parent().unwrap_or(&p_path).to_path_buf()
    } else {
        p_path.clone()
    };

    tokio::task::spawn_blocking(move || {
        let _ = app_clone.emit(
            "include-finder:progress",
            ScanProgressPayload {
                stage: "discovering_modules".to_string(),
                current_count: 0,
                total_estimated: None,
                current_file: None,
            },
        );

        let mut search_roots: Vec<(PathBuf, &str, Option<String>)> = Vec::new();
        let proj_source = project_root.join("Source");
        if proj_source.exists() {
            search_roots.push((proj_source, "project", None));
        }
        let proj_plugins = project_root.join("Plugins");
        if proj_plugins.exists() {
            search_roots.push((proj_plugins, "project_plugin", None));
        }

        let modules = discover_modules(&search_roots);
        let records = index_headers_from_roots(&search_roots, &modules, &project_root, &app_clone);

        let _ = app_clone.emit(
            "include-finder:progress",
            ScanProgressPayload {
                stage: "finalizing".to_string(),
                current_count: records.len(),
                total_estimated: Some(records.len()),
                current_file: None,
            },
        );

        let proj_db = get_project_db_path(&app_clone, &project_path)?;
        save_records_to_sqlite(&proj_db, &records, &project_path)?;

        let stats = read_db_stats(&proj_db).unwrap_or((records.len(), modules.len(), None));

        Ok(IndexStatus {
            engine_version: "".to_string(),
            engine_indexed: false,
            engine_header_count: 0,
            engine_module_count: 0,
            engine_last_scanned: None,
            project_indexed: stats.0 > 0,
            project_header_count: stats.0,
            project_module_count: stats.1,
            project_last_scanned: stats.2,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

fn scope_priority_score(scope: &str) -> i32 {
    match scope {
        "engine" => 1,
        "engine_plugin" => 2,
        "project" => 3,
        "project_plugin" => 4,
        _ => 5,
    }
}

/// Strips common C++ header extensions (.h, .hpp, .inl, .inc) for comparison
fn strip_header_extension(s: &str) -> &str {
    if let Some(stripped) = s
        .strip_suffix(".h")
        .or_else(|| s.strip_suffix(".hpp"))
        .or_else(|| s.strip_suffix(".inl"))
        .or_else(|| s.strip_suffix(".inc"))
        .or_else(|| s.strip_suffix(".H"))
        .or_else(|| s.strip_suffix(".HPP"))
    {
        stripped
    } else {
        s
    }
}

/// Normalizes Unreal Engine C++ class/type prefix (U, A, F, I, E, T, S)
/// e.g., "uphysicalmaterial" -> "physicalmaterial", "AActor" -> "Actor", "FVector" -> "Vector"
fn get_normalized_query(query: &str) -> Option<String> {
    let clean = strip_header_extension(query.trim());
    if clean.len() < 3 {
        return None;
    }

    let mut chars = clean.chars();
    let first = chars.next()?;
    let is_prefix = matches!(
        first,
        'U' | 'u' | 'A' | 'a' | 'F' | 'f' | 'I' | 'i' | 'E' | 'e' | 'T' | 't' | 'S' | 's'
    );

    if is_prefix {
        let rest: String = chars.collect();
        if rest.len() >= 2 {
            return Some(rest);
        }
    }
    None
}

/// Calculates relevance score for an include entry (lower score = higher relevance)
fn calculate_relevance(entry: &IncludeEntry, orig_query: &str, norm_query: Option<&str>) -> i32 {
    let orig = orig_query.to_lowercase();
    let orig_stem = strip_header_extension(&orig).to_string();
    let norm = norm_query.map(|n| n.to_lowercase());
    let norm_stem = norm.as_ref().map(|n| strip_header_extension(n).to_string());

    let header_lower = entry.header_name.to_lowercase();
    let header_stem = strip_header_extension(&header_lower);
    let include_lower = entry.include_path.to_lowercase();
    let module_lower = entry.module_name.to_lowercase();

    // 1. Exact match with original query (e.g. "PhysicalMaterial.h" or "PhysicalMaterial")
    if header_lower == orig || header_stem == orig_stem {
        return 1;
    }

    // 2. Exact match with normalized query (e.g. "PhysicalMaterial.h" when searching "UPhysicalMaterial")
    if let (Some(n), Some(ns)) = (&norm, &norm_stem) {
        if header_lower == *n || header_stem == *ns {
            return 2;
        }
    }

    // 3. Header starts with original query
    if header_lower.starts_with(&orig) || header_stem.starts_with(&orig_stem) {
        return 3;
    }

    // 4. Header starts with normalized query
    if let (Some(n), Some(ns)) = (&norm, &norm_stem) {
        if header_lower.starts_with(n) || header_stem.starts_with(ns) {
            return 4;
        }
    }

    // 5. Header contains original query
    if header_lower.contains(&orig) || header_stem.contains(&orig_stem) {
        return 5;
    }

    // 6. Header contains normalized query
    if let (Some(n), Some(ns)) = (&norm, &norm_stem) {
        if header_lower.contains(n) || header_stem.contains(ns) {
            return 6;
        }
    }

    // 7. Include path contains original query
    if include_lower.contains(&orig) {
        return 7;
    }

    // 8. Include path contains normalized query
    if let Some(n) = &norm {
        if include_lower.contains(n) {
            return 8;
        }
    }

    // 9. Module name contains original query
    if module_lower.contains(&orig) {
        return 9;
    }

    // 10. Module name contains normalized query
    if let Some(n) = &norm {
        if module_lower.contains(n) {
            return 10;
        }
    }

    11
}

fn query_sqlite_db(
    db_path: &Path,
    query: &str,
    scopes: &[String],
    limit: usize,
) -> Vec<IncludeEntry> {
    if !db_path.exists() {
        return Vec::new();
    }

    let conn = match Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    // Optimize SQLite connection for fast read-only in-memory queries
    let _ = conn.execute_batch(
        "PRAGMA mmap_size = 268435456;
         PRAGMA temp_store = MEMORY;
         PRAGMA cache_size = -64000;
         PRAGMA query_only = 1;",
    );

    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let norm_clean = get_normalized_query(trimmed);
    let norm_val = norm_clean.as_deref().unwrap_or(trimmed);

    let pattern_orig = format!("%{}%", trimmed);
    let start_orig = format!("{}%", trimmed);
    let pattern_norm = format!("%{}%", norm_val);
    let start_norm = format!("{}%", norm_val);

    // Build scope placeholders starting after the 6 query parameters
    let mut scope_clause = String::new();
    if !scopes.is_empty() {
        let placeholders: Vec<String> = scopes
            .iter()
            .enumerate()
            .map(|(i, _)| format!("?{}", i + 7))
            .collect();
        scope_clause = format!("AND scope IN ({})", placeholders.join(", "));
    }

    // SQL ranking:
    // 1. Scope priority: engine (1) -> engine_plugin (2) -> project (3) -> project_plugin (4)
    // 2. Relevance: exact orig (1) -> exact norm (2) -> prefix orig (3) -> prefix norm (4) ->
    //    contains orig (5) -> contains norm (6) -> inc orig (7) -> inc norm (8) ->
    //    mod orig (9) -> mod norm (10) -> fallback (11)
    // 3. Header name length ascending (shorter/cleaner names first)
    // 4. Alphabetical header name
    let sql = format!(
        "SELECT id, header_name, include_path, module_name, scope, plugin_name, file_path, relative_path,
            CASE
                WHEN scope = 'engine' THEN 1
                WHEN scope = 'engine_plugin' THEN 2
                WHEN scope = 'project' THEN 3
                WHEN scope = 'project_plugin' THEN 4
                ELSE 5
            END as scope_order,
            CASE
                WHEN LOWER(header_name) = LOWER(?1) OR LOWER(header_name) = LOWER(?1) || '.h' THEN 1
                WHEN LOWER(header_name) = LOWER(?4) OR LOWER(header_name) = LOWER(?4) || '.h' THEN 2
                WHEN LOWER(header_name) LIKE LOWER(?2) THEN 3
                WHEN LOWER(header_name) LIKE LOWER(?5) THEN 4
                WHEN LOWER(header_name) LIKE LOWER(?3) THEN 5
                WHEN LOWER(header_name) LIKE LOWER(?6) THEN 6
                WHEN LOWER(include_path) LIKE LOWER(?3) THEN 7
                WHEN LOWER(include_path) LIKE LOWER(?6) THEN 8
                WHEN LOWER(module_name) LIKE LOWER(?3) THEN 9
                WHEN LOWER(module_name) LIKE LOWER(?6) THEN 10
                ELSE 11
            END as relevance
         FROM headers
         WHERE (header_name LIKE ?3 OR include_path LIKE ?3 OR module_name LIKE ?3
                OR header_name LIKE ?6 OR include_path LIKE ?6 OR module_name LIKE ?6)
           AND header_name NOT LIKE '%.generated.h'
           AND header_name NOT LIKE '%.gen.h'
         {}
         ORDER BY scope_order ASC, relevance ASC, LENGTH(header_name) ASC, header_name ASC
         LIMIT {}",
        scope_clause, limit
    );

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let mut query_params: Vec<&dyn rusqlite::ToSql> = vec![
        &trimmed,
        &start_orig,
        &pattern_orig,
        &norm_val,
        &start_norm,
        &pattern_norm,
    ];
    for s in scopes {
        query_params.push(s);
    }

    let rows = stmt.query_map(query_params.as_slice(), |row| {
        Ok(IncludeEntry {
            id: row.get(0)?,
            header_name: row.get(1)?,
            include_path: row.get(2)?,
            module_name: row.get(3)?,
            scope: row.get(4)?,
            plugin_name: row.get(5)?,
            file_path: row.get(6)?,
            relative_path: row.get(7)?,
        })
    });

    match rows {
        Ok(mapped) => mapped.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    }
}

#[tauri::command]
pub async fn search_includes(
    query: String,
    engine_version: Option<String>,
    project_path: Option<String>,
    scopes: Vec<String>,
    limit: Option<usize>,
    app: AppHandle,
) -> Result<Vec<IncludeEntry>, String> {
    let max_limit = limit.unwrap_or(150);
    let trimmed = query.trim().to_string();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let norm_opt = get_normalized_query(&trimmed);

    tokio::task::spawn_blocking(move || {
        let mut results = Vec::new();

        // 1. Query Engine DB first if available (engine and engine_plugin)
        if let Some(ref eng_ver) = engine_version {
            if let Ok(eng_db) = get_engine_db_path(&app, eng_ver) {
                let eng_results = query_sqlite_db(&eng_db, &trimmed, &scopes, max_limit);
                results.extend(eng_results);
            }
        }

        // 2. Query Project DB if available (project and project_plugin)
        if let Some(ref proj_p) = project_path {
            if let Ok(proj_db) = get_project_db_path(&app, proj_p) {
                let proj_results = query_sqlite_db(&proj_db, &trimmed, &scopes, max_limit);
                results.extend(proj_results);
            }
        }

        // Re-sort overall merged results:
        // 1. Scope priority: Engine core (1) -> Engine plugins (2) -> Project source (3) -> Project plugins (4)
        // 2. Relevance score (exact match > normalized match > prefix > contains > path/module)
        // 3. Header name length ascending (shorter/cleaner names first)
        // 4. Alphabetical header name
        results.sort_by(|a, b| {
            let score_a = scope_priority_score(&a.scope);
            let score_b = scope_priority_score(&b.scope);
            if score_a != score_b {
                return score_a.cmp(&score_b);
            }

            let rel_a = calculate_relevance(a, &trimmed, norm_opt.as_deref());
            let rel_b = calculate_relevance(b, &trimmed, norm_opt.as_deref());
            if rel_a != rel_b {
                return rel_a.cmp(&rel_b);
            }

            if a.header_name.len() != b.header_name.len() {
                return a.header_name.len().cmp(&b.header_name.len());
            }

            a.header_name.cmp(&b.header_name)
        });

        if results.len() > max_limit {
            results.truncate(max_limit);
        }

        Ok(results)
    })
    .await
    .map_err(|e| format!("Search task error: {}", e))?
}

#[tauri::command]
pub async fn clear_engine_include_index(
    engine_version: String,
    app: AppHandle,
) -> Result<(), String> {
    let engine_db = get_engine_db_path(&app, &engine_version)?;
    if engine_db.exists() {
        fs::remove_file(&engine_db)
            .map_err(|e| format!("Failed to delete engine db {}: {}", engine_db.display(), e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_normalized_query() {
        assert_eq!(
            get_normalized_query("uphysicalmaterial"),
            Some("physicalmaterial".to_string())
        );
        assert_eq!(
            get_normalized_query("UPhysicalMaterial.h"),
            Some("PhysicalMaterial".to_string())
        );
        assert_eq!(get_normalized_query("AActor"), Some("Actor".to_string()));
        assert_eq!(get_normalized_query("FVector"), Some("Vector".to_string()));
        assert_eq!(
            get_normalized_query("IModuleInterface"),
            Some("ModuleInterface".to_string())
        );
        assert_eq!(get_normalized_query("ENetRole"), Some("NetRole".to_string()));
        assert_eq!(get_normalized_query("TArray"), Some("Array".to_string()));
        assert_eq!(get_normalized_query("SButton"), Some("Button".to_string()));

        // Non-prefix queries
        assert_eq!(get_normalized_query("PhysicalMaterial"), None);
        assert_eq!(get_normalized_query("JsonObject"), None);
        assert_eq!(get_normalized_query("KismetMathLibrary"), None);

        // Too short queries
        assert_eq!(get_normalized_query("U"), None);
        assert_eq!(get_normalized_query("u1"), None);
    }

    #[test]
    fn test_calculate_relevance() {
        let entry_phys = IncludeEntry {
            id: 1,
            header_name: "PhysicalMaterial.h".to_string(),
            include_path: "PhysicalMaterials/PhysicalMaterial.h".to_string(),
            module_name: "PhysicsCore".to_string(),
            scope: "engine".to_string(),
            plugin_name: None,
            file_path: "/test/PhysicalMaterial.h".to_string(),
            relative_path: "PhysicalMaterial.h".to_string(),
        };

        // Searching "PhysicalMaterial" (exact orig) -> rank 1
        assert_eq!(
            calculate_relevance(&entry_phys, "PhysicalMaterial", None),
            1
        );

        // Searching "uphysicalmaterial" (exact normalized match) -> rank 2
        assert_eq!(
            calculate_relevance(
                &entry_phys,
                "uphysicalmaterial",
                Some("physicalmaterial")
            ),
            2
        );

        // Searching "UPhysicalMaterial.h" (exact normalized match) -> rank 2
        assert_eq!(
            calculate_relevance(
                &entry_phys,
                "UPhysicalMaterial.h",
                Some("PhysicalMaterial")
            ),
            2
        );

        // Searching "uphys" (prefix of normalized "phys") -> rank 4
        assert_eq!(
            calculate_relevance(&entry_phys, "uphys", Some("phys")),
            4
        );
    }
}
