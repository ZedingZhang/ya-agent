function answerDisplayText(text: string): string {
  return text.replace(/[\x00-\x08\x0B-\x1F\x7F]/gu, "");
}

class StreamingAnswerPreview {
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

function renderMarkdown(container: HTMLElement, markdown: string): void {
  container.replaceChildren();
  const lines = answerDisplayText(markdown).split(/\r?\n/u);
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
      const pre = document.createElement("pre");
      const codeNode = document.createElement("code");
      codeNode.textContent = code.join("\n");
      pre.append(codeNode);
      container.append(pre);
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u);
    if (heading) {
      const level = Math.min(6, heading[1]?.length ?? 2);
      const node = document.createElement(`h${level}`);
      appendInline(node, heading[2] ?? "");
      container.append(node);
      index += 1;
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && tableSeparator(lines[index + 1] ?? "")) {
      const table = document.createElement("table");
      const headers = tableCells(line);
      const head = document.createElement("thead");
      const headerRow = document.createElement("tr");
      headers.forEach((header) => {
        const cell = document.createElement("th");
        appendInline(cell, header);
        headerRow.append(cell);
      });
      head.append(headerRow);
      table.append(head);
      const body = document.createElement("tbody");
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim()) {
        const row = document.createElement("tr");
        tableCells(lines[index] ?? "").forEach((value) => {
          const cell = document.createElement("td");
          appendInline(cell, value);
          row.append(cell);
        });
        body.append(row);
        index += 1;
      }
      table.append(body);
      container.append(table);
      continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u.test(line)) {
      container.append(document.createElement("hr"));
      index += 1;
      continue;
    }
    const list = line.match(/^\s*(?:[-+*]|\d+[.)])\s+(.+)$/u);
    if (list) {
      const ul = document.createElement("ul");
      while (index < lines.length) {
        const item = (lines[index] ?? "").match(/^\s*(?:[-+*]|\d+[.)])\s+(.+)$/u);
        if (!item) break;
        const li = document.createElement("li");
        appendInline(li, item[1] ?? "");
        ul.append(li);
        index += 1;
      }
      container.append(ul);
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/u);
    const paragraph = document.createElement(quote ? "blockquote" : "p");
    appendInline(paragraph, quote?.[1] ?? line);
    container.append(paragraph);
    index += 1;
  }
}

function appendInline(parent: HTMLElement, text: string): void {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|(?<!\*)\*[^*]+\*(?!\*)|\[[^\]]+\]\([^\s)]+\))/gu;
  let position = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start > position) parent.append(document.createTextNode(text.slice(position, start)));
    const token = match[0];
    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    } else if (token.startsWith("*")) {
      const emphasis = document.createElement("em");
      emphasis.textContent = token.slice(1, -1);
      parent.append(emphasis);
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/u);
      const anchor = document.createElement("a");
      anchor.href = "#";
      anchor.textContent = link?.[1] ?? token;
      anchor.addEventListener("click", (event) => {
        event.preventDefault();
        if (link?.[2]) void bridge.openExternal(link[2]);
      });
      parent.append(anchor);
    }
    position = start + token.length;
  }
  if (position < text.length) parent.append(document.createTextNode(text.slice(position)));
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
}

function tableSeparator(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}
