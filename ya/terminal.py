from __future__ import annotations

import os
import re


ANSI_ESCAPE = re.compile(r"\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\a]*(?:\a|\x1B\\))")
CONTROL_CHARACTERS = re.compile(r"[\x00-\x08\x0B-\x1F\x7F]")
HEADING = re.compile(r"^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$")
HORIZONTAL_RULE = re.compile(r"^\s{0,3}([-*_])(?:\s*\1){2,}\s*$")
UNORDERED_LIST = re.compile(r"^(\s*)[-+*]\s+(.+)$")
ORDERED_LIST = re.compile(r"^(\s*)\d+[.)]\s+(.+)$")
BLOCK_QUOTE = re.compile(r"^(\s*)>\s?(.*)$")
IMAGE = re.compile(r"!\[([^\]]*)\]\(([^\s)]+)(?:\s+[^)]*)?\)")
LINK = re.compile(r"\[([^\]]+)\]\(([^\s)]+)(?:\s+[^)]*)?\)")
INLINE_CODE = re.compile(r"`([^`]+)`")
BOLD = re.compile(r"(?:\*\*|__)(.+?)(?:\*\*|__)")
ITALIC = re.compile(r"(?<!\*)\*([^*\n]+)\*(?!\*)|(?<!_)_([^_\n]+)_(?!_)")


def strip_terminal_controls(text: str) -> str:
    """Remove terminal control sequences while preserving normal line breaks."""
    return CONTROL_CHARACTERS.sub("", ANSI_ESCAPE.sub("", text))


def _style(text: str, code: str, color: bool) -> str:
    return f"\033[{code}m{text}\033[0m" if color else text


def _render_inline(text: str, color: bool) -> str:
    text = IMAGE.sub(lambda match: f"{match.group(1)} <{match.group(2)}>", text)
    text = LINK.sub(lambda match: f"{match.group(1)} <{match.group(2)}>", text)
    text = INLINE_CODE.sub(lambda match: _style(match.group(1), "7", color), text)
    text = BOLD.sub(lambda match: _style(match.group(1), "1", color), text)
    return ITALIC.sub(lambda match: _style(match.group(1) or match.group(2), "3", color), text)


def _table_cells(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def _is_table_separator(line: str) -> bool:
    cells = _table_cells(line)
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells)


def _render_table(lines: list[str], start: int, color: bool) -> tuple[list[str], int]:
    headers = _table_cells(lines[start])
    index = start + 2
    rendered = [_style(" | ".join(_render_inline(header, color) for header in headers), "1", color)]
    while index < len(lines) and "|" in lines[index] and lines[index].strip():
        cells = _table_cells(lines[index])
        pairs = [
            f"{_render_inline(header, color)}: {_render_inline(cell, color)}"
            for header, cell in zip(headers, cells)
        ]
        rendered.append(f"- {'; '.join(pairs)}")
        index += 1
    return rendered, index


def render_markdown(text: str, color: bool = False) -> str:
    """Render Ya's common Markdown subset for readable terminal output."""
    lines = strip_terminal_controls(text).splitlines()
    rendered: list[str] = []
    in_code_block = False
    index = 0
    while index < len(lines):
        line = lines[index]
        if line.lstrip().startswith("```"):
            in_code_block = not in_code_block
            index += 1
            continue
        if in_code_block:
            rendered.append(f"  {line}")
            index += 1
            continue
        if index + 1 < len(lines) and "|" in line and _is_table_separator(lines[index + 1]):
            table, index = _render_table(lines, index, color)
            rendered.extend(table)
            continue
        heading = HEADING.match(line)
        if heading:
            rendered.append(_style(_render_inline(heading.group(1), color), "1;36", color))
        elif HORIZONTAL_RULE.match(line):
            rendered.append("-" * 40)
        else:
            quote = BLOCK_QUOTE.match(line)
            unordered = UNORDERED_LIST.match(line)
            ordered = ORDERED_LIST.match(line)
            if quote:
                rendered.append(f"{quote.group(1)}| {_render_inline(quote.group(2), color)}")
            elif unordered:
                rendered.append(f"{unordered.group(1)}- {_render_inline(unordered.group(2), color)}")
            elif ordered:
                rendered.append(f"{ordered.group(1)}- {_render_inline(ordered.group(2), color)}")
            else:
                rendered.append(_render_inline(line, color))
        index += 1
    return "\n".join(rendered)


def format_output(text: str, output_format: str, is_tty: bool) -> str:
    """Select terminal rendering without changing machine-readable output by default."""
    sanitized = strip_terminal_controls(text)
    if output_format == "markdown" or (output_format == "auto" and not is_tty):
        return sanitized
    return render_markdown(sanitized, color=is_tty and "NO_COLOR" not in os.environ)
