import { getBridge } from "./dom";

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "link"; text: string; url?: string };

export type MarkdownBlock =
  | { kind: "code"; lines: string[] }
  | { kind: "heading"; level: number; text: string }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "hr" }
  | { kind: "list"; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "paragraph"; text: string };

export type MarkdownRenderer = (container: HTMLElement, markdown: string) => void;

export function answerDisplayText(text: string): string {
  return text.replace(/[\x00-\x08\x0B-\x1F\x7F]/gu, "");
}

export class StreamingAnswerPreview {
  private readonly paragraph = document.createElement("p");
  private pending = "";
  private frame?: number;

  constructor(container: HTMLElement, private readonly onPaint: () => void) {
    container.classList.remove("busy-answer");
    container.replaceChildren(this.paragraph);
  }

  append(chunk: string): void {
    this.pending += answerDisplayText(chunk);
    if (this.frame !== undefined || !this.pending) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.paragraph.append(this.pending);
      this.pending = "";
      this.onPaint();
    });
  }

  cancel(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
  }
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
}

function tableSeparator(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

export function parseInlineTokens(text: string): InlineToken[] {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|(?<!\*)\*[^*]+\*(?!\*)|\[[^\]]+\]\([^\s)]+\))/gu;
  const tokens: InlineToken[] = [];
  let position = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start > position) tokens.push({ kind: "text", text: text.slice(position, start) });
    const token = match[0];
    if (token.startsWith("`")) {
      tokens.push({ kind: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("**") || token.startsWith("__")) {
      tokens.push({ kind: "bold", text: token.slice(2, -2) });
    } else if (token.startsWith("*")) {
      tokens.push({ kind: "italic", text: token.slice(1, -1) });
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/u);
      tokens.push({ kind: "link", text: link?.[1] ?? token, url: link?.[2] });
    }
    position = start + token.length;
  }
  if (position < text.length) tokens.push({ kind: "text", text: text.slice(position) });
  return tokens;
}

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = answerDisplayText(markdown).split(/\r?\n/u);
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trimStart().startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trimStart().startsWith("```")) {
        if (/^\s{0,3}#{1,6}\s+/u.test(lines[index] ?? "") && code.length > 0) break;
        code.push(lines[index] ?? "");
        index += 1;
      }
      if ((lines[index] ?? "").trimStart().startsWith("```")) index += 1;
      blocks.push({ kind: "code", lines: code });
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u);
    if (heading) {
      blocks.push({ kind: "heading", level: Math.min(6, heading[1]?.length ?? 2), text: heading[2] ?? "" });
      index += 1;
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && tableSeparator(lines[index + 1] ?? "")) {
      const headers = tableCells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim()) {
        rows.push(tableCells(lines[index] ?? ""));
        index += 1;
      }
      blocks.push({ kind: "table", headers, rows });
      continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u.test(line)) {
      blocks.push({ kind: "hr" });
      index += 1;
      continue;
    }
    const list = line.match(/^\s*(?:[-+*]|\d+[.)])\s+(.+)$/u);
    if (list) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = (lines[index] ?? "").match(/^\s*(?:[-+*]|\d+[.)])\s+(.+)$/u);
        if (!item) break;
        items.push(item[1] ?? "");
        index += 1;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/u);
    if (quote) {
      blocks.push({ kind: "quote", text: quote[1] ?? "" });
    } else {
      blocks.push({ kind: "paragraph", text: line });
    }
    index += 1;
  }
  return blocks;
}

function appendInline(parent: HTMLElement, text: string): void {
  for (const token of parseInlineTokens(text)) {
    if (token.kind === "text") {
      parent.append(document.createTextNode(token.text));
    } else if (token.kind === "code") {
      const code = document.createElement("code");
      code.textContent = token.text;
      parent.append(code);
    } else if (token.kind === "bold") {
      const strong = document.createElement("strong");
      strong.textContent = token.text;
      parent.append(strong);
    } else if (token.kind === "italic") {
      const emphasis = document.createElement("em");
      emphasis.textContent = token.text;
      parent.append(emphasis);
    } else {
      const anchor = document.createElement("a");
      anchor.href = "#";
      anchor.textContent = token.text;
      anchor.addEventListener("click", (event) => {
        event.preventDefault();
        if (token.url) void getBridge().openExternal(token.url);
      });
      parent.append(anchor);
    }
  }
}

export function defaultRenderMarkdown(container: HTMLElement, markdown: string): void {
  container.replaceChildren();
  for (const block of parseMarkdownBlocks(markdown)) {
    if (block.kind === "code") {
      const pre = document.createElement("pre");
      const codeNode = document.createElement("code");
      codeNode.textContent = block.lines.join("\n");
      pre.append(codeNode);
      container.append(pre);
    } else if (block.kind === "heading") {
      const node = document.createElement(`h${block.level}`);
      appendInline(node, block.text);
      container.append(node);
    } else if (block.kind === "table") {
      const table = document.createElement("table");
      const head = document.createElement("thead");
      const headerRow = document.createElement("tr");
      block.headers.forEach((header) => {
        const cell = document.createElement("th");
        appendInline(cell, header);
        headerRow.append(cell);
      });
      head.append(headerRow);
      table.append(head);
      const body = document.createElement("tbody");
      block.rows.forEach((values) => {
        const row = document.createElement("tr");
        values.forEach((value) => {
          const cell = document.createElement("td");
          appendInline(cell, value);
          row.append(cell);
        });
        body.append(row);
      });
      table.append(body);
      container.append(table);
    } else if (block.kind === "hr") {
      container.append(document.createElement("hr"));
    } else if (block.kind === "list") {
      const ul = document.createElement("ul");
      block.items.forEach((item) => {
        const li = document.createElement("li");
        appendInline(li, item);
        ul.append(li);
      });
      container.append(ul);
    } else if (block.kind === "quote") {
      const blockquote = document.createElement("blockquote");
      appendInline(blockquote, block.text);
      container.append(blockquote);
    } else {
      const paragraph = document.createElement("p");
      appendInline(paragraph, block.text);
      container.append(paragraph);
    }
  }
}

let activeMarkdownRenderer: MarkdownRenderer = defaultRenderMarkdown;

export function renderMarkdown(container: HTMLElement, markdown: string): void {
  activeMarkdownRenderer(container, markdown);
}

export function getMarkdownRenderer(): MarkdownRenderer {
  return activeMarkdownRenderer;
}

export function setMarkdownRenderer(renderer: MarkdownRenderer): void {
  activeMarkdownRenderer = renderer;
}
