import { randomUUID } from "node:crypto";
import { structuredPatch } from "diff";

export const MAX_FILE_DIFF_LINES = 2_000;
export const MAX_FILE_DIFF_CHARS = 128 * 1_024;

export interface FileDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** A bounded, replayable snapshot of one successful file mutation, for presentation only. */
export interface FileChange {
  id: string;
  path: string;
  operation: "create" | "write" | "edit";
  additions: number | null;
  deletions: number | null;
  hunks: FileDiffHunk[];
  truncated: boolean;
}

export function createFileChange(path: string, before: string | undefined, after: string, operation: "write" | "edit"): FileChange {
  const patch = structuredPatch(path, path, before ?? "", after, undefined, undefined, { context: 3, timeout: 250 });
  const change: FileChange = {
    id: randomUUID(), path, operation: before === undefined ? "create" : operation,
    additions: patch ? 0 : null, deletions: patch ? 0 : null, hunks: [], truncated: !patch,
  };
  if (!patch) return change;

  // Count the complete patch even when its persisted preview has to be shortened.
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) change.additions! += 1;
      if (line.startsWith("-")) change.deletions! += 1;
    }
  }
  let lineCount = 0;
  let characters = 0;
  for (const hunk of patch.hunks) {
    const saved: FileDiffHunk = { oldStart: hunk.oldStart, oldLines: hunk.oldLines,
      newStart: hunk.newStart, newLines: hunk.newLines, lines: [] };
    for (const line of hunk.lines) {
      if (lineCount >= MAX_FILE_DIFF_LINES || characters + line.length > MAX_FILE_DIFF_CHARS) {
        change.truncated = true;
        // Keep the beginning of an unusually long line without exceeding the character budget.
        const remaining = MAX_FILE_DIFF_CHARS - characters;
        if (lineCount < MAX_FILE_DIFF_LINES && remaining > 1) saved.lines.push(`${line.slice(0, remaining - 1)}…`);
        if (saved.lines.length > 0) change.hunks.push(saved);
        return change;
      }
      saved.lines.push(line);
      lineCount += 1;
      characters += line.length;
    }
    change.hunks.push(saved);
  }
  return change;
}
