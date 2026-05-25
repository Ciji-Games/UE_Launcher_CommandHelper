//! File helpers for frontend utilities.

use std::path::Path;

/// Read a text file into a String.
///
/// Supports UTF-8 and UTF-16 (LE/BE) with BOM. Falls back to lossy UTF-8.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("File does not exist: {}", path));
    }
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    if bytes.len() >= 2 {
        // UTF-16 with BOM
        if bytes[0] == 0xFF && bytes[1] == 0xFE {
            return decode_utf16(&bytes[2..], true);
        }
        if bytes[0] == 0xFE && bytes[1] == 0xFF {
            return decode_utf16(&bytes[2..], false);
        }
        // UTF-8 BOM
        if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
            return String::from_utf8(bytes[3..].to_vec()).map_err(|e| e.to_string());
        }
    }

    // Try strict UTF-8 first.
    match String::from_utf8(bytes.clone()) {
        Ok(s) => Ok(s),
        Err(_) => Ok(String::from_utf8_lossy(&bytes).to_string()),
    }
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> Result<String, String> {
    if bytes.len() % 2 != 0 {
        // drop trailing byte
    }
    let mut u16s = Vec::with_capacity(bytes.len() / 2);
    let mut i = 0usize;
    while i + 1 < bytes.len() {
        let u = if little_endian {
            u16::from_le_bytes([bytes[i], bytes[i + 1]])
        } else {
            u16::from_be_bytes([bytes[i], bytes[i + 1]])
        };
        u16s.push(u);
        i += 2;
    }
    String::from_utf16(&u16s).map_err(|e| e.to_string())
}

