//! Port of the ranking half of `src/memory.ts`.
//!
//! Loading and saving cards stays in TypeScript for now; these functions are
//! pure so the parity harness can compare them directly.

use std::collections::BTreeSet;

use napi_derive::napi;
use unicode_normalization::UnicodeNormalization;

use crate::compat::{collapse_js_space, utf16_len};

const ENGLISH_STOP_WORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "is", "it", "of",
    "on", "or", "the", "this", "that", "to", "what", "when", "where", "with",
];

const CHINESE_STOP_PHRASES: &[&str] = &[
    "什么",
    "如何",
    "为什",
    "什么是",
    "怎么",
    "可以",
    "请问",
    "一个",
    "这个",
    "那个",
    "我们",
    "你们",
    "他们",
    "关于",
    "以及",
    "进行",
    "一下",
    "是否",
    "需要",
];

fn is_word_start(character: char) -> bool {
    character.is_ascii_lowercase() || character.is_ascii_digit()
}

fn is_word_body(character: char) -> bool {
    is_word_start(character) || character == '_' || character == '-'
}

/// Mirrors `text.match(/[a-z0-9][a-z0-9_-]*/g)`.
fn english_tokens(text: &str) -> Vec<String> {
    let characters: Vec<char> = text.chars().collect();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < characters.len() {
        if is_word_start(characters[index]) {
            let start = index;
            while index < characters.len() && is_word_body(characters[index]) {
                index += 1;
            }
            tokens.push(characters[start..index].iter().collect());
        } else {
            index += 1;
        }
    }
    tokens
}

fn english_words(text: &str) -> Vec<String> {
    let words: BTreeSet<String> = english_tokens(text)
        .into_iter()
        .filter(|word| word.chars().count() >= 2 && !ENGLISH_STOP_WORDS.contains(&word.as_str()))
        .collect();
    words.into_iter().collect()
}

fn english_phrases(text: &str) -> Vec<String> {
    let words: Vec<String> = english_tokens(text)
        .into_iter()
        .filter(|word| !ENGLISH_STOP_WORDS.contains(&word.as_str()))
        .collect();
    let phrases: BTreeSet<String> = words
        .windows(2)
        .map(|pair| format!("{} {}", pair[0], pair[1]))
        .collect();
    phrases.into_iter().collect()
}

/// Mirrors `text.match(/[\u4e00-\u9fff]+/g)` then sliding windows of `width`.
fn han_ngrams(text: &str, width: usize) -> Vec<String> {
    let mut grams: BTreeSet<String> = BTreeSet::new();
    let mut run: Vec<char> = Vec::new();
    let flush = |run: &[char], grams: &mut BTreeSet<String>| {
        if width == 0 || run.len() < width {
            return;
        }
        for window in run.windows(width) {
            let gram: String = window.iter().collect();
            if !CHINESE_STOP_PHRASES.contains(&gram.as_str()) {
                grams.insert(gram);
            }
        }
    };
    for character in text.chars() {
        if ('\u{4E00}'..='\u{9FFF}').contains(&character) {
            run.push(character);
        } else if !run.is_empty() {
            flush(&run, &mut grams);
            run.clear();
        }
    }
    if !run.is_empty() {
        flush(&run, &mut grams);
    }
    grams.into_iter().collect()
}

fn shared(left: &[String], right: &[String]) -> usize {
    let right: BTreeSet<&String> = right.iter().collect();
    left.iter().filter(|value| right.contains(value)).count()
}

#[napi]
pub fn normalize_memory_text(text: String) -> String {
    let normalized: String = text.nfkc().collect();
    let folded = normalized.to_lowercase().replace('ß', "ss");
    collapse_js_space(&folded)
}

#[napi]
pub fn english_word_tokens(text: String) -> Vec<String> {
    english_words(&text)
}

#[napi]
pub fn english_phrase_tokens(text: String) -> Vec<String> {
    english_phrases(&text)
}

#[napi]
pub fn han_ngram_tokens(text: String, width: u32) -> Vec<String> {
    han_ngrams(&text, width as usize)
}

/// Scores a task against a card's text; the card object carries nothing else.
#[napi]
pub fn memory_score(task: String, card_text: String) -> i32 {
    let task_text = normalize_memory_text(task);
    let card_text = normalize_memory_text(card_text);
    if task_text.is_empty() || card_text.is_empty() {
        return 0;
    }
    let shared_words = shared(&english_words(&task_text), &english_words(&card_text));
    let shared_bigrams = shared(&han_ngrams(&task_text, 2), &han_ngrams(&card_text, 2));
    let shared_phrases = shared(&english_phrases(&task_text), &english_phrases(&card_text)) > 0
        || shared(&han_ngrams(&task_text, 3), &han_ngrams(&card_text, 3)) > 0;
    let task_length = utf16_len(&task_text);
    let card_length = utf16_len(&card_text);
    let exact_containment = task_length.min(card_length) >= 4
        && (task_text.contains(&card_text) || card_text.contains(&task_text));
    let phrase_score = if shared_phrases || exact_containment {
        5
    } else {
        0
    };
    phrase_score + 3 * shared_words as i32 + shared_bigrams as i32
}
