import {
  BLOCK_QUOTE,
  HEADING,
  HORIZONTAL_RULE,
  ORDERED_LIST,
  UNORDERED_LIST,
  isTableSeparator,
  stripTerminalControls,
  tableCells,
} from "../terminal";

export type SpanTag = "heading" | "bold" | "italic" | "code" | "code_block" | "quote" | "rule" | "link";

export interface Span {
  text: string;
  tags: SpanTag[];
  url?: string;
}

const INLINE_PATTERN = /(\[[^\]]+\]\([^\s)]+(?:\s+[^)]*)?\)|`[^`]+`|(?:\*\*|__).*?(?:\*\*|__)|(?<!\*)\*[^*\n]+\*(?!\*))/gu;
const EXACT_LINK = /^\[([^\]]+)\]\(([^\s)]+)(?:\s+[^)]*)?\)$/u;
const EXACT_CODE = /^`([^`]+)`$/u;
const EXACT_BOLD = /^(?:\*\*|__)(.*?)(?:\*\*|__)$/u;
const EXACT_ITALIC = /^\*([^*\n]+)\*$/u;

function inline(text: string): Span[] {
  const spans: Span[] = [];
  let position = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const start = match.index;
    if (start > position) spans.push({ text: text.slice(position, start), tags: [] });
    const token = match[0];
    const link = token.match(EXACT_LINK);
    const code = token.match(EXACT_CODE);
    const bold = token.match(EXACT_BOLD);
    const italic = token.match(EXACT_ITALIC);
    if (link) spans.push({ text: link[1] ?? "", tags: ["link"], url: link[2] });
    else if (code) spans.push({ text: code[1] ?? "", tags: ["code"] });
    else if (bold) spans.push({ text: bold[1] ?? "", tags: ["bold"] });
    else if (italic) spans.push({ text: italic[1] ?? "", tags: ["italic"] });
    else spans.push({ text: token, tags: [] });
    position = start + token.length;
  }
  if (position < text.length) spans.push({ text: text.slice(position), tags: [] });
  return spans.length > 0 ? spans : [{ text: "", tags: [] }];
}

export function markdownLines(text: string): Span[][] {
  const raw = stripTerminalControls(text);
  const lines = raw ? raw.split(/\r?\n/u) : [];
  if (lines.at(-1) === "") lines.pop();
  const rendered: Span[][] = [];
  let inCode = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trimStart().startsWith("```")) {
      inCode = !inCode;
      index += 1;
      continue;
    }
    if (inCode && HEADING.test(line)) inCode = false;
    if (inCode) {
      rendered.push([{ text: line, tags: ["code_block"] }]);
      index += 1;
      continue;
    }
    if (index + 1 < lines.length && line.includes("|") && isTableSeparator(lines[index + 1] ?? "")) {
      const headers = tableCells(line);
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim()) {
        const cells = tableCells(lines[index] ?? "");
        const row: Span[] = [];
        headers.slice(0, cells.length).forEach((header, cellIndex) => {
          row.push({ text: `${header}: `, tags: ["bold"] }, ...inline(cells[cellIndex] ?? ""), { text: "  ", tags: [] });
        });
        rendered.push(row);
        index += 1;
      }
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) rendered.push([{ text: heading[1] ?? "", tags: ["heading"] }]);
    else if (HORIZONTAL_RULE.test(line)) rendered.push([{ text: "─".repeat(42), tags: ["rule"] }]);
    else {
      const quote = line.match(BLOCK_QUOTE);
      const unordered = line.match(UNORDERED_LIST);
      const ordered = line.match(ORDERED_LIST);
      const inherited: SpanTag[] = quote ? ["quote"] : [];
      const prefix = quote ? "│ " : unordered || ordered ? "• " : "";
      const body = quote?.[2] ?? unordered?.[2] ?? ordered?.[2] ?? line;
      const spans: Span[] = prefix ? [{ text: prefix, tags: [...inherited] }] : [];
      spans.push(...inline(body).map((span) => ({ ...span, tags: [...inherited, ...span.tags] })));
      rendered.push(spans.length > 0 ? spans : [{ text: "", tags: [] }]);
    }
    index += 1;
  }
  return rendered;
}
