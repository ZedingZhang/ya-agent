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
  for (const streaming of [false, true]) {
    describe(streaming ? "stream retries" : "completion retries", () => {
      const success = () => streaming
        ? streamResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n', 'data: [DONE]\n'])
        : jsonResponse({ choices: [{ message: { content: "ok" } }] });
      const invoke = (fetcher: FetchLike, sleep = vi.fn(async (_ms: number) => undefined), onContent = vi.fn()) => {
        const client = new DeepSeekClient("key", fetcher, sleep);
        return streaming ? client.completeStream([], new ModelConfig(), 100, onContent)
          : client.complete([], new ModelConfig(), 100);
      };

      it.each([429, 500, 503, 599])("retries HTTP %i and retains final status", async (status) => {
        const fetcher = vi.fn<FetchLike>(async () => new Response("failure", { status }));
        const sleep = vi.fn(async (_ms: number) => undefined);
        await expect(invoke(fetcher, sleep)).rejects.toMatchObject({ status });
        expect(fetcher).toHaveBeenCalledTimes(3);
        expect(sleep.mock.calls).toEqual([[500], [1000]]);
      });

      it.each([400, 401, 403, 404, 408, 422])("does not retry HTTP %i", async (status) => {
        const fetcher = vi.fn<FetchLike>(async () => new Response("failure", { status }));
        const sleep = vi.fn(async (_ms: number) => undefined);
        await expect(invoke(fetcher, sleep)).rejects.toMatchObject({ status });
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
      });

      it.each([
        ["3", 3000], ["0", 500], ["invalid", 500], ["-1", 500],
        ["Tue, 29 Sep 2026 00:00:04 GMT", 4000],
        ["Mon, 28 Sep 2026 00:00:00 GMT", 500],
      ])("handles Retry-After %s", async (header, delay) => {
        const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 8, 29));
        try {
          const fetcher = vi.fn<FetchLike>().mockResolvedValueOnce(new Response("busy", {
            status: 429, headers: { "Retry-After": String(header) },
          })).mockImplementation(async () => success());
          const sleep = vi.fn(async (_ms: number) => undefined);
          await expect(invoke(fetcher, sleep)).resolves.toMatchObject({ content: "ok" });
          expect(sleep.mock.calls).toEqual([[delay]]);
        } finally {
          clock.mockRestore();
        }
      });

      it("retries transport failures without inspecting error messages", async () => {
        const failure = new TypeError("wrapped HTTP 401 text");
        const fetcher = vi.fn<FetchLike>().mockRejectedValue(failure);
        await expect(invoke(fetcher)).rejects.toMatchObject({ cause: failure });
        expect(fetcher).toHaveBeenCalledTimes(3);
      });

      it("retries a body transport failure before output", async () => {
        const fetcher = vi.fn<FetchLike>().mockResolvedValueOnce(new Response(new ReadableStream({
          start(controller) { controller.error(new TypeError("connection reset")); },
        }))).mockImplementation(async () => success());
        await expect(invoke(fetcher)).resolves.toMatchObject({ content: "ok" });
        expect(fetcher).toHaveBeenCalledTimes(2);
      });

      it("preserves HTTP status when the error body fails", async () => {
        const fetcher = vi.fn<FetchLike>(async () => new Response(new ReadableStream({
          start(controller) { controller.error(new TypeError("connection reset")); },
        }), { status: 401 }));
        await expect(invoke(fetcher)).rejects.toMatchObject({ status: 401 });
        expect(fetcher).toHaveBeenCalledTimes(1);
      });
    });
  }

  it("does not replay a stream after delivering content", async () => {
    let reads = 0;
    const fetcher = vi.fn<FetchLike>(async () => new Response(new ReadableStream({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
        else controller.error(new TypeError("connection reset"));
      },
    })));
    const output = vi.fn();
    const sleep = vi.fn(async () => undefined);
    await expect(new DeepSeekClient("key", fetcher, sleep).completeStream([], new ModelConfig(), 100, output)).rejects.toThrow("connection reset");
    expect(output).toHaveBeenCalledExactlyOnceWith("hello");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry callback exceptions", async () => {
    const fetcher = vi.fn<FetchLike>(async () => streamResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n']));
    const failure = new TypeError("callback failed");
    await expect(new DeepSeekClient("key", fetcher).completeStream([], new ModelConfig(), 100, () => { throw failure; })).rejects.toBe(failure);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not retry invalid JSON", async () => {
    const fetcher = vi.fn<FetchLike>(async () => new Response("invalid JSON"));
    await expect(new DeepSeekClient("key", fetcher).complete([], new ModelConfig(), 100)).rejects.toThrow(SyntaxError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

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
      model: "deepseek-flash",
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
      new ModelConfig({ model: "deepseek-flash" }),
      100,
    );
    expect(seen).toMatchObject({ model: "deepseek-flash", messages });
  });

  it("rejects vision content before sending it to a text-only model", async () => {
    const fetcher = vi.fn<FetchLike>();
    await expect(new DeepSeekClient("key", fetcher).complete(
      [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/chart.png" } }] }],
      new ModelConfig({ model: "deepseek-v4-pro" }),
      100,
    )).rejects.toThrow(/deepseek-flash/u);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects images outside user messages before sending a request", async () => {
    const fetcher = vi.fn<FetchLike>();
    await expect(new DeepSeekClient("key", fetcher).complete(
      [{ role: "system", content: [{ type: "image_url", image_url: { url: "https://example.com/chart.png" } }] }],
      new ModelConfig({ model: "deepseek-flash" }),
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
