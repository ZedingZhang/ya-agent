import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import type { ModelReply } from "../src/deepseek";
import type { ChatMessage, ToolDefinition, ToolHandler, UserImageContentPart } from "../src/types";
import { tempHome, type TempHome } from "./helpers";

function reply(content: string): ModelReply {
  return { content, toolCalls: [], usage: {}, assistantMessage: { role: "assistant", content } };
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
      new ModelConfig(),
      "off",
      undefined,
      undefined,
      undefined,
      [image],
    )).rejects.toThrow(/deepseek-v4-flash-vision-exp/u);
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

  it("propagates vision input to each ToA worker and root synthesis", async () => {
    const client = new FakeClient();
    await toaAgent(
      client,
      "Explain the chart",
      new ModelConfig({ model: "deepseek-v4-flash-vision-exp" }),
      2,
      async () => "[]",
      [image],
    );
    expect(client.calls).toHaveLength(3);
    for (const call of client.calls) {
      expect(call.messages[1]!.content).toEqual([{ type: "text", text: "Explain the chart" }, image]);
    }
  });

  it("marks synthesis partial when a worker fails", async () => {
    const client = new FakeClient();
    client.runWithTools = async (messages) => {
      const system = String(messages[0]?.content ?? "");
      if (system.includes("skeptical reviewer")) throw new Error("worker failed");
      if (system.includes("strongest available evidence")) return reply("evidence packet");
      return reply("partial synthesis");
    };
    const result = await toaAgent(client, "Compare options", new ModelConfig(), 2);
    expect(result.partial).toBe(true);
    expect(result.content).toBe("partial synthesis");
  });

  it("rejects more than two ToA workers", async () => {
    await expect(toaAgent(new FakeClient(), "task", new ModelConfig(), 3)).rejects.toThrow(/1 or 2/u);
  });
});
