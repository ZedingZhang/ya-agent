import { basename, join, resolve } from "node:path";
import { linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOT_PERMISSIONS_DIR, ModelConfig, loadConfig } from "../src/config";
import {
  GuiController,
  loadPreferences,
  preferencesPath,
  type TaskRunner,
} from "../src/gui/controller";
import { initialWindowGeometry } from "../src/gui/layout";
import { markdownLines } from "../src/gui/markdown";
import { appendAuditRecord } from "../src/local";
import { DeepSeekClient } from "../src/deepseek";
import { TaskStore, runTask } from "../src/service";
import type { ConversationMessage, UserImageContentPart } from "../src/types";
import { tempHome, type TempHome } from "./helpers";
import { clearAccountCredential, saveAccountCredential } from "../src/credentials";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { mockKeychain } = await import("./keychain-fixture");
  return { ...actual, execFileSync: mockKeychain(actual.execFileSync) };
});

describe("GUI controller", () => {
  let home: TempHome;
  beforeEach(() => { home = tempHome(); });
  afterEach(() => home.cleanup());

  it("defaults to English and persists language and streaming preferences", () => {
    const controller = new GuiController();
    expect(controller.language).toBe("en");
    expect(controller.stream).toBe(true);
    controller.setLanguage("zh-CN");
    controller.setStream(false);
    expect(loadPreferences()).toMatchObject({ language: "zh-CN", stream: false });
    expect(new GuiController()).toMatchObject({ language: "zh-CN", stream: false });
  });

  it("falls back safely when a preference file is malformed", () => {
    writeFileSync(preferencesPath(), "not json", "utf8");
    expect(loadPreferences()).toEqual({ language: "en", stream: true });
  });

  it("persists only picker grants per bot and ignores legacy workspace preferences", () => {
    const folder = join(home.path, "workspace");
    mkdirSync(folder);
    writeFileSync(preferencesPath(), JSON.stringify({ workspace: folder, workspaces: [folder], language: "zh-CN" }));
    const controller = new GuiController();
    controller.activeBotId = "first";
    expect(controller.folderAccess().workspace).toBeUndefined();
    controller.grantFolder("first", folder);
    expect(controller.folderAccess().validWorkspace).toBe(realpathSync(folder));
    controller.activeBotId = "second";
    expect(controller.workspaceEntries("second")).toEqual([]);
    expect(() => controller.workspaceEntries("first")).toThrow("Select this bot");
    expect(() => controller.grantFolder("first", folder)).toThrow("Select this bot");
    const restarted = new GuiController();
    expect(restarted.folderAccess().workspace).toBeUndefined();
    restarted.activeBotId = "first";
    expect(restarted.folderAccess().validWorkspace).toBe(realpathSync(folder));
    restarted.revokeFolder("first");
    controller.activeBotId = "first";
    expect(controller.folderAccess().validWorkspace).toBeUndefined();
  });

  it("allows subdirectories, rejects redirected folders, and replaces the old scope on a new grant", () => {
    const first = join(home.path, "first");
    const second = join(home.path, "second");
    mkdirSync(join(first, "nested"), { recursive: true });
    writeFileSync(join(first, "nested", "notes.txt"), "example");
    mkdirSync(second);
    const controller = new GuiController();
    controller.activeBotId = "bot";
    controller.grantFolder("bot", first);
    expect(controller.workspaceEntries("bot", "nested")).toEqual([{ path: join("nested", "notes.txt"), type: "file" }]);
    renameSync(first, first + "-moved");
    symlinkSync(second, first, process.platform === "win32" ? "junction" : "dir");
    expect(controller.folderAccess().validWorkspace).toBeUndefined();
    expect(controller.workspaceEntries("bot")).toEqual([]);
    controller.grantFolder("bot", second);
    expect(() => controller.workspaceEntries("bot", first + "-moved")).toThrow("inside the authorized workspace");
  });

  it("requires a new grant when another directory takes the same path", async () => {
    const folder = join(home.path, "notes");
    mkdirSync(folder);
    const runner = vi.fn<TaskRunner>(async () => ({ content: "", mode: "single", usage: {} }));
    const controller = new GuiController(runner);
    controller.setSessionApiKey("key");
    controller.activeBotId = "reviewer";
    controller.grantFolder("reviewer", folder);
    const physical = realpathSync(folder);
    writeFileSync(join(folder, "draft.txt"), "draft");
    await controller.run({ task: "List notes", sessionId: "reviewer", local: true });
    const oldTools = runner.mock.calls[0]![3]!.localWorkspace!;

    renameSync(folder, folder + "-original");
    mkdirSync(folder);
    const restarted = new GuiController();
    restarted.activeBotId = "reviewer";
    expect(restarted.folderAccess()).toEqual({ workspace: physical, validWorkspace: undefined });
    expect(() => oldTools.list({ path: "." })).toThrow("Folder access has changed");
    expect(restarted.grantFolder("reviewer", folder).validWorkspace).toBe(physical);
    expect(() => oldTools.list({ path: "." })).toThrow("Folder access has changed");
  });

  it("requires the picker to renew a legacy path-only grant", () => {
    const folder = join(home.path, "notes");
    mkdirSync(folder);
    const controller = new GuiController();
    controller.activeBotId = "reviewer";
    controller.grantFolder("reviewer", folder);
    const store = join(home.path, BOT_PERMISSIONS_DIR);
    writeFileSync(join(store, readdirSync(store)[0]!), realpathSync(folder));
    expect(controller.folderAccess().validWorkspace).toBeUndefined();
    expect(controller.grantFolder("reviewer", folder).validWorkspace).toBe(realpathSync(folder));
  });

  it("keeps folder grants private when the user selects the Ya data directory", async () => {
    const runner = vi.fn<TaskRunner>(async () => ({ content: "", mode: "single", usage: {} }));
    const controller = new GuiController(runner);
    controller.setSessionApiKey("key");
    controller.activeBotId = "bot";
    controller.grantFolder("bot", home.path);
    expect(() => controller.workspaceEntries("bot", BOT_PERMISSIONS_DIR)).toThrow("sensitive");
    await controller.run({ task: "write", sessionId: "bot", local: true });
    const files = runner.mock.calls[0]![3]!.localWorkspace!;
    await expect(files.write({ path: join(BOT_PERMISSIONS_DIR, "new"), content: home.path })).rejects.toThrow("sensitive");
  });

  it("saves model configuration and keeps a session-only API key", () => {
    const controller = new GuiController();
    const config = new ModelConfig({ model: "deepseek-v4-pro", thinkingEnabled: true, reasoningEffort: "max" });
    controller.saveModelConfig(config);
    controller.setSessionApiKey(" session-key ");
    expect(loadConfig()).toEqual(config);
    expect(controller.apiKey()).toBe("session-key");
  });

  it("shares a stored account login with task execution and preserves the session API key after sign-out", async () => {
    const account = { kind: "account", token: "account-test-token" } as const;
    let usedCredential: unknown;
    const controller = new GuiController(async (credential) => {
      usedCredential = credential;
      return { content: "Account answer", mode: "single", usage: {} };
    });
    controller.setSessionApiKey("session-key");
    saveAccountCredential(account);
    expect(controller.apiKey()).toEqual(account);
    await controller.run({ task: "Hello", webMode: "off" });
    expect(usedCredential).toEqual(account);
    clearAccountCredential();
    expect(controller.apiKey()).toBe("session-key");
  });

  it.each(["low", "high", "max"] as const)("persists %s workspace reasoning effort without changing settings-owned values", (reasoningEffort) => {
    const controller = new GuiController();
    controller.saveModelConfig(new ModelConfig({ thinkingEnabled: true, toaTokenBudget: 6_000, toaTimeout: 120 }));
    controller.saveWorkspaceModelSelection("deepseek-v4-pro", reasoningEffort);
    expect(loadConfig()).toEqual(new ModelConfig({
      model: "deepseek-v4-pro",
      reasoningEffort,
      thinkingEnabled: true,
      toaTokenBudget: 6_000,
      toaTimeout: 120,
    }));
  });

  it("streams only simple, non-local, non-ToA tasks", () => {
    const controller = new GuiController();
    expect(controller.canStream({ task: "Explain recursion" })).toBe(true);
    expect(controller.canStream({ task: "latest news" })).toBe(false);
    expect(controller.canStream({ task: "Explain recursion", toa: true })).toBe(false);
    expect(controller.canStream({ task: "Explain recursion", local: true })).toBe(false);
  });

  it("passes callbacks and a confined workspace to the shared task service", async () => {
    const calls: Parameters<TaskRunner>[] = [];
    const runner: TaskRunner = async (...arguments_) => {
      calls.push(arguments_);
      return { content: "answer", mode: "single", usage: {} };
    };
    const workspace = join(home.path, "workspace");
    mkdirSync(workspace);
    const controller = new GuiController(runner);
    controller.setSessionApiKey("key");
    controller.activeBotId = "bot";
    controller.grantFolder("bot", workspace);
    await controller.run({ task: "Create notes", sessionId: "bot", local: true }, { onLocalAction: () => true });
    const options = calls[0]![3]!;
    expect(options.localWorkspace?.root).toBe(realpathSync(workspace));
    expect(options.onContent).toBeUndefined();
    expect(await options.localWorkspace?.confirm({ operation: "mkdir", paths: [join(workspace, "notes")], summary: "Create" })).toBe(true);
  });

  it("binds local tools to the active bot and rechecks grants after approval", async () => {
    const first = join(home.path, "first");
    const second = join(home.path, "second");
    mkdirSync(first);
    mkdirSync(second);
    const runner = vi.fn<TaskRunner>(async () => ({ content: "", mode: "single", usage: {} }));
    const controller = new GuiController(runner);
    controller.setSessionApiKey("key");
    controller.activeBotId = "a";
    controller.grantFolder("a", first);
    const task = { task: "update notes", sessionId: "a", local: true };
    await expect(controller.run({ ...task, sessionId: "b" })).rejects.toThrow("Select this bot");
    await expect(controller.run({ ...task, exec: true })).rejects.toThrow("Shell commands");
    expect(runner).not.toHaveBeenCalled();
    await controller.run(task, { onLocalAction: () => { controller.revokeFolder("a"); return true; } });
    const files = runner.mock.calls[0]![3]!.localWorkspace!;
    expect(files.commandsEnabled).toBe(false);
    expect(() => files.list({ path: second })).toThrow("inside the authorized workspace");
    await expect(files.write({ path: "note", content: "hi" })).rejects.toThrow("Folder access has changed");
    expect(() => files.list({ path: "." })).toThrow("Folder access has changed");
    controller.grantFolder("a", second);
    expect(() => files.list({ path: "." })).toThrow("Folder access has changed");
  });

  it("preserves other links when a scoped bot requests a whole-file overwrite", async () => {
    const folder = join(home.path, "allowed");
    mkdirSync(folder);
    const original = join(home.path, "outside.txt");
    writeFileSync(original, "original");
    linkSync(original, join(folder, "linked.txt"));
    const runner = vi.fn<TaskRunner>(async () => ({ content: "", mode: "single", usage: {} }));
    const controller = new GuiController(runner);
    controller.setSessionApiKey("key");
    controller.activeBotId = "bot";
    controller.grantFolder("bot", folder);
    await controller.run({ task: "write", sessionId: "bot", local: true }, { onLocalAction: () => true });
    await expect(runner.mock.calls[0]![3]!.localWorkspace!.write({ path: "linked.txt", content: "new" }))
      .rejects.toThrow("hard-linked");
    expect(readFileSync(original, "utf8")).toBe("original");
  });

  it("passes a stream callback only for simple tasks", async () => {
    const calls: Parameters<TaskRunner>[] = [];
    const runner: TaskRunner = async (...arguments_) => {
      calls.push(arguments_);
      return { content: "answer", mode: "single", usage: {} };
    };
    const controller = new GuiController(runner);
    controller.setSessionApiKey("key");
    await controller.run({ task: "Explain recursion" }, { onContent: () => undefined });
    await controller.run({ task: "latest news" }, { onContent: () => undefined });
    expect(calls[0]![3]!.onContent).toBeTypeOf("function");
    expect(calls[1]![3]!.onContent).toBeUndefined();
  });

  it("passes selected vision content through the shared task service boundary", async () => {
    const calls: Parameters<TaskRunner>[] = [];
    const runner: TaskRunner = async (...arguments_) => {
      calls.push(arguments_);
      return { content: "answer", mode: "single", usage: {} };
    };
    const images: UserImageContentPart[] = [{
      type: "image_url",
      image_url: { url: "data:image/png;base64,iVBORw0KGgo=", detail: "auto" },
    }];
    const controller = new GuiController(runner);
    controller.setSessionApiKey("key");
    controller.saveModelConfig(new ModelConfig({ model: "deepseek-flash" }));
    await controller.run({ task: "Explain the image", images });
    expect(calls[0]![3]!.images).toEqual(images);
  });

  it("forwards the original request as history after configuring a missing API key", async () => {
    const calls: Parameters<TaskRunner>[] = [];
    const controller = new GuiController(async (...arguments_) => {
      calls.push(arguments_);
      return { content: "Creating ya.md", mode: "single", usage: {} };
    });
    const key = vi.spyOn(controller, "apiKey").mockReturnValue(undefined);
    await expect(controller.run({ task: "Create ya.md" })).rejects.toThrow("Sign in to DeepSeek or add an API key");
    expect(calls).toHaveLength(0);
    key.mockRestore();
    controller.setSessionApiKey("test-key");
    const history: ConversationMessage[] = [{ role: "user", content: "Create ya.md" }];
    await controller.run({ task: "继续", history });
    expect(calls[0]?.[1]).toBe("继续");
    expect(calls[0]?.[3]?.history).toEqual(history);
    await controller.run({ task: "New conversation" });
    expect(calls[1]?.[3]?.history).toBeUndefined();
  });

  it("rejects local plus ToA and missing local workspaces", async () => {
    const controller = new GuiController(async () => ({ content: "", mode: "single", usage: {} }));
    controller.setSessionApiKey("key");
    await expect(controller.run({ task: "test", toa: true, local: true })).rejects.toThrow(/cannot be used/u);
    controller.activeBotId = "bot";
    await expect(controller.run({ task: "test", sessionId: "bot", local: true })).rejects.toThrow(/Grant this bot/u);
  });

  it("uses only the active workspace even if a task supplies an arbitrary path", async () => {
    const runner = vi.fn<TaskRunner>(async () => ({ content: "", mode: "single", usage: {} }));
    const controller = new GuiController(runner);
    controller.setSessionApiKey("key");
    const selected = join(home.path, "selected");
    const outside = join(home.path, "outside");
    mkdirSync(selected); mkdirSync(outside);
    const options = { task: "Read notes", sessionId: "bot", local: true, workspace: outside };
    controller.activeBotId = "bot";
    await expect(controller.run(options)).rejects.toThrow(/Grant this bot/u);
    expect(runner).not.toHaveBeenCalled();
    controller.grantFolder("bot", selected);
    await controller.run(options);
    expect(runner.mock.calls[0]?.[3]?.localWorkspace?.root).toBe(realpathSync(selected));
  });

  it("lists navigation metadata without returning file contents", () => {
    const workspace = join(home.path, "workspace");
    mkdirSync(workspace);
    mkdirSync(join(workspace, "folder"));
    writeFileSync(join(workspace, "notes.txt"), "private note", "utf8");
    const controller = new GuiController();
    controller.activeBotId = "bot";
    controller.grantFolder("bot", workspace);
    const entries = controller.workspaceEntries("bot");
    expect(entries).toEqual([{ path: "folder", type: "directory" }, { path: "notes.txt", type: "file" }]);
    expect(JSON.stringify(entries)).not.toContain("private note");
  });

  it("manages memory and audit history", { timeout: 30_000 }, () => {
    const controller = new GuiController();
    const card = controller.createMemory("Use PostgreSQL indexes", "evidence", "procedure");
    controller.setMemoryStatus(card.id, "approved");
    expect(controller.relevantCards("Explain PostgreSQL indexes").map((match) => match.card.id)).toEqual([card.id]);
    controller.setMemoryStatus(card.id, "revoked");
    expect(controller.prunePreview().map((item) => item.id)).toEqual([card.id]);
    expect(controller.prune().map((item) => item.id)).toEqual([card.id]);
    appendAuditRecord({ record: 1 });
    expect(controller.auditLogs().map((path) => basename(path))).toEqual(["actions.jsonl"]);
    expect(controller.auditLogTotalBytes()).toBeGreaterThan(0);
    expect(controller.clearAuditLogs().map((path) => basename(path))).toEqual(["actions.jsonl"]);
  });

  it("binds GUI pruning to the preview instead of newly prunable cards", { timeout: 30_000 }, () => {
    const controller = new GuiController();
    const shown = controller.createMemory("shown", "evidence", "procedure");
    expect(controller.prunePreview(true).map((card) => card.id)).toEqual([shown.id]);
    const unseen = controller.createMemory("unseen", "evidence", "procedure");
    expect(controller.prune(true).map((card) => card.id)).toEqual([shown.id]);
    expect(controller.cards().map((card) => card.id)).toEqual([unseen.id]);
    expect(() => controller.prune(true)).toThrow(/Preview/u);
  });

  it("classifies previously active tasks as interrupted on controller startup and persists session-linked runs", async () => {
    const workspace = join(home.path, "workspace");
    mkdirSync(workspace);
    const previousProcessStore = new TaskStore();
    const orphaned = previousProcessStore.create({
      objective: "Previous process task",
      sessionId: "session-previous",
      workspace,
      options: { local: true, commandsEnabled: true, webMode: "off" },
    });

    const controller = new GuiController((apiKey, task, config, options = {}) => runTask(apiKey, task, config, {
      ...options,
      clientFactory: (key) => new DeepSeekClient(key, async () =>
        Response.json({ choices: [{ message: { role: "assistant", content: "Completed GUI task" } }] })),
    }));
    expect(controller.task(orphaned.id)).toMatchObject({
      id: orphaned.id,
      objective: "Previous process task",
      sessionId: "session-previous",
      workspace: realpathSync(workspace),
      status: "interrupted",
      revision: 2,
    });

    controller.setSessionApiKey("gui-session-secret");
    controller.activeBotId = "session-current";
    controller.grantFolder("session-current", workspace);
    const result = await controller.run({
      sessionId: "session-current",
      task: "Run current GUI task",
      local: true,
      webMode: "off",
    });
    expect(result.taskId).toBeTruthy();
    expect(controller.task(result.taskId!)).toMatchObject({
      id: result.taskId,
      objective: "Run current GUI task",
      sessionId: "session-current",
      workspace: realpathSync(workspace),
      status: "completed",
      revision: 2,
      options: { local: true, commandsEnabled: false, webMode: "off" },
    });
    expect(controller.tasks().map((record) => ({ id: record.id, status: record.status }))).toEqual([
      { id: orphaned.id, status: "interrupted" },
      { id: result.taskId!, status: "completed" },
    ]);
    expect(JSON.stringify(controller.tasks())).not.toContain("gui-session-secret");
  });
});

describe("GUI presentation helpers", () => {
  it("chooses a spacious centered initial geometry", () => {
    expect(initialWindowGeometry(2_048, 1_280)).toEqual({ width: 1_884, height: 1_152, x: 82, y: 64 });
    expect(initialWindowGeometry(1_280, 800)).toEqual({ width: 1_178, height: 720, x: 51, y: 40 });
  });

  it("parses headings, inline styles, links, lists, quotes, code, and tables", () => {
    const lines = markdownLines(`## Heading
**bold** and *italic* and \`code\` and [link](https://example.com)
- item
> quote
\`\`\`
const x = 1;
\`\`\`
| Name | Value |
| --- | --- |
| Ya | Agent |
`);
    expect(lines[0]).toEqual([{ text: "Heading", tags: ["heading"] }]);
    expect(lines.flat().some((span) => span.tags.includes("bold") && span.text === "bold")).toBe(true);
    expect(lines.flat().some((span) => span.tags.includes("italic") && span.text === "italic")).toBe(true);
    expect(lines.flat().some((span) => span.tags.includes("link") && span.url === "https://example.com")).toBe(true);
    expect(lines.flat().some((span) => span.tags.includes("code_block") && span.text === "const x = 1;")).toBe(true);
    expect(lines.flat().some((span) => span.text === "Name: ")).toBe(true);
  });

  it("removes terminal controls before GUI rendering", () => {
    expect(markdownLines("safe\u001b[31m text\u0007")).toEqual([[{ text: "safe text", tags: [] }]]);
  });
});
