use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::running_process::{clear_running_pid, set_running_pid};
use crate::trace::csv_ingest::ProcessedFrame;
use crate::trace::source::{ExportSlice, PassAOutputs, TraceSource};
use crate::utils::kill_pid;

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TraceCandidate {
    pub path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub modified_ms: u64,
    pub is_cached: bool,
    pub source: String, // "store", "project"
}

pub struct InsightsCliSource {
    pub insights_path: PathBuf,
}

impl InsightsCliSource {
    pub fn new(insights_path: PathBuf) -> Self {
        Self { insights_path }
    }

    pub fn find_insights_exe(engine_root: &Path) -> Option<PathBuf> {
        let candidate = engine_root
            .join("Engine")
            .join("Binaries")
            .join("Win64")
            .join("UnrealInsights.exe");
        if candidate.is_file() {
            Some(candidate)
        } else {
            None
        }
    }

    pub fn list_candidate_traces(
        project_path: Option<&Path>,
        cache_checker: impl Fn(&Path) -> bool,
    ) -> Vec<TraceCandidate> {
        let mut candidates = Vec::new();

        // 1. Unreal Trace Store: %LOCALAPPDATA%/UnrealEngine/Common/UnrealTrace/Store/001/
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let store_dir = PathBuf::from(local_app_data)
                .join("UnrealEngine")
                .join("Common")
                .join("UnrealTrace")
                .join("Store")
                .join("001");
            if store_dir.is_dir() {
                if let Ok(entries) = fs::read_dir(store_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_file()
                            && path
                                .extension()
                                .and_then(|e| e.to_str())
                                .map(|e| e.eq_ignore_ascii_case("utrace"))
                                == Some(true)
                        {
                            if let Ok(meta) = entry.metadata() {
                                let modified_ms = meta
                                    .modified()
                                    .ok()
                                    .and_then(|t| {
                                        t.duration_since(std::time::UNIX_EPOCH)
                                            .ok()
                                            .map(|d| d.as_millis() as u64)
                                    })
                                    .unwrap_or(0);
                                candidates.push(TraceCandidate {
                                    file_name: path
                                        .file_name()
                                        .and_then(|n| n.to_str())
                                        .unwrap_or("")
                                        .to_string(),
                                    path: path.to_string_lossy().to_string(),
                                    size_bytes: meta.len(),
                                    modified_ms,
                                    is_cached: cache_checker(&path),
                                    source: "store".to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }

        // 2. Project Saved/ directories: Saved/Profiling/UnrealTrace, Saved/Trace
        if let Some(proj) = project_path {
            let proj_dir = if proj.is_file() {
                proj.parent().unwrap_or(proj)
            } else {
                proj
            };
            let search_dirs = [
                proj_dir.join("Saved").join("Profiling").join("UnrealTrace"),
                proj_dir.join("Saved").join("Trace"),
                proj_dir.join("Saved").join("Profiling"),
            ];

            for dir in search_dirs {
                if dir.is_dir() {
                    if let Ok(entries) = fs::read_dir(dir) {
                        for entry in entries.flatten() {
                            let path = entry.path();
                            if path.is_file()
                                && path
                                    .extension()
                                    .and_then(|e| e.to_str())
                                    .map(|e| e.eq_ignore_ascii_case("utrace"))
                                    == Some(true)
                            {
                                if let Ok(meta) = entry.metadata() {
                                    let modified_ms = meta
                                        .modified()
                                        .ok()
                                        .and_then(|t| {
                                            t.duration_since(std::time::UNIX_EPOCH)
                                                .ok()
                                                .map(|d| d.as_millis() as u64)
                                        })
                                        .unwrap_or(0);
                                    let path_str = path.to_string_lossy().to_string();
                                    if !candidates.iter().any(|c| c.path == path_str) {
                                        candidates.push(TraceCandidate {
                                            file_name: path
                                                .file_name()
                                                .and_then(|n| n.to_str())
                                                .unwrap_or("")
                                                .to_string(),
                                            path: path_str,
                                            size_bytes: meta.len(),
                                            modified_ms,
                                            is_cached: cache_checker(&path),
                                            source: "project".to_string(),
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Sort descending by modified_ms
        candidates.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
        candidates
    }

    fn run_insights_rsp(
        &self,
        trace_path: &Path,
        rsp_content: &str,
        rsp_path: &Path,
        log_path: &Path,
        cancel_flag: &Arc<AtomicBool>,
    ) -> Result<(), String> {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err("Analysis cancelled before starting Unreal Insights".to_string());
        }

        fs::write(rsp_path, rsp_content)
            .map_err(|e| format!("Failed to write response file: {}", e))?;

        let mut cmd = Command::new(&self.insights_path);
        let trace_arg = format!("-OpenTraceFile={}", trace_path.to_string_lossy());
        let abslog_arg = format!("-ABSLOG={}", log_path.to_string_lossy());
        let rsp_arg = format!("-ExecOnAnalysisCompleteCmd=@={}", rsp_path.to_string_lossy());

        cmd.arg(&trace_arg)
            .arg(&abslog_arg)
            .arg("-AutoQuit")
            .arg("-NoUI")
            .arg("-Silent")
            .arg(&rsp_arg)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());

        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000u32 | 0x0000_0008u32); // CREATE_NO_WINDOW | DETACHED_PROCESS

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn UnrealInsights ({}): {}", self.insights_path.display(), e))?;

        let pid = child.id();
        set_running_pid(pid);

        loop {
            if cancel_flag.load(Ordering::Relaxed) {
                let _ = kill_pid(pid);
                let _ = child.kill();
                clear_running_pid();
                return Err("Analysis cancelled by user".to_string());
            }

            match child.try_wait() {
                Ok(Some(status)) => {
                    clear_running_pid();
                    if !status.success() {
                        let code_str = status.code().map(|c| c.to_string()).unwrap_or_else(|| "terminated by signal".to_string());
                        let log_content = fs::read_to_string(log_path).unwrap_or_default();
                        let tail = log_content.lines().rev().take(15).collect::<Vec<_>>();
                        let log_tail = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
                        return Err(format!(
                            "UnrealInsights exited with non-zero code {}.\nLog details:\n{}",
                            code_str, log_tail
                        ));
                    }
                    return Ok(());
                }
                Ok(None) => {
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => {
                    clear_running_pid();
                    return Err(format!("Error waiting for UnrealInsights process: {}", e));
                }
            }
        }
    }
    pub fn plan_slices(
        frames: &[ProcessedFrame],
        trace_start_s: f64,
        target_frames_per_slice: usize,
    ) -> Vec<ExportSlice> {
        if frames.is_empty() {
            return Vec::new();
        }
        let chunk_size = target_frames_per_slice.max(100);
        let mut slices = Vec::new();
        let pad_s = 0.066; // 66 ms padding for start/end export boundary safety

        let total = frames.len();
        let mut slice_id = 0;
        let mut idx = 0;

        while idx < total {
            let end_idx = (idx + chunk_size).min(total) - 1;
            let first_frame = &frames[idx];
            let last_frame = &frames[end_idx];

            let start_s = (first_frame.start_s - pad_s).max(0.0) + trace_start_s;
            let end_s = last_frame.start_s + (last_frame.interval_ms / 1000.0) + pad_s + trace_start_s;

            slices.push(ExportSlice {
                slice_id,
                frame_from: first_frame.idx,
                frame_to: last_frame.idx,
                start_s,
                end_s,
                threads: vec![
                    "GameThread".to_string(),
                    "RenderThread*".to_string(),
                    "RHIThread".to_string(),
                    "GPU*".to_string(),
                ],
            });

            slice_id += 1;
            idx = end_idx + 1;
        }

        slices
    }
}

impl TraceSource for InsightsCliSource {
    fn export_pass_a(
        &self,
        trace_path: &Path,
        output_dir: &Path,
        cancel_flag: &Arc<AtomicBool>,
    ) -> Result<PassAOutputs, String> {
        let threads_csv = output_dir.join("threads.csv");
        let timers_csv = output_dir.join("timers.csv");
        let frames_csv = output_dir.join("frames_game.csv");
        let bookmarks_csv = output_dir.join("bookmarks.csv");
        let rsp_path = output_dir.join("pass_a.rsp");
        let log_path = output_dir.join("pass_a.log");

        let threads_str = threads_csv.to_string_lossy().replace('\\', "/");
        let timers_str = timers_csv.to_string_lossy().replace('\\', "/");
        let frames_str = frames_csv.to_string_lossy().replace('\\', "/");
        let bookmarks_str = bookmarks_csv.to_string_lossy().replace('\\', "/");

        let rsp_content = format!(
            "TimingInsights.ExportThreads {}\nTimingInsights.ExportTimers {}\nTimingInsights.ExportTimingEvents {} -threads=GameThread,RenderThread*,RHIThread,GPU* -timers=Frame\nTimingInsights.ExportTimingEvents {} -threads=* -timers=*Bookmark*,TRACE_BOOKMARK*,NamedRegion*\n",
            threads_str, timers_str, frames_str, bookmarks_str
        );

        self.run_insights_rsp(trace_path, &rsp_content, &rsp_path, &log_path, cancel_flag)?;

        if !threads_csv.is_file() || !timers_csv.is_file() || !frames_csv.is_file() {
            return Err("UnrealInsights did not generate all required Pass A output CSV files".to_string());
        }

        let bookmarks_out = if bookmarks_csv.is_file() {
            Some(bookmarks_csv)
        } else {
            None
        };

        Ok(PassAOutputs {
            threads_csv,
            timers_csv,
            frames_csv,
            bookmarks_csv: bookmarks_out,
        })
    }

    fn export_slice(
        &self,
        trace_path: &Path,
        slice: &ExportSlice,
        output_dir: &Path,
        cancel_flag: &Arc<AtomicBool>,
    ) -> Result<PathBuf, String> {
        let csv_path = output_dir.join(format!("slice_{}.csv", slice.slice_id));
        let csv_str = csv_path.to_string_lossy().replace('\\', "/");
        let threads_arg = if slice.threads.is_empty() {
            "GameThread,RenderThread*,RHIThread,GPU*".to_string()
        } else {
            slice.threads.join(",")
        };

        let rsp_content = format!(
            "TimingInsights.ExportTimingEvents {} -threads={} -timers=* -startTime={:.4} -endTime={:.4}\n",
            csv_str, threads_arg, slice.start_s, slice.end_s
        );
        let rsp_path = output_dir.join(format!("slice_{}.rsp", slice.slice_id));
        let log_path = output_dir.join(format!("slice_{}.log", slice.slice_id));

        self.run_insights_rsp(trace_path, &rsp_content, &rsp_path, &log_path, cancel_flag)?;

        if !csv_path.is_file() {
            return Err(format!("UnrealInsights failed to export slice {}", slice.slice_id));
        }

        Ok(csv_path)
    }
}
