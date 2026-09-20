import {
  StreamingMarkdownRenderer as NativeStreamingMarkdownRenderer,
  renderMarkdown as nativeRenderMarkdown,
} from "ya-core";
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

/**
 * These four primitives stay in TypeScript: the desktop renderer in
 * `gui/markdown.ts` parses with them line by line into DOM nodes, and moving
 * them behind the boundary would add a call per line for no gain. The parity
 * harness compares them against the Rust renderer's own copies, so drift is
 * still caught.
 */
export function stripTerminalControls(text: string): string {
  return text.replace(ANSI_ESCAPE, "").replace(CONTROL_CHARACTERS, "");
}

export function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
}

export function isTableSeparator(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

/** Markdown rendered as terminal text; the renderer itself is in the Rust core. */
export function renderMarkdown(text: string, color = false): string {
  return nativeRenderMarkdown(text, color);
}

export function formatOutput(text: string, outputFormat: OutputFormat, isTty: boolean): string {
  const sanitized = stripTerminalControls(text);
  if (outputFormat === "markdown" || (outputFormat === "auto" && !isTty)) return sanitized;
  return nativeRenderMarkdown(sanitized, isTty && !("NO_COLOR" in process.env));
}

/** Streams an answer as it arrives; the held-back line state lives in Rust. */
export class StreamingMarkdownRenderer {
  private readonly native: NativeStreamingMarkdownRenderer;
  readonly color: boolean;

  constructor(color = false) {
    this.color = color;
    this.native = new NativeStreamingMarkdownRenderer(color);
  }

  write(chunk: string): string {
    return this.native.write(chunk);
  }

  finish(): string {
    return this.native.finish();
  }
}
