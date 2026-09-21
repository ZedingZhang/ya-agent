//! Port of the decision half of `src/local.ts`.
//!
//! The workspace-confinement check itself stays in TypeScript. It is a security
//! boundary built on `path.resolve`, `path.relative` and `realpath`, whose
//! Windows semantics (drive-relative paths, UNC prefixes, both separators,
//! case-insensitive roots) are not reproduced by `std::path`; re-deriving them
//! in another language would put the boundary at risk for no gain. What moves
//! here is the policy that does not depend on those semantics.

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use serde_json::json;

pub const MAX_TEXT_BYTES: u64 = 1024 * 1024;
pub const MAX_LIST_ENTRIES: usize = 200;
pub const MAX_SEARCH_RESULTS: usize = 100;
pub const MAX_DIFF_LINES: usize = 200;
pub const MAX_AUDIT_ARCHIVES: usize = 3;
pub const AUDIT_LOG_MAX_BYTES: u64 = 1024 * 1024;

const CREDENTIAL_NAMES: &[&str] = &[
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "credentials",
    "credentials.json",
];

const SENSITIVE_EXTENSIONS: &[&str] = &[".pem", ".key", ".p12", ".pfx", ".kdbx", ".der", ".token"];

/// The size and count limits the local tools enforce.
#[napi(object)]
pub struct LocalLimits {
    pub max_text_bytes: i64,
    pub max_list_entries: i64,
    pub max_search_results: i64,
    pub max_diff_lines: i64,
    pub max_audit_archives: i64,
    pub audit_log_max_bytes: i64,
}

#[napi]
pub fn local_limits() -> LocalLimits {
    LocalLimits {
        max_text_bytes: MAX_TEXT_BYTES as i64,
        max_list_entries: MAX_LIST_ENTRIES as i64,
        max_search_results: MAX_SEARCH_RESULTS as i64,
        max_diff_lines: MAX_DIFF_LINES as i64,
        max_audit_archives: MAX_AUDIT_ARCHIVES as i64,
        audit_log_max_bytes: AUDIT_LOG_MAX_BYTES as i64,
    }
}

/// Policy for names that must never be read in local mode.
///
/// The caller passes the lower-cased basename and the already-split path parts,
/// because splitting a path is Node path semantics rather than policy.
#[napi]
pub fn is_sensitive_file(lowered_basename: String, path_parts: Vec<String>) -> bool {
    if path_parts.iter().any(|part| part == ".git") {
        return true;
    }
    if lowered_basename == ".env" || lowered_basename.starts_with(".env.") {
        return true;
    }
    if CREDENTIAL_NAMES.contains(&lowered_basename.as_str()) {
        return true;
    }
    let extension = match lowered_basename.rfind('.') {
        Some(index) => &lowered_basename[index..],
        None => "",
    };
    SENSITIVE_EXTENSIONS.contains(&extension) || lowered_basename.contains("secret")
}

/// Rejects a text file that is too large to read or replace.
#[napi]
pub fn assert_text_size(size: f64) -> napi::Result<()> {
    if size > MAX_TEXT_BYTES as f64 {
        return Err(napi::Error::from_reason(
            "Text files larger than 1 MiB cannot be read or replaced.",
        ));
    }
    Ok(())
}

/// Decodes file bytes as strict UTF-8, refusing NUL bytes as binary.
#[napi]
pub fn decode_text_file(bytes: Buffer) -> napi::Result<String> {
    if bytes.as_ref().contains(&0) {
        return Err(napi::Error::from_reason(
            "Binary files cannot be read in local mode.",
        ));
    }
    std::str::from_utf8(bytes.as_ref())
        .map(str::to_string)
        .map_err(|_| {
            napi::Error::from_reason("Only UTF-8 text files can be read in local mode.")
        })
}

/// Keeps the last `limit` bytes from the first complete line onwards, so an
/// archived audit log never starts mid-record.
#[napi]
pub fn tail_complete_lines(data: Buffer, limit: i64) -> Buffer {
    let bytes = data.as_ref();
    let limit = limit.max(0) as usize;
    if bytes.len() <= limit {
        return Buffer::from(bytes.to_vec());
    }
    let tail = &bytes[bytes.len() - limit..];
    match tail.iter().position(|byte| *byte == 0x0a) {
        Some(newline) => Buffer::from(tail[newline + 1..].to_vec()),
        None => Buffer::from(Vec::new()),
    }
}

/// The tool contracts advertised to the model in local mode.
#[napi]
pub fn local_tool_definitions() -> String {
    json!([
        {
            "type": "function",
            "function": {
                "name": "local_list",
                "description": "List up to 200 entries in a directory inside the authorized workspace.",
                "parameters": { "type": "object", "properties": { "path": { "type": "string" } } }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "local_read",
                "description": "Read a UTF-8 text file up to 1 MiB inside the authorized workspace. Sensitive files are blocked.",
                "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "local_search",
                "description": "Search file names and non-sensitive UTF-8 text files inside the authorized workspace.",
                "parameters": {
                    "type": "object",
                    "properties": { "query": { "type": "string" }, "path": { "type": "string" } },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "local_mkdir",
                "description": "Create one directory inside the workspace. Its parent must already exist. The client asks the user before writing.",
                "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "local_write",
                "description": "Create or replace a UTF-8 text file inside the workspace. Its parent must already exist. The client shows a diff and asks before writing.",
                "parameters": {
                    "type": "object",
                    "properties": { "path": { "type": "string" }, "content": { "type": "string" } },
                    "required": ["path", "content"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "local_move",
                "description": "Move or rename a file or directory inside the workspace without replacing a destination. The client asks before writing.",
                "parameters": {
                    "type": "object",
                    "properties": { "source": { "type": "string" }, "destination": { "type": "string" } },
                    "required": ["source", "destination"]
                }
            }
        }
    ])
    .to_string()
}
