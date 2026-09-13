//! GitHub device authorization. Tokens never cross the Tauri command boundary.

use serde::Serialize;
use reqwest::blocking::Client;
use std::io::{Read, Write};
use std::net::TcpListener;
use tauri::{AppHandle, Emitter};
use super::secure_credentials;

const CLIENT_ID: &str = "Iv23liLncreHlmomtfsQ";
const SCOPE: &str = "repo";

pub fn start_github_callback_server(app: AppHandle) {
    std::thread::spawn(move || {
        let listener = match TcpListener::bind("127.0.0.1:80") {
            Ok(l) => l,
            Err(err) => {
                eprintln!("[github_auth] Warning: Could not bind callback server on 127.0.0.1:80 ({err}). Trying 127.0.0.1:8080 as backup.");
                match TcpListener::bind("127.0.0.1:8080") {
                    Ok(l) => l,
                    Err(err2) => {
                        eprintln!("[github_auth] Failed to bind callback server on 127.0.0.1:8080 ({err2}).");
                        return;
                    }
                }
            }
        };

        eprintln!("[github_auth] Callback server listening on {:?}", listener.local_addr());

        for stream in listener.incoming() {
            match stream {
                Ok(mut stream) => {
                    let mut buffer = [0u8; 2048];
                    let read_bytes = stream.read(&mut buffer).unwrap_or(0);
                    let request_str = String::from_utf8_lossy(&buffer[..read_bytes]);

                    if request_str.starts_with("GET") {
                        let html_body = r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GitHub App Configured - Unreal Engine Launcher</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 1rem;
      box-sizing: border-box;
    }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      padding: 2.5rem 2rem;
      border-radius: 1rem;
      text-align: center;
      max-width: 440px;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
    }
    .icon {
      font-size: 3rem;
      margin-bottom: 1rem;
    }
    .badge {
      display: inline-block;
      background: rgba(56, 189, 248, 0.15);
      color: #38bdf8;
      border: 1px solid rgba(56, 189, 248, 0.3);
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      margin-bottom: 0.75rem;
    }
    h1 {
      color: #f1f5f9;
      font-size: 1.35rem;
      font-weight: 700;
      margin: 0 0 0.5rem 0;
    }
    p {
      color: #94a3b8;
      font-size: 0.875rem;
      line-height: 1.5;
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#x2705;</div>
    <div class="badge">Unreal Engine Launcher</div>
    <h1>GitHub App Installed!</h1>
    <p>Your GitHub repository access has been updated and synchronized with Unreal Engine Launcher. You can safely close this browser tab and return to the launcher.</p>
  </div>
</body>
</html>"#;

                        let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            html_body.len(),
                            html_body
                        );
                        let _ = stream.write_all(response.as_bytes());
                        let _ = stream.flush();

                        let _ = app.emit("github://app-installed", serde_json::json!({ "status": "installed" }));
                    }
                }
                Err(err) => {
                    eprintln!("[github_auth] Error accepting connection: {err}");
                }
            }
        }
    });
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAuthorization {
    pub user_code: String,
    pub verification_uri: String,
    pub device_code: String,
    pub interval: u64,
    pub expires_in: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubCommandResult<T> {
    pub ok: bool,
    pub data: Option<T>,
    pub category: Option<String>,
    pub message: String,
}

#[derive(Serialize)]
struct DeviceRequest<'a> { client_id: &'a str, scope: &'a str }

#[derive(serde::Deserialize)]
struct DeviceResponse { device_code: String, user_code: String, verification_uri: String, interval: Option<u64>, expires_in: u64 }

#[tauri::command]
pub fn github_start_authorization() -> GitHubCommandResult<DeviceAuthorization> {
    let client = Client::builder().timeout(std::time::Duration::from_secs(15)).build();
    let response = client.and_then(|client| client.post("https://github.com/login/device/code").header("Accept", "application/json").json(&DeviceRequest { client_id: CLIENT_ID, scope: SCOPE }).send());
    match response.and_then(|value| value.error_for_status()).and_then(|value| value.json::<DeviceResponse>()) {
        Ok(value) => GitHubCommandResult { ok: true, data: Some(DeviceAuthorization { user_code: value.user_code, verification_uri: value.verification_uri, device_code: value.device_code, interval: value.interval.unwrap_or(5), expires_in: value.expires_in }), category: None, message: String::new() },
        Err(error) => GitHubCommandResult { ok: false, data: None, category: Some("network".to_owned()), message: format!("Unable to start GitHub authorization: {error}") },
    }
}

#[derive(serde::Deserialize)]
struct TokenResponse { access_token: Option<String>, error: Option<String>, error_description: Option<String> }

#[derive(Serialize)]
struct TokenRequest<'a> { client_id: &'a str, device_code: &'a str, grant_type: &'a str }

#[tauri::command]
pub fn github_complete_authorization(device_code: String) -> GitHubCommandResult<bool> {
    let client = Client::builder().timeout(std::time::Duration::from_secs(15)).build();
    let response = client.and_then(|client| client.post("https://github.com/login/oauth/access_token").header("Accept", "application/json").json(&TokenRequest { client_id: CLIENT_ID, device_code: &device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }).send());
    match response.and_then(|value| value.error_for_status()).and_then(|value| value.json::<TokenResponse>()) {
        Ok(value) if value.access_token.is_some() => match secure_credentials::write_token(value.access_token.as_ref().unwrap()) { Ok(()) => GitHubCommandResult { ok: true, data: Some(true), category: None, message: "GitHub authorization connected.".to_owned() }, Err(error) => GitHubCommandResult { ok: false, data: None, category: Some("secure-storage".to_owned()), message: format!("GitHub authorization could not be stored securely: {error}") } },
        Ok(value) => GitHubCommandResult { ok: false, data: None, category: Some(value.error.unwrap_or_else(|| "authorization-pending".to_owned())), message: value.error_description.unwrap_or_else(|| "GitHub authorization is still pending or was denied.".to_owned()) },
        Err(error) => GitHubCommandResult { ok: false, data: None, category: Some("network".to_owned()), message: format!("Unable to complete GitHub authorization: {error}") },
    }
}

#[tauri::command]
pub fn github_is_connected() -> bool {
    secure_credentials::read_token().map(|token| token.is_some()).unwrap_or(false)
}

#[tauri::command]
pub fn github_disconnect() -> GitHubCommandResult<bool> {
    match secure_credentials::delete_token() { Ok(()) => GitHubCommandResult { ok: true, data: Some(true), category: None, message: "GitHub authorization disconnected.".to_owned() }, Err(error) => GitHubCommandResult { ok: false, data: None, category: Some("secure-storage".to_owned()), message: format!("Could not disconnect GitHub securely: {error}") } }
}