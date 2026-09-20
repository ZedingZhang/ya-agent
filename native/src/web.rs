//! Port of the parsing half of `src/web.ts`.
//!
//! `search()` itself stays in TypeScript: it owns the HTTP transport, which the
//! tests replace with an injected fetcher.

use std::sync::OnceLock;

use napi_derive::napi;
use regex::Regex;
use url::Url;

use crate::compat::{collapse_js_space, split_js_space, JS_SPACE_CLASS};

const SEARCH_BASE: &str = "https://html.duckduckgo.com";
const RESULT_CLASS: &str = "result__a";

#[napi(object)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
}

fn anchor_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?i)<a\b([^>]*)>([\s\S]*?)</a>").expect("anchor pattern"))
}

fn tag_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"<[^>]+>").expect("tag pattern"))
}

fn entity_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?i)&(#x?[0-9a-f]+|[a-z]+);").expect("entity pattern"))
}

/// Mirrors `new RegExp("(?:^|\\s)NAME\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "iu")`.
fn build_attribute_pattern(name: &str) -> Regex {
    Regex::new(&format!(
        r#"(?i)(?:^{space}|[{space}]){name}[{space}]*=[{space}]*(?:"([^"]*)"|'([^']*)'|([^{space}>]+))"#,
        space = JS_SPACE_CLASS,
        name = name,
    ))
    .expect("attribute pattern")
}

fn class_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| build_attribute_pattern("class"))
}

fn href_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| build_attribute_pattern("href"))
}

fn attribute(attributes: &str, name: &str) -> Option<String> {
    // `Regex` is cheap to clone: the compiled program is shared.
    let pattern = match name {
        "class" => class_pattern().clone(),
        "href" => href_pattern().clone(),
        other => build_attribute_pattern(other),
    };
    let captures = pattern.captures(attributes)?;
    (1..=3).find_map(|index| captures.get(index).map(|value| value.as_str().to_string()))
}

fn named_entity(name: &str) -> Option<&'static str> {
    match name {
        "amp" => Some("&"),
        "apos" => Some("'"),
        "gt" => Some(">"),
        "lt" => Some("<"),
        "nbsp" => Some(" "),
        "quot" => Some("\""),
        _ => None,
    }
}

/// `String.fromCodePoint` accepts lone surrogates and rejects anything above
/// U+10FFFF. Rust strings cannot hold a lone surrogate, so it becomes U+FFFD.
fn code_point(value: u32) -> napi::Result<String> {
    if let Some(character) = char::from_u32(value) {
        return Ok(character.to_string());
    }
    if (0xD800..=0xDFFF).contains(&value) {
        return Ok('\u{FFFD}'.to_string());
    }
    Err(napi::Error::from_reason(format!(
        "Invalid code point {value}"
    )))
}

fn decode_html(value: &str) -> napi::Result<String> {
    let mut decoded = String::with_capacity(value.len());
    let mut cursor = 0;
    for captures in entity_pattern().captures_iter(value) {
        let (Some(whole), Some(code)) = (captures.get(0), captures.get(1)) else {
            continue;
        };
        decoded.push_str(&value[cursor..whole.start()]);
        cursor = whole.end();
        let code = code.as_str();
        let replacement =
            if let Some(hex) = code.strip_prefix("#x").or_else(|| code.strip_prefix("#X")) {
                u32::from_str_radix(hex, 16)
                    .ok()
                    .map(code_point)
                    .transpose()?
            } else if let Some(decimal) = code.strip_prefix('#') {
                decimal.parse::<u32>().ok().map(code_point).transpose()?
            } else {
                named_entity(&code.to_lowercase()).map(str::to_string)
            };
        match replacement {
            Some(text) => decoded.push_str(&text),
            // Unknown named entity: the original text is kept verbatim.
            None => decoded.push_str(&value[whole.start()..whole.end()]),
        }
    }
    decoded.push_str(&value[cursor..]);
    Ok(decoded)
}

/// Resolves the DuckDuckGo redirect wrapper to the real target URL.
fn resolve_search_url(base: &Url, href: &str) -> Option<String> {
    let parsed = base.join(href).ok()?;
    let target_text = parsed
        .query_pairs()
        .find(|(key, _)| key == "uddg")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_else(|| parsed.to_string());
    let target = Url::parse(&target_text).ok()?;
    if target.scheme() != "https" && target.scheme() != "http" {
        return None;
    }
    Some(target.to_string())
}

#[napi]
pub fn parse_search_results(html: String) -> napi::Result<Vec<SearchResult>> {
    let base =
        Url::parse(SEARCH_BASE).map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let mut results = Vec::new();
    for captures in anchor_pattern().captures_iter(&html) {
        let attributes = captures.get(1).map(|value| value.as_str()).unwrap_or("");
        let classes = attribute(attributes, "class").unwrap_or_default();
        if !split_js_space(&classes).contains(&RESULT_CLASS) {
            continue;
        }
        let href = decode_html(&attribute(attributes, "href").unwrap_or_default())?;
        if href.is_empty() {
            continue;
        }
        let Some(url) = resolve_search_url(&base, &href) else {
            continue;
        };
        let inner = captures.get(2).map(|value| value.as_str()).unwrap_or("");
        let stripped = tag_pattern().replace_all(inner, "");
        let title = collapse_js_space(&decode_html(&stripped)?);
        results.push(SearchResult { title, url });
    }
    Ok(results)
}
