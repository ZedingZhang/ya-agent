import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { dataHome } from "./config";
import { atomicWriteFileSync } from "./fs-utils";
import type { HistoryEntry } from "./history";
import { withTaskStoreLock } from "./task-store-lock";

export let AUDIT_LOG_MAX_BYTES = 1024 * 1024;
export const MAX_AUDIT_ARCHIVES = 3;

export function setAuditLogMaxBytesForTesting(value: number): void {
  AUDIT_LOG_MAX_BYTES = value;
}

export function auditLogPath(index = 0): string {
  return join(dataHome(), `actions${index === 0 ? "" : `.${index}`}.jsonl`);
}

export function auditLogFiles(): string[] {
  const paths: string[] = [];
  for (let index = 0; index <= MAX_AUDIT_ARCHIVES; index += 1) {
    const path = auditLogPath(index);
    if (lstatSync(path, { throwIfNoEntry: false })?.isFile()) paths.push(path);
  }
  return paths;
}

export function auditLogTotalBytes(): number {
  return auditLogFiles().reduce((total, path) => total + (lstatSync(path, { throwIfNoEntry: false })?.size ?? 0), 0);
}

export function clearAuditLogs(): string[] {
  return withTaskStoreLock(auditLogPath(), () => {
    const removed = auditLogFiles();
    for (const path of removed) unlinkSync(path);
    return removed;
  });
}

function* auditLines(path: string) {
  // A rotated file keeps its identity. A replacement file can contain identical JSON at the same offset.
  const { dev, ino, birthtimeNs } = statSync(path, { bigint: true });
  const data = readFileSync(path);
  for (let start = 0; start < data.length;) {
    const newline = data.indexOf(0x0a, start);
    const end = newline < 0 ? data.length : newline + 1;
    const line = data.subarray(start, end);
    const id = createHash("sha256").update(`${dev}:${ino}:${birthtimeNs}:${start}:`).update(line).digest("hex");
    yield { line, id };
    start = end;
  }
}

export function auditHistoryEntries(): HistoryEntry[] {
  return withTaskStoreLock(auditLogPath(), () => {
    const entries: HistoryEntry[] = [];
    for (const path of auditLogFiles()) {
      for (const { line, id } of auditLines(path)) {
        let timestamp = NaN;
        try {
          const record = JSON.parse(line.toString("utf8"));
          if (typeof record?.timestamp === "string") timestamp = Date.parse(record.timestamp);
        } catch { /* Keep undated or damaged lines available for explicit cleanup. */ }
        entries.push({ id, timestamp: Number.isFinite(timestamp) ? timestamp : null, bytes: line.length });
      }
    }
    return entries;
  });
}

export function deleteAuditHistory(ids: readonly string[]): number {
  const selected = new Set(ids);
  return withTaskStoreLock(auditLogPath(), () => {
    let removed = 0;
    for (const path of auditLogFiles()) {
      const kept: Buffer[] = [];
      let changed = false;
      for (const { line, id } of auditLines(path)) {
        if (!selected.has(id)) { kept.push(line); continue; }
        changed = true;
        removed++;
      }
      if (!changed) continue;
      if (!kept.length) { unlinkSync(path); continue; }
      atomicWriteFileSync(path, Buffer.concat(kept), { mode: 0o600, flag: "wx", ensureDir: false });
    }
    return removed;
  });
}

function tailCompleteLines(data: Buffer, limit: number): Buffer {
  if (data.byteLength <= limit) return data;
  const tail = data.subarray(data.byteLength - limit);
  const newline = tail.indexOf(0x0a);
  return newline >= 0 ? tail.subarray(newline + 1) : Buffer.alloc(0);
}

function rotateAuditLogs(): void {
  for (let index = MAX_AUDIT_ARCHIVES; index >= 1; index -= 1) {
    const source = auditLogPath(index - 1);
    const destination = auditLogPath(index);
    if (!existsSync(source) || !statSync(source).isFile()) continue;
    if (existsSync(destination)) unlinkSync(destination);
    if (index === 1 && statSync(source).size > AUDIT_LOG_MAX_BYTES) {
      const data = tailCompleteLines(readFileSync(source), AUDIT_LOG_MAX_BYTES);
      atomicWriteFileSync(destination, data, { ensureDir: false });
      unlinkSync(source);
    } else {
      renameSync(source, destination);
    }
  }
}

export function appendAuditRecord(record: Record<string, unknown>): void {
  const encoded = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  const active = auditLogPath();
  withTaskStoreLock(active, () => {
    if (existsSync(active) && statSync(active).size + encoded.byteLength > AUDIT_LOG_MAX_BYTES) rotateAuditLogs();
    appendFileSync(active, encoded);
  });
}
