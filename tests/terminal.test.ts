import { afterEach, describe, expect, it } from "vitest";
import {
  StreamingMarkdownRenderer,
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
