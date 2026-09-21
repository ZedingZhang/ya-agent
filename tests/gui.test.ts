import { basename, join, resolve } from "node:path";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelConfig, loadConfig } from "../src/config";
import {
  GuiController,
  loadPreferences,
  preferencesPath,
  type TaskRunner,
} from "../src/gui/controller";
import { initialWindowGeometry, initialWorkbenchColumns } from "../src/gui/layout";
import { markdownLines } from "../src/gui/markdown";
import { appendAuditRecord } from "../src/local";
import type { UserImageContentPart } from "../src/types";
import { tempHome, type TempHome } from "./helpers";

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

  it("persists an existing workspace but rejects it after removal", () => {
    const workspace = join(home.path, "workspace");
    mkdirSync(workspace);
    const controller = new GuiController();
    expect(controller.workspace).toBeUndefined();
    expect(controller.setWorkspace(workspace)).toBe(realpathSync(workspace));
    expect(new GuiController().validWorkspace()).toBe(realpathSync(workspace));
    rmSync(workspace, { recursive: true });
    expect(new GuiController().validWorkspace()).toBeUndefined();
  });

  it("saves model configuration and keeps a session-only API key", () => {
    const controller = new GuiController();
    const config = new ModelConfig({ model: "deepseek-v4-pro", thinkingEnabled: true, reasoningEffort: "max" });
    controller.saveModelConfig(config);
    controller.setSessionApiKey(" session-key ");
    expect(loadConfig()).toEqual(config);
    expect(controller.apiKey()).toBe("session-key");
  });

  it("persists workspace model controls without changing settings-owned values", () => {
    const controller = new GuiController();
    controller.saveModelConfig(new ModelConfig({ thinkingEnabled: true, toaTokenBudget: 6_000, toaTimeout: 120 }));
    controller.saveWorkspaceModelSelection("deepseek-v4-pro", "max");
    expect(loadConfig()).toEqual(new ModelConfig({
      model: "deepseek-v4-pro",
      reasoningEffort: "max",
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
    controller.setWorkspace(workspace);
    await controller.run({ task: "Create notes", local: true }, { onLocalAction: () => true });
    const options = calls[0]![3]!;
    expect(options.localWorkspace?.root).toBe(realpathSync(workspace));
    expect(options.onContent).toBeUndefined();
    expect(await options.localWorkspace?.confirm({ operation: "mkdir", paths: [join(workspace, "notes")], summary: "Create" })).toBe(true);
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

  it("rejects local plus ToA and missing local workspaces", async () => {
    const controller = new GuiController(async () => ({ content: "", mode: "single", usage: {} }));
    controller.setSessionApiKey("key");
    await expect(controller.run({ task: "test", toa: true, local: true })).rejects.toThrow(/cannot be used/u);
    await expect(controller.run({ task: "test", local: true })).rejects.toThrow(/Choose an existing/u);
  });

  it("lists navigation metadata without returning file contents", () => {
    const workspace = join(home.path, "workspace");
    mkdirSync(workspace);
    mkdirSync(join(workspace, "folder"));
    writeFileSync(join(workspace, "notes.txt"), "private note", "utf8");
    const controller = new GuiController();
    controller.setWorkspace(workspace);
    const entries = controller.workspaceEntries();
    expect(entries).toEqual([{ path: "folder", type: "directory" }, { path: "notes.txt", type: "file" }]);
    expect(JSON.stringify(entries)).not.toContain("private note");
  });

  it("manages memory and audit history", () => {
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
});

describe("GUI presentation helpers", () => {
  it("chooses a spacious centered initial geometry", () => {
    expect(initialWindowGeometry(2_048, 1_280)).toEqual({ width: 1_884, height: 1_152, x: 82, y: 64 });
    expect(initialWindowGeometry(1_280, 800)).toEqual({ width: 1_178, height: 720, x: 51, y: 40 });
    expect(initialWorkbenchColumns(1_720)).toEqual([10, 75, 15]);
    expect(initialWorkbenchColumns(1_020).reduce((sum, value) => sum + value, 0)).toBe(1_020);
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
