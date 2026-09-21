//! Port of the pure half of `src/deepseek.ts`.
//!
//! The transport and the retry loop stay in TypeScript: `DeepSeekClient` takes
//! an injected fetcher and sleep so the tests can drive it without a network.
//! What moves here is everything that decides *what* is sent and *how* a
//! response is understood.

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use serde_json::{json, Map, Value};

use crate::config::vision_capable;
use crate::images::check_image_count;

const MODEL_FLASH: &str = "deepseek-flash";

/// Counts inline image parts and enforces DeepSeek's role rule.
pub(crate) fn validate_image_messages(messages: &Value) -> Result<usize, String> {
    let mut count = 0usize;
    let Some(items) = messages.as_array() else {
        return Ok(0);
    };
    for message in items {
        let Some(object) = message.as_object() else {
            continue;
        };
        let Some(parts) = object.get("content").and_then(Value::as_array) else {
            continue;
        };
        let message_images = parts
            .iter()
            .filter(|part| {
                matches!(
                    part.get("type").and_then(Value::as_str),
                    Some("image_url") | Some("file")
                )
            })
            .count();
        if message_images > 0 && object.get("role").and_then(Value::as_str) != Some("user") {
            return Err("DeepSeek image content is supported only in user messages.".to_string());
        }
        count += message_images;
    }
    check_image_count(count)?;
    Ok(count)
}

/// Builds the chat-completions request body.
#[napi]
pub fn build_chat_payload(
    messages_json: String,
    model: String,
    thinking_enabled: bool,
    reasoning_effort: String,
    max_tokens: u32,
    tools_json: Option<String>,
    stream: bool,
) -> napi::Result<String> {
    let messages: Value = serde_json::from_str(&messages_json)
        .map_err(|error| napi::Error::from_reason(format!("Invalid messages: {error}")))?;
    let image_count =
        validate_image_messages(&messages).map_err(napi::Error::from_reason)?;
    if image_count > 0 && !vision_capable(&model) {
        return Err(napi::Error::from_reason(format!(
            "Image input requires model {MODEL_FLASH}."
        )));
    }

    let mut payload = Map::new();
    payload.insert("model".to_string(), Value::String(model));
    payload.insert("messages".to_string(), messages);
    payload.insert(
        "thinking".to_string(),
        json!({ "type": if thinking_enabled { "enabled" } else { "disabled" } }),
    );
    payload.insert("stream".to_string(), Value::Bool(stream));
    payload.insert("max_tokens".to_string(), json!(max_tokens));
    if thinking_enabled {
        payload.insert("reasoning_effort".to_string(), Value::String(reasoning_effort));
    }
    if let Some(tools_json) = tools_json {
        let tools: Value = serde_json::from_str(&tools_json)
            .map_err(|error| napi::Error::from_reason(format!("Invalid tools: {error}")))?;
        if tools.as_array().is_some_and(|items| !items.is_empty()) {
            payload.insert("tools".to_string(), tools);
        }
    }
    if stream {
        payload.insert("stream_options".to_string(), json!({ "include_usage": true }));
    }
    serde_json::to_string(&Value::Object(payload))
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

/// Parses a non-streaming reply into the `ModelReply` shape.
#[napi]
pub fn parse_model_reply(body_json: String) -> napi::Result<String> {
    let body: Value = serde_json::from_str(&body_json)
        .map_err(|error| napi::Error::from_reason(format!("Invalid response body: {error}")))?;
    let message = body
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .filter(|message| message.is_object())
        .cloned()
        .ok_or_else(|| {
            napi::Error::from_reason(format!("Unexpected DeepSeek response: {body_json}"))
        })?;

    let mut reply = Map::new();
    reply.insert(
        "content".to_string(),
        Value::String(
            message
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        ),
    );
    if let Some(reasoning) = message.get("reasoning_content").and_then(Value::as_str) {
        reply.insert(
            "reasoningContent".to_string(),
            Value::String(reasoning.to_string()),
        );
    }
    reply.insert(
        "toolCalls".to_string(),
        message
            .get("tool_calls")
            .filter(|value| value.is_array())
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
    );
    reply.insert(
        "usage".to_string(),
        body.get("usage")
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new())),
    );
    reply.insert("assistantMessage".to_string(), message);
    serde_json::to_string(&Value::Object(reply))
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

/// One interpreted server-sent event.
#[napi(object)]
pub struct StreamChunk {
    pub done: bool,
    pub content: Option<String>,
    pub reasoning_content: Option<String>,
    pub usage_json: Option<String>,
}

/// Interprets one `data:` payload from the streaming response.
///
/// A malformed payload is an error rather than a skipped event: the TypeScript
/// original lets `JSON.parse` throw, which fails the request instead of
/// silently dropping part of the answer.
#[napi]
pub fn parse_stream_chunk(data: String) -> napi::Result<StreamChunk> {
    let empty = StreamChunk {
        done: false,
        content: None,
        reasoning_content: None,
        usage_json: None,
    };
    if data == "[DONE]" {
        return Ok(StreamChunk {
            done: true,
            ..empty
        });
    }
    let chunk: Value = serde_json::from_str(&data)
        .map_err(|error| napi::Error::from_reason(format!("Invalid streaming chunk: {error}")))?;
    if !chunk.is_object() {
        return Ok(empty);
    }
    let delta = chunk
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("delta"));
    Ok(StreamChunk {
        done: false,
        content: delta
            .and_then(|delta| delta.get("content"))
            .and_then(Value::as_str)
            .map(str::to_string),
        reasoning_content: delta
            .and_then(|delta| delta.get("reasoning_content"))
            .and_then(Value::as_str)
            .map(str::to_string),
        usage_json: chunk
            .get("usage")
            .filter(|usage| usage.is_object())
            .map(Value::to_string),
    })
}

/// Incremental server-sent-event framing.
///
/// `TextDecoder` is fed with `{ stream: true }`, so a multi-byte character split
/// across two chunks stays intact; `take_utf8` reproduces that by holding an
/// incomplete trailing sequence until the next chunk arrives.
#[napi]
pub struct SseReader {
    bytes: Vec<u8>,
    text: String,
}

fn take_utf8(bytes: &mut Vec<u8>, flush: bool) -> String {
    let mut decoded = String::new();
    loop {
        match std::str::from_utf8(bytes) {
            Ok(text) => {
                decoded.push_str(text);
                bytes.clear();
                break;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                if let Ok(text) = std::str::from_utf8(&bytes[..valid]) {
                    decoded.push_str(text);
                }
                match error.error_len() {
                    Some(length) => {
                        // Genuinely invalid input: the decoder emits U+FFFD and moves on.
                        decoded.push('\u{FFFD}');
                        bytes.drain(..valid + length);
                    }
                    None => {
                        // Incomplete trailing sequence: decode it once more arrives.
                        bytes.drain(..valid);
                        if flush && !bytes.is_empty() {
                            decoded.push('\u{FFFD}');
                            bytes.clear();
                        }
                        break;
                    }
                }
            }
        }
    }
    decoded
}

fn line_payload(line: &str) -> Option<String> {
    let raw = line.trim_end_matches('\r').trim();
    raw.strip_prefix("data:")
        .map(|rest| rest.trim().to_string())
        .filter(|data| !data.is_empty())
}

#[napi]
impl SseReader {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            bytes: Vec::new(),
            text: String::new(),
        }
    }

    /// Feeds one chunk and returns every complete `data:` payload it completed.
    #[napi]
    pub fn push(&mut self, chunk: Buffer) -> Vec<String> {
        self.bytes.extend_from_slice(chunk.as_ref());
        self.text.push_str(&take_utf8(&mut self.bytes, false));
        let mut payloads = Vec::new();
        while let Some(index) = self.text.find('\n') {
            let line: String = self.text.drain(..=index).collect();
            let line = line.trim_end_matches('\n');
            if let Some(data) = line_payload(line) {
                payloads.push(data);
            }
        }
        payloads
    }

    /// Flushes the trailing line, mirroring the final `pending.trim()` pass.
    #[napi]
    pub fn finish(&mut self) -> Option<String> {
        self.text.push_str(&take_utf8(&mut self.bytes, true));
        let final_line = self.text.trim();
        final_line
            .strip_prefix("data:")
            .map(|rest| rest.trim().to_string())
    }
}
