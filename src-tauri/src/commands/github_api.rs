//! Read-only GitHub API access using the token held by secure_credentials.

use serde::Serialize;
use reqwest::blocking::Client;
use super::secure_credentials;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubApiResult<T> { pub ok: bool, pub data: Option<T>, pub category: Option<String>, pub message: String }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubAccount { pub account_id: String, pub login: String, pub display_name: Option<String>, pub avatar_url: Option<String>, pub scopes: Vec<String>, pub connected_at: String }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRepository { pub id: String, pub owner: String, pub name: String, pub full_name: String, pub private: bool, pub default_branch: String, pub clone_url: String, pub updated_at: Option<String> }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubBranch { pub name: String, pub commit: String, pub protected: bool }

fn client() -> Result<Client, String> { Ok(Client::builder().user_agent("UE-Launcher-CommandHelper").timeout(std::time::Duration::from_secs(15)).build().map_err(|error| error.to_string())?) }
fn token() -> Result<String, String> { secure_credentials::read_token()?.ok_or_else(|| "Connect a GitHub account before browsing repositories.".to_owned()) }
fn request(path: &str) -> Result<reqwest::blocking::Response, String> { let value = client()?.get(format!("https://api.github.com{path}")).bearer_auth(token()?).header("Accept", "application/vnd.github+json").send().map_err(|error| format!("GitHub network request failed: {error}"))?; if value.status().is_success() { Ok(value) } else if value.status().as_u16() == 401 || value.status().as_u16() == 403 { Err("GitHub authorization expired or lacks permission for this repository.".to_owned()) } else { Err(format!("GitHub returned HTTP {}.", value.status())) } }

#[derive(serde::Deserialize)] struct User { id: u64, login: String, name: Option<String>, avatar_url: Option<String> }
#[tauri::command]
pub fn github_current_account() -> GitHubApiResult<GitHubAccount> { match request("/user").and_then(|response| response.json::<User>().map_err(|error| error.to_string())) { Ok(user) => GitHubApiResult { ok: true, data: Some(GitHubAccount { account_id: user.id.to_string(), login: user.login, display_name: user.name, avatar_url: user.avatar_url, scopes: vec!["repo".to_owned()], connected_at: chrono_like_now() }), category: None, message: String::new() }, Err(error) => GitHubApiResult { ok: false, data: None, category: Some("authorization".to_owned()), message: error } } }

fn chrono_like_now() -> String { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|value| value.as_secs().to_string()).unwrap_or_default() }

#[derive(serde::Deserialize)] struct ApiRepo { id: u64, name: String, full_name: String, private: bool, default_branch: String, clone_url: String, updated_at: Option<String>, owner: ApiOwner }
#[derive(serde::Deserialize)] struct ApiOwner { login: String }
#[tauri::command]
pub fn github_list_repositories(page: u32, per_page: u32) -> GitHubApiResult<Vec<GitHubRepository>> { let path = format!("/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=updated&per_page={}&page={}", per_page.clamp(1, 100), page.max(1)); match request(&path).and_then(|response| response.json::<Vec<ApiRepo>>().map_err(|error| error.to_string())) { Ok(repos) => GitHubApiResult { ok: true, data: Some(repos.into_iter().map(|repo| GitHubRepository { id: repo.id.to_string(), owner: repo.owner.login, name: repo.name, full_name: repo.full_name, private: repo.private, default_branch: repo.default_branch, clone_url: repo.clone_url, updated_at: repo.updated_at }).collect()), category: None, message: String::new() }, Err(error) => GitHubApiResult { ok: false, data: None, category: Some("repository".to_owned()), message: error } } }

#[derive(serde::Deserialize)] struct ApiBranch { name: String, protected: bool, commit: ApiCommit }
#[derive(serde::Deserialize)] struct ApiCommit { sha: String }
#[tauri::command]
pub fn github_list_branches(owner: String, repository: String, page: u32, per_page: u32) -> GitHubApiResult<Vec<GitHubBranch>> { let path = format!("/repos/{owner}/{repository}/branches?per_page={}&page={}", per_page.clamp(1, 100), page.max(1)); match request(&path).and_then(|response| response.json::<Vec<ApiBranch>>().map_err(|error| error.to_string())) { Ok(branches) => GitHubApiResult { ok: true, data: Some(branches.into_iter().map(|branch| GitHubBranch { name: branch.name, commit: branch.commit.sha, protected: branch.protected }).collect()), category: None, message: String::new() }, Err(error) => GitHubApiResult { ok: false, data: None, category: Some("branch".to_owned()), message: error } } }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubBranchTip { pub commit: String }

#[tauri::command]
pub fn github_get_branch_tip(owner: String, repository: String, branch: String) -> GitHubApiResult<GitHubBranchTip> {
    let path = format!("/repos/{owner}/{repository}/branches/{branch}");
    match request(&path).and_then(|response| response.json::<ApiBranch>().map_err(|error| error.to_string())) {
        Ok(value) => GitHubApiResult { ok: true, data: Some(GitHubBranchTip { commit: value.commit.sha }), category: None, message: String::new() },
        Err(error) => GitHubApiResult { ok: false, data: None, category: Some("branch".to_owned()), message: error },
    }
}