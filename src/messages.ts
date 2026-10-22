import type { DeepSeekPayload, ModelReply } from "./deepseek";
import type { ChatMessage, TokenUsage, ToolCall } from "./types";

export const ACCOUNT_API_URL = "https://api.deepseek.com/anthropic/v1/messages";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentBlocks(message: ChatMessage): Record<string, unknown>[] {
  if (message.role === "assistant" && Array.isArray(message.account_content)) {
    return message.account_content as Record<string, unknown>[];
  }
  if (message.role === "tool") {
    return [{ type: "tool_result", tool_use_id: message.tool_call_id, content: message.content ?? "" }];
  }
  const blocks: Record<string, unknown>[] = [];
  if (message.role === "assistant" && message.reasoning_content) {
    blocks.push({ type: "thinking", thinking: message.reasoning_content });
  }
  if (typeof message.content === "string" && message.content) blocks.push({ type: "text", text: message.content });
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === "text") { if (part.text) blocks.push({ type: "text", text: part.text }); }
      else if (part.type === "file") blocks.push({ type: "image", source: { type: "file", file_id: part.file_id } });
      else {
        const data = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/u.exec(part.image_url.url);
        blocks.push({ type: "image", source: data
          ? { type: "base64", media_type: data[1], data: data[2] }
          : { type: "url", url: part.image_url.url } });
      }
    }
  }
  for (const call of message.tool_calls ?? []) {
    const input: unknown = JSON.parse(call.function.arguments || "{}");
    if (!isRecord(input)) throw new Error("DeepSeek tool arguments must be a JSON object.");
    blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input });
  }
  return blocks;
}

/** Keep the shared agent loop while translating account requests to the supported Messages API. */
export function messagesPayload(payload: DeepSeekPayload): Record<string, unknown> {
  const messages: Array<{ role: string; content: Record<string, unknown>[] }> = [];
  const system: Record<string, unknown>[] = [];
  for (const message of payload.messages) {
    const content = contentBlocks(message);
    if (message.role === "system") { system.push(...content); continue; }
    if (!content.length) continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content: [...content] });
  }
  return {
    model: payload.model, messages, max_tokens: payload.max_tokens, stream: payload.stream, thinking: payload.thinking,
    ...(system.length ? { system } : {}),
    ...(payload.reasoning_effort ? { output_config: { effort: payload.reasoning_effort } } : {}),
    ...(payload.tools?.length ? { tools: payload.tools.map(({ function: tool }) => ({
      name: tool.name, description: tool.description, input_schema: tool.parameters,
    })) } : {}),
  };
}

export function messagesReply(body: unknown): ModelReply {
  if (!isRecord(body) || !Array.isArray(body.content) || !body.content.every(isRecord)) {
    throw new Error("Unexpected DeepSeek account response.");
  }
  const blocks = body.content as Record<string, unknown>[];
  const content = blocks.filter((block) => block.type === "text").map((block) => typeof block.text === "string" ? block.text : "").join("");
  const reasoning = blocks.filter((block) => block.type === "thinking").map((block) => typeof block.thinking === "string" ? block.thinking : "").join("");
  const toolCalls: ToolCall[] = blocks.filter((block) => block.type === "tool_use").map((block) => {
    if (typeof block.id !== "string" || typeof block.name !== "string" || !isRecord(block.input)) {
      throw new Error("Invalid DeepSeek account tool call.");
    }
    return { id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input) } };
  });
  const usage: TokenUsage = isRecord(body.usage) ? body.usage : {};
  return {
    content, ...(reasoning ? { reasoningContent: reasoning } : {}), toolCalls, usage,
    assistantMessage: { role: "assistant", content, account_content: blocks,
      ...(reasoning ? { reasoning_content: reasoning } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
  };
}
