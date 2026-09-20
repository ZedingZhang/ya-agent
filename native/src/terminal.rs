//! Port of `src/terminal.ts`: Markdown rendered for a terminal, and the
//! streaming variant the CLI writes as tokens arrive.
//!
//! Two patterns need `fancy-regex`: the italic rule uses lookarounds and the
//! horizontal rule uses a backreference, neither of which the `regex` crate
//! supports. JavaScript's `\d` is always `[0-9]` and its `\s` is wider than
//! Rust's, so those are written out explicitly.

use std::sync::OnceLock;

use fancy_regex::Regex as FancyRegex;
use napi_derive::napi;
use regex::Regex;

use crate::compat::JS_SPACE_CLASS;

fn ansi_escape() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))")
            .expect("ansi pattern")
    })
}

fn control_characters() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"[\x00-\x08\x0B-\x1F\x7F]").expect("control pattern"))
}

fn heading() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(&format!(
            r"^[{space}]{{0,3}}#{{1,6}}[{space}]+(.+?)[{space}]*#*[{space}]*$",
            space = JS_SPACE_CLASS
        ))
        .expect("heading pattern")
    })
}

/// Uses a backreference, so it needs the fancy engine.
fn horizontal_rule() -> &'static FancyRegex {
    static PATTERN: OnceLock<FancyRegex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        FancyRegex::new(&format!(
            r"^[{space}]{{0,3}}([-*_])(?:[{space}]*\1){{2,}}[{space}]*$",
            space = JS_SPACE_CLASS
        ))
        .expect("horizontal rule pattern")
    })
}

fn unordered_list() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(&format!(
            r"^([{space}]*)[-+*][{space}]+(.+)$",
            space = JS_SPACE_CLASS
        ))
        .expect("unordered list pattern")
    })
}

fn ordered_list() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(&format!(
            r"^([{space}]*)[0-9]+[.)][{space}]+(.+)$",
            space = JS_SPACE_CLASS
        ))
        .expect("ordered list pattern")
    })
}

fn block_quote() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(&format!(r"^([{space}]*)>[{space}]?(.*)$", space = JS_SPACE_CLASS))
            .expect("block quote pattern")
    })
}

fn image() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(&format!(
            r"!\[([^\]]*)\]\(([^{space})]+)(?:[{space}]+[^)]*)?\)",
            space = JS_SPACE_CLASS
        ))
        .expect("image pattern")
    })
}

fn link() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(&format!(
            r"\[([^\]]+)\]\(([^{space})]+)(?:[{space}]+[^)]*)?\)",
            space = JS_SPACE_CLASS
        ))
        .expect("link pattern")
    })
}

fn inline_code() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"`([^`]+)`").expect("inline code pattern"))
}

fn bold() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?:\*\*|__)(.+?)(?:\*\*|__)").expect("bold pattern"))
}

/// Lookarounds, so it needs the fancy engine.
fn italic() -> &'static FancyRegex {
    static PATTERN: OnceLock<FancyRegex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        FancyRegex::new(r"(?<!\*)\*([^*\n]+)\*(?!\*)|(?<!_)_([^_\n]+)_(?!_)")
            .expect("italic pattern")
    })
}

fn table_separator_cell() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^:?-{3,}:?$").expect("separator cell pattern"))
}

/// `String.prototype.trim`, which uses JavaScript's whitespace set.
fn js_trim(text: &str) -> &str {
    text.trim_matches(crate::compat::is_js_space)
}

fn style(text: &str, code: &str, color: bool) -> String {
    if color {
        format!("\u{1b}[{code}m{text}\u{1b}[0m")
    } else {
        text.to_string()
    }
}

#[napi]
pub fn strip_terminal_controls(text: String) -> String {
    let without_ansi = ansi_escape().replace_all(&text, "");
    control_characters().replace_all(&without_ansi, "").into_owned()
}

/// Mirrors `text.replace(ITALIC, (_match, star, underscore) => ...)`; written
/// by hand because the fancy engine's closure generics do not infer here.
fn render_italic(text: &str, color: bool) -> String {
    let pattern = italic();
    let mut rendered = String::with_capacity(text.len());
    let mut cursor = 0;
    for captures in pattern.captures_iter(text).flatten() {
        let Some(whole) = captures.get(0) else {
            continue;
        };
        rendered.push_str(&text[cursor..whole.start()]);
        cursor = whole.end();
        let matched = captures
            .get(1)
            .or_else(|| captures.get(2))
            .map(|value| value.as_str())
            .unwrap_or("");
        rendered.push_str(&style(matched, "3", color));
    }
    rendered.push_str(&text[cursor..]);
    rendered
}

fn render_inline(text: &str, color: bool) -> String {
    let replaced = image().replace_all(text, |captures: &regex::Captures| {
        format!("{} <{}>", &captures[1], &captures[2])
    });
    let replaced = link().replace_all(&replaced, |captures: &regex::Captures| {
        format!("{} <{}>", &captures[1], &captures[2])
    });
    let replaced = inline_code().replace_all(&replaced, |captures: &regex::Captures| {
        style(&captures[1], "7", color)
    });
    let replaced = bold().replace_all(&replaced, |captures: &regex::Captures| {
        style(&captures[1], "1", color)
    });
    render_italic(&replaced, color)
}

#[napi]
pub fn table_cells(line: String) -> Vec<String> {
    let trimmed = js_trim(&line);
    let without_leading = trimmed.strip_prefix('|').unwrap_or(trimmed);
    let without_trailing = without_leading.strip_suffix('|').unwrap_or(without_leading);
    without_trailing
        .split('|')
        .map(|cell| js_trim(cell).to_string())
        .collect()
}

#[napi]
pub fn is_table_separator(line: String) -> bool {
    let cells = table_cells(line);
    !cells.is_empty() && cells.iter().all(|cell| table_separator_cell().is_match(cell))
}

fn render_table(lines: &[String], start: usize, color: bool) -> (Vec<String>, usize) {
    let headers = table_cells(lines.get(start).cloned().unwrap_or_default());
    let mut index = start + 2;
    let joined = headers
        .iter()
        .map(|header| render_inline(header, color))
        .collect::<Vec<_>>()
        .join(" | ");
    let mut rendered = vec![style(&joined, "1", color)];
    while index < lines.len() {
        let line = lines.get(index).cloned().unwrap_or_default();
        if !line.contains('|') || js_trim(&line).is_empty() {
            break;
        }
        let cells = table_cells(line);
        let pairs = headers
            .iter()
            .take(cells.len())
            .enumerate()
            .map(|(cell_index, header)| {
                format!(
                    "{}: {}",
                    render_inline(header, color),
                    render_inline(cells.get(cell_index).cloned().unwrap_or_default().as_str(), color)
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        rendered.push(format!("- {pairs}"));
        index += 1;
    }
    (rendered, index)
}

fn split_lines(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    // `text.split(/\r?\n/u)`: only a carriage return directly before a newline
    // is part of the separator, so a lone trailing CR stays in its line.
    let mut lines: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(index) = rest.find('\n') {
        let line = rest[..index].strip_suffix('\r').unwrap_or(&rest[..index]);
        lines.push(line.to_string());
        rest = &rest[index + 1..];
    }
    lines.push(rest.to_string());
    if lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    lines
}

#[napi]
pub fn render_markdown(text: String, color: bool) -> String {
    let lines = split_lines(&strip_terminal_controls(text));
    let mut rendered: Vec<String> = Vec::new();
    let mut in_code_block = false;
    let mut index = 0usize;
    while index < lines.len() {
        let line = lines.get(index).cloned().unwrap_or_default();
        if line.trim_start_matches(crate::compat::is_js_space).starts_with("```") {
            in_code_block = !in_code_block;
            index += 1;
            continue;
        }
        if in_code_block && heading().is_match(&line) {
            in_code_block = false;
        }
        if in_code_block {
            rendered.push(format!("  {line}"));
            index += 1;
            continue;
        }
        if index + 1 < lines.len()
            && line.contains('|')
            && is_table_separator(lines.get(index + 1).cloned().unwrap_or_default())
        {
            let (table, next) = render_table(&lines, index, color);
            rendered.extend(table);
            index = next;
            continue;
        }
        if let Some(captures) = heading().captures(&line) {
            let title = captures.get(1).map(|value| value.as_str()).unwrap_or("");
            rendered.push(style(&render_inline(title, color), "1;36", color));
        } else if horizontal_rule().is_match(&line).unwrap_or(false) {
            rendered.push("-".repeat(40));
        } else if let Some(captures) = block_quote().captures(&line) {
            rendered.push(format!(
                "{}| {}",
                captures.get(1).map(|value| value.as_str()).unwrap_or(""),
                render_inline(captures.get(2).map(|value| value.as_str()).unwrap_or(""), color)
            ));
        } else if let Some(captures) = unordered_list().captures(&line) {
            rendered.push(format!(
                "{}- {}",
                captures.get(1).map(|value| value.as_str()).unwrap_or(""),
                render_inline(captures.get(2).map(|value| value.as_str()).unwrap_or(""), color)
            ));
        } else if let Some(captures) = ordered_list().captures(&line) {
            rendered.push(format!(
                "{}- {}",
                captures.get(1).map(|value| value.as_str()).unwrap_or(""),
                render_inline(captures.get(2).map(|value| value.as_str()).unwrap_or(""), color)
            ));
        } else {
            rendered.push(render_inline(&line, color));
        }
        index += 1;
    }
    rendered.join("\n")
}

const TABLE_SENTINEL: &str = "\u{0}TABLE:";

/// Streaming Markdown for a token-by-token answer. A line is held back until
/// the next one arrives, because a table separator only becomes recognisable
/// once the following line is known.
#[napi]
pub struct StreamingMarkdownRenderer {
    pending: String,
    previous: Option<String>,
    code: bool,
    color: bool,
}

#[napi]
impl StreamingMarkdownRenderer {
    #[napi(constructor)]
    pub fn new(color: Option<bool>) -> Self {
        Self {
            pending: String::new(),
            previous: None,
            code: false,
            color: color.unwrap_or(false),
        }
    }

    #[napi]
    pub fn write(&mut self, chunk: String) -> String {
        self.pending.push_str(&strip_terminal_controls(chunk));
        let mut output: Vec<String> = Vec::new();
        while let Some(newline) = self.pending.find('\n') {
            let line: String = self.pending.drain(..=newline).collect();
            let line = line.trim_end_matches('\n').to_string();
            output.extend(self.line(&line));
        }
        if output.is_empty() {
            String::new()
        } else {
            format!("{}\n", output.join("\n"))
        }
    }

    #[napi]
    pub fn finish(&mut self) -> String {
        let mut output: Vec<String> = Vec::new();
        if !self.pending.is_empty() {
            let pending = std::mem::take(&mut self.pending);
            output.extend(self.line(&pending));
        }
        if let Some(previous) = self.previous.take() {
            output.extend(self.render_plain(&previous));
        }
        output.join("\n")
    }

    fn line(&mut self, line: &str) -> Vec<String> {
        if line.trim_start_matches(crate::compat::is_js_space).starts_with("```") {
            let previous = match self.previous.take() {
                Some(previous) => self.render_plain(&previous),
                None => Vec::new(),
            };
            self.code = !self.code;
            return previous;
        }
        if self.code && heading().is_match(line) {
            self.code = false;
        }
        if self.code {
            return vec![format!("  {line}")];
        }
        if let Some(previous) = &self.previous {
            if is_table_separator(line.to_string()) && previous.contains('|') {
                self.previous = Some(format!(
                    "{TABLE_SENTINEL}{}",
                    table_cells(previous.clone()).join("\u{1f}")
                ));
                return Vec::new();
            }
        }
        let mut previous: Vec<String> = Vec::new();
        if let Some(held) = &self.previous {
            if let Some(headers) = held.strip_prefix(TABLE_SENTINEL) {
                if line.contains('|') && !js_trim(line).is_empty() {
                    let headers: Vec<String> = headers.split('\u{1f}').map(str::to_string).collect();
                    let cells = table_cells(line.to_string());
                    let pairs = headers
                        .iter()
                        .take(cells.len())
                        .enumerate()
                        .map(|(cell_index, header)| {
                            format!(
                                "{}: {}",
                                render_inline(header, self.color),
                                render_inline(cells.get(cell_index).map(String::as_str).unwrap_or(""), self.color)
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("; ");
                    return vec![format!("- {pairs}")];
                }
            } else {
                previous = self.render_plain(held);
            }
        }
        self.previous = Some(line.to_string());
        previous
    }

    fn render_plain(&self, line: &str) -> Vec<String> {
        if line.starts_with(TABLE_SENTINEL) {
            return Vec::new();
        }
        let rendered = render_markdown(line.to_string(), self.color);
        if rendered.is_empty() {
            vec![String::new()]
        } else {
            rendered.split('\n').map(str::to_string).collect()
        }
    }
}
