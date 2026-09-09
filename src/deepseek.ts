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

  constructor(apiKey: string, fetcher: FetchLike = fetch, sleep: Sleep = defaultSleep) {
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
    return replyFromBody(await response.json() as unknown);
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
          if (data === "[DONE]") return true;
          const chunk = JSON.parse(data) as unknown;
          if (!isRecord(chunk)) return false;
          if (isRecord(chunk.usage)) Object.assign(usage, chunk.usage);
          const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
          const first = isRecord(choices[0]) ? choices[0] : undefined;
          const delta = first && isRecord(first.delta) ? first.delta : undefined;
          if (delta && typeof delta.reasoning_content === "string") reasoning.push(delta.reasoning_content);
          if (delta && typeof delta.content === "string") {
            content.push(delta.content);
            onContent(delta.content);
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
            if (!isRecord(parsed)) throw new Error("Tool arguments must be a JSON object.");
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

async function readServerSentEvents(response: Response, onData: (data: string) => boolean): Promise<boolean> {
  if (!response.body) throw new DeepSeekError("DeepSeek streaming response had no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const rawLine = pending.slice(0, newline).replace(/\r$/u, "").trim();
      pending = pending.slice(newline + 1);
      if (rawLine.startsWith("data:")) {
        const data = rawLine.slice(5).trim();
        if (data && onData(data)) {
          await reader.cancel();
          return true;
        }
      }
      newline = pending.indexOf("\n");
    }
    if (done) break;
  }
  const finalLine = pending.trim();
  return finalLine.startsWith("data:") && onData(finalLine.slice(5).trim());
}
