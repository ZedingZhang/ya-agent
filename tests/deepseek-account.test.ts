import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/config";
import { loadAccountCredential, saveAccountCredential } from "../src/credentials";
import { DeepSeekClient, type FetchLike } from "../src/deepseek";
import { ACCOUNT_API_URL } from "../src/messages";
import type { ChatMessage, ToolDefinition } from "../src/types";
import { tempHome, type TempHome } from "./helpers";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { mockKeychain } = await import("./keychain-fixture");
  return { ...actual, execFileSync: mockKeychain(actual.execFileSync) };
});

const credential = { kind: "account", token: "test-account-token" } as const;
const tool: ToolDefinition = { type: "function", function: { name: "lookup", description: "Look up an item", parameters: {
  type: "object", properties: { name: { type: "string" } }, required: ["name"],
} } };

function stream(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
}

describe("DeepSeek account inference", () => {
  let home: TempHome;
  beforeEach(() => { home = tempHome(); });
  afterEach(() => home.cleanup());

  it.each(["low", "high", "max"] as const)("sends account tokens only as a dedicated header with %s effort", async (reasoningEffort) => {
    const fetcher = vi.fn<FetchLike>(async () => Response.json({ content: [{ type: "text", text: "Account reply" }], usage: { output_tokens: 3 } }));
    const reply = await new DeepSeekClient(credential, fetcher).complete([
      { role: "system", content: "Be concise" }, { role: "user", content: "Hello" },
    ], new ModelConfig({ thinkingEnabled: true, reasoningEffort }), 500, [tool]);
    expect(reply.content).toBe("Account reply");
    expect(reply.usage).toEqual({ output_tokens: 3 });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(ACCOUNT_API_URL);
    expect(init).toMatchObject({ redirect: "error", headers: { "x-dsh-auth-token": credential.token } });
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "deepseek-flash", system: [{ type: "text", text: "Be concise" }],
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }], max_tokens: 500,
      thinking: { type: "enabled" }, output_config: { effort: reasoningEffort },
      tools: [{ name: "lookup", input_schema: tool.function.parameters }],
    });
    expect(String(init?.body)).not.toContain(credential.token);
  });

  it("omits saved low effort from account requests when thinking is disabled", async () => {
    const fetcher = vi.fn<FetchLike>(async () => Response.json({ content: [{ type: "text", text: "Answer" }] }));
    await new DeepSeekClient(credential, fetcher).complete([], new ModelConfig({ reasoningEffort: "low" }), 500);
    const payload = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(payload.thinking).toEqual({ type: "disabled" });
    expect(payload).not.toHaveProperty("output_config");
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("preserves thinking signatures and tool-call history through the shared tool loop", async () => {
    const thinking = { type: "thinking", thinking: "reasoning", signature: "signed-thinking" };
    const fetcher = vi.fn<FetchLike>()
      .mockResolvedValueOnce(Response.json({ content: [thinking, { type: "tool_use", id: "call-1", name: "lookup", input: { name: "item" } }] }))
      .mockResolvedValueOnce(Response.json({ content: [{ type: "text", text: "Found it" }] }));
    const lookup = vi.fn(() => "Tool result");
    const reply = await new DeepSeekClient(credential, fetcher).runWithTools([
      { role: "user", content: "Find item" },
    ], new ModelConfig({ thinkingEnabled: true }), 500, [tool], { lookup });
    expect(reply.content).toBe("Found it");
    expect(lookup).toHaveBeenCalledExactlyOnceWith({ name: "item" });
    const messages = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).messages;
    expect(messages[1]).toEqual({ role: "assistant", content: [thinking, { type: "tool_use", id: "call-1", name: "lookup", input: { name: "item" } }] });
    expect(messages[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "Tool result" }] });
  });

  it("converts data, remote URL and Files images without changing the API-key format", async () => {
    const fetcher = vi.fn<FetchLike>(async () => Response.json({ content: [{ type: "text", text: "Images" }] }));
    await new DeepSeekClient(credential, fetcher).complete([{ role: "user", content: [
      { type: "text", text: "Describe" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
      { type: "image_url", image_url: { url: "https://example.com/image.png" } },
      { type: "file", file_id: "file-api-image" },
    ] }], new ModelConfig(), 500);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).messages[0].content).toEqual([
      { type: "text", text: "Describe" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
      { type: "image", source: { type: "url", url: "https://example.com/image.png" } },
      { type: "image", source: { type: "file", file_id: "file-api-image" } },
    ]);
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("anthropic-beta")).toContain("files-api-2025-04-14");
  });

  it.each([
    ["data URL", "data:image/png;base64,aGVsbG8=", false],
    ["remote URL", "https://example.com/image.png", false],
    ["data URL", "data:image/png;base64,aGVsbG8=", true],
    ["remote URL", "https://example.com/image.png", true],
  ] as const)("rejects low-detail %s account images (%s; stream: %s)", async (_source, url, streaming) => {
    const fetcher = vi.fn<FetchLike>(async () => streaming
      ? stream([
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "Images" } },
        { type: "message_stop" },
      ])
      : Response.json({ content: [{ type: "text", text: "Images" }] }));
    const sleep = vi.fn(async () => undefined);
    const onContent = vi.fn();
    const client = new DeepSeekClient(credential, fetcher, sleep);
    const messages: ChatMessage[] = [{ role: "user", content: [
      { type: "image_url", image_url: { url, detail: "low" } },
    ] }];
    const request = streaming ? client.completeStream(messages, new ModelConfig(), 500, onContent)
      : client.complete(messages, new ModelConfig(), 500);
    await expect(request).rejects.toThrow(/Low image detail.*account sign-in/u);
    expect(fetcher).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(onContent).not.toHaveBeenCalled();
  });

  it("keeps low-detail API-key images available", async () => {
    const fetcher = vi.fn<FetchLike>(async () => Response.json({ choices: [{ message: { role: "assistant", content: "Images" } }] }));
    await new DeepSeekClient("test-api-key", fetcher).complete([{ role: "user", content: [
      { type: "image_url", image_url: { url: "https://example.com/image.png", detail: "low" } },
    ] }], new ModelConfig(), 500);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).messages[0].content[0].image_url.detail).toBe("low");
  });

  it.each(["auto", "high", "original"] as const)("accepts %s account images", async (detail) => {
    const fetcher = vi.fn<FetchLike>(async () => Response.json({ content: [{ type: "text", text: "Images" }] }));
    await expect(new DeepSeekClient(credential, fetcher).complete([{ role: "user", content: [
      { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=", detail } },
      { type: "image_url", image_url: { url: "https://example.com/image.png", detail } },
    ] }], new ModelConfig(), 500)).resolves.toMatchObject({ content: "Images" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("streams account text and reasoning while retaining usage and replay signatures", async () => {
    const fetcher = vi.fn<FetchLike>(async () => stream([
      { type: "message_start", message: { usage: { input_tokens: 7, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Thought" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signature" } },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello " } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "world" } },
      { type: "message_delta", usage: { output_tokens: 5 } }, { type: "message_stop" },
    ]));
    const onContent = vi.fn();
    const reply = await new DeepSeekClient(credential, fetcher).completeStream([], new ModelConfig({ thinkingEnabled: true, reasoningEffort: "low" }), 500, onContent);
    expect(reply).toMatchObject({ content: "Hello world", reasoningContent: "Thought", usage: { input_tokens: 7, output_tokens: 5 } });
    expect(reply.assistantMessage.account_content).toEqual([
      { type: "thinking", thinking: "Thought", signature: "signature" }, { type: "text", text: "Hello world" },
    ]);
    expect(onContent.mock.calls).toEqual([["Hello "], ["world"]]);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "deepseek-flash", thinking: { type: "enabled" }, output_config: { effort: "low" }, stream: true,
    });
  });

  it("rejects truncated streams without replaying text already delivered", async () => {
    const fetcher = vi.fn<FetchLike>(async () => stream([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
    ]));
    const onContent = vi.fn();
    await expect(new DeepSeekClient(credential, fetcher).completeStream([], new ModelConfig(), 500, onContent)).rejects.toThrow("ended before completion");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onContent).toHaveBeenCalledExactlyOnceWith("partial");
  });

  it("reuses the bounded retry policy for account rate limits", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(Response.json({ content: [{ type: "text", text: "retried" }] }));
    const sleep = vi.fn(async () => undefined);
    expect((await new DeepSeekClient(credential, fetcher, sleep).complete([], new ModelConfig(), 500)).content).toBe("retried");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it.each(["overloaded_error", "api_error", "rate_limit_error"])("retries an in-band %s before delivering account text", async (type) => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValueOnce(stream([
      { type: "error", error: { type, message: "Temporary failure" } },
    ])).mockResolvedValueOnce(stream([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Recovered" } },
      { type: "message_stop" },
    ]));
    const sleep = vi.fn(async () => undefined);
    const onContent = vi.fn();
    const reply = await new DeepSeekClient(credential, fetcher, sleep).completeStream([], new ModelConfig(), 500, onContent);
    expect(reply.content).toBe("Recovered");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(500);
    expect(onContent).toHaveBeenCalledExactlyOnceWith("Recovered");
  });

  it.each(["authentication_error", "invalid_request_error", "unknown_error"])("does not retry an in-band %s", async (type) => {
    const fetcher = vi.fn<FetchLike>(async () => stream([{ type: "error", error: { type, message: "private-detail" } }]));
    const sleep = vi.fn(async () => undefined);
    await expect(new DeepSeekClient(credential, fetcher, sleep).completeStream([], new ModelConfig(), 500, () => undefined))
      .rejects.toThrow("DeepSeek account stream returned an error.");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("can retry after empty account text deltas before visible output", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValueOnce(stream([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } },
      { type: "error", error: { type: "overloaded_error" } },
    ])).mockResolvedValueOnce(stream([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "Recovered" } },
      { type: "message_stop" },
    ]));
    const sleep = vi.fn(async () => undefined);
    const onContent = vi.fn();
    const reply = await new DeepSeekClient(credential, fetcher, sleep).completeStream([], new ModelConfig(), 500, onContent);
    expect(reply.content).toBe("Recovered");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(500);
    expect(onContent).toHaveBeenCalledExactlyOnceWith("Recovered");
  });

  it("bounds retries for repeated in-band overload errors", async () => {
    const fetcher = vi.fn<FetchLike>(async () => stream([{ type: "error", error: { type: "overloaded_error" } }]));
    const sleep = vi.fn(async () => undefined);
    await expect(new DeepSeekClient(credential, fetcher, sleep).completeStream([], new ModelConfig(), 500, () => undefined))
      .rejects.toThrow("DeepSeek account stream returned an error.");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[500], [1_000]]);
  });

  it.each(["start", "delta"])("does not replay account text delivered in a block %s before an in-band error", async (stage) => {
    const fetcher = vi.fn<FetchLike>(async () => stream([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: stage === "start" ? "Partial" : "" } },
      ...(stage === "delta" ? [{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partial" } }] : []),
      { type: "error", error: { type: "overloaded_error" } },
    ]));
    const sleep = vi.fn(async () => undefined);
    const onContent = vi.fn();
    await expect(new DeepSeekClient(credential, fetcher, sleep).completeStream([], new ModelConfig(), 500, onContent))
      .rejects.toThrow("DeepSeek account stream returned an error.");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(onContent).toHaveBeenCalledExactlyOnceWith("Partial");
  });

  it("honors Retry-After when a transient failure arrives inside an account stream", async () => {
    const response = stream([{ type: "error", error: { type: "rate_limit_error" } }]);
    response.headers.set("Retry-After", "2");
    const fetcher = vi.fn<FetchLike>().mockResolvedValueOnce(response)
      .mockResolvedValueOnce(stream([{ type: "message_stop" }]));
    const sleep = vi.fn(async () => undefined);
    await new DeepSeekClient(credential, fetcher, sleep).completeStream([], new ModelConfig(), 500, () => undefined);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(2_000);
  });

  it("can retry after thinking-only account output without replaying stale reasoning", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValueOnce(stream([
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "Incomplete thought" } },
      { type: "error", error: { type: "api_error" } },
    ])).mockResolvedValueOnce(stream([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "Recovered" } },
      { type: "message_stop" },
    ]));
    const onContent = vi.fn();
    const reply = await new DeepSeekClient(credential, fetcher, async () => undefined)
      .completeStream([], new ModelConfig(), 500, onContent);
    expect(reply.content).toBe("Recovered");
    expect(reply.reasoningContent).toBeUndefined();
    expect(onContent).toHaveBeenCalledExactlyOnceWith("Recovered");
  });

  it.each([false, true])("invalidates only the rejected login on HTTP 401 (replacement: %s)", async (replacement) => {
    saveAccountCredential(replacement ? { kind: "account", token: "replacement-token" } : credential);
    const fetcher = vi.fn<FetchLike>(async () => new Response(`error echoes ${credential.token}`, { status: 401 }));
    const request = new DeepSeekClient(credential, fetcher).complete([], new ModelConfig(), 500);
    await expect(request).rejects.toThrow("Sign in again");
    await expect(request).rejects.not.toThrow(credential.token);
    expect(loadAccountCredential()?.token).toBe(replacement ? "replacement-token" : undefined);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("merges adjacent tool results into one user turn without mutating saved history", async () => {
    const fetcher = vi.fn<FetchLike>(async () => Response.json({ content: [{ type: "text", text: "Done" }] }));
    const history: ChatMessage[] = [
      { role: "assistant", content: "", tool_calls: [{ id: "first", function: { name: "lookup", arguments: "{}" } }, { id: "second", function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "first", content: "one" }, { role: "tool", tool_call_id: "second", content: "two" },
    ];
    const snapshot = JSON.stringify(history);
    await new DeepSeekClient(credential, fetcher).complete(history, new ModelConfig(), 500);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).messages[1].content).toHaveLength(2);
    expect(JSON.stringify(history)).toBe(snapshot);
  });
});
