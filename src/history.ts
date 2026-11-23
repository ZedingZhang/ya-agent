export type StoredHistoryKind = "tasks" | "audit";

/** Metadata for the storage manager. Record contents stay in their owning store. */
export interface HistoryEntry {
  id: string;
  timestamp: number | null;
  bytes: number;
}
