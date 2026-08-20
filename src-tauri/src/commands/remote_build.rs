//! Safe local Git operations for the automatic-build monitor.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use serde::Serialize;
use crate::utils::build_cmd;
use walkdir::WalkDir;
use base64::Engine;
use super::secure_credentials;
use crate::stream_processor;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommandResult {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutStatus {
    pub repository_path: String,
    pub current_branch: Option<String>,
    pub head_commit: Option<String>,
    pub remote_commit: Option<String>,
    pub is_behind: bool,
    pub behind_count: u32,
    pub worktree_clean: bool,
    pub index_clean: bool,
    pub remote_url: Option<String>,
    pub git_lfs_available: bool,
    pub git_lfs_error: Option<String>,
    pub remotes: Vec<String>,
    pub branches: Vec<String>,
    pub projects: Vec<DetectedRemoteProject>,
    pub result: GitCommandResult,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedRemoteProject {
    pub project_path: String,
    pub project_name: String,
    pub engine_version: String,
}

fn run_git(repository: &Path, args: &[&str]) -> GitCommandResult {
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
    let mut command = build_cmd("git", &args, repository.to_str());
    command.env("GIT_TERMINAL_PROMPT", "0");
    match command_output(command) {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            GitCommandResult { ok: output.status.success(), stdout, stderr: stderr.clone(), error: (!output.status.success()).then(|| actionable_git_error(&stderr)) }
        }
        Err(error) => GitCommandResult { ok: false, stdout: String::new(), stderr: String::new(), error: Some(format!("Unable to start git: {error}")) },
    }
}

fn run_authenticated_git(repository: &Path, args: &[&str]) -> GitCommandResult {
    let token = match secure_credentials::read_token() {
        Ok(Some(token)) => token,
        Ok(None) => return run_git(repository, args),
        Err(_) => return run_git(repository, args),
    };
    let values: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
    let credential = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
    let mut command = build_cmd("git", &values, repository.to_str());
    command.env("GIT_TERMINAL_PROMPT", "0").env("GIT_CONFIG_COUNT", "1").env("GIT_CONFIG_KEY_0", "http.extraHeader").env("GIT_CONFIG_VALUE_0", format!("Authorization: Basic {credential}"));
    match command_output_with_timeout(command, Duration::from_secs(120)) {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            let res = GitCommandResult { ok: output.status.success(), stdout, stderr: stderr.clone(), error: (!output.status.success()).then(|| actionable_git_error(&stderr)) };
            if !res.ok {
                let fallback = run_git(repository, args);
                if fallback.ok {
                    return fallback;
                }
            }
            res
        }
        Err(error) => {
            let fallback = run_git(repository, args);
            if fallback.ok {
                return fallback;
            }
            GitCommandResult { ok: false, stdout: String::new(), stderr: String::new(), error: Some(format!("Unable to start git: {error}")) }
        }
    }
}

fn command_output(command: Command) -> Result<Output, std::io::Error> {
    command_output_with_timeout(command, Duration::from_secs(30))
}

fn command_output_with_timeout(mut command: Command, timeout: Duration) -> Result<Output, std::io::Error> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let started = Instant::now();
    let mut child = command.spawn()?;
    loop {
        if child.try_wait()?.is_some() {
            return child.wait_with_output();
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, format!("Git command timed out after {} seconds.", timeout.as_secs())));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn actionable_git_error(stderr: &str) -> String {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("permission denied (publickey)") || lower.contains("no supported authentication methods available") {
        return "GitHub SSH authentication failed. Configure an SSH key/agent for this Windows user, or change the checkout remote to an HTTPS URL; the launcher never stores Git credentials.".to_owned();
    }
    if lower.contains("could not read username") || lower.contains("authentication") || lower.contains("credential") {
        return "Git authentication failed. Configure credentials for this Windows user, or use an authenticated HTTPS remote; the launcher never stores Git credentials.".to_owned();
    }
    if lower.contains("could not resolve host") || lower.contains("unable to access") || lower.contains("network") {
        return "Git could not access the remote. Check network access and the configured remote URL.".to_owned();
    }
    if lower.contains("does not appear to be a git repository") { return "The selected folder is not a Git repository.".to_owned(); }
    if lower.contains("not found") && lower.contains("branch") { return "The configured build branch was not found in the repository or remote.".to_owned(); }
    stderr.trim().to_owned()
}

fn clone_destination_error(destination: &Path) -> Option<String> {
    if !destination.exists() {
        let mut ancestor = destination.parent();
        while let Some(path) = ancestor {
            if path.exists() {
                return (!path.is_dir()).then(|| "The parent folder for the clone destination is not a directory.".to_owned());
            }
            ancestor = path.parent();
        }
        return Some("The parent folder for the clone destination does not exist.".to_owned());
    }
    if !destination.is_dir() {
        return Some("The clone destination is an existing file; choose a new or empty folder.".to_owned());
    }
    let entries = match std::fs::read_dir(destination) {
        Ok(entries) => entries,
        Err(error) => return Some(format!("The clone destination could not be inspected: {error}")),
    };
    let entries: Vec<_> = entries.filter_map(Result::ok).collect();
    if entries.is_empty() {
        return None;
    }
    if entries.iter().any(|entry| entry.file_name() == ".git") {
        return Some("The clone destination already contains a Git checkout (including hidden .git metadata). Choose a different folder; existing checkouts are never overwritten.".to_owned());
    }
    Some("The clone destination must be new or an empty folder. Existing files are never overwritten.".to_owned())
}

#[cfg(test)]
mod path_tests {
    use std::path::Path;

    fn checkout_path(target: &Path) -> std::path::PathBuf { target.join("BuildRepo") }
    fn packaged_build_path(target: &Path, commit: &str) -> std::path::PathBuf { target.join("PackagedBuild").join(commit) }

    #[test]
    fn separates_checkout_and_packaged_build_paths() {
        let target = Path::new(r"C:\builds\project");
        assert_eq!(checkout_path(target), target.join("BuildRepo"));
        assert_eq!(packaged_build_path(target, "abc123"), target.join("PackagedBuild").join("abc123"));
        assert_ne!(checkout_path(target), packaged_build_path(target, "abc123"));
    }
}

#[cfg(test)]
mod tests {
    use super::{actionable_git_error, clone_destination_error};
    use std::fs;
    use std::path::PathBuf;

    fn test_directory(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("ue-launcher-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create test directory");
        path
    }

    #[test]
    fn accepts_an_existing_empty_clone_destination() {
        let path = test_directory("empty-clone-destination");

        assert_eq!(clone_destination_error(&path), None);

        fs::remove_dir_all(path).expect("remove test directory");
    }

    #[test]
    fn rejects_a_non_empty_clone_destination() {
        let path = test_directory("non-empty-clone-destination");
        fs::write(path.join("README.md"), "existing").expect("create test file");

        let error = clone_destination_error(&path).expect("destination should be rejected");
        assert!(error.contains("new or an empty folder"));

        fs::remove_dir_all(path).expect("remove test directory");
    }

    #[test]
    fn identifies_an_existing_git_checkout() {
        let path = test_directory("git-clone-destination");
        fs::create_dir(path.join(".git")).expect("create git metadata directory");

        let error = clone_destination_error(&path).expect("destination should be rejected");
        assert!(error.contains("already contains a Git checkout"));

        fs::remove_dir_all(path).expect("remove test directory");
    }

    #[test]
    fn accepts_a_clone_destination_with_missing_intermediate_folders() {
        let root = test_directory("missing-clone-parent");
        let destination = root.join("target").join("BuildRepo");

        assert_eq!(clone_destination_error(&destination), None);

        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn explains_github_ssh_authentication_failures() {
        let message = actionable_git_error("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.");

        assert!(message.contains("SSH authentication failed"));
        assert!(message.contains("SSH key/agent"));
    }

    #[test]
    fn keeps_other_remote_errors_actionable() {
        let message = actionable_git_error("fatal: unable to access 'https://github.com/example/repo.git': Could not resolve host");

        assert_eq!(message, "Git could not access the remote. Check network access and the configured remote URL.");
    }

    #[test]
    fn clone_uses_only_the_selected_branch() {
        let args = super::clone_arguments("main", "https://github.com/example/repo.git", r"C:\build\BuildRepo");

        assert_eq!(args, vec![
            "clone",
            "--no-tags",
            "--branch",
            "main",
            "--single-branch",
            "https://github.com/example/repo.git",
            r"C:\build\BuildRepo",
        ]);
    }
}

fn require_repository(path: &str) -> Result<PathBuf, GitCommandResult> {
    let repository = PathBuf::from(path);
    if !repository.is_dir() {
        return Err(GitCommandResult {
            ok: false,
            stdout: String::new(),
            stderr: String::new(),
            error: Some("The selected folder must be an existing Git checkout.".to_owned()),
        });
    }
    Ok(repository)
}

fn detected_projects(repository: &Path) -> Vec<DetectedRemoteProject> {
    WalkDir::new(repository)
        .min_depth(1)
        .max_depth(4)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter(|entry| entry.path().extension().is_some_and(|extension| extension.eq_ignore_ascii_case("uproject")))
        .filter_map(|entry| {
            let path = entry.path();
            let content = std::fs::read_to_string(path).ok()?;
            let json: serde_json::Value = serde_json::from_str(&content).ok()?;
            let engine_version = json.get("EngineAssociation").and_then(|value| value.as_str()).unwrap_or("Unknown").to_owned();
            Some(DetectedRemoteProject {
                project_path: path.to_string_lossy().to_string(),
                project_name: path.file_stem()?.to_string_lossy().to_string(),
                engine_version,
            })
        })
        .collect()
}

fn clone_arguments(build_branch: &str, clone_url: &str, destination: &str) -> Vec<String> {
    vec![
        "clone".to_owned(),
        "--no-tags".to_owned(),
        "--branch".to_owned(),
        build_branch.to_owned(),
        "--single-branch".to_owned(),
        clone_url.to_owned(),
        destination.to_owned(),
    ]
}

fn ensure_clone_branch(repository: &Path, build_branch: &str) -> GitCommandResult {
    let current = run_git(repository, &["branch", "--show-current"]);
    if current.ok && current.stdout == build_branch {
        return current;
    }

    // `git clone --branch` normally creates the local branch already. If HEAD
    // is detached, switch to that existing branch before attempting to create
    // one; otherwise Git reports that the branch already exists.
    let checkout = run_git(repository, &["checkout", build_branch]);
    let checkout = if checkout.ok {
        checkout
    } else if current.ok && current.stdout.is_empty() {
        run_git(repository, &["checkout", "-b", build_branch, &format!("origin/{build_branch}")])
    } else {
        checkout
    };
    if !checkout.ok {
        return checkout;
    }

    run_git(repository, &["branch", "--show-current"])
}

#[tauri::command]
pub fn prepare_remote_build_output(output_root: String, keep_count: u32) -> Result<(), String> {
    let root = PathBuf::from(&output_root);
    if output_root.trim().is_empty() {
        return Err("The automatic-build output folder is not configured.".to_owned());
    }
    if root.exists() && !root.is_dir() {
        return Err("The automatic-build output path is not a folder.".to_owned());
    }
    std::fs::create_dir_all(&root).map_err(|error| format!("Could not create the build output folder: {error}"))?;

    let mut entries = std::fs::read_dir(&root)
        .map_err(|error| format!("Could not inspect the build output folder: {error}"))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((entry.path(), modified))
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| right.1.cmp(&left.1));

    let keep = keep_count as usize;
    for (path, _) in entries.into_iter().skip(keep) {
        let result = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        result.map_err(|error| format!("Could not remove old build '{}': {error}", path.display()))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn archive_remote_build_output(app: AppHandle, output_directory: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || archive_remote_build_output_impl(app, output_directory))
        .await
        .map_err(|error| format!("Build archiving task failed: {error}"))?
}

fn archive_remote_build_output_impl(app: AppHandle, output_directory: String) -> Result<String, String> {
    let directory = PathBuf::from(&output_directory);
    if !directory.is_dir() {
        return Err("The packaged build folder does not exist.".to_owned());
    }
    let files = WalkDir::new(&directory)
        .into_iter()
        .map(|entry| entry.map_err(|error| format!("Could not inspect build file: {error}")))
        .collect::<Result<Vec<_>, _>>()?;
    let total_bytes = files
        .iter()
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.metadata().map(|metadata| metadata.len()).map_err(|error| format!("Could not inspect build file '{}': {error}", entry.path().display())))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .sum::<u64>();

    let archive_path = directory.with_extension("zip");
    let file = File::create(&archive_path).map_err(|error| format!("Could not create build archive: {error}"))?;
    let mut archive = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let started = Instant::now();
    let mut processed_bytes = 0_u64;
    stream_processor::emit_progress(&app, 0, started.elapsed().as_millis() as u64);

    for entry in files {
        let path = entry.path();
        let relative = path.strip_prefix(&directory).map_err(|error| error.to_string())?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        let name = relative.to_string_lossy().replace('\\', "/");
        if path.is_dir() {
            archive.add_directory(format!("{name}/"), options).map_err(|error| format!("Could not add build folder to archive: {error}"))?;
        } else {
            archive.start_file(name, options).map_err(|error| format!("Could not add build file to archive: {error}"))?;
            let mut input = File::open(path).map_err(|error| format!("Could not read build file: {error}"))?;
            let mut buffer = [0_u8; 1024 * 1024];
            loop {
                let read = input.read(&mut buffer).map_err(|error| format!("Could not read build file: {error}"))?;
                if read == 0 {
                    break;
                }
                archive.write_all(&buffer[..read]).map_err(|error| format!("Could not write build archive: {error}"))?;
                processed_bytes += read as u64;
                let percent = if total_bytes == 0 { 100 } else { ((processed_bytes * 100) / total_bytes).min(100) as u32 };
                stream_processor::emit_progress(&app, percent, started.elapsed().as_millis() as u64);
            }
        }
    }

    archive.finish().map_err(|error| format!("Could not finish build archive: {error}"))?;
    stream_processor::emit_progress(&app, 100, started.elapsed().as_millis() as u64);
    std::fs::remove_dir_all(&directory).map_err(|error| format!("Could not remove unpacked build after archiving: {error}"))?;
    Ok(archive_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn inspect_remote_build_checkout(repository_path: String, remote_name: String, build_branch: String) -> CheckoutStatus {
    eprintln!("[automatic-build] checkout inspection starting: repository={}, branch={}", repository_path, build_branch);
    let repository = match require_repository(&repository_path) {
        Ok(path) => path,
        Err(result) => return CheckoutStatus {
            repository_path,
            current_branch: None,
            head_commit: None,
            remote_commit: None,
            is_behind: false,
            behind_count: 0,
            worktree_clean: false,
            index_clean: false,
            remote_url: None,
            git_lfs_available: false,
            git_lfs_error: result.error.clone(),
            remotes: vec![],
            branches: vec![],
            projects: vec![],
            result,
        },
    };

    if !build_branch.is_empty() && !remote_name.is_empty() {
        let refspec = format!("+refs/heads/{build_branch}:refs/remotes/{remote_name}/{build_branch}");
        let _ = run_authenticated_git(&repository, &["fetch", "--prune", &remote_name, &refspec]);
    }

    let branch = run_git(&repository, &["branch", "--show-current"]);
    let head = run_git(&repository, &["rev-parse", "HEAD"]);
    let remote = if build_branch.is_empty() {
        GitCommandResult { ok: false, stdout: String::new(), stderr: String::new(), error: Some("Select a build branch.".to_owned()) }
    } else {
        let rev = run_git(&repository, &["rev-parse", &format!("refs/remotes/{remote_name}/{build_branch}")]);
        if rev.ok {
            rev
        } else {
            run_git(&repository, &["rev-parse", "FETCH_HEAD"])
        }
    };
    let remote_url = run_git(&repository, &["remote", "get-url", &remote_name]);
    let status = run_git(&repository, &["status", "--porcelain"]);
    let lfs = run_git(&repository, &["lfs", "version"]);
    let remotes_result = run_git(&repository, &["remote"]);
    let branches_result = run_git(&repository, &["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"]);
    let result = if !branch.ok { branch.clone() } else if !head.ok { head.clone() } else { status.clone() };

    let (is_behind, behind_count) = if let (Some(head_sha), Some(remote_sha)) = (head.ok.then_some(&head.stdout), remote.ok.then_some(&remote.stdout)) {
        if head_sha == remote_sha {
            (false, 0)
        } else {
            let rev_list = run_git(&repository, &["rev-list", "--count", &format!("{head_sha}..{remote_sha}")]);
            if rev_list.ok {
                let count = rev_list.stdout.trim().parse::<u32>().unwrap_or(0);
                (count > 0, count)
            } else {
                (false, 0)
            }
        }
    } else {
        (false, 0)
    };

    let checkout_status = CheckoutStatus {
        repository_path,
        current_branch: branch.ok.then_some(branch.stdout),
        head_commit: head.ok.then_some(head.stdout),
        remote_commit: remote.ok.then_some(remote.stdout),
        is_behind,
        behind_count,
        worktree_clean: status.ok && status.stdout.is_empty(),
        index_clean: status.ok && status.stdout.lines().all(|line| line.as_bytes().first() == Some(&b' ')),
        remote_url: remote_url.ok.then_some(remote_url.stdout),
        git_lfs_available: lfs.ok,
        git_lfs_error: lfs.error,
        remotes: remotes_result.stdout.lines().map(str::to_owned).collect(),
        branches: branches_result.stdout.lines().filter(|branch| !branch.ends_with(&format!("/{build_branch}"))).map(str::to_owned).collect(),
        projects: detected_projects(&repository),
        result,
    };
    eprintln!("[automatic-build] checkout inspection completed: repository={}, branch={}, current_branch={}, clean={}, behind={}", checkout_status.repository_path, build_branch, checkout_status.current_branch.as_deref().unwrap_or("(unknown)"), checkout_status.worktree_clean && checkout_status.index_clean, checkout_status.is_behind);
    checkout_status
}

#[tauri::command]
pub fn fetch_remote_build_branch(repository_path: String, remote_name: String, build_branch: String) -> GitCommandResult {
    eprintln!("[automatic-build] fetch starting: repository={}, remote={}, branch={}", repository_path, remote_name, build_branch);
    let repository = match require_repository(&repository_path) {
        Ok(path) => path,
        Err(result) => return result,
    };
    let current = run_git(&repository, &["branch", "--show-current"]);
    if !current.ok || current.stdout != build_branch {
        return GitCommandResult { ok: false, stdout: current.stdout, stderr: current.stderr, error: Some("The checkout is not on the configured build branch; no fetch was started.".to_owned()) };
    }
    let status = run_git(&repository, &["status", "--porcelain"]);
    if !status.ok || !status.stdout.is_empty() {
        return GitCommandResult { ok: false, stdout: status.stdout, stderr: status.stderr, error: Some("The checkout has local changes; clean the worktree and index before fetching.".to_owned()) };
    }
    let refspec = format!("+refs/heads/{build_branch}:refs/remotes/{remote_name}/{build_branch}");
    let result = run_authenticated_git(&repository, &["fetch", "--prune", &remote_name, &refspec]);
    eprintln!("[automatic-build] fetch {}: repository={}, remote={}, branch={}, error={}", if result.ok { "completed" } else { "failed" }, repository_path, remote_name, build_branch, result.error.as_deref().unwrap_or("none"));
    result
}

#[tauri::command]
pub fn update_remote_build_checkout(repository_path: String, build_branch: String, target_commit: String) -> GitCommandResult {
    eprintln!("[automatic-build] checkout update starting: repository={}, branch={}, target={}", repository_path, build_branch, target_commit);
    let repository = match require_repository(&repository_path) {
        Ok(path) => path,
        Err(result) => return result,
    };
    let current = run_git(&repository, &["branch", "--show-current"]);
    let status = run_git(&repository, &["status", "--porcelain"]);
    if !current.ok || current.stdout != build_branch || !status.ok || !status.stdout.is_empty() {
        return GitCommandResult { ok: false, stdout: status.stdout, stderr: status.stderr, error: Some("The checkout must remain on the configured branch with no local changes; no update was started.".to_owned()) };
    }
    let result = run_git(&repository, &["merge", "--ff-only", &target_commit]);
    eprintln!("[automatic-build] checkout update {}: repository={}, target={}, error={}", if result.ok { "completed" } else { "failed" }, repository_path, target_commit, result.error.as_deref().unwrap_or("none"));
    result
}

/// Clone only a GitHub HTTPS repository into a new, empty destination.
/// The token is supplied to Git through an ephemeral environment configuration,
/// never through the remote URL, persisted files, or a serialized result.
#[tauri::command]
pub fn clone_github_repository(clone_url: String, destination: String, build_branch: String) -> GitCommandResult {
    let destination_path = PathBuf::from(&destination);
    if !clone_url.starts_with("https://github.com/") || !clone_url.ends_with(".git") {
        return GitCommandResult { ok: false, stdout: String::new(), stderr: String::new(), error: Some("Only HTTPS GitHub repository URLs returned by the GitHub API can be cloned.".to_owned()) };
    }
    if build_branch.trim().is_empty() || build_branch.contains('\n') || build_branch.contains('\r') {
        return GitCommandResult { ok: false, stdout: String::new(), stderr: String::new(), error: Some("Select a valid GitHub branch before cloning.".to_owned()) };
    }
    if let Some(error) = clone_destination_error(&destination_path) {
        return GitCommandResult { ok: false, stdout: String::new(), stderr: String::new(), error: Some(error) };
    }
    if let Some(parent) = destination_path.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            return GitCommandResult { ok: false, stdout: String::new(), stderr: String::new(), error: Some(format!("The clone parent folder could not be created: {error}")) };
        }
    }
    let token = match secure_credentials::read_token() {
        Ok(Some(token)) => token,
        Ok(None) => return GitCommandResult { ok: false, stdout: String::new(), stderr: String::new(), error: Some("Connect GitHub before cloning.".to_owned()) },
        Err(error) => return GitCommandResult { ok: false, stdout: String::new(), stderr: String::new(), error: Some(format!("Unable to access secure GitHub credentials: {error}")) },
    };
    let credential = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
    let args = clone_arguments(&build_branch, &clone_url, &destination);
    eprintln!("[automatic-build] clone starting: branch='{build_branch}', destination='{destination}'");
    let mut command = build_cmd("git", &args, None);
    command.env("GIT_TERMINAL_PROMPT", "0").env("GIT_CONFIG_COUNT", "1").env("GIT_CONFIG_KEY_0", "http.extraHeader").env("GIT_CONFIG_VALUE_0", format!("Authorization: Basic {credential}"));
    match command_output_with_timeout(command, Duration::from_secs(600)) {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            let mut result = GitCommandResult { ok: output.status.success(), stdout, stderr: stderr.clone(), error: (!output.status.success()).then(|| actionable_git_error(&stderr)) };
            if result.ok {
                let checkout = ensure_clone_branch(&destination_path, &build_branch);
                if checkout.ok && checkout.stdout == build_branch {
                    eprintln!("[automatic-build] clone checkout ready: branch='{build_branch}', destination='{destination}'");
                } else {
                    let error = checkout.error.unwrap_or_else(|| format!("Git checked out branch '{}' instead of '{}'.", checkout.stdout, build_branch));
                    result = GitCommandResult { ok: false, stdout: checkout.stdout, stderr: checkout.stderr, error: Some(error) };
                    eprintln!("[automatic-build] clone branch setup failed: branch='{build_branch}', destination='{destination}', error='{}'", result.error.as_deref().unwrap_or("unknown Git error"));
                }
            }
            if result.ok {
                eprintln!("[automatic-build] clone completed: branch='{build_branch}', destination='{destination}'");
            } else {
                eprintln!("[automatic-build] clone failed: branch='{build_branch}', destination='{destination}', error='{}'", result.error.as_deref().unwrap_or("unknown Git error"));
            }
            result
        }
        Err(error) => {
            eprintln!("[automatic-build] clone could not start: branch='{build_branch}', destination='{destination}', error='{error}'");
            GitCommandResult { ok: false, stdout: String::new(), stderr: String::new(), error: Some(format!("Unable to start git: {error}")) }
        }
    }
}

#[tauri::command]
pub fn validate_clone_destination(destination: String) -> GitCommandResult {
    match clone_destination_error(Path::new(&destination)) {
        Some(error) => GitCommandResult { ok: false, stdout: String::new(), stderr: String::new(), error: Some(error) },
        None => GitCommandResult { ok: true, stdout: String::new(), stderr: String::new(), error: None },
    }
}

