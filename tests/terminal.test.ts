import { afterEach, describe, expect, it } from "vitest";
import {
  StreamingMarkdownRenderer,
  TerminalControlFilter,
  formatOutput,
  renderMarkdown,
  stripTerminalControls,
} from "../src/terminal";

describe("terminal Markdown rendering", () => {
  const previousNoColor = process.env.NO_COLOR;
  afterEach(() => {
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  });

  it("renders common Markdown without its markers", () => {
    const text = `## Title

**bold** and *italic* with \`code\`

- item
1. first
> quote

| Name | Value |
| --- | --- |
| Ya | Agent |

---
`;
    const rendered = renderMarkdown(text);
    expect(rendered).toContain("Title");
    expect(rendered).toContain("bold and italic with code");
    expect(rendered).toContain("- item");
    expect(rendered).toContain("- first");
    expect(rendered).toContain("| quote");
    expect(rendered).toContain("Name: Ya; Value: Agent");
    expect(rendered).not.toContain("##");
    expect(rendered).not.toContain("**");
    expect(rendered).not.toContain("| ---");
  });

  it("preserves unsupported Markdown", () => {
    expect(renderMarkdown("~~unfinished~~")).toBe("~~unfinished~~");
  });

  it("removes terminal control sequences", () => {
    expect(stripTerminalControls("safe\u001b[31m text\u0007\r")).toBe("safe text");
  });

  it.each([
    ["\x1b]0;my title\x07ok", "ok"],
    ["\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ end", "link end"],
    ["a\x1b(Bb\x1b7c", "abc"],
    ["a\u009b2Jb", "ab"],
    ["a\u009d0;title\u009cb", "ab"],
    ["a\x1bPprivate\x1b\\b", "ab"],
    ["a\x1b_hidden\x07b", "ab"],
    ["a\x1b^private\x1b\\b", "ab"],
    ["a\x1bXprivate\x1b\\b", "ab"],
    ["a\u0090private\u009cb", "ab"],
    ["safe\x1b]0;unterminated title", "safe"],
  ])("strips complete control payloads from %j", (source, expected) => {
    expect(stripTerminalControls(source)).toBe(expected);
    for (let offset = 0; offset <= source.length; offset += 1) {
      const filter = new TerminalControlFilter();
      expect(filter.write(source.slice(0, offset)) + filter.write(source.slice(offset))).toBe(expected);
    }
  });

  it("removes every C1 control while preserving printable UTF-8, LF and tab", () => {
    for (let code = 0x80; code <= 0x9f; code += 1) expect(stripTerminalControls(String.fromCharCode(code))).toBe("");
    expect(stripTerminalControls("中文 café 🙂\n\ttext")).toBe("中文 café 🙂\n\ttext");
  });

  it("keeps OSC payloads out of streamed Markdown across every chunk boundary", () => {
    const source = "## Safe\x1b]0;hidden title\x07 heading\nbody";
    for (let offset = 0; offset <= source.length; offset += 1) {
      const renderer = new StreamingMarkdownRenderer();
      expect(renderer.write(source.slice(0, offset)) + renderer.write(source.slice(offset)) + renderer.finish()).toBe("Safe heading\nbody");
    }
  });

  it("preserves Markdown for non-TTY auto output", () => {
    expect(formatOutput("## Title", "auto", false)).toBe("## Title");
  });

  it("renders terminal format in a pipe", () => {
    expect(formatOutput("## Title", "terminal", false)).toBe("Title");
  });

  it("respects NO_COLOR", () => {
    process.env.NO_COLOR = "";
    expect(formatOutput("## Title", "terminal", true)).toBe("Title");
  });

  it("handles Markdown lines and tables split across stream chunks", () => {
    const renderer = new StreamingMarkdownRenderer();
    const rendered = renderer.write("## Ti")
      + renderer.write("tle\n\n| Name | Value |\n| --- | --- |\n| Ya | Agent |\n")
      + renderer.finish();
    expect(rendered).toContain("Title");
    expect(rendered).toContain("Name: Ya; Value: Agent");
    expect(rendered).not.toContain("##");
  });

  it("recovers from an unclosed fence at a heading", () => {
    const text = `## Start
\`\`\`sql
SELECT 1;
   ## Recovered heading
- **bold item**
`;
    const stream = new StreamingMarkdownRenderer();
    const renderedValues = [renderMarkdown(text), stream.write(text) + stream.finish()];
    for (const rendered of renderedValues) {
      expect(rendered).toContain("SELECT 1;");
      expect(rendered).toContain("Recovered heading");
      expect(rendered).toContain("- bold item");
      expect(rendered).not.toContain("## Recovered");
      expect(rendered).not.toContain("**bold item**");
    }
  });
});
