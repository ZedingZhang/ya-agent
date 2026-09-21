//! Port of `src/keychain.ts`: macOS Keychain storage for the DeepSeek API key.
//!
//! `platform` and `security_path` are injectable so the rules can be exercised
//! on any host without mocking `process.platform` or `node:child_process`.

use std::path::Path;
use std::process::Command;

use napi_derive::napi;

pub const KEYCHAIN_SERVICE: &str = "Ya DeepSeek API";
pub const KEYCHAIN_ACCOUNT: &str = "default";
pub const DEFAULT_SECURITY_PATH: &str = "/usr/bin/security";

const EMPTY_KEY_ERROR: &str = "API key cannot be empty.";
const NOT_MACOS_ERROR: &str =
    "ya auth deepseek is available only on macOS. Set DEEPSEEK_API_KEY instead.";
const SAVE_FAILED_ERROR: &str = "Could not save the API key to macOS Keychain.";

/// Node's `process.platform` spelling, which differs from `std::env::consts::OS`.
fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

fn security_available(platform: &str, security_path: &str) -> bool {
    platform == "darwin" && Path::new(security_path).exists()
}

/// Trims the key; blank input counts as absent, matching the TypeScript rules.
fn normalize(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[napi]
pub fn current_platform() -> String {
    node_platform().to_string()
}

#[napi]
pub fn keychain_service() -> String {
    KEYCHAIN_SERVICE.to_string()
}

#[napi]
pub fn keychain_account() -> String {
    KEYCHAIN_ACCOUNT.to_string()
}

#[napi]
pub fn macos_keychain_available(platform: String, security_path: Option<String>) -> bool {
    security_available(
        &platform,
        security_path.as_deref().unwrap_or(DEFAULT_SECURITY_PATH),
    )
}

#[napi]
pub fn normalize_api_key(value: String) -> Option<String> {
    normalize(&value)
}

#[napi]
pub fn load_api_key() -> Option<String> {
    if let Ok(value) = std::env::var("DEEPSEEK_API_KEY") {
        if let Some(trimmed) = normalize(&value) {
            return Some(trimmed);
        }
    }
    if !security_available(node_platform(), DEFAULT_SECURITY_PATH) {
        return None;
    }
    let output = Command::new(DEFAULT_SECURITY_PATH)
        .args([
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
            "-w",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    normalize(&String::from_utf8_lossy(&output.stdout))
}

#[napi]
pub fn save_api_key(
    api_key: String,
    platform: Option<String>,
    security_path: Option<String>,
) -> napi::Result<()> {
    let Some(value) = normalize(&api_key) else {
        return Err(napi::Error::from_reason(EMPTY_KEY_ERROR));
    };
    let security_path = security_path.unwrap_or_else(|| DEFAULT_SECURITY_PATH.to_string());
    if !security_available(
        &platform.unwrap_or_else(|| node_platform().to_string()),
        &security_path,
    ) {
        return Err(napi::Error::from_reason(NOT_MACOS_ERROR));
    }
    match Command::new(&security_path)
        .args([
            "add-generic-password",
            "-U",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
            "-w",
            value.as_str(),
        ])
        .output()
    {
        Ok(output) if output.status.success() => Ok(()),
        // Child-process errors can include the full argv. Never surface the key.
        _ => Err(napi::Error::from_reason(SAVE_FAILED_ERROR)),
    }
}
