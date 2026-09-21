import {
  buildIcmInstruction,
  buildIcmSupplement,
  buildSynthesisInstruction,
  buildTaskMessages,
  corePrompt,
  icmFollowUpNeeded as nativeIcmFollowUpNeeded,
  localPrompt,
  shouldUseWeb as nativeShouldUseWeb,
  singleAgentBudget,
  toaAgentBudget,
  webRequiredInstruction,
  workerPrompt,
} from "ya-core";
import { LOCAL_TOOLS, LocalWorkspace } from "./local";
import { assertImageInputSupported, ModelConfig } from "./config";
import type { ModelReply } from "./deepseek";
import { assertImageCount } from "./images";
import { relevantContext } from "./memory";
import type { ChatMessage, TokenUsage, ToolDefinition, ToolHandler, UserImageContentPart, WebMode } from "./types";
import { search, WEB_SEARCH_TOOL } from "./web";

/** The prompt texts live in the Rust core so both front ends share one copy. */
export const CORE_PROMPT = corePrompt();
export const LOCAL_PROMPT = localPrompt();

export interface RunResult {
  content: string;
  mode: "single" | "toa";
  usage: TokenUsage;
  partial?: boolean;
}

export interface AgentClient {
  completeStream(
    messages: ChatMessage[],
    config: ModelConfig,
    maxTokens: number,
    onContent: (content: string) => void,
  ): Promise<ModelReply>;
  runWithTools(
    messages: ChatMessage[],
    config: ModelConfig,
    maxTokens: number,
    tools?: ToolDefinition[],
    handlers?: Record<string, ToolHandler>,
  ): Promise<ModelReply>;
}

/**
 * Builds the system and user messages for one task. The prompt contract lives
 * in the Rust core; approved memory is selected here because it reads storage.
 */
export function messagesForTask(
  task: string,
  extraInstruction = "",
  localEnabled = false,
  images: UserImageContentPart[] = [],
): ChatMessage[] {
  return JSON.parse(buildTaskMessages(
    task,
    relevantContext(task),
    extraInstruction,
    localEnabled,
    JSON.stringify(images),
  )) as ChatMessage[];
}

export function shouldUseWeb(task: string, webMode: WebMode): boolean {
  return nativeShouldUseWeb(task, webMode);
}

async function runAgent(
  client: AgentClient,
  task: string,
  config: ModelConfig,
  maxTokens: number,
  instruction = "",
  webMode: WebMode = "auto",
  localWorkspace?: LocalWorkspace,
  webSearch: ToolHandler = search,
  images: UserImageContentPart[] = [],
): Promise<ModelReply> {
  const useWeb = shouldUseWeb(task, webMode);
  const completeInstruction = webRequiredInstruction(instruction, webMode);
  const tools: ToolDefinition[] = [];
  const handlers: Record<string, ToolHandler> = {};
  if (useWeb) {
    tools.push(WEB_SEARCH_TOOL);
    handlers.web_search = webSearch;
  }
  if (localWorkspace) {
    tools.push(...LOCAL_TOOLS);
    Object.assign(handlers, localWorkspace.toolHandlers);
  }
  return client.runWithTools(
    messagesForTask(task, completeInstruction, Boolean(localWorkspace), images),
    config,
    maxTokens,
    tools.length > 0 ? tools : undefined,
    handlers,
  );
}

export async function singleAgent(
  client: AgentClient,
  task: string,
  config: ModelConfig,
  webMode: WebMode = "auto",
  onContent?: (content: string) => void,
  localWorkspace?: LocalWorkspace,
  webSearch: ToolHandler = search,
  images: UserImageContentPart[] = [],
): Promise<RunResult> {
  assertImageCount(images.length);
  assertImageInputSupported(config.model, images.length);
  const { reserve, maxTokens } = singleAgentBudget(config.toaTokenBudget);
  if (onContent && !localWorkspace && !shouldUseWeb(task, webMode)) {
    const reply = await client.completeStream(messagesForTask(task, "", false, images), config, maxTokens, onContent);
    return { content: reply.content, mode: "single", usage: reply.usage };
  }
  const reply = await runAgent(client, task, config, maxTokens, "", webMode, localWorkspace, webSearch, images);
  return applyIcm(client, task, config, { content: reply.content, mode: "single", usage: reply.usage }, reserve, webSearch, images);
}

export async function toaAgent(
  client: AgentClient,
  task: string,
  config: ModelConfig,
  workers: number,
  webSearch: ToolHandler = search,
  images: UserImageContentPart[] = [],
): Promise<RunResult> {
  if (workers !== 1 && workers !== 2) throw new Error("ToA workers must be 1 or 2.");
  assertImageCount(images.length);
  assertImageInputSupported(config.model, images.length);
  const roles = (["evidence", "risk"] as const).slice(0, workers);
  const { icmReserve, allocation, synthesisBudget } = toaAgentBudget(config.toaTokenBudget, workers);
  const packets: Array<{ role: string; content: string; usage: TokenUsage }> = [];
  const failures: string[] = [];

  await Promise.all(roles.map(async (role) => {
    try {
      const reply = await withTimeout(
        runAgent(client, task, config, allocation, workerPrompt(role), "on", undefined, webSearch, images),
        config.toaTimeout * 1_000,
      );
      packets.push({ role, content: reply.content, usage: reply.usage });
    } catch (error) {
      failures.push(`${role}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));

  const synthesis = buildSynthesisInstruction(JSON.stringify(packets));
  const reply = await runAgent(client, task, config, synthesisBudget, synthesis, "on", undefined, webSearch, images);
  const usage: TokenUsage = { ...reply.usage, worker_count: workers };
  return applyIcm(
    client,
    task,
    config,
    { content: reply.content, mode: "toa", usage, partial: failures.length > 0 },
    icmReserve,
    webSearch,
    images,
  );
}

export function icmFollowUpNeeded(content: string): boolean {
  return nativeIcmFollowUpNeeded(content);
}

async function applyIcm(
  client: AgentClient,
  task: string,
  config: ModelConfig,
  result: RunResult,
  reserve: number,
  webSearch: ToolHandler,
  images: UserImageContentPart[],
): Promise<RunResult> {
  if (!icmFollowUpNeeded(result.content)) return result;
  const reply = await runAgent(
    client,
    task,
    config,
    reserve,
    buildIcmInstruction(result.content),
    "on",
    undefined,
    webSearch,
    images,
  );
  return {
    ...result,
    content: buildIcmSupplement(result.content, reply.content),
    usage: { ...result.usage, icm_follow_up: reply.usage },
  };
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
