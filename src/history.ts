import { auditHistoryEntries, deleteAuditHistory } from "./audit-log";
import { TaskStore } from "./tasks";

export type StoredHistoryKind = "tasks" | "audit";

/** Metadata for the storage manager. Record contents stay in their owning store. */
export interface HistoryEntry {
  id: string;
  timestamp: number | null;
  bytes: number;
}

// A storage preview must not perform startup reconciliation on the task file.
const taskHistory = new TaskStore({ reconcileOnStartup: false });

export function listStoredHistory(kind: StoredHistoryKind): HistoryEntry[] {
  return kind === "tasks" ? taskHistory.historyEntries() : auditHistoryEntries();
}

export function deleteStoredHistory(kind: StoredHistoryKind, ids: readonly string[]): number {
  return kind === "tasks" ? taskHistory.deleteHistory(ids) : deleteAuditHistory(ids);
}
