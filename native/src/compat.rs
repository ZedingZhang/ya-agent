//! JavaScript semantics that differ from Rust, kept in one place.
//!
//! Each helper here exists because a naive Rust equivalent is subtly wrong:
//! these are the differences the parity harness pinned down.

/// JavaScript's `\s`, which is wider than Rust's `char::is_whitespace`:
/// it adds `\uFEFF` and the line/paragraph separators.
pub fn is_js_space(character: char) -> bool {
    matches!(
        character,
        '\t' | '\n'
            | '\u{000B}'
            | '\u{000C}'
            | '\r'
            | ' '
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    ) || ('\u{2000}'..='\u{200A}').contains(&character)
}

/// The same set as a regular-expression character class, for patterns that
/// mirror a JavaScript `\s`.
pub const JS_SPACE_CLASS: &str = r"\t\n\x0B\x0C\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}";

/// `String.prototype.length` counts UTF-16 code units, not code points.
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Collapses runs of JavaScript whitespace and trims, mirroring
/// `text.replace(/\s+/gu, " ").trim()`.
pub fn collapse_js_space(text: &str) -> String {
    let mut collapsed = String::with_capacity(text.len());
    let mut pending_space = false;
    for character in text.chars() {
        if is_js_space(character) {
            pending_space = !collapsed.is_empty();
        } else {
            if pending_space {
                collapsed.push(' ');
                pending_space = false;
            }
            collapsed.push(character);
        }
    }
    collapsed
}

/// Splits on runs of JavaScript whitespace, mirroring `text.split(/\s+/u)`.
pub fn split_js_space(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start: Option<usize> = None;
    for (index, character) in text.char_indices() {
        if is_js_space(character) {
            if let Some(begin) = start.take() {
                parts.push(&text[begin..index]);
            }
        } else if start.is_none() {
            start = Some(index);
        }
    }
    if let Some(begin) = start {
        parts.push(&text[begin..]);
    }
    parts
}

/// `Buffer.from(value, "base64")`, which ignores padding and any trailing
/// characters that do not complete a group of four. The `base64` crate is
/// strict, so decoding is done here instead.
pub fn decode_base64_lenient(payload: &str) -> Vec<u8> {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut groups: Vec<u8> = Vec::with_capacity(payload.len());
    for byte in payload.bytes() {
        if byte == b'=' {
            continue;
        }
        if let Some(index) = ALPHABET.iter().position(|candidate| *candidate == byte) {
            groups.push(index as u8);
        }
    }
    let mut decoded = Vec::with_capacity(groups.len() / 4 * 3 + 2);
    for chunk in groups.chunks(4) {
        let first = chunk[0] as u32;
        match chunk.len() {
            4 => {
                let second = chunk[1] as u32;
                let third = chunk[2] as u32;
                decoded.push(((first << 2) | (second >> 4)) as u8);
                decoded.push((((second & 0x0f) << 4) | (third >> 2)) as u8);
                decoded.push((((third & 0x03) << 6) | chunk[3] as u32) as u8);
            }
            3 => {
                let second = chunk[1] as u32;
                let third = chunk[2] as u32;
                decoded.push(((first << 2) | (second >> 4)) as u8);
                decoded.push((((second & 0x0f) << 4) | (third >> 2)) as u8);
            }
            2 => {
                decoded.push(((first << 2) | (chunk[1] as u32 >> 4)) as u8);
            }
            _ => {}
        }
    }
    decoded
}
