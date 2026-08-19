//! GitHub device authorization. Tokens never cross the Tauri command boundary.

use serde::Serialize;
use reqwest::blocking::Client;
use super::secure_credentials;

const CLIENT_ID: &str = "Ov23lil4I3jArpLzXpDo";
const SCOPE: &str = "repo";

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
pub fn github_disconnect() -> GitHubCommandResult<bool> {
    match secure_credentials::delete_token() { Ok(()) => GitHubCommandResult { ok: true, data: Some(true), category: None, message: "GitHub authorization disconnected.".to_owned() }, Err(error) => GitHubCommandResult { ok: false, data: None, category: Some("secure-storage".to_owned()), message: format!("Could not disconnect GitHub securely: {error}") } }
}