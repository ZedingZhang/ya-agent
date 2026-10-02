import { createHash } from "node:crypto";

export const MAX_EDITS = 100;

export function textRevision(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** All ranges refer to the original text; replacements cannot affect later matches. */
export function applyTextEdits(original: string, edits: unknown, maxBytes: number): { content: string; count: number } {
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > MAX_EDITS) {
    throw new Error(`edits must contain 1–${MAX_EDITS} replacements.`);
  }
  const ranges = edits.map((edit: unknown, index) => {
    if (!edit || typeof edit !== "object" || Array.isArray(edit)) throw new Error(`Edit ${index + 1} must be an object.`);
    const { old_text: oldText, new_text: newText } = edit as Record<string, unknown>;
    if (typeof oldText !== "string" || !oldText || typeof newText !== "string") {
      throw new Error(`Edit ${index + 1} requires non-empty old_text and string new_text.`);
    }
    if (Buffer.byteLength(newText, "utf8") > maxBytes) throw new Error("Edited text larger than 1 MiB cannot be written.");
    if ([oldText, newText].some((text) => text.includes("\0") || Buffer.from(text, "utf8").toString("utf8") !== text)) {
      throw new Error(`Edit ${index + 1} must contain valid UTF-8 text without NUL bytes.`);
    }
    const start = original.indexOf(oldText);
    if (start < 0) throw new Error(`Edit ${index + 1} has no exact match. Read the file again and include exact context.`);
    if (original.indexOf(oldText, start + 1) >= 0) {
      throw new Error(`Edit ${index + 1} matches more than once. Include more surrounding context.`);
    }
    if (oldText === newText) throw new Error(`Edit ${index + 1} does not change the text.`);
    return { start, end: start + oldText.length, newText };
  }).sort((left, right) => left.start - right.start);
  const resultBytes = ranges.reduce((bytes, range) => bytes - Buffer.byteLength(original.slice(range.start, range.end), "utf8") + Buffer.byteLength(range.newText, "utf8"), Buffer.byteLength(original, "utf8"));
  if (resultBytes > maxBytes) throw new Error("Edited text larger than 1 MiB cannot be written.");
  let position = 0;
  const parts: string[] = [];
  for (const range of ranges) {
    if (range.start < position) throw new Error("Edit ranges overlap. Use disjoint original-text replacements.");
    parts.push(original.slice(position, range.start), range.newText);
    position = range.end;
  }
  parts.push(original.slice(position));
  const content = parts.join("");
  if (content === original) throw new Error("Edits do not change the file.");
  return { content, count: ranges.length };
}
