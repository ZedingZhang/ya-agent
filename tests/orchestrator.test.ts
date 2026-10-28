import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/config";
import { LocalWorkspace } from "../src/local";
import { createCandidate, setStatus } from "../src/memory";
import {
  messagesForTask,
  shouldUseWeb,
  singleAgent,
  toaAgent,
  type AgentClient,
} from "../src/orchestrator";
import { DeepSeekClient, type FetchLike, type ModelReply } from "../src/deepseek";
import { search } from "../src/web";
import type { ChatMessage, ToolDefinition, ToolHandler, UserImageContentPart } from "../src/types";
import { tempHome, type TempHome } from "./helpers";

function reply(content: string): ModelReply {
  return { content, toolCalls: [], usage: {}, assistantMessage: { role: "assistant", content } };
}

function evidencePackets(messages: ChatMessage[]): unknown {
  const payload = /Evidence packets:\n([^\n]+)/u.exec(String(messages[0]?.content))?.[1];
  expect(payload).toBeDefined();
  return JSON.parse(payload!);
}

const image: UserImageContentPart = {
  type: "image_url",
  image_url: { url: "https://example.com/chart.png", detail: "high" },
};

class FakeClient implements AgentClient {
  streamed = false;
  calls: Array<{ messages: ChatMessage[]; tools?: ToolDefinition[]; handlers?: Record<string, ToolHandler> }> = [];

  async completeStream(
    _messages: ChatMessage[],
    _config: ModelConfig,
    _maxTokens: number,
    onContent: (content: string) => void,
  ): Promise<ModelReply> {
    onContent("answer");
    this.streamed = true;
    return reply("answer");
  }

  async runWithTools(
    messages: ChatMessage[],
    _config: ModelConfig,
    _maxTokens: number,
    tools?: ToolDefinition[],
    handlers?: Record<string, ToolHandler>,
  ): Promise<ModelReply> {
    this.calls.push({ messages, tools, handlers });
    return reply("answer");
  }
}

describe("agent orchestration", () => {
  let home: TempHome;
  beforeEach(() => { home = tempHome(); });
  afterEach(() => home.cleanup());

  it("keeps automatic web search conservative", () => {
    expect(shouldUseWeb("Explain recursion", "auto")).toBe(false);
    expect(shouldUseWeb("What is the latest weather forecast?", "auto")).toBe(true);
    expect(shouldUseWeb("Explain recursion", "on")).toBe(true);
    expect(shouldUseWeb("latest weather", "off")).toBe(false);
    expect(shouldUseWeb("请对比最新价格", "auto")).toBe(true);
  });

  it("streams a simple single-agent answer", async () => {
    const client = new FakeClient();
    const output: string[] = [];
    const result = await singleAgent(client, "Explain recursion", new ModelConfig(), "auto", (content) => output.push(content));
    expect(result.content).toBe("answer");
    expect(output).toEqual(["answer"]);
    expect(client.streamed).toBe(true);
  });

  it.each(Array.from({ length: "[ICM_GAP]".length + 1 }, (_, index) => index))(
    "filters an ICM marker split at offset %i and emits one supplement", async (offset) => {
      const client = new FakeClient();
      const output: string[] = [];
      const marker = "[ICM_GAP]";
      client.completeStream = async (_messages, _config, _maxTokens, onContent) => {
        onContent(`Draft ${marker.slice(0, offset)}`);
        expect(output.join("")).toBe("Draft ");
        onContent(`${marker.slice(offset)} tail`);
        return { ...reply(`Draft ${marker} tail`), usage: { output_tokens: 5 } };
      };
      client.runWithTools = async (messages, _config, maxTokens, tools, handlers) => {
        client.calls.push({ messages, tools, handlers });
        expect(maxTokens).toBeLessThanOrEqual(1_024);
        return { ...reply("Supplement"), usage: { output_tokens: 3 } };
      };
      const result = await singleAgent(client, "Explain recursion", new ModelConfig(), "off", (text) => output.push(text));
      expect(result.content).toBe("Draft  tail\n\nEvidence supplement:\nSupplement");
      expect(output.join("")).toBe(result.content);
      expect(client.calls).toHaveLength(1);
      expect(client.calls[0]!.tools?.map((tool) => tool.function.name)).toContain("web_search");
      expect(result.usage).toMatchObject({ output_tokens: 8, icm_follow_up: { output_tokens: 3 } });
    },
  );

  it("emits ordinary chunks immediately", async () => {
    const client = new FakeClient();
    const output: string[] = [];
    client.completeStream = async (_messages, _config, _maxTokens, onContent) => {
      onContent("Hello ");
      expect(output).toEqual(["Hello "]);
      onContent("world");
      expect(output).toEqual(["Hello ", "world"]);
      return reply("Hello world");
    };
    const result = await singleAgent(client, "Explain recursion", new ModelConfig(), "off", (text) => output.push(text));
    expect(result.content).toBe("Hello world");
    expect(client.calls).toEqual([]);
  });

  it("flushes an incomplete marker prefix as ordinary text at normal completion", async () => {
    const client = new FakeClient();
    const output: string[] = [];
    client.completeStream = async (_messages, _config, _maxTokens, onContent) => {
      onContent("Use [ICM_");
      return reply("Use [ICM_");
    };
    const result = await singleAgent(client, "Explain recursion", new ModelConfig(), "off", (text) => output.push(text));
    expect(output.join("")).toBe("Use [ICM_");
    expect(result.content).toBe("Use [ICM_");
    expect(client.calls).toEqual([]);
  });

  it.each([
    ["One [icm_gap] two [ICM_GAP] end", "One  two  end"],
    ["Before [ICM_[ICM_GAP]GAP] after", "Before  after"],
    [`Start ${"[ICM_".repeat(10)}[ICM_GAP]${"GAP]".repeat(10)} end`, "Start  end"],
  ])("removes markers from draft %s and the supplement", async (draft, clean) => {
    for (let offset = 0; offset <= draft.length; offset += 1) {
      const client = new FakeClient();
      const output: string[] = [];
      client.completeStream = async (_messages, _config, _maxTokens, onContent) => {
        onContent(draft.slice(0, offset));
        onContent(draft.slice(offset));
        return reply(draft);
      };
      client.runWithTools = async (messages) => { client.calls.push({ messages }); return reply("Supplement [ICM_GAP]"); };
      const result = await singleAgent(client, "Explain recursion", new ModelConfig(), "off", (text) => output.push(text));
      expect(result.content).toBe(`${clean}\n\nEvidence supplement:\nSupplement `);
      expect(output.join(""), `split offset ${offset}`).toBe(result.content);
      expect(client.calls).toHaveLength(1);
    }
  });

  it("defers pathological nested prefixes and catches up from the final reply", async () => {
    const client = new FakeClient();
    const output: string[] = [];
    const prefix = "[ICM_".repeat(10);
    const tail = `[ICM_GAP]${"GAP]".repeat(10)} end`;
    client.completeStream = async (_messages, _config, _maxTokens, onContent) => {
      onContent("Start ");
      onContent(prefix);
      onContent(tail);
      expect(output.join("")).toBe("Start ");
      return reply(`Start ${prefix}${tail}`);
    };
    const result = await singleAgent(client, "Explain recursion", new ModelConfig(), "off", (text) => output.push(text));
    expect(result.content).toBe("Start  end\n\nEvidence supplement:\nanswer");
    expect(output.join("")).toBe(result.content);
    expect(client.calls).toHaveLength(1);
  });

  it("propagates stream failures without starting a supplement or leaking a pending marker prefix", async () => {
    const client = new FakeClient();
    const output: string[] = [];
    const failure = new Error("Stream failed");
    client.completeStream = async (_messages, _config, _maxTokens, onContent) => { onContent("Partial [ICM_"); throw failure; };
    await expect(singleAgent(client, "Explain recursion", new ModelConfig(), "off", (text) => output.push(text))).rejects.toBe(failure);
    expect(output.join("")).toBe("Partial ");
    expect(client.calls).toEqual([]);
  });

  it("injects only task-relevant approved memory", () => {
    const matching = setStatus(createCandidate("Use PostgreSQL indexes", "evidence").id, "approved");
    const unrelated = setStatus(createCandidate("Use dark terminal themes", "evidence").id, "approved");
    const messages = messagesForTask("Explain PostgreSQL indexes");
    expect(messages[0]!.content).toContain(matching.text);
    expect(messages[0]!.content).not.toContain(unrelated.text);
  });

  it("builds a multimodal user message without placing images in system messages", () => {
    const messages = messagesForTask("Explain the chart", "", false, [image]);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toBeTypeOf("string");
    expect(messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Explain the chart" }, image],
    });
  });

  it("rejects image content unless the configured model supports vision", async () => {
    await expect(singleAgent(
      new FakeClient(),
      "Explain the chart",
      new ModelConfig({ model: "deepseek-v4-pro" }),
      "off",
      undefined,
      undefined,
      undefined,
      [image],
    )).rejects.toThrow(/deepseek-flash/u);
  });

  it("buffers local mode and combines local and web tools", async () => {
    const root = join(home.path, "workspace");
    mkdirSync(root);
    const workspace = new LocalWorkspace(root, () => false);
    const client = new FakeClient();
    const result = await singleAgent(client, "latest weather in notes", new ModelConfig(), "on", () => undefined, workspace);
    expect(result.content).toBe("answer");
    expect(client.streamed).toBe(false);
    const names = new Set(client.calls[0]!.tools?.map((tool) => tool.function.name));
    expect(names).toContain("web_search");
    expect(names).toContain("local_read");
    expect(names).toContain("local_edit");
    expect(client.calls[0]!.messages[0]!.content).toContain("prefer local_edit");
    expect(client.calls[0]!.messages[0]!.content).toContain("Local workspace tools are available");
  });

  it("uses an injected web-search adapter", async () => {
    const client = new FakeClient();
    const webSearch: ToolHandler = async () => "[]";
    await singleAgent(client, "latest news", new ModelConfig(), "on", undefined, undefined, webSearch);
    expect(client.calls[0]!.handlers?.web_search).toBe(webSearch);
  });

  it("performs at most one ICM evidence supplement", async () => {
    const client = new FakeClient();
    client.runWithTools = async (messages) => {
      client.calls.push({ messages });
      return reply(client.calls.length === 1 ? "Draft [icm_gap]" : "Source-backed supplement");
    };
    const result = await singleAgent(client, "Research a topic", new ModelConfig(), "off");
    expect(result.content).toBe("Draft \n\nEvidence supplement:\nSource-backed supplement");
    expect(result.usage).toHaveProperty("icm_follow_up");
    expect(client.calls).toHaveLength(2);
  });

  it.each(["buffered", "web", "toa", "local", "command", "stream"])("removes every ICM marker from %s results without extra follow-ups", async (mode) => {
    const client = new FakeClient();
    const draft = "Draft [ICM_GAP] and [icm_gap] and [IcM_GaP].";
    const supplement = "Evidence [icm_gap] and [ICM_GAP].";
    client.runWithTools = async (messages) => {
      client.calls.push({ messages });
      const system = String(messages[0]?.content);
      if (system.includes("strongest available evidence")) return reply("worker packet");
      return reply(system.includes("prior draft identifies") ? supplement : draft);
    };
    client.completeStream = async (_messages, _config, _maxTokens, onContent) => {
      for (const part of [draft.slice(0, 10), draft.slice(10, 22), draft.slice(22)]) onContent(part);
      return reply(draft);
    };
    const workspace = mode === "local" || mode === "command"
      ? new LocalWorkspace(home.path, () => true, undefined, { commandsEnabled: mode === "command" }) : undefined;
    const chunks: string[] = [];
    const result = mode === "toa" ? await toaAgent(client, "Explain this", new ModelConfig(), 1, () => "[]")
      : await singleAgent(client, "Explain this", new ModelConfig(), mode === "web" ? "on" : "off",
        mode === "stream" ? (chunk) => chunks.push(chunk) : undefined, workspace, () => "[]");
    expect(result.content).not.toMatch(/\[icm_gap\]/iu);
    expect(result.content).toContain("Draft  and  and .");
    expect(client.calls).toHaveLength(mode === "toa" ? 3 : mode === "command" || mode === "stream" ? 1 : 2);
    if (mode === "command") expect(result.content).not.toContain("Evidence supplement:");
    else expect(result.content).toContain("Evidence supplement:\nEvidence  and .");
    if (mode === "stream") expect(chunks.join("")).toBe(result.content);
  });

  it("runs bounded evidence and risk workers before synthesis", async () => {
    const client = new FakeClient();
    client.runWithTools = async (messages) => {
      client.calls.push({ messages });
      const system = String(messages[0]?.content ?? "");
      if (system.includes("strongest available evidence")) return reply("evidence packet");
      if (system.includes("skeptical reviewer")) return reply("risk packet");
      expect(system).toContain("evidence packet");
      expect(system).toContain("risk packet");
      return reply("synthesis");
    };
    const result = await toaAgent(client, "Compare options", new ModelConfig(), 2);
    expect(result).toMatchObject({ content: "synthesis", mode: "toa", partial: false });
    expect(result.usage.worker_count).toBe(2);
    expect(client.calls).toHaveLength(3);
  });

  it.each(["evidence", "risk"] as const)("keeps role order when %s finishes first", async (first) => {
    const client = new FakeClient();
    const started: string[] = [];
    const finish: Record<string, (value: ModelReply) => void> = {};
    client.runWithTools = async (messages) => {
      const system = String(messages[0]?.content);
      const role = system.includes("strongest available evidence") ? "evidence"
        : system.includes("skeptical reviewer") ? "risk" : undefined;
      if (role) {
        started.push(role);
        return new Promise<ModelReply>((resolve) => { finish[role] = resolve; });
      }
      expect(evidencePackets(messages)).toEqual([
        { role: "evidence", content: "evidence packet" },
        { role: "risk", content: "risk packet" },
      ]);
      return reply("synthesis");
    };
    const running = toaAgent(client, "Compare options", new ModelConfig(), 2);
    expect(started).toEqual(["evidence", "risk"]);
    finish[first]!(reply(`${first} packet`));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = first === "evidence" ? "risk" : "evidence";
    finish[second]!(reply(`${second} packet`));
    expect(await running).toMatchObject({ content: "synthesis", partial: false });
  });

  it("synthesizes a single evidence worker", async () => {
    const client = new FakeClient();
    client.runWithTools = async (messages) => {
      if (String(messages[0]?.content).includes("strongest available evidence")) return reply("evidence packet");
      expect(evidencePackets(messages)).toEqual([{ role: "evidence", content: "evidence packet" }]);
      return reply("synthesis");
    };
    expect(await toaAgent(client, "Compare options", new ModelConfig(), 1))
      .toMatchObject({ content: "synthesis", partial: false, usage: { worker_count: 1 } });
  });

  it("propagates vision input to each ToA worker and root synthesis", async () => {
    const client = new FakeClient();
    await toaAgent(
      client,
      "Explain the chart",
      new ModelConfig({ model: "deepseek-flash" }),
      2,
      async () => "[]",
      [image],
    );
    expect(client.calls).toHaveLength(3);
    for (const call of client.calls) {
      expect(call.messages[1]!.content).toEqual([{ type: "text", text: "Explain the chart" }, image]);
    }
  });

  it.each(["evidence", "risk"] as const)("omits the failed %s worker from synthesis", async (failed) => {
    const client = new FakeClient();
    client.runWithTools = async (messages) => {
      const system = String(messages[0]?.content);
      const role = system.includes("strongest available evidence") ? "evidence"
        : system.includes("skeptical reviewer") ? "risk" : undefined;
      if (role === failed) throw new Error("worker failed");
      if (role) return reply(`${role} packet`);
      const remaining = failed === "evidence" ? "risk" : "evidence";
      expect(evidencePackets(messages)).toEqual([{ role: remaining, content: `${remaining} packet` }]);
      return reply("partial synthesis");
    };
    const result = await toaAgent(client, "Compare options", new ModelConfig(), 2);
    expect(result.partial).toBe(true);
    expect(result.content).toBe("partial synthesis");
  });

  it.each(["evidence", "risk"] as const)("omits the timed-out %s worker from synthesis", async (timedOut) => {
    vi.useFakeTimers();
    try {
      const client = new FakeClient();
      client.runWithTools = async (messages) => {
        const system = String(messages[0]?.content);
        const role = system.includes("strongest available evidence") ? "evidence"
          : system.includes("skeptical reviewer") ? "risk" : undefined;
        if (role === timedOut) return new Promise<ModelReply>(() => undefined);
        if (role) return reply(`${role} packet`);
        const remaining = timedOut === "evidence" ? "risk" : "evidence";
        expect(evidencePackets(messages)).toEqual([{ role: remaining, content: `${remaining} packet` }]);
        return reply("partial synthesis");
      };
      const running = toaAgent(client, "Compare options", new ModelConfig({ toaTimeout: 30 }), 2);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await running).toMatchObject({ content: "partial synthesis", partial: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects more than two ToA workers", async () => {
    await expect(toaAgent(new FakeClient(), "task", new ModelConfig(), 3)).rejects.toThrow(/1 or 2/u);
  });

  it.each(["fetch", "search"])("aborts an in-flight worker %s on timeout and issues no later requests", async (pending) => {
    vi.useFakeTimers();
    try {
      const workerSignals: AbortSignal[] = [];
      const searchSignals: AbortSignal[] = [];
      const fetcher = vi.fn<FetchLike>(async (_url, init) => {
        const system = String(JSON.parse(String(init?.body)).messages[0]?.content);
        if (system.includes("strongest available evidence")) {
          const signal = init!.signal!;
          workerSignals.push(signal);
          if (pending === "fetch") return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          return Response.json({ usage: { completion_tokens: 7 }, choices: [{ message: { content: "", tool_calls: [
            { id: "search", type: "function", function: { name: "web_search", arguments: '{"query":"evidence"}' } },
          ] } }] });
        }
        return Response.json({ usage: { completion_tokens: 11 }, choices: [{ message: { content: "partial synthesis" } }] });
      });
      const searchFetcher = vi.fn<FetchLike>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init!.signal!;
        searchSignals.push(signal);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
      const webSearch: ToolHandler = (args, signal) => search(args, searchFetcher, undefined, signal);
      const running = toaAgent(new DeepSeekClient("key", fetcher), "Compare options", new ModelConfig({ toaTimeout: 30 }), 1, webSearch);
      await vi.advanceTimersByTimeAsync(0);
      expect(workerSignals).toHaveLength(1);
      if (pending === "search") expect(searchSignals).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await running).toMatchObject({ content: "partial synthesis", partial: true,
        usage: { completion_tokens: pending === "search" ? 18 : 11 } });
      expect(workerSignals[0]?.aborted).toBe(true);
      if (pending === "search") expect(searchSignals[0]?.aborted).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(searchFetcher).toHaveBeenCalledTimes(pending === "search" ? 1 : 0);
    } finally { vi.useRealTimers(); }
  });

  it("cancels all ToA workers with the task without starting synthesis", async () => {
    const cancellation = new AbortController();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<FetchLike>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const client = new DeepSeekClient("key", fetcher, undefined, cancellation.signal);
    const running = toaAgent(client, "Compare options", new ModelConfig(), 2, undefined, [], [], cancellation.signal);
    const rejected = expect(running).rejects.toThrow("Stop task");
    expect(signals).toHaveLength(2);
    cancellation.abort(new Error("Stop task"));
    await rejected;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    { workers: 1, budget: 1_000, account: false },
    { workers: 2, budget: 1_000, account: true },
    { workers: 2, budget: 8_000, account: false },
    { workers: 1, budget: 8_000, account: true },
    { workers: 1, budget: 16_000, account: false },
    { workers: 2, budget: 16_000, account: true },
  ])("bounds every ToA round and totals provider usage: %j", async ({ workers, budget, account }) => {
    const requests: Array<{ role: string; tokens: number; limit: number }> = [];
    const fetcher: FetchLike = async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      const system = account ? payload.system.map((part: { text: string }) => part.text).join("\n") : payload.messages[0].content;
      const role = system.includes("prior draft identifies") ? "icm" : system.includes("root coordinator") ? "root"
        : system.includes("skeptical reviewer") ? "risk" : "evidence";
      if (role === "root") {
        const packets = JSON.parse(/Evidence packets:\n([^\n]+)/u.exec(system)![1]!);
        expect(packets).toHaveLength(workers);
        expect(packets.every((packet: object) => !Object.hasOwn(packet, "usage"))).toBe(true);
      }
      const tokens = Math.min(80, payload.max_tokens);
      requests.push({ role, tokens, limit: payload.max_tokens });
      const content = role === "root" ? "Root [ICM_GAP]" : `${role} answer`;
      const usage = account ? { input_tokens: 7, output_tokens: tokens, cache_creation_input_tokens: 2 }
        : { prompt_tokens: 7, completion_tokens: tokens, total_tokens: tokens + 7, completion_tokens_details: { reasoning_tokens: 3 } };
      if (account) return Response.json({ usage, content: payload.tools?.length
        ? [{ type: "tool_use", id: String(requests.length), name: "web_search", input: { query: "evidence" } }]
        : [{ type: "text", text: content }] });
      return Response.json({ usage, choices: [{ message: payload.tools?.length
        ? { content: "", tool_calls: [{ id: String(requests.length), function: { name: "web_search", arguments: '{"query":"evidence"}' } }] }
        : { content } }] });
    };
    const credential = account ? { kind: "account" as const, token: "grant" } : "key";
    const result = await toaAgent(new DeepSeekClient(credential, fetcher), "Compare options", new ModelConfig({ toaTokenBudget: budget }), workers, () => "[]");
    const total = requests.reduce((sum, request) => sum + request.tokens, 0);
    expect(total).toBeLessThanOrEqual(budget);
    expect(requests.every((request) => request.limit >= 1 && request.tokens <= request.limit)).toBe(true);
    expect(requests.filter((request) => request.role === "icm").length).toBeGreaterThan(1);
    expect(result.content).toContain("icm answer");
    expect(result.usage[account ? "output_tokens" : "completion_tokens"]).toBe(total);
    expect(result.usage[account ? "input_tokens" : "prompt_tokens"]).toBe(requests.length * 7);
    expect(result.usage.worker_count).toBe(workers);
    if (!account) expect(result.usage.completion_tokens_details).toEqual({ reasoning_tokens: requests.length * 3 });
  });
});
