import type {
  ChatMessage,
  TokenUsage,
  ToolArguments,
  ToolCall,
  ToolDefinition,
  ToolHandler,
} from "./types";
import { assertImageInputSupported, ModelConfig } from "./config";
import { assertImageCount } from "./images";
import { abortable, delay as waitDelay } from "./cancellation";

export const API_URL = "https://api.deepseek.com/chat/completions";
export const MAX_TOOL_CALL_ROUNDS = 6;
export const MAX_CODING_TOOL_CALL_ROUNDS = 20;
export const MAX_REQUEST_ATTEMPTS = 3;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type Sleep = (milliseconds: number) => Promise<void>;

const defaultSleep: Sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class DeepSeekError extends Error {
  override readonly name = "DeepSeekError";

  constructor(message: string, readonly status?: number, readonly retryAfterMs?: number, options?: ErrorOptions) {
    super(message, options);
  }
}

class NetworkError extends DeepSeekError {}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) {
    const milliseconds = Number(trimmed) * 1_000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  // Only HTTP dates, not negative numbers or other Date.parse shortcuts.
  if (!/^[A-Za-z]/u.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

async function readNetwork<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new NetworkError(`DeepSeek API request failed: ${error instanceof Error ? error.message : String(error)}`,
      undefined, undefined, { cause: error });
  }
}

export interface ModelReply {
  content: string;
  reasoningContent?: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  assistantMessage: ChatMessage;
}

interface DeepSeekPayload {
  model: string;
  messages: ChatMessage[];
  thinking: { type: "enabled" | "disabled" };
  stream: boolean;
  max_tokens: number;
  reasoning_effort?: string;
  tools?: ToolDefinition[];
  stream_options?: { include_usage: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageFromBody(body: unknown): ChatMessage {
  if (!isRecord(body) || !Array.isArray(body.choices) || !isRecord(body.choices[0]) || !isRecord(body.choices[0].message)) {
    throw new DeepSeekError(`Unexpected DeepSeek response: ${JSON.stringify(body)}`);
  }
  return body.choices[0].message as ChatMessage;
}

function usageFromBody(body: unknown): TokenUsage {
  return isRecord(body) && isRecord(body.usage) ? body.usage : {};
}

function replyFromBody(body: unknown): ModelReply {
  const message = messageFromBody(body);
  return {
    content: typeof message.content === "string" ? message.content : "",
    ...(typeof message.reasoning_content === "string" ? { reasoningContent: message.reasoning_content } : {}),
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    usage: usageFromBody(body),
    assistantMessage: message,
  };
}

function validateImageMessages(messages: ChatMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    const messageImageCount = message.content.filter((part) => part.type === "image_url" || part.type === "file").length;
    if (messageImageCount > 0 && message.role !== "user") {
      throw new Error("DeepSeek image content is supported only in user messages.");
    }
    count += messageImageCount;
  }
  assertImageCount(count);
  return count;
}

export class DeepSeekClient {
  readonly apiKey: string;
  private readonly fetcher: FetchLike;
  private readonly sleep: Sleep;

  constructor(apiKey: string, fetcher: FetchLike = fetch, sleep: Sleep = defaultSleep, private readonly signal?: AbortSignal) {
    this.apiKey = apiKey;
    this.fetcher = fetcher;
    this.sleep = sleep;
  }

  payload(
    messages: ChatMessage[],
    config: ModelConfig,
    maxTokens: number,
    tools: ToolDefinition[] | undefined,
    stream: boolean,
  ): DeepSeekPayload {
    assertImageInputSupported(config.model, validateImageMessages(messages));
    const payload: DeepSeekPayload = {
      model: config.model,
      messages,
      thinking: { type: config.thinkingEnabled ? "enabled" : "disabled" },
      stream,
      max_tokens: maxTokens,
    };
    if (config.thinkingEnabled) payload.reasoning_effort = config.reasoningEffort;
    if (tools && tools.length > 0) payload.tools = tools;
    if (stream) payload.stream_options = { include_usage: true };
    return payload;
  }

  private async requestOnce(payload: DeepSeekPayload, timeoutSeconds: number): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutSeconds * 1_000);
    return readNetwork(() => abortable(this.fetcher(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: this.signal ? AbortSignal.any([timeout, this.signal]) : timeout,
    }), this.signal));
  }

  private async httpError(response: Response): Promise<DeepSeekError> {
    // A broken error body must not discard the status (e.g. turn a 401 into a retry).
    const detail = await abortable(response.text(), this.signal).catch(() => response.statusText);
    return new DeepSeekError(`DeepSeek API returned HTTP ${response.status}: ${detail}`,
      response.status, retryAfterMilliseconds(response.headers.get("Retry-After")));
  }

  private async request(payload: DeepSeekPayload, timeoutSeconds: number): Promise<Response> {
    const response = await this.requestOnce(payload, timeoutSeconds);
    if (!response.ok) throw await this.httpError(response);
    return response;
  }

  private async withRetry<T>(operation: (markDelivered: () => void) => Promise<T>): Promise<T> {
    let delivered = false;
    for (let attempt = 0; ; attempt += 1) {
      this.signal?.throwIfAborted();
      try {
        const result = await operation(() => { delivered = true; });
        this.signal?.throwIfAborted();
        return result;
      } catch (error) {
        this.signal?.throwIfAborted();
        const retryable = error instanceof NetworkError || error instanceof DeepSeekError &&
          (error.status === 429 || error.status !== undefined && error.status >= 500 && error.status < 600);
        if (delivered || !retryable || attempt >= MAX_REQUEST_ATTEMPTS - 1) throw error;
        let delay = Math.max(500 * 2 ** attempt, (error as DeepSeekError).retryAfterMs ?? 0);
        // Node timers overflow above a signed 32-bit millisecond delay.
        while (delay > 0) {
          const interval = Math.min(delay, 2_147_483_647);
          await (this.sleep === defaultSleep ? waitDelay(interval, this.signal) : abortable(this.sleep(interval), this.signal));
          delay -= interval;
        }
      }
    }
  }

  async complete(
    messages: ChatMessage[],
    config: ModelConfig,
    maxTokens: number,
    tools?: ToolDefinition[],
  ): Promise<ModelReply> {
    config.validate();
    const payload = this.payload(messages, config, maxTokens, tools, false);
    return this.withRetry(async () => {
      const response = await this.request(payload, config.toaTimeout);
      const body = JSON.parse(await readNetwork(() => abortable(response.text(), this.signal))) as unknown;
      return replyFromBody(body);
    });
  }

  async completeStream(
    messages: ChatMessage[],
    config: ModelConfig,
    maxTokens: number,
    onContent: (content: string) => void,
  ): Promise<ModelReply> {
    config.validate();
    const payload = this.payload(messages, config, maxTokens, undefined, true);
    return this.withRetry(async (markDelivered) => {
      const content: string[] = [];
      const reasoning: string[] = [];
      const usage: TokenUsage = {};
      const response = await this.request(payload, config.toaTimeout);
      const done = await readServerSentEvents(response, (data) => {
        if (data === "[DONE]") return true;
        let chunk: unknown;
        try {
          chunk = JSON.parse(data) as unknown;
        } catch (error) {
          throw new DeepSeekError(`Invalid streaming chunk: ${error instanceof Error ? error.message : String(error)}`,
            undefined, undefined, { cause: error });
        }
        if (!isRecord(chunk)) return false;
        if (isRecord(chunk.usage)) Object.assign(usage, chunk.usage);
        const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
        const first = isRecord(choices[0]) ? choices[0] : undefined;
        const delta = first && isRecord(first.delta) ? first.delta : undefined;
        if (delta && typeof delta.reasoning_content === "string") reasoning.push(delta.reasoning_content);
        if (delta && typeof delta.content === "string") {
          content.push(delta.content);
          markDelivered();
          onContent(delta.content);
        }
        return false;
      }, this.signal);
      void done;
      const joinedContent = content.join("");
      const joinedReasoning = reasoning.join("");
      return {
        content: joinedContent,
        ...(joinedReasoning ? { reasoningContent: joinedReasoning } : {}),
        toolCalls: [],
        usage,
        assistantMessage: { role: "assistant", content: joinedContent },
      };
    });
  }

  async runWithTools(
    messages: ChatMessage[],
    config: ModelConfig,
    maxTokens: number,
    tools?: ToolDefinition[],
    toolHandlers: Record<string, ToolHandler> = {},
    maxRounds = MAX_TOOL_CALL_ROUNDS,
  ): Promise<ModelReply> {
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 40) throw new Error("Tool rounds must be an integer from 1 to 40.");
    const transientMessages = [...messages];
    for (let round = 0; round <= maxRounds; round += 1) {
      const reply = await this.complete(transientMessages, config, maxTokens, tools);
      if (reply.toolCalls.length === 0) return reply;
      if (round === maxRounds) break;
      transientMessages.push(reply.assistantMessage);
      for (const call of reply.toolCalls) {
        this.signal?.throwIfAborted();
        let result: string;
        const handler = toolHandlers[call.function.name];
        if (!handler) {
          result = JSON.stringify({ error: `Tool '${call.function.name}' is not available.` });
        } else {
          try {
            const parsed = JSON.parse(call.function.arguments || "{}") as unknown;
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
              throw new Error("Tool arguments must be a JSON object.");
            }
            result = await handler(parsed as ToolArguments);
            this.signal?.throwIfAborted();
          } catch (error) {
            this.signal?.throwIfAborted();
            result = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
          }
        }
        transientMessages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
    transientMessages.push({
      role: "user",
      content: "The tool-call budget is exhausted. Return the best final answer to the original request now without using any tools. Be concise and state uncertainty when needed.",
    });
    const reply = await this.complete(transientMessages, config, maxTokens);
    if (reply.toolCalls.length === 0) return reply;
    throw new DeepSeekError(`Tool-call limit (${maxRounds} rounds) reached before a final answer.`);
  }
}

async function readServerSentEvents(response: Response, onData: (data: string) => boolean, signal?: AbortSignal): Promise<boolean> {
  if (!response.body) throw new DeepSeekError("DeepSeek streaming response had no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await readNetwork(() => abortable(reader.read(), signal));
      pending += decoder.decode(value, { stream: !done });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const rawLine = pending.slice(0, newline).replace(/\r$/u, "").trim();
        pending = pending.slice(newline + 1);
        if (rawLine.startsWith("data:")) {
          const data = rawLine.slice(5).trim();
          if (data && onData(data)) return true;
        }
        newline = pending.indexOf("\n");
      }
      if (done) break;
    }
    const finalLine = pending.trim();
    return finalLine.startsWith("data:") && onData(finalLine.slice(5).trim());
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
