import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  memoryScore as nativeMemoryScore,
  normalizeMemoryText as nativeNormalizeMemoryText,
} from "ya-core";
import { dataHome } from "./config";

export const MAX_MEMORY_CARDS = 100;
export const MAX_RELEVANT_MEMORY_CARDS = 3;
export const MIN_RELEVANCE_SCORE = 3;

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

interface StoredMemoryCard extends Omit<MemoryCard, "createdAt"> {
  created_at: string;
}

export interface MemoryMatch {
  card: MemoryCard;
  score: number;
}

const ACTIVE_STATUSES = new Set<MemoryStatus>(["candidate", "approved"]);
const DEFAULT_PRUNE_STATUSES = new Set<MemoryStatus>(["rejected", "revoked"]);

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
  return join(dataHome(), "memory.json");
}

function fromStored(value: unknown): MemoryCard {
  if (!isRecord(value)) throw new Error("Invalid memory card data.");
  return {
    id: expectString(value.id, "id"),
    kind: expectString(value.kind, "kind") as MemoryKind,
    text: expectString(value.text, "text"),
    evidence: expectString(value.evidence, "evidence"),
    status: expectString(value.status, "status") as MemoryStatus,
    createdAt: expectString(value.created_at ?? value.createdAt, "created_at"),
    version: typeof value.version === "number" ? value.version : 1,
  };
}

function toStored(card: MemoryCard): StoredMemoryCard {
  const { createdAt, ...rest } = card;
  return { ...rest, created_at: createdAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Invalid memory card ${field}.`);
  return value;
}

export function loadMemoryCards(): MemoryCard[] {
  const path = memoryPath();
  if (!existsSync(path)) return [];
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(value)) throw new Error("Memory file must contain a JSON array.");
  return value.map(fromStored);
}

export function saveMemoryCards(cards: readonly MemoryCard[]): void {
  const path = memoryPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(cards.map(toStored), null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

/** NFKC, case folding, `ß` to `ss`, and collapsed whitespace; implemented in Rust. */
export function normalizeMemoryText(text: string): string {
  return nativeNormalizeMemoryText(text);
}

export function createCandidate(text: string, evidence: string, kind: MemoryKind = "procedure"): MemoryCard {
  if (!(["preference", "procedure", "knowledge"] as const).includes(kind)) {
    throw new Error("memory kind must be preference, procedure, or knowledge.");
  }
  const cards = loadMemoryCards();
  const normalizedText = normalizeMemoryText(text);
  const duplicate = cards.find(
    (card) => card.kind === kind && ACTIVE_STATUSES.has(card.status) && normalizeMemoryText(card.text) === normalizedText,
  );
  if (duplicate) throw new DuplicateMemoryError(duplicate);
  if (cards.length >= MAX_MEMORY_CARDS) {
    throw new MemoryLimitError(`Memory card limit (${MAX_MEMORY_CARDS}) reached. Run: ya memory prune`);
  }
  const card: MemoryCard = {
    id: randomUUID().replaceAll("-", "").slice(0, 8),
    kind,
    text: text.trim(),
    evidence: evidence.trim(),
    status: "candidate",
    createdAt: new Date().toISOString(),
    version: 1,
  };
  cards.push(card);
  saveMemoryCards(cards);
  return card;
}

export function listCards(status?: MemoryStatus): MemoryCard[] {
  const cards = loadMemoryCards();
  return status ? cards.filter((card) => card.status === status) : cards;
}

export function setStatus(cardId: string, status: Exclude<MemoryStatus, "candidate">): MemoryCard {
  if (!(["approved", "rejected", "revoked"] as const).includes(status)) throw new Error("invalid memory status");
  const cards = loadMemoryCards();
  const card = cards.find((candidate) => candidate.id === cardId);
  if (!card) throw new Error("memory card not found");
  card.status = status;
  card.version += 1;
  saveMemoryCards(cards);
  return card;
}

export function cardsToPrune(includeCandidates = false): MemoryCard[] {
  return loadMemoryCards().filter(
    (card) => DEFAULT_PRUNE_STATUSES.has(card.status) || (includeCandidates && card.status === "candidate"),
  );
}

export function pruneCards(includeCandidates = false): MemoryCard[] {
  const cards = loadMemoryCards();
  const removed = cards.filter(
    (card) => DEFAULT_PRUNE_STATUSES.has(card.status) || (includeCandidates && card.status === "candidate"),
  );
  if (removed.length > 0) {
    const removedIds = new Set(removed.map((card) => card.id));
    saveMemoryCards(cards.filter((card) => !removedIds.has(card.id)));
  }
  return removed;
}

/**
 * Scores a task against a card: shared English words, shared Han bigrams, and a
 * phrase or containment bonus. Implemented in Rust.
 */
export function memoryScore(task: string, card: MemoryCard): number {
  return nativeMemoryScore(task, card.text);
}

export function selectRelevantCards(task: string, limit = MAX_RELEVANT_MEMORY_CARDS): MemoryMatch[] {
  return listCards("approved")
    .map((card) => ({ card, score: memoryScore(task, card) }))
    .filter((match) => match.score >= MIN_RELEVANCE_SCORE)
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      const dateDifference = (Date.parse(right.card.createdAt) || 0) - (Date.parse(left.card.createdAt) || 0);
      return dateDifference || left.card.id.localeCompare(right.card.id);
    })
    .slice(0, limit);
}

export function relevantContext(task: string, limit = MAX_RELEVANT_MEMORY_CARDS): string {
  return selectRelevantCards(task, limit).map(({ card }) => `- [${card.kind}] ${card.text}`).join("\n");
}
