import { describe, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/config";
import {
  DeepSeekClient,
  DeepSeekError,
  MAX_TOOL_CALL_ROUNDS,
  type FetchLike,
} from "../src/deepseek";
import type { ToolCall } from "../src/types";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function payloadFrom(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("DeepSeek client", () => {
  it("sends explicit thinking settings and reasoning effort", async () => {
    let seen: Record<string, unknown> = {};
    const fetcher: FetchLike = async (_url, init) => {
      seen = payloadFrom(init);
      return jsonResponse({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    };
    const reply = await new DeepSeekClient("test-key", fetcher).complete(
      [{ role: "user", content: "hello" }],
      new ModelConfig({ thinkingEnabled: true }),
      100,
    );
    expect(reply.content).toBe("ok");
    expect(seen).toMatchObject({
      model: "deepseek-v4.1-flash",
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      max_tokens: 100,
      stream: false,
    });
  });

  it("omits reasoning effort when thinking is disabled", async () => {
    let seen: Record<string, unknown> = {};
    const fetcher: FetchLike = async (_url, init) => {
      seen = payloadFrom(init);
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    };
    await new DeepSeekClient("test-key", fetcher).complete([], new ModelConfig(), 100);
    expect(seen.thinking).toEqual({ type: "disabled" });
    expect(seen).not.toHaveProperty("reasoning_effort");
  });

  it("preserves vision content blocks in an OpenAI-compatible request", async () => {
    let seen: Record<string, unknown> = {};
    const fetcher: FetchLike = async (_url, init) => {
      seen = payloadFrom(init);
      return jsonResponse({ choices: [{ message: { content: "a chart" } }] });
    };
    const messages = [{
      role: "user" as const,
      content: [
        { type: "text" as const, text: "What is shown?" },
        { type: "image_url" as const, image_url: { url: "https://example.com/chart.png", detail: "original" as const } },
        { type: "file" as const, file_id: "file-api-example" },
      ],
    }];
    await new DeepSeekClient("key", fetcher).complete(
      messages,
      new ModelConfig({ model: "deepseek-v4.1-flash" }),
      100,
    );
    expect(seen).toMatchObject({ model: "deepseek-v4.1-flash", messages });
  });

  it("rejects vision content before sending it to a text-only model", async () => {
    const fetcher = vi.fn<FetchLike>();
    await expect(new DeepSeekClient("key", fetcher).complete(
      [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/chart.png" } }] }],
      new ModelConfig({ model: "deepseek-v4-pro-0813" }),
      100,
    )).rejects.toThrow(/deepseek-v4\.1-flash/u);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects images outside user messages before sending a request", async () => {
    const fetcher = vi.fn<FetchLike>();
    await expect(new DeepSeekClient("key", fetcher).complete(
      [{ role: "system", content: [{ type: "image_url", image_url: { url: "https://example.com/chart.png" } }] }],
      new ModelConfig({ model: "deepseek-v4.1-flash" }),
      100,
    )).rejects.toThrow(/only in user messages/u);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows six tool rounds before the final response", async () => {
    const toolCall: ToolCall = { id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } };
    const responses = Array.from({ length: MAX_TOOL_CALL_ROUNDS }, () => ({ choices: [{ message: { role: "assistant", tool_calls: [toolCall] } }] }));
    responses.push({ choices: [{ message: { role: "assistant", content: "final answer" } }] } as never);
    let requestCount = 0;
    const fetcher: FetchLike = async () => jsonResponse(responses[requestCount++]!);
    const reply = await new DeepSeekClient("key", fetcher).runWithTools(
      [{ role: "user", content: "hello" }],
      new ModelConfig(),
      100,
      [{ type: "function", function: { name: "lookup", description: "lookup", parameters: { type: "object", properties: {} } } }],
      { lookup: () => "result" },
    );
    expect(reply.content).toBe("final answer");
    expect(requestCount).toBe(MAX_TOOL_CALL_ROUNDS + 1);
  });

  it("falls back to a tool-free synthesis after exhausting tool calls", async () => {
    const toolCall: ToolCall = { id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } };
    let requestCount = 0;
    let fallback: Record<string, unknown> = {};
    const fetcher: FetchLike = async (_url, init) => {
      const payload = payloadFrom(init);
      requestCount += 1;
      if (!("tools" in payload)) {
        fallback = payload;
        return jsonResponse({ choices: [{ message: { content: "fallback answer" } }] });
      }
      return jsonResponse({ choices: [{ message: { tool_calls: [toolCall] } }] });
    };
    const reply = await new DeepSeekClient("key", fetcher).runWithTools(
      [{ role: "user", content: "hello" }],
      new ModelConfig(),
      100,
      [{ type: "function", function: { name: "lookup", description: "lookup", parameters: { type: "object", properties: {} } } }],
      { lookup: () => "result" },
    );
    expect(reply.content).toBe("fallback answer");
    expect(requestCount).toBe(MAX_TOOL_CALL_ROUNDS + 2);
    expect(fallback).not.toHaveProperty("tools");
  });

  it("returns unknown tool errors to the model", async () => {
    const payloads: Record<string, unknown>[] = [];
    let request = 0;
    const fetcher: FetchLike = async (_url, init) => {
      payloads.push(payloadFrom(init));
      request += 1;
      if (request === 1) {
        return jsonResponse({ choices: [{ message: { tool_calls: [{ id: "x", function: { name: "missing", arguments: "{}" } }] } }] });
      }
      return jsonResponse({ choices: [{ message: { content: "done" } }] });
    };
    await new DeepSeekClient("key", fetcher).runWithTools([], new ModelConfig(), 100, [
      { type: "function", function: { name: "missing", description: "missing", parameters: { type: "object", properties: {} } } },
    ]);
    expect(JSON.stringify(payloads[1])).toContain("is not available");
  });

  it("accumulates streamed visible content and hides reasoning", async () => {
    let seen: Record<string, unknown> = {};
    const fetcher: FetchLike = async (_url, init) => {
      seen = payloadFrom(init);
      return streamResponse([
        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"hidden\"}}]}\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"hello ",
        "world\"}}],\"usage\":{\"total_tokens\":3}}\n",
        "data: [DONE]\n",
      ]);
    };
    const output: string[] = [];
    const reply = await new DeepSeekClient("key", fetcher).completeStream(
      [{ role: "user", content: "hello" }], new ModelConfig(), 100, (content) => output.push(content),
    );
    expect(seen.stream).toBe(true);
    expect(output).toEqual(["hello world"]);
    expect(reply.content).toBe("hello world");
    expect(reply.reasoningContent).toBe("hidden");
    expect(reply.usage.total_tokens).toBe(3);
  });

  it("retries transient request failures", async () => {
    let attempts = 0;
    const fetcher: FetchLike = async () => {
      attempts += 1;
      if (attempts < 3) throw new TypeError("temporary");
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    };
    const sleep = vi.fn(async () => undefined);
    const reply = await new DeepSeekClient("key", fetcher, sleep).complete([], new ModelConfig(), 100);
    expect(reply.content).toBe("ok");
    expect(attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry a client-side HTTP error", async () => {
    const fetcher = vi.fn<FetchLike>(async () => new Response("bad key", { status: 401 }));
    await expect(new DeepSeekClient("key", fetcher).complete([], new ModelConfig(), 100)).rejects.toThrow(DeepSeekError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed response bodies with a useful error", async () => {
    const fetcher: FetchLike = async () => jsonResponse({ unexpected: true });
    await expect(new DeepSeekClient("key", fetcher).complete([], new ModelConfig(), 100)).rejects.toThrow(/Unexpected DeepSeek response/u);
  });
});
