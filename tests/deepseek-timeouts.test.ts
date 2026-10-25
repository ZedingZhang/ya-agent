import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/config";
import type { DeepSeekCredential } from "../src/credentials";
import { DeepSeekClient, type FetchLike } from "../src/deepseek";

describe.each([
  ["API key", "synthetic-key"],
  ["account", { kind: "account", token: "synthetic-grant" }],
] as const)("%s transport deadlines", (_name, credential: DeepSeekCredential) => {
  let cancellation: AbortController;
  beforeEach(() => {
    vi.useFakeTimers();
    cancellation = new AbortController();
    // Native AbortSignal.timeout does not use fake timers. Model its fetch/body
    // semantics so these controlled-clock regressions also fail on the old code.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), milliseconds);
      return controller.signal;
    });
  });
  afterEach(async () => {
    cancellation.abort(new Error("Test cleanup"));
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const config = () => new ModelConfig({ toaTimeout: 30 });
  const sleep = vi.fn(async () => undefined);

  function exchange(headerDelay = 0) {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let signal: AbortSignal | undefined;
    let started = false;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel });
    const response = new Response(body);
    const fetcher = vi.fn<FetchLike>(async (_url, init) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener("abort", () => controller.error(signal?.reason), { once: true });
      if (headerDelay) await new Promise((resolve) => setTimeout(resolve, headerDelay));
      return response;
    });
    const send = (text: string) => controller.enqueue(new TextEncoder().encode(text));
    return {
      body, cancel, fetcher, send,
      signal: () => signal,
      text(text: string) {
        if (typeof credential === "string") send(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
        else if (!started) {
          send(`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text } })}\n\n`);
          started = true;
        } else send(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { text } })}\n\n`);
      },
      finish() {
        send(typeof credential === "string" ? "data: [DONE]\n\n" : 'data: {"type":"message_stop"}\n\n');
        controller.close();
      },
      close: () => controller.close(),
    };
  }

  it.each([": heartbeat\n\n", "data: {}\n\n"])("keeps an active stream alive beyond the old total deadline with %j", async (heartbeat) => {
    const stream = exchange();
    const content = vi.fn();
    const task = new DeepSeekClient(credential, stream.fetcher, sleep, cancellation.signal)
      .completeStream([], new ModelConfig(), 100, content);
    const result = task.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    stream.text("first");
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 4; index += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(stream.signal()?.aborted).toBe(false);
      stream.send(heartbeat);
      await vi.advanceTimersByTimeAsync(0);
    }
    stream.text(" last");
    stream.finish();
    await expect(result).resolves.toMatchObject({ content: "first last" });
    expect(content.mock.calls).toEqual([["first"], [" last"]]);
    expect(stream.fetcher).toHaveBeenCalledTimes(1);
    expect(stream.body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts the idle deadline after headers and resets it on fragmented bytes", async () => {
    const stream = exchange(80_000);
    const task = new DeepSeekClient(credential, stream.fetcher, sleep, cancellation.signal)
      .completeStream([], config(), 100, () => undefined);
    const result = task.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(80_000);
    expect(stream.signal()?.aborted).toBe(false);
    for (const fragment of [": heart", "beat\n", "\n"]) {
      await vi.advanceTimersByTimeAsync(80_000);
      expect(stream.signal()?.aborted).toBe(false);
      stream.send(fragment);
      await vi.advanceTimersByTimeAsync(0);
    }
    stream.text("done");
    stream.finish();
    await expect(result).resolves.toMatchObject({ content: "done" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a truly idle stream at 90 seconds without replaying delivered text", async () => {
    const stream = exchange();
    const content = vi.fn();
    const task = new DeepSeekClient(credential, stream.fetcher, sleep, cancellation.signal)
      .completeStream([], config(), 100, content);
    const result = task.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    stream.text("visible once");
    await vi.advanceTimersByTimeAsync(89_999);
    expect(stream.signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ message: expect.stringMatching(/idle/iu) });
    expect(content.mock.calls).toEqual([["visible once"]]);
    expect(stream.fetcher).toHaveBeenCalledTimes(1);
    expect(stream.body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an idle stream immediately and clears its timer", async () => {
    const stream = exchange();
    const task = new DeepSeekClient(credential, stream.fetcher, sleep, cancellation.signal)
      .completeStream([], new ModelConfig(), 100, () => undefined);
    const result = task.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    cancellation.abort(new Error("User stopped"));
    expect(await result).toMatchObject({ message: "User stopped" });
    expect(stream.signal()?.aborted).toBe(true);
    expect(stream.fetcher).toHaveBeenCalledTimes(1);
    expect(stream.body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer when stream parsing or a content callback fails", async () => {
    for (const callbackFailure of [false, true]) {
      const stream = exchange();
      const task = new DeepSeekClient(credential, stream.fetcher, sleep, cancellation.signal)
        .completeStream([], new ModelConfig(), 100, () => { if (callbackFailure) throw new Error("Callback failed"); });
      const result = task.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      if (callbackFailure) stream.text("visible");
      else stream.send("data: invalid-json\n\n");
      expect(await result).toMatchObject({ message: expect.stringContaining(callbackFailure ? "Callback failed" : "Invalid streaming chunk") });
      expect(stream.fetcher).toHaveBeenCalledTimes(1);
      expect(stream.body.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("gives non-streaming requests an independent 90-second total deadline", async () => {
    const stream = exchange(40_000);
    const task = new DeepSeekClient(credential, stream.fetcher, sleep, cancellation.signal).complete([], config(), 100);
    const result = task.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(80_000);
    expect(stream.signal()?.aborted).toBe(false);
    stream.send(JSON.stringify(typeof credential === "string" ? { choices: [{ message: { content: "ok" } }] } : { content: [{ type: "text", text: "ok" }] }));
    stream.close();
    await expect(result).resolves.toMatchObject({ content: "ok" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("bounds stalled initial responses and retries with a fresh deadline (stream=%s)", async (streaming) => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<FetchLike>((_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        signals.push(signal);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }
    }));
    const client = new DeepSeekClient(credential, fetcher, sleep, cancellation.signal);
    const task = streaming ? client.completeStream([], config(), 100, () => undefined) : client.complete([], config(), 100);
    const result = task.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(89_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(180_001);
    expect(await result).toMatchObject({ message: expect.stringMatching(/request.*timed out/iu) });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("bounds transports that ignore their abort signal (stream=%s)", async (streaming) => {
    const fetcher = vi.fn<FetchLike>(() => new Promise(() => undefined));
    const client = new DeepSeekClient(credential, fetcher, sleep, cancellation.signal);
    const task = streaming ? client.completeStream([], config(), 100, () => undefined) : client.complete([], config(), 100);
    const result = task.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(270_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(await result).toMatchObject({ message: expect.stringMatching(/request.*timed out/iu) });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("bounds unread response bodies across all retry attempts (stream=%s)", async (streaming) => {
    const responses = [exchange(), exchange(), exchange()];
    let attempt = 0;
    const fetcher = vi.fn<FetchLike>((input, init) => responses[attempt++]!.fetcher(input, init));
    const client = new DeepSeekClient(credential, fetcher, sleep, cancellation.signal);
    const task = streaming ? client.completeStream([], config(), 100, () => undefined) : client.complete([], config(), 100);
    const result = task.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    for (const response of responses) {
      await vi.advanceTimersByTimeAsync(89_999);
      expect(response.signal()?.aborted).toBe(false);
      // Non-streaming body activity must not extend the total request deadline.
      if (!streaming) response.send(" ");
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(await result).toMatchObject({ message: expect.stringMatching(streaming ? /idle/iu : /request.*timed out/iu) });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(responses.every((response) => response.signal()?.aborted)).toBe(true);
    if (streaming) expect(responses.every((response) => !response.body.locked)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["transport", "HTTP", "JSON"])("clears timers after a non-streaming %s failure", async (failure) => {
    const fetcher = vi.fn<FetchLike>(async () => {
      if (failure === "transport") throw new Error("Transport failed");
      return new Response("invalid-json", { status: failure === "HTTP" ? 403 : 200 });
    });
    await expect(new DeepSeekClient(credential, fetcher, sleep, cancellation.signal).complete([], config(), 100)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(failure === "HTTP" ? 1 : 3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
