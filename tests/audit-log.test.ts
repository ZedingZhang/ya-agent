import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUDIT_LOG_MAX_BYTES,
  appendAuditRecord,
  auditHistoryEntries,
  auditLogFiles,
  auditLogPath,
  auditLogTotalBytes,
  clearAuditLogs,
  deleteAuditHistory,
  setAuditLogMaxBytesForTesting,
} from "../src/audit-log";
import { tempHome, type TempHome } from "./helpers";

describe("audit log storage", () => {
  let home: TempHome;
  const originalMaxBytes = AUDIT_LOG_MAX_BYTES;

  beforeEach(() => { home = tempHome("ya-audit-"); });
  afterEach(() => {
    setAuditLogMaxBytesForTesting(originalMaxBytes);
    home.cleanup();
  });

  it("appends, rotates, lists, selectively deletes, and clears audit logs", () => {
    setAuditLogMaxBytesForTesting(180);
    appendAuditRecord({ timestamp: "2026-01-01T00:00:00.000Z", operation: "write", path: "one.txt" });
    appendAuditRecord({ timestamp: "2026-01-02T00:00:00.000Z", operation: "edit", path: "two.txt" });
    appendAuditRecord({ timestamp: "2026-01-03T00:00:00.000Z", operation: "move", path: "three.txt" });

    const files = auditLogFiles();
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(auditLogTotalBytes()).toBeGreaterThan(0);

    const entries = auditHistoryEntries();
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const first = entries[0]!;
    expect(deleteAuditHistory([first.id])).toBe(1);
    expect(auditHistoryEntries().some((entry) => entry.id === first.id)).toBe(false);

    const removed = clearAuditLogs();
    expect(removed.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(auditLogPath(0))).toBe(false);
    expect(auditLogFiles()).toEqual([]);
  });

  it("preserves valid JSON lines when rotating oversized active logs", () => {
    setAuditLogMaxBytesForTesting(140);
    appendAuditRecord({ timestamp: "2026-01-01T00:00:00.000Z", operation: "write", payload: "a".repeat(60) });
    appendAuditRecord({ timestamp: "2026-01-02T00:00:00.000Z", operation: "write", payload: "b".repeat(60) });

    for (const file of auditLogFiles()) {
      const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
