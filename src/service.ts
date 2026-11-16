import { assertImageInputSupported, ModelConfig } from "./config";
import { DeepSeekClient } from "./deepseek";
import { assertImageCount } from "./images";
import { LocalWorkspace } from "./local";
import { singleAgent, toaAgent, type RunResult } from "./orchestrator";
import {
  ACTIVE_TASK_STATUSES,
  StaleTaskRecordError,
  TASK_STATUSES,
  TASK_STORE_VERSION,
  TERMINAL_TASK_STATUSES,
  TaskStore,
  TaskTransitionError,
  redactSecrets,
  tasksPath,
  validateWorkspaceIdentity,
  type CreateTaskInput,
  type ListTasksOptions,
  type TaskExecutionOptions,
  type TaskRecord,
  type TaskStatus,
  type TaskStoreOptions,
  type TransitionTaskInput,
} from "./tasks";
import type { ConversationMessage, ToolHandler, UserImageContentPart, WebMode } from "./types";
import { search } from "./web";
import type { DeepSeekCredential } from "./credentials";

export {
  ACTIVE_TASK_STATUSES,
  StaleTaskRecordError,
  TASK_STATUSES,
  TASK_STORE_VERSION,
  TERMINAL_TASK_STATUSES,
  TaskStore,
  TaskTransitionError,
  redactSecrets,
  tasksPath,
  validateWorkspaceIdentity,
};
export type {
  CreateTaskInput,
  ListTasksOptions,
  TaskExecutionOptions,
  TaskRecord,
  TaskStatus,
  TaskStoreOptions,
  TransitionTaskInput,
};

export interface RunTaskOptions {
  sessionId?: string;
  history?: ConversationMessage[];
  webMode?: WebMode;
  toa?: boolean;
  toaWorkers?: number;
  onContent?: (content: string) => void;
  localWorkspace?: LocalWorkspace;
  clientFactory?: (apiKey: DeepSeekCredential, signal?: AbortSignal) => DeepSeekClient;
  webSearch?: ToolHandler;
  images?: UserImageContentPart[];
  signal?: AbortSignal;
  taskStore?: TaskStore;
  onTaskCreated?: (record: TaskRecord) => void;
}

const defaultStores = new Map<string, TaskStore>();

function defaultTaskStore(): TaskStore {
  const path = tasksPath();
  let store = defaultStores.get(path);
  if (!store) {
    store = new TaskStore({ path });
    defaultStores.set(path, store);
  }
  return store;
}

export function openTaskStore(options: TaskStoreOptions = {}): TaskStore {
  const store = new TaskStore(options);
  if (!options.path) {
    defaultStores.set(store.path, store);
  }
  return store;
}

export function readTask(id: string, store: TaskStore = defaultTaskStore()): TaskRecord | undefined {
  return store.get(id);
}

export function getTask(id: string, store: TaskStore = defaultTaskStore()): TaskRecord | undefined {
  return store.get(id);
}

export function listTasks(options: ListTasksOptions = {}, store: TaskStore = defaultTaskStore()): TaskRecord[] {
  return store.list(options);
}

export function reconcileInterruptedTasks(store: TaskStore = defaultTaskStore()): TaskRecord[] {
  return store.reconcileInterrupted();
}

export async function runTask(
  apiKey: DeepSeekCredential,
  task: string,
  config: ModelConfig,
  options: RunTaskOptions = {},
): Promise<RunResult> {
  options.signal?.throwIfAborted();
  if (options.toa && options.localWorkspace) throw new Error("Local workspace mode cannot be used with Tree of Agents.");
  config.validate();
  const images = options.images ?? [];
  const history = options.history ?? [];
  const toa = Boolean(options.toa);
  const toaWorkers = options.toaWorkers ?? 2;
  if (toa && toaWorkers !== 1 && toaWorkers !== 2) throw new Error("ToA workers must be 1 or 2.");
  assertImageCount(images.length);
  assertImageInputSupported(config.model, images.length);

  const localWorkspace = options.localWorkspace?.withSignal(options.signal);
  const store = options.taskStore ?? defaultTaskStore();
  const record = store.create({
    objective: task,
    sessionId: options.sessionId,
    workspace: localWorkspace?.root,
    config,
    options: {
      model: config.model,
      thinkingEnabled: config.thinkingEnabled,
      reasoningEffort: config.reasoningEffort,
      webMode: options.webMode ?? "auto",
      toa,
      toaWorkers: toaWorkers === 1 ? 1 : 2,
      toaTokenBudget: config.toaTokenBudget,
      toaTimeout: config.toaTimeout,
      local: Boolean(localWorkspace),
      commandsEnabled: Boolean(localWorkspace?.commandsEnabled),
      stream: Boolean(options.onContent),
      imageCount: images.length,
      historyLength: history.length,
    },
  });
  options.onTaskCreated?.(record);

  try {
    options.signal?.throwIfAborted();
    const client = options.clientFactory?.(apiKey, options.signal) ?? new DeepSeekClient(apiKey, undefined, undefined, options.signal);
    const webSearch: ToolHandler = options.webSearch ?? ((arguments_, signal) => search(arguments_, undefined, undefined, signal ?? options.signal));
    const result = toa
      ? await toaAgent(client, task, config, toaWorkers, webSearch, images, history, options.signal)
      : await singleAgent(
          client,
          task,
          config,
          options.webMode ?? "auto",
          options.onContent,
          localWorkspace,
          webSearch,
          images,
          history,
        );
    options.signal?.throwIfAborted();
    store.transition(record.id, "completed", {
      expectedRevision: record.revision,
      mode: result.mode,
      partial: Boolean(result.partial),
    });
    return { ...result, taskId: record.id };
  } catch (error) {
    const terminalStatus = options.signal?.aborted ? "cancelled" : "failed";
    const rawMessage = error instanceof Error ? error.message : String(error);
    try {
      store.transition(record.id, terminalStatus, {
        expectedRevision: record.revision,
        error: redactSecrets(rawMessage, apiKey),
      });
    } catch (transitionError) {
      if (!(transitionError instanceof StaleTaskRecordError) && !(transitionError instanceof TaskTransitionError)) {
        throw transitionError;
      }
    }
    throw error;
  }
}
