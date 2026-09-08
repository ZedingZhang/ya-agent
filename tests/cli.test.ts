import { PassThrough, Writable } from "node:stream";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, localConfirm, type CliIo } from "../src/cli";
import { DeepSeekClient, type ModelReply } from "../src/deepseek";
import { appendAuditRecord, auditLogFiles, type LocalAction } from "../src/local";
import { createCandidate, listCards, setStatus } from "../src/memory";
import { tempHome, type TempHome } from "./helpers";

class CaptureStream extends Writable {
  output = "";
  isTTY: boolean;

  constructor(isTTY: boolean) {
    super();
    this.isTTY = isTTY;
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.output += chunk.toString();
    callback();
  }
}

interface FakeIo {
  io: CliIo;
  stdout: CaptureStream;
  stderr: CaptureStream;
  prompts: string[];
}

function fakeIo(isTTY = false, answers: string[] = []): FakeIo {
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean };
  stdin.isTTY = isTTY;
  const stdout = new CaptureStream(isTTY);
  const stderr = new CaptureStream(isTTY);
  const prompts: string[] = [];
  return {
    stdout,
    stderr,
    prompts,
    io: {
      stdin,
      stdout,
      stderr,
      prompt: async (question) => {
        prompts.push(question);
        return answers.shift() ?? "";
      },
    },
  };
}

function modelReply(content: string): ModelReply {
  return { content, toolCalls: [], usage: {}, assistantMessage: { role: "assistant", content } };
}

function fakeClient(content = "## Title\n\n**bold**"): DeepSeekClient {
  return {
    completeStream: async (_messages, _config, _tokens, onContent) => {
      onContent(content);
      return modelReply(content);
    },
    runWithTools: async () => modelReply(content),
  } as unknown as DeepSeekClient;
}

function context(io: CliIo, client = fakeClient()) {
  return {
    io,
    runtime: {
      loadApiKey: () => "key",
      createClient: () => client,
      saveApiKey: () => undefined,
    },
  };
}

describe("CLI", () => {
  let home: TempHome;
  beforeEach(() => { home = tempHome(); });
  afterEach(() => home.cleanup());

  it("shows module help", async () => {
    const capture = fakeIo();
    expect(await main(["--help"], context(capture.io))).toBe(0);
    expect(capture.stdout.output).toContain("Usage: ya");
    expect(capture.stdout.output).toContain("ask");
  });

  it("sets validated configuration values", async () => {
    const capture = fakeIo();
    expect(await main(["config", "set", "model", "pro"], { io: capture.io })).toBe(0);
    expect(capture.stdout.output).toContain("deepseek-v4-pro");
    expect(await main(["config", "set", "unknown", "max"], { io: capture.io })).toBe(2);
    expect(capture.stderr.output).toContain("config key");
  });

  it("requires thinking when a one-off reasoning effort is supplied", async () => {
    const capture = fakeIo();
    expect(await main(["ask", "test", "--thinking", "off", "--reasoning-effort", "max"], context(capture.io))).toBe(2);
    expect(capture.stderr.output).toContain("requires --thinking on");
  });

  it("explains both portable and macOS API-key setup", async () => {
    const capture = fakeIo();
    const code = await main(["ask", "test"], {
      io: capture.io,
      runtime: { loadApiKey: () => undefined },
    });
    expect(code).toBe(2);
    expect(capture.stderr.output).toContain("DEEPSEEK_API_KEY");
    expect(capture.stderr.output).toContain("ya auth deepseek");
  });

  it("enforces mutually exclusive local and ToA options", async () => {
    const capture = fakeIo();
    expect(await main(["ask", "test", "--local", "--toa"], context(capture.io))).toBe(2);
    expect(await main(["ask", "test", "--approve"], context(capture.io))).toBe(2);
    expect(await main(["ask", "test", "--workspace", home.path], context(capture.io))).toBe(2);
  });

  it("requires explicit ToA permission in a non-interactive shell", async () => {
    const capture = fakeIo(false);
    expect(await main(["ask", "test", "--toa", "--no-feedback"], context(capture.io))).toBe(2);
    expect(capture.stderr.output).toContain("interactive confirmation or --yes");
  });

  it("rejects a third ToA worker at parse time", async () => {
    const capture = fakeIo();
    expect(await main(["ask", "test", "--toa-workers", "3"], context(capture.io))).not.toBe(0);
    expect(capture.stderr.output).toMatch(/allowed choices/iu);
  });

  it("renders Markdown for a TTY and preserves it for redirected output", async () => {
    const tty = fakeIo(true);
    expect(await main(["ask", "test", "--stream", "off", "--no-feedback"], context(tty.io))).toBe(0);
    expect(tty.stdout.output).toContain("Title");
    expect(tty.stdout.output).toContain("bold");
    expect(tty.stdout.output).not.toContain("## Title");
    expect(tty.stdout.output).not.toContain("**bold**");

    const pipe = fakeIo(false);
    expect(await main(["ask", "test", "--no-feedback"], context(pipe.io))).toBe(0);
    expect(pipe.stdout.output).toContain("## Title");
  });

  it("honors explicit Markdown and terminal output formats", async () => {
    const markdown = fakeIo(true);
    await main(["ask", "test", "--format", "markdown", "--no-feedback"], context(markdown.io));
    expect(markdown.stdout.output).toContain("## Title");
    const terminal = fakeIo(false);
    await main(["ask", "test", "--format", "terminal", "--no-feedback"], context(terminal.io));
    expect(terminal.stdout.output).toContain("Title");
    expect(terminal.stdout.output).not.toContain("## Title");
  });

  it("streams simple TTY answers", async () => {
    const capture = fakeIo(true);
    expect(await main(["ask", "explain a concept", "--no-feedback"], context(capture.io))).toBe(0);
    expect(capture.stdout.output).toContain("[Ya single result]");
    expect(capture.stdout.output).toContain("Title");
    expect(capture.stdout.output).not.toContain("## Title");
  });

  it("shows selected memory before the answer only when requested", async () => {
    const card = setStatus(createCandidate("Use PostgreSQL indexes", "evidence").id, "approved");
    const capture = fakeIo(false);
    await main(["ask", "Explain PostgreSQL indexes", "--show-memory", "--no-feedback"], context(capture.io, fakeClient("answer")));
    expect(capture.stdout.output).toContain("[Ya memory context]");
    expect(capture.stdout.output).toContain(card.id);
    expect(capture.stdout.output.indexOf(card.id)).toBeLessThan(capture.stdout.output.indexOf("[Ya single result]"));

    const silent = fakeIo(false);
    await main(["ask", "Explain PostgreSQL indexes", "--no-feedback"], context(silent.io, fakeClient("answer")));
    expect(silent.stdout.output).not.toContain("[Ya memory context]");
    expect(silent.stdout.output).not.toContain(card.id);
  });

  it("uses plain-language feedback prompts", async () => {
    const capture = fakeIo(true, ["n"]);
    await main(["ask", "test", "--stream", "off"], context(capture.io, fakeClient("answer")));
    expect(capture.prompts).toEqual(["\nLearn from this answer? [y/N] "]);
  });

  it("requires --approve for non-interactive local changes", async () => {
    const action: LocalAction = { operation: "mkdir", paths: [home.path], summary: "Create directory" };
    const capture = fakeIo(false);
    await expect(localConfirm(action, false, capture.io)).resolves.toBe(false);
    await expect(localConfirm(action, true, capture.io)).resolves.toBe(true);
    expect(capture.stdout.output).toContain("require --approve");
  });

  it("requires --yes to prune memory non-interactively", async () => {
    const card = setStatus(createCandidate("discard me", "evidence").id, "rejected");
    const denied = fakeIo(false);
    expect(await main(["memory", "prune"], { io: denied.io })).toBe(2);
    expect(listCards().map((item) => item.id)).toEqual([card.id]);
    const approved = fakeIo(false);
    expect(await main(["memory", "prune", "--yes"], { io: approved.io })).toBe(0);
    expect(approved.stdout.output).toContain("Deleted 1 memory card(s)");
    expect(listCards()).toEqual([]);
  });

  it("can decline interactive pruning", async () => {
    const card = setStatus(createCandidate("discard me", "evidence").id, "rejected");
    const capture = fakeIo(true, ["n"]);
    expect(await main(["memory", "prune"], { io: capture.io })).toBe(0);
    expect(capture.stdout.output).toContain("No memory cards deleted");
    expect(listCards().map((item) => item.id)).toEqual([card.id]);
  });

  it("clears audit history only with confirmation", async () => {
    appendAuditRecord({ record: 1 });
    writeFileSync(join(home.path, "actions.1.jsonl"), '{"record":0}\n');
    const denied = fakeIo(false);
    expect(await main(["audit", "clear"], { io: denied.io })).toBe(2);
    expect(auditLogFiles()).toHaveLength(2);
    const approved = fakeIo(false);
    expect(await main(["audit", "clear", "--yes"], { io: approved.io })).toBe(0);
    expect(approved.stdout.output).toContain("Deleted 2 audit log file(s)");
    expect(auditLogFiles()).toEqual([]);
  });

  it("reports an empty audit history", async () => {
    const capture = fakeIo();
    expect(await main(["audit", "clear", "--yes"], { io: capture.io })).toBe(0);
    expect(capture.stdout.output).toContain("No audit logs to delete");
  });
});
