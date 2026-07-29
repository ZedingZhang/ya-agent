"""A deliberately small Markdown parser shared by the native Tk text renderer."""

from __future__ import annotations

from dataclasses import dataclass
import re

from .terminal import (
    BLOCK_QUOTE, HEADING, HORIZONTAL_RULE, INLINE_CODE, ITALIC, BOLD, LINK,
    ORDERED_LIST, UNORDERED_LIST, _is_table_separator, _table_cells, strip_terminal_controls,
)


@dataclass(frozen=True)
class Span:
    text: str
    tags: tuple[str, ...] = ()
    url: str | None = None


def _inline(text: str) -> list[Span]:
    """Render familiar inline constructs, preserving unknown Markdown literally."""
    pattern = re.compile(r"(\[[^\]]+\]\([^\s)]+(?:\s+[^)]*)?\)|`[^`]+`|(?:\*\*|__).*?(?:\*\*|__)|(?<!\*)\*[^*\n]+\*(?!\*))")
    spans: list[Span] = []
    position = 0
    for match in pattern.finditer(text):
        if match.start() > position:
            spans.append(Span(text[position:match.start()]))
        token = match.group(0)
        link = LINK.fullmatch(token)
        if link:
            spans.append(Span(link.group(1), ("link",), link.group(2)))
        elif INLINE_CODE.fullmatch(token):
            spans.append(Span(token[1:-1], ("code",)))
        elif BOLD.fullmatch(token):
            spans.append(Span(token[2:-2], ("bold",)))
        elif ITALIC.fullmatch(token):
            spans.append(Span(token[1:-1], ("italic",)))
        else:
            spans.append(Span(token))
        position = match.end()
    if position < len(text):
        spans.append(Span(text[position:]))
    return spans or [Span("")]


def markdown_lines(text: str) -> list[list[Span]]:
    """Return Tk-friendly line spans for Ya's common Markdown subset."""
    lines = strip_terminal_controls(text).splitlines()
    rendered: list[list[Span]] = []
    in_code = False
    index = 0
    while index < len(lines):
        line = lines[index]
        if line.lstrip().startswith("```"):
            in_code = not in_code
            index += 1
            continue
        if in_code and HEADING.match(line):
            in_code = False
        if in_code:
            rendered.append([Span(line, ("code_block",))])
            index += 1
            continue
        if index + 1 < len(lines) and "|" in line and _is_table_separator(lines[index + 1]):
            headers = _table_cells(line)
            index += 2
            while index < len(lines) and "|" in lines[index] and lines[index].strip():
                cells = _table_cells(lines[index])
                row: list[Span] = []
                for header, cell in zip(headers, cells):
                    row.extend([Span(header + ": ", ("bold",)), *_inline(cell), Span("  ")])
                rendered.append(row)
                index += 1
            continue
        heading = HEADING.match(line)
        if heading:
            rendered.append([Span(heading.group(1), ("heading",))])
        elif HORIZONTAL_RULE.match(line):
            rendered.append([Span("─" * 42, ("rule",))])
        else:
            quote = BLOCK_QUOTE.match(line)
            unordered = UNORDERED_LIST.match(line)
            ordered = ORDERED_LIST.match(line)
            prefix = ""
            tags: tuple[str, ...] = ()
            body = line
            if quote:
                prefix, body, tags = "│ ", quote.group(2), ("quote",)
            elif unordered:
                prefix, body = "• ", unordered.group(2)
            elif ordered:
                prefix, body = "• ", ordered.group(2)
            spans = [Span(prefix, tags)] if prefix else []
            for span in _inline(body):
                spans.append(Span(span.text, tags + span.tags, span.url))
            rendered.append(spans or [Span("")])
        index += 1
    return rendered
