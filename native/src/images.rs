//! Port of the validation half of `src/images.ts`.
//!
//! Filesystem inspection stays in TypeScript; these functions are pure so the
//! parity harness can compare them directly.

use std::sync::OnceLock;

use base64::Engine;
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use regex::Regex;
use url::Url;

use crate::compat::{decode_base64_lenient, utf16_len};

pub const MAX_IMAGES_PER_REQUEST: u32 = 600;
pub const MAX_IMAGE_URL_LENGTH: usize = 8_192;
const MAX_INLINE_IMAGE_BYTES: usize = 32 * 1024 * 1024;

const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

fn data_url_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)^data:image/(?:jpeg|png|gif|webp);base64,([a-z0-9+/]+={0,2})$")
            .expect("data URL pattern is valid")
    })
}

fn file_api_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)^file-api-[a-z0-9_-]+$").expect("file-api pattern is valid")
    })
}

fn generic_scheme_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)^[a-z][a-z0-9+.-]*://").expect("scheme pattern is valid")
    })
}

fn http_scheme(source: &str) -> bool {
    let lowered = source.get(..8).unwrap_or(source).to_ascii_lowercase();
    lowered.starts_with("http://") || lowered.starts_with("https://")
}

fn sniff_mime_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 8 && bytes[..8] == PNG_SIGNATURE {
        return Some("image/png");
    }
    if bytes.len() >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff {
        return Some("image/jpeg");
    }
    if bytes.len() >= 6 && (&bytes[..6] == b"GIF87a" || &bytes[..6] == b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

#[napi]
pub fn detect_image_mime_type(bytes: Buffer) -> Option<String> {
    sniff_mime_type(bytes.as_ref()).map(str::to_string)
}

#[napi]
pub fn is_image_detail(value: String) -> bool {
    matches!(value.as_str(), "low" | "high" | "original" | "auto")
}

/// Enforces DeepSeek's per-request image limit.
pub(crate) fn check_image_count(count: usize) -> Result<(), String> {
    if count > MAX_IMAGES_PER_REQUEST as usize {
        return Err(format!(
            "DeepSeek accepts at most {MAX_IMAGES_PER_REQUEST} images per request."
        ));
    }
    Ok(())
}

#[napi]
pub fn assert_image_count(count: u32) -> napi::Result<()> {
    check_image_count(count as usize).map_err(napi::Error::from_reason)
}

/// The canonical data URL and decoded byte count for an inline image source.
/// `detail` is validated by the caller and attached when the part is built.
#[napi(object)]
pub struct ImageDataUrlPart {
    pub url: String,
    pub bytes: u32,
}

#[napi]
pub fn image_data_url_part(source: String) -> napi::Result<ImageDataUrlPart> {
    let Some(captures) = data_url_pattern().captures(&source) else {
        return Err(napi::Error::from_reason(
            "Image data URLs must contain base64-encoded JPEG, PNG, GIF, or WebP data.",
        ));
    };
    let payload = captures.get(1).map(|value| value.as_str()).unwrap_or("");
    let estimated_bytes = payload.len() * 3 / 4;
    if estimated_bytes > MAX_INLINE_IMAGE_BYTES {
        return Err(napi::Error::from_reason(
            "Image data URL exceeds DeepSeek's 32 MiB inline limit.",
        ));
    }
    let decoded = decode_base64_lenient(payload);
    let Some(mime_type) = sniff_mime_type(&decoded) else {
        return Err(napi::Error::from_reason(
            "Image data URL does not contain supported JPEG, PNG, GIF, or WebP content.",
        ));
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(&decoded);
    Ok(ImageDataUrlPart {
        url: format!("data:{mime_type};base64,{encoded}"),
        bytes: decoded.len() as u32,
    })
}

/// Validates a DeepSeek Files API image id and returns it unchanged.
#[napi]
pub fn file_api_image_id(source: String) -> napi::Result<String> {
    if !file_api_pattern().is_match(&source) {
        return Err(napi::Error::from_reason(format!(
            "Invalid DeepSeek Files API image ID: {source}"
        )));
    }
    Ok(source)
}

/// Mirrors `/^https?:\/\//iu`: the transport gate the source branch uses.
#[napi]
pub fn is_http_url(source: String) -> bool {
    http_scheme(&source)
}

/// Mirrors `/^[a-z][a-z0-9+.-]*:\/\//iu`: a scheme that is not HTTP(S).
#[napi]
pub fn is_scheme_url(source: String) -> bool {
    generic_scheme_pattern().is_match(&source)
}

/// Validates an HTTP(S) image source and returns the normalised URL.
///
/// Sources that are not HTTP(S) belong to the caller's other branches; the
/// local-file branch in particular stays in TypeScript.
#[napi]
pub fn external_image_url(source: String) -> napi::Result<String> {
    if !http_scheme(&source) {
        return Err(napi::Error::from_reason(
            "External images require an HTTP(S) URL.",
        ));
    }
    if utf16_len(&source) > MAX_IMAGE_URL_LENGTH {
        return Err(napi::Error::from_reason(
            "External image URLs may contain at most 8192 characters.",
        ));
    }
    let parsed = Url::parse(&source)
        .map_err(|_| napi::Error::from_reason("External images require an HTTP(S) URL."))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(napi::Error::from_reason(
            "External images require an HTTP(S) URL.",
        ));
    }
    let normalized = parsed.to_string();
    if utf16_len(&normalized) > MAX_IMAGE_URL_LENGTH {
        return Err(napi::Error::from_reason(
            "External image URLs may contain at most 8192 characters.",
        ));
    }
    Ok(normalized)
}
