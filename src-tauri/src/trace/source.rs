use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSlice {
    pub slice_id: i64,
    pub frame_from: i64,
    pub frame_to: i64,
    pub start_s: f64,
    pub end_s: f64,
    pub threads: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct PassAOutputs {
    pub threads_csv: PathBuf,
    pub timers_csv: PathBuf,
    pub frames_csv: PathBuf,
    pub bookmarks_csv: Option<PathBuf>,
}

pub trait TraceSource: Send + Sync {
    fn export_pass_a(
        &self,
        trace_path: &Path,
        output_dir: &Path,
        cancel_flag: &Arc<AtomicBool>,
    ) -> Result<PassAOutputs, String>;

    fn export_slice(
        &self,
        trace_path: &Path,
        slice: &ExportSlice,
        output_dir: &Path,
        cancel_flag: &Arc<AtomicBool>,
    ) -> Result<PathBuf, String>;
}
