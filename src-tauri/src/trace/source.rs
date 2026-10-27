use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct ExportWindow {
    pub window_id: i64,
    pub start_s: f64,
    pub end_s: f64,
    pub threads: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct PassAOutputs {
    pub threads_csv: PathBuf,
    pub timers_csv: PathBuf,
    pub frames_csv: PathBuf,
}

#[derive(Debug, Clone)]
pub struct PassBOutputs {
    pub window_csvs: Vec<(i64, PathBuf)>,
}

pub trait TraceSource: Send + Sync {
    fn export_pass_a(
        &self,
        trace_path: &Path,
        output_dir: &Path,
        cancel_flag: &Arc<AtomicBool>,
    ) -> Result<PassAOutputs, String>;

    fn export_pass_b(
        &self,
        trace_path: &Path,
        windows: &[ExportWindow],
        output_dir: &Path,
        cancel_flag: &Arc<AtomicBool>,
    ) -> Result<PassBOutputs, String>;
}
