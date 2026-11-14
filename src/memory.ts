import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";
import { dataHome } from "./config";

export const MAX_MEMORY_CARDS = 100;
export const MAX_RELEVANT_MEMORY_CARDS = 3;

export type MemoryKind = "preference" | "procedure" | "knowledge";
export type MemoryStatus = "candidate" | "approved" | "rejected" | "revoked";

export interface MemoryCard {
  id: string;
  kind: MemoryKind;
  text: string;
  evidence: string;
  status: MemoryStatus;
  createdAt: string;
  version: number;
}

export interface MemoryMatch {
  card: MemoryCard;
  // Octop returns ranked snippets without exposing its internal numeric scores.
  score: number | null;
}

export class DuplicateMemoryError extends Error {
  readonly card: MemoryCard;

  constructor(card: MemoryCard) {
    super(`Matching memory card already exists: ${card.id}`);
    this.name = "DuplicateMemoryError";
    this.card = card;
  }
}

export class MemoryLimitError extends Error {
  override readonly name = "MemoryLimitError";
}

export function memoryPath(): string {
  return join(dataHome(), "memory.sqlite");
}

interface MemoryResponse<T> {
  result?: T;
  error?: { message: string; code?: string; card?: MemoryCard };
}

function callMemory<T>(operation: string, params: Record<string, unknown> = {}): T {
  // Reading the bundled script also works inside Electron ASAR and pkg snapshots.
  const script = readFileSync(join(__dirname, "octop-memory.py"), "utf8");
  const override = process.env.YA_MEMORY_PYTHON;
  const interpreters = override ? [override] : process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  const request = JSON.stringify({ operation, home: dataHome(), maxCards: MAX_MEMORY_CARDS, ...params });
  for (const interpreter of interpreters) {
    let executable = interpreter;
    if (process.platform === "win32" && !isAbsolute(interpreter)) {
      // Resolve from absolute PATH entries so Windows cannot prefer a workspace executable.
      const filename = extname(interpreter) ? interpreter : `${interpreter}.exe`;
      const directories = (process.env.PATH ?? "").split(delimiter).map((directory) => directory.replace(/^"(.*)"$/, "$1"));
      const directory = directories.find((entry) => isAbsolute(entry) && existsSync(join(entry, filename)));
      if (!directory) continue;
      executable = join(directory, filename);
    }
    // Exclude workspace imports and inherited Python settings, including PYTHONPATH.
    const args = interpreter === "py" ? ["-3", "-E", "-P", "-X", "utf8", "-c", script] : ["-E", "-P", "-X", "utf8", "-c", script];
    const response = spawnSync(executable, args, {
      input: request,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (response.error && (response.error as NodeJS.ErrnoException).code === "ENOENT" && !override) continue;
    if (response.error || response.status !== 0) {
      throw new Error(`Octop Memory failed: ${response.error?.message ?? response.stderr.trim()}`);
    }
    let payload: MemoryResponse<T>;
    try { payload = JSON.parse(response.stdout) as MemoryResponse<T>; }
    catch { throw new Error("Octop Memory returned an invalid response."); }
    if (payload.error?.code === "duplicate" && payload.error.card) throw new DuplicateMemoryError(payload.error.card);
    if (payload.error?.code === "limit") throw new MemoryLimitError(payload.error.message);
    if (payload.error) throw new Error(payload.error.message);
    return payload.result as T;
  }
  throw new Error("Octop Memory requires Python 3.12+ and octop-memory==1.0.4. Install with python -m pip install octop-memory==1.0.4, then set YA_MEMORY_PYTHON to that interpreter if needed.");
}

function hasMemory(): boolean {
  return existsSync(memoryPath()) || existsSync(join(dataHome(), "memory.json"));
}

export function loadMemoryCards(): MemoryCard[] {
  return listCards();
}

export function createCandidate(text: string, evidence: string, kind: MemoryKind = "procedure"): MemoryCard {
  if (!(["preference", "procedure", "knowledge"] as const).includes(kind)) {
    throw new Error("memory kind must be preference, procedure, or knowledge.");
  }
  if (!text.trim()) throw new Error("memory text must not be empty.");
  return callMemory("create", { text: text.trim(), evidence: evidence.trim(), kind });
}

export function listCards(status?: MemoryStatus): MemoryCard[] {
  return hasMemory() ? callMemory("list", { status }) : [];
}

export function setStatus(cardId: string, status: Exclude<MemoryStatus, "candidate">): MemoryCard {
  if (!(["approved", "rejected", "revoked"] as const).includes(status)) throw new Error("invalid memory status");
  return callMemory("status", { cardId, status });
}

export function cardsToPrune(includeCandidates = false): MemoryCard[] {
  return listCards().filter((card) => card.status === "rejected" || card.status === "revoked"
    || (includeCandidates && card.status === "candidate"));
}

export function pruneCards(confirmedIds: readonly string[], includeCandidates = false): MemoryCard[] {
  return hasMemory() ? callMemory("prune", { confirmedIds, includeCandidates }) : [];
}

export function selectRelevantCards(task: string, limit = MAX_RELEVANT_MEMORY_CARDS): MemoryMatch[] {
  if (!Number.isInteger(limit) || limit < 0) throw new Error("memory recall limit must be a non-negative integer.");
  if (!task.trim() || limit === 0 || !hasMemory()) return [];
  return callMemory("recall", { query: task, limit });
}

export function relevantContext(task: string, limit = MAX_RELEVANT_MEMORY_CARDS): string {
  return selectRelevantCards(task, limit).map(({ card }) => `- [${card.kind}] ${card.text}`).join("\n");
}
