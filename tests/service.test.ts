import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelConfig } from "../src/config";
import { DeepSeekClient, type FetchLike } from "../src/deepseek";
import { LocalWorkspace } from "../src/local";
import { runTask } from "../src/service";
import type { ChatMessage, ConversationMessage } from "../src/types";
import { tempHome, type TempHome } from "./helpers";

const history: ConversationMessage[] = [
  { role: "user", content: "新建一个 md 文件，内容是 Ya 的介绍" },
  { role: "assistant", content: "准备在工作区中创建 ya.md。" },
];

describe("conversation context in model requests", () => {
  let home: TempHome;
  beforeEach(() => { home = tempHome(); });
  afterEach(() => home.cleanup());

  it.each(["buffered", "streaming", "local", "toa"])("includes prior turns in %s requests", async (mode) => {
    const requests: Array<{ messages: ChatMessage[]; stream: boolean }> = [];
    const fetcher: FetchLike = async (_input, init) => {
      const payload = JSON.parse(String(init?.body));
      requests.push(payload);
      return new Response(payload.stream
        ? `data: ${JSON.stringify({ choices: [{ delta: { content: "继续创建 ya.md。" } }] })}\n\ndata: [DONE]\n\n`
        : JSON.stringify({ choices: [{ message: { role: "assistant", content: "继续创建 ya.md。" } }] }));
    };
    const chunks: string[] = [];
    const result = await runTask("test-key", "继续", new ModelConfig(), {
      history,
      webMode: "off",
      onContent: mode === "streaming" ? (chunk) => chunks.push(chunk) : undefined,
      localWorkspace: mode === "local" ? new LocalWorkspace(home.path, () => false) : undefined,
      toa: mode === "toa",
      clientFactory: (key) => new DeepSeekClient(key, fetcher),
    });
    expect(result.content).toBe("继续创建 ya.md。");
    expect(requests).toHaveLength(mode === "toa" ? 3 : 1);
    for (const request of requests) {
      expect(request.messages[0]?.role).toBe("system");
      expect(request.messages.slice(1)).toEqual([...history, { role: "user", content: "继续" }]);
    }
    if (mode === "streaming") expect(chunks).toEqual(["继续创建 ya.md。"]);
  });

  it("keeps conversation context in an ICM follow-up", async () => {
    const requests: ChatMessage[][] = [];
    const fetcher: FetchLike = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)).messages);
      const content = requests.length === 1 ? "Draft [ICM_GAP]" : "Evidence supplement";
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
    };
    await runTask("test-key", "继续", new ModelConfig(), {
      history, webMode: "off", clientFactory: (key) => new DeepSeekClient(key, fetcher),
    });
    expect(requests).toHaveLength(2);
    for (const messages of requests) expect(messages.slice(1)).toEqual([...history, { role: "user", content: "继续" }]);
  });

  it("does not carry another request's history into a run without history", async () => {
    const requests: ChatMessage[][] = [];
    const clientFactory = (key: string) => new DeepSeekClient(key, async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)).messages);
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "answer" } }] }));
    });
    await runTask("test-key", "继续", new ModelConfig(), { history, webMode: "off", clientFactory });
    await runTask("test-key", "Another conversation", new ModelConfig(), { webMode: "off", clientFactory });
    expect(requests[0]?.slice(1)).toEqual([...history, { role: "user", content: "继续" }]);
    expect(requests[1]?.slice(1)).toEqual([{ role: "user", content: "Another conversation" }]);
  });
});
