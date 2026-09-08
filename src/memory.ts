import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
const ENGLISH_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "is", "it", "of", "on",
  "or", "the", "this", "that", "to", "what", "when", "where", "with",
]);
const CHINESE_STOP_PHRASES = new Set([
  "什么", "如何", "为什", "什么是", "怎么", "可以", "请问", "一个", "这个", "那个", "我们", "你们", "他们",
  "关于", "以及", "进行", "一下", "是否", "需要",
]);

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

export function normalizeMemoryText(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("und").replaceAll("ß", "ss").replace(/\s+/gu, " ").trim();
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

function englishWords(text: string): Set<string> {
  return new Set((text.match(/[a-z0-9][a-z0-9_-]*/g) ?? []).filter((word) => word.length >= 2 && !ENGLISH_STOP_WORDS.has(word)));
}

function englishPhrases(text: string): Set<string> {
  const words = (text.match(/[a-z0-9][a-z0-9_-]*/g) ?? []).filter((word) => !ENGLISH_STOP_WORDS.has(word));
  return new Set(words.slice(0, -1).map((word, index) => `${word} ${words[index + 1]}`));
}

function hanNgrams(text: string, width: number): Set<string> {
  const grams = new Set<string>();
  for (const run of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let index = 0; index <= run.length - width; index += 1) {
      const gram = run.slice(index, index + width);
      if (!CHINESE_STOP_PHRASES.has(gram)) grams.add(gram);
    }
  }
  return grams;
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
}

export function memoryScore(task: string, card: MemoryCard): number {
  const taskText = normalizeMemoryText(task);
  const cardText = normalizeMemoryText(card.text);
  if (!taskText || !cardText) return 0;
  const sharedWords = intersectionSize(englishWords(taskText), englishWords(cardText));
  const sharedBigrams = intersectionSize(hanNgrams(taskText, 2), hanNgrams(cardText, 2));
  const sharedPhrases = intersectionSize(englishPhrases(taskText), englishPhrases(cardText)) > 0
    || intersectionSize(hanNgrams(taskText, 3), hanNgrams(cardText, 3)) > 0;
  const exactContainment = Math.min(taskText.length, cardText.length) >= 4
    && (taskText.includes(cardText) || cardText.includes(taskText));
  return (sharedPhrases || exactContainment ? 5 : 0) + 3 * sharedWords + sharedBigrams;
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
