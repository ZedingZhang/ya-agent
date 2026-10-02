import type { OutputFormat } from "./types";

export const ANSI_ESCAPE = /\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/gu;
export const CONTROL_CHARACTERS = /[\x00-\x08\x0B-\x1F\x7F]/gu;
export const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u;
export const HORIZONTAL_RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u;
export const UNORDERED_LIST = /^(\s*)[-+*]\s+(.+)$/u;
export const ORDERED_LIST = /^(\s*)\d+[.)]\s+(.+)$/u;
export const BLOCK_QUOTE = /^(\s*)>\s?(.*)$/u;
export const IMAGE = /!\[([^\]]*)\]\(([^\s)]+)(?:\s+[^)]*)?\)/gu;
export const LINK = /\[([^\]]+)\]\(([^\s)]+)(?:\s+[^)]*)?\)/gu;
export const INLINE_CODE = /`([^`]+)`/gu;
export const BOLD = /(?:\*\*|__)(.+?)(?:\*\*|__)/gu;
export const ITALIC = /(?<!\*)\*([^*\n]+)\*(?!\*)|(?<!_)_([^_\n]+)_(?!_)/gu;

export function stripTerminalControls(text: string): string {
  return text.replace(ANSI_ESCAPE, "").replace(CONTROL_CHARACTERS, "");
}

function style(text: string, code: string, color: boolean): string {
  return color ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function renderInline(text: string, color: boolean): string {
  return text
    .replace(IMAGE, (_match, alt: string, url: string) => `${alt} <${url}>`)
    .replace(LINK, (_match, label: string, url: string) => `${label} <${url}>`)
    .replace(INLINE_CODE, (_match, code: string) => style(code, "7", color))
    .replace(BOLD, (_match, bold: string) => style(bold, "1", color))
    .replace(ITALIC, (_match, star: string | undefined, underscore: string | undefined) => style(star ?? underscore ?? "", "3", color));
}

export function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
}

export function isTableSeparator(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function renderTable(lines: string[], start: number, color: boolean): [string[], number] {
  const headers = tableCells(lines[start] ?? "");
  let index = start + 2;
  const rendered = [style(headers.map((header) => renderInline(header, color)).join(" | "), "1", color)];
  while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim()) {
    const cells = tableCells(lines[index] ?? "");
    const pairs = headers.slice(0, cells.length).map((header, cellIndex) =>
      `${renderInline(header, color)}: ${renderInline(cells[cellIndex] ?? "", color)}`,
    );
    rendered.push(`- ${pairs.join("; ")}`);
    index += 1;
  }
  return [rendered, index];
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function renderMarkdown(text: string, color = false): string {
  const lines = splitLines(stripTerminalControls(text));
  const rendered: string[] = [];
  let inCodeBlock = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      index += 1;
      continue;
    }
    if (inCodeBlock && HEADING.test(line)) inCodeBlock = false;
    if (inCodeBlock) {
      rendered.push(`  ${line}`);
      index += 1;
      continue;
    }
    if (index + 1 < lines.length && line.includes("|") && isTableSeparator(lines[index + 1] ?? "")) {
      const [table, next] = renderTable(lines, index, color);
      rendered.push(...table);
      index = next;
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) rendered.push(style(renderInline(heading[1] ?? "", color), "1;36", color));
    else if (HORIZONTAL_RULE.test(line)) rendered.push("-".repeat(40));
    else {
      const quote = line.match(BLOCK_QUOTE);
      const unordered = line.match(UNORDERED_LIST);
      const ordered = line.match(ORDERED_LIST);
      if (quote) rendered.push(`${quote[1] ?? ""}| ${renderInline(quote[2] ?? "", color)}`);
      else if (unordered) rendered.push(`${unordered[1] ?? ""}- ${renderInline(unordered[2] ?? "", color)}`);
      else if (ordered) rendered.push(`${ordered[1] ?? ""}- ${renderInline(ordered[2] ?? "", color)}`);
      else rendered.push(renderInline(line, color));
    }
    index += 1;
  }
  return rendered.join("\n");
}

export function formatOutput(text: string, outputFormat: OutputFormat, isTty: boolean): string {
  const sanitized = stripTerminalControls(text);
  if (outputFormat === "markdown" || (outputFormat === "auto" && !isTty)) return sanitized;
  return renderMarkdown(sanitized, isTty && !("NO_COLOR" in process.env));
}

export class StreamingMarkdownRenderer {
  private pending = "";
  private previous?: string;
  private code = false;
  readonly color: boolean;

  constructor(color = false) {
    this.color = color;
  }

  write(chunk: string): string {
    this.pending += stripTerminalControls(chunk);
    const output: string[] = [];
    while (this.pending.includes("\n")) {
      const newline = this.pending.indexOf("\n");
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      output.push(...this.line(line));
    }
    return output.length > 0 ? `${output.join("\n")}\n` : "";
  }

  finish(): string {
    const output: string[] = [];
    if (this.pending) {
      output.push(...this.line(this.pending));
      this.pending = "";
    }
    if (this.previous !== undefined) {
      output.push(...this.renderPlain(this.previous));
      this.previous = undefined;
    }
    return output.join("\n");
  }

  private line(line: string): string[] {
    if (line.trimStart().startsWith("```")) {
      const previous = this.previous === undefined ? [] : this.renderPlain(this.previous);
      this.previous = undefined;
      this.code = !this.code;
      return previous;
    }
    if (this.code && HEADING.test(line)) this.code = false;
    if (this.code) return [`  ${line}`];
    if (this.previous !== undefined && isTableSeparator(line) && this.previous.includes("|")) {
      this.previous = `\u0000TABLE:${tableCells(this.previous).join("\u001f")}`;
      return [];
    }
    let previous: string[] = [];
    if (this.previous?.startsWith("\u0000TABLE:")) {
      if (line.includes("|") && line.trim()) {
        const headers = this.previous.slice("\u0000TABLE:".length).split("\u001f");
        const cells = tableCells(line);
        const pairs = headers.slice(0, cells.length).map((header, index) =>
          `${renderInline(header, this.color)}: ${renderInline(cells[index] ?? "", this.color)}`,
        );
        return [`- ${pairs.join("; ")}`];
      }
    } else if (this.previous !== undefined) {
      previous = this.renderPlain(this.previous);
    }
    this.previous = line;
    return previous;
  }

  private renderPlain(line: string): string[] {
    if (line.startsWith("\u0000TABLE:")) return [];
    const rendered = renderMarkdown(line, this.color);
    return rendered ? rendered.split("\n") : [""];
  }
}
