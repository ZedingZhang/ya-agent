import {
  SseReader,
  buildChatPayload,
  parseModelReply,
  parseStreamChunk,
} from "ya-core";
import type {
  ChatMessage,
  TokenUsage,
  ToolArguments,
  ToolCall,
  ToolDefinition,
  ToolHandler,
} from "./types";
import { ModelConfig } from "./config";

export const API_URL = "https://api.deepseek.com/chat/completions";
export const MAX_TOOL_CALL_ROUNDS = 6;
export const MAX_REQUEST_ATTEMPTS = 3;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type Sleep = (milliseconds: number) => Promise<void>;

const defaultSleep: Sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class DeepSeekError extends Error {
  override readonly name = "DeepSeekError";
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

export class DeepSeekClient {
  readonly apiKey: string;
  private readonly fetcher: FetchLike;
  private readonly sleep: Sleep;

  constructor(apiKey: string, fetcher: FetchLike = fetch, sleep: Sleep = defaultSleep) {
    this.apiKey = apiKey;
    this.fetcher = fetcher;
    this.sleep = sleep;
  }

  /**
   * Builds the chat-completions body.
   *
   * The shape, the image role rule, and the per-request image limit live in the
   * Rust core; this only marshals the arguments across the boundary.
   */
  payload(
    messages: ChatMessage[],
    config: ModelConfig,
    maxTokens: number,
    tools: ToolDefinition[] | undefined,
    stream: boolean,
  ): DeepSeekPayload {
    return JSON.parse(buildChatPayload(
      JSON.stringify(messages),
      config.model,
      config.thinkingEnabled,
      config.reasoningEffort,
      maxTokens,
      tools === undefined ? undefined : JSON.stringify(tools),
      stream,
    )) as DeepSeekPayload;
  }

  private async requestOnce(payload: DeepSeekPayload, timeoutSeconds: number): Promise<Response> {
    return this.fetcher(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutSeconds * 1_000),
    });
  }

  private async httpError(response: Response): Promise<DeepSeekError> {
    const detail = await response.text();
    return new DeepSeekError(`DeepSeek API returned HTTP ${response.status}: ${detail}`);
  }

  private networkError(error: unknown): DeepSeekError {
    return new DeepSeekError(`DeepSeek API request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  private async request(payload: DeepSeekPayload, timeoutSeconds: number): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.requestOnce(payload, timeoutSeconds);
        if (response.ok) return response;
        const error = await this.httpError(response);
        if (response.status < 500 || attempt === MAX_REQUEST_ATTEMPTS - 1) throw error;
        lastError = error;
      } catch (error) {
        if (error instanceof DeepSeekError && (error.message.includes("HTTP 4") || attempt === MAX_REQUEST_ATTEMPTS - 1)) throw error;
        lastError = error;
        if (attempt === MAX_REQUEST_ATTEMPTS - 1) throw this.networkError(error);
      }
      await this.sleep(500 * (attempt + 1));
    }
    throw this.networkError(lastError);
  }

  async complete(
    messages: ChatMessage[],
    config: ModelConfig,
    maxTokens: number,
    tools?: ToolDefinition[],
  ): Promise<ModelReply> {
    config.validate();
    const response = await this.request(this.payload(messages, config, maxTokens, tools, false), config.toaTimeout);
    // Parsing the body here keeps a non-JSON response failing exactly where it
    // did before; the Rust core receives the same re-serialised JSON that the
    // TypeScript original embedded in its error message.
    const body = await response.json() as unknown;
    return JSON.parse(parseModelReply(JSON.stringify(body))) as ModelReply;
  }

  async completeStream(
    messages: ChatMessage[],
    config: ModelConfig,
    maxTokens: number,
    onContent: (content: string) => void,
  ): Promise<ModelReply> {
    config.validate();
    const payload = this.payload(messages, config, maxTokens, undefined, true);
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
      const content: string[] = [];
      const reasoning: string[] = [];
      const usage: TokenUsage = {};
      try {
        const response = await this.requestOnce(payload, config.toaTimeout);
        if (!response.ok) {
          const error = await this.httpError(response);
          if (response.status < 500 || attempt === MAX_REQUEST_ATTEMPTS - 1) throw error;
          lastError = error;
          await this.sleep(500 * (attempt + 1));
          continue;
        }
        const done = await readServerSentEvents(response, (data) => {
          const chunk = parseStreamChunk(data);
          if (chunk.done) return true;
          if (chunk.usageJson) Object.assign(usage, JSON.parse(chunk.usageJson) as TokenUsage);
          if (chunk.reasoningContent != null) reasoning.push(chunk.reasoningContent);
          if (chunk.content != null) {
            content.push(chunk.content);
            onContent(chunk.content);
          }
          return false;
        });
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
      } catch (error) {
        lastError = error;
        if (content.length > 0 || attempt === MAX_REQUEST_ATTEMPTS - 1 || error instanceof DeepSeekError && error.message.includes("HTTP 4")) {
          throw error instanceof DeepSeekError ? error : this.networkError(error);
        }
        await this.sleep(500 * (attempt + 1));
      }
    }
    throw this.networkError(lastError);
  }

  async runWithTools(
    messages: ChatMessage[],
    config: ModelConfig,
    maxTokens: number,
    tools?: ToolDefinition[],
    toolHandlers: Record<string, ToolHandler> = {},
  ): Promise<ModelReply> {
    const transientMessages = [...messages];
    for (let round = 0; round <= MAX_TOOL_CALL_ROUNDS; round += 1) {
      const reply = await this.complete(transientMessages, config, maxTokens, tools);
      if (reply.toolCalls.length === 0) return reply;
      if (round === MAX_TOOL_CALL_ROUNDS) break;
      transientMessages.push(reply.assistantMessage);
      for (const call of reply.toolCalls) {
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
          } catch (error) {
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
    throw new DeepSeekError(`Tool-call limit (${MAX_TOOL_CALL_ROUNDS} rounds) reached before a final answer.`);
  }
}

/**
 * Reads the event stream, with the framing and the incremental UTF-8 decoding
 * handled by the Rust core so a multi-byte character split across two chunks
 * stays intact.
 */
async function readServerSentEvents(response: Response, onData: (data: string) => boolean): Promise<boolean> {
  if (!response.body) throw new DeepSeekError("DeepSeek streaming response had no body.");
  const reader = response.body.getReader();
  const frames = new SseReader();
  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      for (const data of frames.push(Buffer.from(value))) {
        if (onData(data)) {
          await reader.cancel();
          return true;
        }
      }
    }
    if (done) break;
  }
  const trailing = frames.finish();
  return trailing !== null && onData(trailing);
}
