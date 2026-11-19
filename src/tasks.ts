import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  ModelConfig,
  VALID_MODELS,
  dataHome,
  isReasoningEffort,
  type ModelId,
  type ReasoningEffort,
} from "./config";
import type { DeepSeekCredential } from "./credentials";
import { isProcessAlive, withTaskStoreLock } from "./task-store-lock";
import type { WebMode } from "./types";

export const TASK_STORE_VERSION = 1;

export const TASK_STATUSES = [
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ["running"];
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["completed", "failed", "cancelled"];

const VALID_WEB_MODES: readonly WebMode[] = ["auto", "on", "off"];
const FORBIDDEN_SECRET_KEYS = new Set([
  "apikey",
  "api_key",
  "deepseekapikey",
  "token",
  "authtoken",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "clientsecret",
  "privatekey",
  "credential",
  "credentials",
  "password",
  "secret",
  "authorization",
  "x-dsh-auth-token",
]);

export interface TaskExecutionOptions {
  model: ModelId;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  webMode: WebMode;
  toa: boolean;
  toaWorkers: 1 | 2;
  toaTokenBudget: number;
  toaTimeout: number;
  local: boolean;
  commandsEnabled: boolean;
  stream: boolean;
  imageCount: number;
  historyLength: number;
}

export interface TaskRecord {
  id: string;
  objective: string;
  sessionId?: string;
  workspace?: string;
  options: TaskExecutionOptions;
  status: TaskStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
  completedAt?: string;
  mode?: "single" | "toa";
  partial?: boolean;
  error?: string;
}

interface StoredTaskExecutionOptions {
  model: ModelId;
  thinking_enabled: boolean;
  reasoning_effort: ReasoningEffort;
  web_mode: WebMode;
  toa: boolean;
  toa_workers: 1 | 2;
  toa_token_budget: number;
  toa_timeout: number;
  local: boolean;
  commands_enabled: boolean;
  stream: boolean;
  image_count: number;
  history_length: number;
}

interface StoredTaskRecord {
  schema_version: number;
  id: string;
  objective: string;
  session_id?: string;
  workspace?: string;
  options: StoredTaskExecutionOptions;
  status: TaskStatus;
  revision: number;
  created_at: string;
  updated_at: string;
  ended_at?: string;
  completed_at?: string;
  mode?: "single" | "toa";
  partial?: boolean;
  error?: string;
  runtime_id?: string;
  runtime_pid?: number;
}

interface StoredTaskStore {
  version: number;
  tasks: StoredTaskRecord[];
}

export interface CreateTaskInput {
  objective: string;
  sessionId?: string;
  workspace?: string;
  config?: ModelConfig;
  options?: Partial<TaskExecutionOptions>;
}

export interface TransitionTaskInput {
  expectedRevision?: number;
  mode?: "single" | "toa";
  partial?: boolean;
  error?: string;
}

export interface ListTasksOptions {
  status?: TaskStatus | readonly TaskStatus[];
  sessionId?: string;
  workspace?: string;
}

export interface TaskStoreOptions {
  path?: string;
  runtimeId?: string;
  now?: () => Date;
  reconcileOnStartup?: boolean;
  writeFile?: (path: string, content: string) => void;
}

export class TaskTransitionError extends Error {
  override readonly name = "TaskTransitionError";
}

export class StaleTaskRecordError extends Error {
  override readonly name = "StaleTaskRecordError";
}

export function tasksPath(): string {
  return join(dataHome(), "tasks.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

export function validateWorkspaceIdentity(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Workspace path must be a non-empty string.");
  }
  const expanded = resolve(expandHome(value.trim()));
  if (!existsSync(expanded)) throw new Error(`Workspace does not exist: ${expanded}`);
  const physical = realpathSync(expanded);
  if (!statSync(physical).isDirectory()) throw new Error(`Workspace is not a directory: ${physical}`);
  return physical;
}

function assertNoSecretFields(value: unknown, context: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretFields(item, `${context}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLocaleLowerCase("und");
    if (FORBIDDEN_SECRET_KEYS.has(normalized)) {
      throw new Error(`Task records must not contain credential field "${key}" in ${context}.`);
    }
    assertNoSecretFields(child, `${context}.${key}`);
  }
}

export function redactSecrets(message: string, credential?: DeepSeekCredential): string {
  let clean = message;
  const secret = typeof credential === "string" ? credential.trim() : credential?.token?.trim();
  if (secret && secret.length > 0) {
    clean = clean.split(secret).join("[redacted]");
  }
  clean = clean.replace(/Bearer\s+[\x21-\x7e]+/giu, "Bearer [redacted]");
  clean = clean.replace(/(x-dsh-auth-token\s*[:=]\s*)[\x21-\x7e]+/giu, "$1[redacted]");
  return clean;
}

function validateSessionId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Task sessionId must be a string.");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128 || /[\x00-\x1F\x7F]/u.test(trimmed)) {
    throw new Error("Task sessionId must be a printable string with at most 128 characters.");
  }
  return trimmed;
}

function validateObjective(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Task objective must be a non-empty string.");
  }
  return value;
}

function validateIsoTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new Error(`Invalid task ${field} timestamp.`);
  }
  return value;
}

function validatePositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Task ${field} must be a positive integer.`);
  }
  return value;
}

function validateNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Task ${field} must be a non-negative integer.`);
  }
  return value;
}

function validateExecutionOptions(
  raw: unknown,
  config = new ModelConfig(),
  hasWorkspace = false,
): TaskExecutionOptions {
  if (raw !== undefined && !isRecord(raw)) {
    throw new Error("Task execution options must be an object.");
  }
  assertNoSecretFields(raw, "options");
  const source = raw ?? {};

  const modelValue = source.model ?? config.model;
  if (typeof modelValue !== "string" || !Object.values(VALID_MODELS).includes(modelValue as ModelId)) {
    throw new Error(`Invalid task model: ${String(modelValue)}.`);
  }
  const thinkingValue = source.thinking_enabled ?? source.thinkingEnabled ?? config.thinkingEnabled;
  if (typeof thinkingValue !== "boolean") {
    throw new Error("Task thinkingEnabled must be a boolean.");
  }
  const effortValue = source.reasoning_effort ?? source.reasoningEffort ?? config.reasoningEffort;
  if (!isReasoningEffort(effortValue)) {
    throw new Error("Task reasoningEffort must be 'low', 'high', or 'max'.");
  }
  const webModeValue = source.web_mode ?? source.webMode ?? "auto";
  if (typeof webModeValue !== "string" || !VALID_WEB_MODES.includes(webModeValue as WebMode)) {
    throw new Error("Task webMode must be 'auto', 'on', or 'off'.");
  }
  const toaValue = source.toa ?? false;
  if (typeof toaValue !== "boolean") {
    throw new Error("Task toa option must be a boolean.");
  }
  const workersValue = source.toa_workers ?? source.toaWorkers ?? 2;
  if (workersValue !== 1 && workersValue !== 2) {
    throw new Error("ToA workers must be 1 or 2.");
  }
  const budgetValue = source.toa_token_budget ?? source.toaTokenBudget ?? config.toaTokenBudget;
  if (typeof budgetValue !== "number" || !Number.isInteger(budgetValue) || budgetValue < 1_000 || budgetValue > 16_000) {
    throw new Error("ToA token budget must be between 1000 and 16000.");
  }
  const timeoutValue = source.toa_timeout ?? source.toaTimeout ?? config.toaTimeout;
  if (typeof timeoutValue !== "number" || !Number.isInteger(timeoutValue) || timeoutValue < 30 || timeoutValue > 180) {
    throw new Error("ToA timeout must be between 30 and 180 seconds.");
  }
  const localValue = source.local ?? hasWorkspace;
  if (typeof localValue !== "boolean") {
    throw new Error("Task local option must be a boolean.");
  }
  const commandsValue = source.commands_enabled ?? source.commandsEnabled ?? false;
  if (typeof commandsValue !== "boolean") {
    throw new Error("Task commandsEnabled option must be a boolean.");
  }
  const streamValue = source.stream ?? false;
  if (typeof streamValue !== "boolean") {
    throw new Error("Task stream option must be a boolean.");
  }
  const imageCount = validateNonNegativeInt(source.image_count ?? source.imageCount ?? 0, "imageCount");
  const historyLength = validateNonNegativeInt(source.history_length ?? source.historyLength ?? 0, "historyLength");

  if (toaValue && localValue) {
    throw new Error("Local workspace mode cannot be used with Tree of Agents.");
  }
  if (commandsValue && !localValue) {
    throw new Error("Command execution requires local workspace mode.");
  }
  return {
    model: modelValue as ModelId,
    thinkingEnabled: thinkingValue,
    reasoningEffort: effortValue,
    webMode: webModeValue as WebMode,
    toa: toaValue,
    toaWorkers: workersValue,
    toaTokenBudget: budgetValue,
    toaTimeout: timeoutValue,
    local: localValue,
    commandsEnabled: commandsValue,
    stream: streamValue,
    imageCount,
    historyLength,
  };
}

function toStoredOptions(options: TaskExecutionOptions): StoredTaskExecutionOptions {
  return {
    model: options.model,
    thinking_enabled: options.thinkingEnabled,
    reasoning_effort: options.reasoningEffort,
    web_mode: options.webMode,
    toa: options.toa,
    toa_workers: options.toaWorkers,
    toa_token_budget: options.toaTokenBudget,
    toa_timeout: options.toaTimeout,
    local: options.local,
    commands_enabled: options.commandsEnabled,
    stream: options.stream,
    image_count: options.imageCount,
    history_length: options.historyLength,
  };
}

function parseStoredRecord(raw: unknown): StoredTaskRecord {
  if (!isRecord(raw)) throw new Error("Invalid task record: expected an object.");
  assertNoSecretFields(raw, "task");
  const schemaVersion = raw.schema_version ?? raw.schemaVersion ?? TASK_STORE_VERSION;
  if (schemaVersion !== TASK_STORE_VERSION) {
    throw new Error(`Unsupported task record schema version: ${String(schemaVersion)}.`);
  }
  const id = raw.id;
  if (typeof id !== "string" || !id.trim() || id.length > 128) {
    throw new Error("Invalid task record id.");
  }
  const objective = validateObjective(raw.objective);
  const sessionId = validateSessionId(raw.session_id ?? raw.sessionId);
  const workspaceRaw = raw.workspace;
  let workspace: string | undefined;
  if (workspaceRaw !== undefined) {
    if (typeof workspaceRaw !== "string" || !workspaceRaw.trim()) {
      throw new Error("Invalid task record workspace.");
    }
    workspace = workspaceRaw;
  }
  const options = validateExecutionOptions(raw.options, undefined, workspace !== undefined);
  if (options.local && !workspace) {
    throw new Error("Local task records require an authorized workspace.");
  }
  if (!options.local && workspace !== undefined) {
    throw new Error("Non-local task records cannot include a workspace.");
  }
  const status = raw.status;
  if (typeof status !== "string" || !TASK_STATUSES.includes(status as TaskStatus)) {
    throw new Error(`Invalid task status: ${String(status)}.`);
  }
  const revision = validatePositiveInt(raw.revision, "revision");
  const createdAt = validateIsoTimestamp(raw.created_at ?? raw.createdAt, "createdAt");
  const updatedAt = validateIsoTimestamp(raw.updated_at ?? raw.updatedAt, "updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error("Task updatedAt cannot be earlier than createdAt.");
  }
  const endedRaw = raw.ended_at ?? raw.endedAt;
  const endedAt = endedRaw === undefined ? undefined : validateIsoTimestamp(endedRaw, "endedAt");
  if (endedAt !== undefined && Date.parse(endedAt) < Date.parse(createdAt)) {
    throw new Error("Task endedAt cannot be earlier than createdAt.");
  }
  const completedRaw = raw.completed_at ?? raw.completedAt;
  const completedAt = completedRaw === undefined ? undefined : validateIsoTimestamp(completedRaw, "completedAt");
  if (completedAt !== undefined && status !== "completed") {
    throw new Error("Only completed task records can include completedAt.");
  }
  const mode = raw.mode;
  if (mode !== undefined && mode !== "single" && mode !== "toa") {
    throw new Error(`Invalid task mode: ${String(mode)}.`);
  }
  const partial = raw.partial;
  if (partial !== undefined && typeof partial !== "boolean") {
    throw new Error("Invalid task partial flag.");
  }
  const error = raw.error;
  if (error !== undefined && typeof error !== "string") {
    throw new Error("Invalid task error message.");
  }
  const runtimeId = raw.runtime_id ?? raw.runtimeId;
  if (runtimeId !== undefined && (typeof runtimeId !== "string" || !runtimeId.trim())) {
    throw new Error("Invalid task runtime_id.");
  }
  const runtimePid = raw.runtime_pid;
  if (runtimePid !== undefined && (typeof runtimePid !== "number"
    || !Number.isInteger(runtimePid) || runtimePid <= 0 || runtimePid > 0x7fffffff)) {
    throw new Error("Invalid task runtime_pid.");
  }
  return {
    schema_version: TASK_STORE_VERSION,
    id,
    objective,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(workspace ? { workspace } : {}),
    options: toStoredOptions(options),
    status: status as TaskStatus,
    revision,
    created_at: createdAt,
    updated_at: updatedAt,
    ...(endedAt ? { ended_at: endedAt } : {}),
    ...(completedAt ? { completed_at: completedAt } : {}),
    ...(mode ? { mode } : {}),
    ...(partial !== undefined ? { partial } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(runtimeId ? { runtime_id: runtimeId } : {}),
    ...(runtimePid !== undefined ? { runtime_pid: runtimePid } : {}),
  };
}

function toPublicRecord(stored: StoredTaskRecord, isRunning: boolean): TaskRecord {
  const interrupted = stored.status === "running" && !isRunning;
  const status: TaskStatus = interrupted ? "interrupted" : stored.status;
  const endedAt = stored.ended_at ?? (status !== "running" ? stored.updated_at : undefined);
  return {
    id: stored.id,
    objective: stored.objective,
    ...(stored.session_id ? { sessionId: stored.session_id } : {}),
    ...(stored.workspace ? { workspace: stored.workspace } : {}),
    options: {
      model: stored.options.model,
      thinkingEnabled: stored.options.thinking_enabled,
      reasoningEffort: stored.options.reasoning_effort,
      webMode: stored.options.web_mode,
      toa: stored.options.toa,
      toaWorkers: stored.options.toa_workers,
      toaTokenBudget: stored.options.toa_token_budget,
      toaTimeout: stored.options.toa_timeout,
      local: stored.options.local,
      commandsEnabled: stored.options.commands_enabled,
      stream: stored.options.stream,
      imageCount: stored.options.image_count,
      historyLength: stored.options.history_length,
    },
    status,
    revision: stored.revision,
    createdAt: stored.created_at,
    updatedAt: stored.updated_at,
    ...(endedAt ? { endedAt } : {}),
    ...(stored.completed_at ? { completedAt: stored.completed_at } : {}),
    ...(stored.mode ? { mode: stored.mode } : {}),
    ...(stored.partial !== undefined ? { partial: stored.partial } : {}),
    ...(stored.error !== undefined ? { error: stored.error } : {}),
  };
}

function nextTimestamp(now: () => Date, minimumIso?: string): string {
  const currentMs = now().getTime();
  const minimumMs = minimumIso ? Date.parse(minimumIso) : Number.NaN;
  const timestampMs = Number.isFinite(minimumMs) ? Math.max(currentMs, minimumMs) : currentMs;
  return new Date(timestampMs).toISOString();
}

export class TaskStore {
  readonly runtimeId: string;
  private readonly customPath?: string;
  private readonly now: () => Date;
  private readonly customWriteFile?: (path: string, content: string) => void;
  private readonly activeTaskIds = new Set<string>();

  constructor(options: TaskStoreOptions = {}) {
    this.customPath = options.path ? resolve(options.path) : undefined;
    this.runtimeId = options.runtimeId?.trim() || randomUUID();
    this.now = options.now ?? (() => new Date());
    this.customWriteFile = options.writeFile;
    if (options.reconcileOnStartup !== false) {
      this.reconcileInterrupted();
    }
  }

  get path(): string {
    return this.customPath ?? tasksPath();
  }

  private isRecordActive(record: StoredTaskRecord): boolean {
    return record.status === "running"
      && record.runtime_id === this.runtimeId
      && this.activeTaskIds.has(record.id);
  }

  private isRecordRunning(record: StoredTaskRecord): boolean {
    return this.isRecordActive(record) || (record.status === "running"
      && record.runtime_id !== undefined && record.runtime_pid !== undefined
      && record.runtime_pid !== process.pid && isProcessAlive(record.runtime_pid));
  }

  private readStoreFile(file = this.path): StoredTaskRecord[] {
    if (!existsSync(file)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not load Ya task store from "${file}": ${reason}`, { cause: error });
    }
    if (!isRecord(parsed) || parsed.version !== TASK_STORE_VERSION || !Array.isArray(parsed.tasks)) {
      throw new Error(`Invalid Ya task store format in "${file}". Expected version ${TASK_STORE_VERSION}.`);
    }
    const ids = new Set<string>();
    return parsed.tasks.map((entry) => {
      const record = parseStoredRecord(entry);
      if (ids.has(record.id)) throw new Error(`Duplicate task ID "${record.id}" in task store.`);
      ids.add(record.id);
      return record;
    });
  }

  private writeStoreFile(file: string, tasks: readonly StoredTaskRecord[]): void {
    const envelope: StoredTaskStore = {
      version: TASK_STORE_VERSION,
      tasks: [...tasks],
    };
    const payload = `${JSON.stringify(envelope, null, 2)}\n`;
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      if (this.customWriteFile) {
        this.customWriteFile(temporary, payload);
      } else {
        writeFileSync(temporary, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
      }
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private mutateStore<T>(
    action: (file: string, records: StoredTaskRecord[]) => T,
    file = this.path,
  ): T {
    return withTaskStoreLock(file, () => action(file, this.readStoreFile(file)));
  }

  private interruptStaleRecords(records: readonly StoredTaskRecord[]): { records: StoredTaskRecord[]; changed: boolean } {
    let changed = false;
    const updated = records.map((record): StoredTaskRecord => {
      if (record.status !== "running" || this.isRecordRunning(record)) return record;
      changed = true;
      const timestamp = nextTimestamp(this.now, record.updated_at);
      const { runtime_id: _runtimeId, runtime_pid: _runtimePid, ...rest } = record;
      return {
        ...rest,
        status: "interrupted",
        revision: record.revision + 1,
        updated_at: timestamp,
        ended_at: record.ended_at ?? timestamp,
      };
    });
    return { records: updated, changed };
  }

  /**
   * Classifies records without a live owner as interrupted.
   * Does not start or resume task execution.
   */
  reconcileInterrupted(): TaskRecord[] {
    const file = this.path;
    if (!existsSync(file)) return [];
    return this.mutateStore((path, records) => {
      const { records: updated, changed } = this.interruptStaleRecords(records);
      if (changed) this.writeStoreFile(path, updated);
      return updated
        .filter((record) => record.status === "interrupted")
        .map((record) => toPublicRecord(record, false));
    }, file);
  }

  create(input: CreateTaskInput): TaskRecord {
    assertNoSecretFields(input, "createTask");
    const objective = validateObjective(input.objective);
    const sessionId = validateSessionId(input.sessionId);
    const workspace = input.workspace !== undefined ? validateWorkspaceIdentity(input.workspace) : undefined;
    const options = validateExecutionOptions(
      {
        ...input.options,
        ...(workspace !== undefined && input.options?.local === undefined ? { local: true } : {}),
      },
      input.config,
      workspace !== undefined,
    );
    if (options.local && !workspace) {
      throw new Error("Local workspace tasks require a validated workspace directory.");
    }
    if (!options.local && workspace !== undefined) {
      throw new Error("Non-local tasks cannot specify a workspace directory.");
    }

    return this.mutateStore((file, existing) => {
      if (existing.some((record) => this.isRecordActive(record))) {
        throw new Error("A task is already running.");
      }
      const { records: baseRecords } = this.interruptStaleRecords(existing);
      let id = randomUUID();
      while (baseRecords.some((record) => record.id === id)) {
        id = randomUUID();
      }
      const timestamp = nextTimestamp(this.now);
      const stored: StoredTaskRecord = {
        schema_version: TASK_STORE_VERSION,
        id,
        objective,
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(workspace ? { workspace } : {}),
        options: toStoredOptions(options),
        status: "running",
        revision: 1,
        created_at: timestamp,
        updated_at: timestamp,
        runtime_id: this.runtimeId,
        runtime_pid: process.pid,
      };
      this.writeStoreFile(file, [...baseRecords, stored]);
      this.activeTaskIds.add(id);
      return toPublicRecord(stored, true);
    });
  }

  transition(
    id: string,
    nextStatus: Exclude<TaskStatus, "running">,
    details: TransitionTaskInput = {},
  ): TaskRecord {
    assertNoSecretFields(details, "transitionTask");
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("Task ID is required.");
    }
    return this.mutateStore((file, records) => {
      const index = records.findIndex((candidate) => candidate.id === id);
      if (index < 0) {
        throw new Error(`Task record not found: ${id}`);
      }
      const current = records[index]!;
      if (details.expectedRevision !== undefined) {
        validatePositiveInt(details.expectedRevision, "expectedRevision");
        if (current.revision !== details.expectedRevision) {
          throw new StaleTaskRecordError(
            `Stale task record update for ${id}: expected revision ${details.expectedRevision}, current revision is ${current.revision}.`,
          );
        }
      }
      if (current.status !== "running" || !["completed", "failed", "cancelled", "interrupted"].includes(nextStatus)) {
        throw new TaskTransitionError(
          `Invalid task status transition for ${id}: cannot transition from "${current.status}" to "${nextStatus}".`,
        );
      }
      if (nextStatus !== "interrupted" && !this.isRecordActive(current)) {
        throw new StaleTaskRecordError(
          `Stale task record update for ${id}: task is no longer active in this runtime.`,
        );
      }
      if (details.mode !== undefined && details.mode !== "single" && details.mode !== "toa") {
        throw new Error(`Invalid task mode: ${String(details.mode)}.`);
      }
      if (details.partial !== undefined && typeof details.partial !== "boolean") {
        throw new Error("Invalid task partial flag.");
      }
      if (details.error !== undefined && typeof details.error !== "string") {
        throw new Error("Invalid task error message.");
      }

      const sanitizedError = details.error !== undefined ? redactSecrets(details.error) : undefined;
      const timestamp = nextTimestamp(this.now, current.updated_at);
      const { runtime_id: _runtimeId, runtime_pid: _runtimePid, ...rest } = current;
      const updated: StoredTaskRecord = {
        ...rest,
        status: nextStatus,
        revision: current.revision + 1,
        updated_at: timestamp,
        ended_at: timestamp,
        ...(nextStatus === "completed" ? { completed_at: timestamp } : {}),
        ...(details.mode ? { mode: details.mode } : {}),
        ...(details.partial !== undefined ? { partial: details.partial } : {}),
        ...(sanitizedError !== undefined && sanitizedError.length > 0 ? { error: sanitizedError } : {}),
      };
      const nextRecords = [...records];
      nextRecords[index] = updated;
      this.writeStoreFile(file, nextRecords);
      this.activeTaskIds.delete(id);
      return toPublicRecord(updated, false);
    });
  }

  read(id: string): TaskRecord | undefined {
    return this.get(id);
  }

  get(id: string): TaskRecord | undefined {
    if (typeof id !== "string" || !id.trim()) return undefined;
    const record = this.readStoreFile().find((candidate) => candidate.id === id);
    if (!record) return undefined;
    return toPublicRecord(record, this.isRecordRunning(record));
  }

  list(options: ListTasksOptions = {}): TaskRecord[] {
    const allowedStatuses = options.status === undefined
      ? undefined
      : Array.isArray(options.status)
        ? new Set<TaskStatus>(options.status)
        : new Set<TaskStatus>([options.status as TaskStatus]);
    let normalizedWorkspace: string | undefined;
    if (options.workspace !== undefined) {
      try {
        normalizedWorkspace = validateWorkspaceIdentity(options.workspace);
      } catch {
        normalizedWorkspace = resolve(expandHome(options.workspace));
      }
    }
    const records = this.readStoreFile().map((record) =>
      toPublicRecord(record, this.isRecordRunning(record)),
    );
    return records.filter((record) => {
      if (allowedStatuses && !allowedStatuses.has(record.status)) return false;
      if (options.sessionId !== undefined && record.sessionId !== options.sessionId) return false;
      if (options.workspace !== undefined && record.workspace !== options.workspace && record.workspace !== normalizedWorkspace) {
        return false;
      }
      return true;
    });
  }
}
