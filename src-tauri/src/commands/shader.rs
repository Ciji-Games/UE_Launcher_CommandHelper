//! ShaderCompileWorker process priority (Shader Booster)
//! Dedicated module - monitor.rs is read-only for blocking checks; this needs Windows API for priority.

use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{
    GetPriorityClass, OpenProcess, SetPriorityClass, ABOVE_NORMAL_PRIORITY_CLASS,
    BELOW_NORMAL_PRIORITY_CLASS, HIGH_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS,
    PROCESS_QUERY_INFORMATION, PROCESS_SET_INFORMATION,
};

const PROCESS_NAME: &str = "ShaderCompileWorker";

/// Priority index: 0=BelowNormal, 1=Normal, 2=AboveNormal, 3=High
fn priority_class_from_index(index: u32) -> u32 {
    match index {
        0 => BELOW_NORMAL_PRIORITY_CLASS.0,
        1 => NORMAL_PRIORITY_CLASS.0,
        2 => ABOVE_NORMAL_PRIORITY_CLASS.0,
        3 => HIGH_PRIORITY_CLASS.0,
        _ => BELOW_NORMAL_PRIORITY_CLASS.0,
    }
}

fn priority_name_from_class(class: u32) -> &'static str {
    match class {
        x if x == BELOW_NORMAL_PRIORITY_CLASS.0 => "BelowNormal",
        x if x == NORMAL_PRIORITY_CLASS.0 => "Normal",
        x if x == ABOVE_NORMAL_PRIORITY_CLASS.0 => "AboveNormal",
        x if x == HIGH_PRIORITY_CLASS.0 => "High",
        _ => "Unknown",
    }
}

fn get_shader_worker_pids() -> Vec<u32> {
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing(),
    );
    let mut pids = Vec::new();
    for (pid, process) in sys.processes() {
        let name = process.name().to_string_lossy();
        if name.eq_ignore_ascii_case(PROCESS_NAME)
            || name.eq_ignore_ascii_case(&format!("{}.exe", PROCESS_NAME))
        {
            pids.push(pid.as_u32());
        }
    }
    pids
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShaderStatus {
    pub running: bool,
    pub priority: Option<String>,
}

fn get_priority_for_pid(pid: u32) -> Option<u32> {
    #[cfg(windows)]
    {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_INFORMATION, false, pid).ok()?;
            let class = GetPriorityClass(handle);
            let _ = CloseHandle(handle);
            if class == 0 {
                return None;
            }
            Some(class)
        }
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        None
    }
}

#[tauri::command]
pub fn get_shader_worker_status() -> Result<ShaderStatus, String> {
    let pids = get_shader_worker_pids();
    if pids.is_empty() {
        return Ok(ShaderStatus {
            running: false,
            priority: None,
        });
    }
    Ok(ShaderStatus {
        running: true,
        priority: pids
            .first()
            .and_then(|&pid| get_priority_for_pid(pid))
            .map(|c| priority_name_from_class(c).to_string()),
    })
}

#[tauri::command]
pub fn set_shader_worker_priority(priority: String) -> Result<(), String> {
    let index = match priority.as_str() {
        "BelowNormal" | "0" => 0,
        "Normal" | "1" => 1,
        "AboveNormal" | "2" => 2,
        "High" | "3" => 3,
        _ => return Err(format!("Invalid priority: {}", priority)),
    };
    set_shader_worker_priority_by_index(index)
}

fn set_shader_worker_priority_by_index(index: u32) -> Result<(), String> {
    let pids = get_shader_worker_pids();
    if pids.is_empty() {
        return Err(format!("{} is not running.", PROCESS_NAME));
    }
    let priority_class = priority_class_from_index(index);

    #[cfg(windows)]
    {
        unsafe {
            for pid in pids {
                let handle = OpenProcess(PROCESS_SET_INFORMATION, false, pid)
                    .map_err(|e| format!("OpenProcess failed: {}", e))?;
                SetPriorityClass(
                    handle,
                    windows::Win32::System::Threading::PROCESS_CREATION_FLAGS(priority_class),
                )
                .map_err(|e| format!("SetPriorityClass failed: {}", e))?;
                let _ = CloseHandle(handle);
            }
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (pids, priority_class);
        Err("Shader Booster is only supported on Windows.".to_string())
    }
}
