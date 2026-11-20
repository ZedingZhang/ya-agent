import { ChildProcess, execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { basename, join, resolve } from "node:path";
import { chmodSync, constants, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOT_PERMISSIONS_DIR, ModelConfig, loadConfig } from "../src/config";
import {
  GuiController,
  loadPreferences,
  preferencesPath,
  type TaskRunner,
} from "../src/gui/controller";
import { FolderGrants, folderIdentityExecutable } from "../src/gui/folder-grants";
import { GrantedFolderIO } from "../src/gui/folder-io";
import { initialWindowGeometry } from "../src/gui/layout";
import { markdownLines } from "../src/gui/markdown";
import { appendAuditRecord, LocalWorkspace } from "../src/local";
import { DeepSeekClient } from "../src/deepseek";
import { TaskStore, runTask } from "../src/service";
import type { ConversationMessage, UserImageContentPart } from "../src/types";
import { tempHome, type TempHome } from "./helpers";
import { clearAccountCredential, saveAccountCredential } from "../src/credentials";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { mockKeychain } = await import("./keychain-fixture");
  return { ...actual, fork: vi.fn(actual.fork), execFileSync: mockKeychain(actual.execFileSync) };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, open: vi.fn(fs.open) };
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

  it("persists only picker grants per bot and ignores legacy workspace preferences", async () => {
    const folder = join(home.path, "workspace");
    mkdirSync(folder);
    writeFileSync(preferencesPath(), JSON.stringify({ workspace: folder, workspaces: [folder], language: "zh-CN" }));
    const controller = new GuiController();
    controller.activeBotId = "first";
    expect((await controller.folderAccess()).workspace).toBeUndefined();
    const access = await controller.grantFolder("first", folder);
    expect((await controller.folderAccess()).validWorkspace).toBe(realpathSync(folder));
    controller.activeBotId = "second";
    expect((await controller.workspaceEntries("second")).access.validWorkspace).toBeUndefined();
    await expect(controller.workspaceEntries("first")).rejects.toThrow("Select this bot");
    await expect(controller.grantFolder("first", folder)).rejects.toThrow("Select this bot");
    const restarted = new GuiController();
    expect((await restarted.folderAccess()).workspace).toBeUndefined();
    restarted.activeBotId = "first";
    expect((await restarted.folderAccess()).validWorkspace).toBe(access.folderSessionOnly ? undefined : realpathSync(folder));
    restarted.revokeFolder("first");
    controller.activeBotId = "first";
    expect((await controller.folderAccess()).validWorkspace).toBeUndefined();
  });

  it.each(["revoke", "regrant"])("keeps a later %s from a second store when a slow selection completes", async (operation) => {
    let finish!: (identity: string) => void;
    const pending = new Promise<string>((resolve) => { finish = resolve; });
    const identify = vi.fn(() => pending);
    const first = new FolderGrants(identify);
    const second = new FolderGrants(() => "new");
    if (operation === "regrant") await second.grant("bot", home.path);
    const stale = first.grant("bot", home.path);
    await vi.waitFor(() => expect(identify).toHaveBeenCalledOnce());
    // The other app instance edits the shared record using its own JS runtime.
    execFileSync(process.execPath, ["-e", `
      const { FolderGrants } = require("./dist/typescript/gui/folder-grants");
      const store = new FolderGrants(() => "replacement");
      store.revoke("bot");
      if (process.argv[1] === "regrant") store.grant("bot", process.env.YA_HOME).catch(() => { process.exitCode = 1; });
    `, operation]);
    const expected = second.read("bot");
    if (operation === "regrant") expect(expected?.identity).toBe("replacement");
    else expect(expected).toBeUndefined();
    finish("stale");
    await expect(stale).rejects.toThrow("no longer current");
    expect(first.read("bot")).toEqual(expected);
  });

  it("revokes an existing grant without staging a file and invalidates a picker started while revoked", async () => {
    const grants = new FolderGrants(() => "identity");
    await grants.grant("bot", home.path);
    const dir = join(home.path, BOT_PERMISSIONS_DIR);
    // Older grants predate lock files. Revocation must work even in that format.
    const lock = readdirSync(dir).find((name) => name.endsWith(".lock"))!;
    unlinkSync(join(dir, lock));
    const files = readdirSync(dir);
    if (process.platform !== "win32") chmodSync(dir, 0o500);
    try {
      grants.revoke("bot");
      expect(new FolderGrants().read("bot")).toBeUndefined();
      expect(readdirSync(dir)).toEqual(files);
    } finally { if (process.platform !== "win32") chmodSync(dir, 0o700); }
    const snapshot = grants.snapshot("bot");
    grants.revoke("bot");
    await expect(grants.grant("bot", home.path, undefined, snapshot)).rejects.toThrow("no longer current");
    expect((await grants.grant("bot", home.path)).identity).toBe("identity");
  });

  it("times out a stalled folder selection and discards its late identity", async () => {
    let finish!: (identity: string) => void;
    const identity = new Promise<string>((resolve) => { finish = resolve; });
    const identify = vi.fn().mockReturnValueOnce("original").mockReturnValueOnce(identity);
    const grants = new FolderGrants(identify);
    const original = await grants.grant("bot", home.path);
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    try {
      const selection = grants.grant("bot", home.path);
      const outcome = selection.catch((reason: unknown) => reason);
      await vi.waitFor(() => expect(identify).toHaveBeenCalledTimes(2));
      const expired = new Error("Folder selection timed out");
      deadline.abort(expired);
      expect(await Promise.race([outcome, new Promise((r) => setImmediate(() => r("pending")))])).toBe(expired);
      finish("late");
      await new Promise((r) => setImmediate(r));
      expect(grants.read("bot")).toEqual(original);
    } finally {
      finish("late");
      timeout.mockRestore();
    }
  });

  it.each(["open", "stat"])("releases a timed-out fallback handle after a stalled %s and retains the original pin", async (stage) => {
    const grants = new FolderGrants(() => undefined);
    const original = await grants.grant("bot", home.path);
    const originalId = grants.sessionDirectoryId("bot", original);
    const replacement = join(home.path, "other");
    mkdirSync(replacement);
    const handle = await open(replacement, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    const stats = await handle.stat({ bigint: true });
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const started = new Promise<void>((resolve) => { reached = resolve; });
    vi.mocked(open).mockImplementationOnce(async () => {
      if (stage === "open") { reached(); await stalled; }
      return handle;
    });
    if (stage === "stat") vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
      reached();
      await stalled;
      return stats;
    });
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    try {
      const selection = grants.grant("bot", replacement);
      const rejected = expect(selection).rejects.toThrow("timed out");
      await started;
      deadline.abort(new Error("Folder selection timed out"));
      await rejected;
      release();
      await vi.waitFor(() => expect(handle.fd).toBe(-1));
      expect(grants.read("bot")).toEqual(original);
      expect(grants.sessionDirectoryId("bot", original)).toEqual(originalId);
    } finally {
      release();
      timeout.mockRestore();
      await handle.close();
      grants.revoke("bot");
    }
  });

  it("allows subdirectories, rejects redirected folders, and replaces the old scope on a new grant", async () => {
    const first = join(home.path, "first");
    const second = join(home.path, "second");
    mkdirSync(join(first, "nested"), { recursive: true });
    writeFileSync(join(first, "nested", "notes.txt"), "example");
    mkdirSync(second);
    const controller = new GuiController();
    controller.activeBotId = "bot";
    const firstGrant = await controller.grantFolder("bot", first);
    expect((await controller.workspaceEntries("bot", "nested", firstGrant.folderGrantVersion)).entries).toEqual([{ path: join("nested", "notes.txt"), type: "file" }]);
    renameSync(first, first + "-moved");
    symlinkSync(second, first, process.platform === "win32" ? "junction" : "dir");
    expect((await controller.folderAccess()).validWorkspace).toBeUndefined();
    expect((await controller.workspaceEntries("bot")).access.validWorkspace).toBeUndefined();
    const secondGrant = await controller.grantFolder("bot", second);
    await expect(controller.workspaceEntries("bot", first + "-moved", secondGrant.folderGrantVersion)).rejects.toThrow("inside the authorized workspace");
  });

  it("requires a new grant when another directory takes the same path", async () => {
    const folder = join(home.path, "notes");
    mkdirSync(folder);
    const runner = vi.fn<TaskRunner>(async () => ({ content: "", mode: "single", usage: {} }));
    const controller = new GuiController(runner);
    controller.setSessionApiKey("key");
    controller.activeBotId = "reviewer";
    const { folderGrantVersion } = await controller.grantFolder("reviewer", folder);
    const physical = realpathSync(folder);
    writeFileSync(join(folder, "draft.txt"), "draft");
    await controller.run({ task: "List notes", sessionId: "reviewer", local: true, folderGrantVersion });
    const oldTools = runner.mock.calls[0]![3]!.localWorkspace!;

    renameSync(folder, folder + "-original");
    mkdirSync(folder);
    const restarted = new GuiController();
    restarted.activeBotId = "reviewer";
    expect(await restarted.folderAccess()).toMatchObject({ workspace: physical, validWorkspace: undefined });
    await expect(Promise.resolve().then(() => oldTools.list({ path: "." }))).rejects.toThrow("Folder access has changed");
    expect((await restarted.grantFolder("reviewer", folder)).validWorkspace).toBe(physical);
    await expect(Promise.resolve().then(() => oldTools.list({ path: "." }))).rejects.toThrow("Folder access has changed");
  });

  it("binds submission to the displayed grant, including a new selection of the same folder", async () => {
    const first = join(home.path, "first");
    const second = join(home.path, "second");
    mkdirSync(first);
    mkdirSync(second);
    const runner = vi.fn<TaskRunner>(async () => ({ content: "", mode: "single", usage: {} }));
    const controller = new GuiController(runner);
    controller.activeBotId = "bot";
    controller.setSessionApiKey("key");
    const firstGrant = await controller.grantFolder("bot", first);
    const task = { sessionId: "bot", task: "List files", local: true, folderGrantVersion: firstGrant.folderGrantVersion };
    const callbacks = { onStarted: vi.fn(), loadImages: vi.fn(() => []) };
    const other = new GuiController();
    other.activeBotId = "bot";
    const replacement = await other.grantFolder("bot", second);
    await expect(controller.run(task, callbacks)).rejects.toMatchObject({ access: { workspace: replacement.workspace } });
    const renewed = await controller.grantFolder("bot", first);
    expect(renewed.folderGrantVersion).not.toBe(firstGrant.folderGrantVersion);
    await expect(controller.run(task, callbacks)).rejects.toMatchObject({ access: renewed });
    expect(callbacks.onStarted).not.toHaveBeenCalled();
    expect(callbacks.loadImages).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    await controller.run({ ...task, folderGrantVersion: renewed.folderGrantVersion }, callbacks);
    expect(callbacks.onStarted).toHaveBeenCalledOnce();
    expect(callbacks.loadImages).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0]?.[3]?.localWorkspace?.root).toBe(realpathSync(first));
  });

  it("retains the original folder when a backup restores directory timestamps", async () => {
    const folder = join(home.path, "notes");
    mkdirSync(folder);
    const controller = new GuiController();
    controller.activeBotId = "reviewer";
    const access = await controller.grantFolder("reviewer", folder);
    const oldDate = new Date("2020-01-01T00:00:00Z");
    utimesSync(folder, oldDate, oldDate);
    expect((await controller.folderAccess()).validWorkspace).toBe(realpathSync(folder));
    const restarted = new GuiController();
    restarted.activeBotId = "reviewer";
    expect((await restarted.folderAccess()).validWorkspace).toBe(access.folderSessionOnly ? undefined : realpathSync(folder));
  });

  it("pins unsupported filesystems only for the current process and requires a fresh selection after replacement", async () => {
    const folder = join(home.path, "notes");
    mkdirSync(folder);
    const store = new FolderGrants(() => undefined);
    const grant = await store.grant("reviewer", folder);
    try {
      expect(await new GrantedFolderIO(store, "reviewer", grant).available()).toBe(true);
      const restarted = new FolderGrants(() => undefined);
      expect(await new GrantedFolderIO(restarted, "reviewer", restarted.read("reviewer")!).available()).toBe(false);
      renameSync(folder, folder + "-previous");
      mkdirSync(folder);
      expect(await new GrantedFolderIO(store, "reviewer", grant).available()).toBe(false);
      const replacement = await store.grant("reviewer", folder);
      expect(await new GrantedFolderIO(store, "reviewer", grant).available()).toBe(false);
      expect(await new GrantedFolderIO(store, "reviewer", replacement).available()).toBe(true);
    } finally {
      store.revoke("reviewer");
    }
  });

  it("searches relative to a pinned session grant in a separate process", async () => {
    const folder = join(home.path, "notes");
    mkdirSync(join(folder, "drafts", "nested"), { recursive: true });
    writeFileSync(join(folder, "drafts", "nested", "一.txt"), "FIRST\nneedle");
    writeFileSync(join(folder, "drafts", "z.txt"), "needle");
    writeFileSync(join(folder, "outside-subdirectory.txt"), "needle");
    const grants = new FolderGrants(() => undefined);
    const grant = await grants.grant("bot", folder);
    try {
      const files = new GrantedFolderIO(grants, "bot", grant);
      expect(JSON.parse(await files.search("drafts", "needle")).results).toEqual([
        { path: join("drafts", "nested", "一.txt"), match: "text", line: 2, text: "needle" },
        { path: join("drafts", "z.txt"), match: "text", line: 1, text: "needle" },
      ]);
      grants.revoke("bot");
      await expect(files.search(".", "needle")).rejects.toThrow("Folder access has changed");
    } finally {
      grants.revoke("bot");
    }
  });

  it.each(["read", "list", "search"])("discards %s results when another controller revokes the grant before delivery", async (operation) => {
    const folder = join(home.path, "notes");
    mkdirSync(folder);
    writeFileSync(join(folder, "notes.txt"), "needle");
    const runner = vi.fn<TaskRunner>(async () => ({ content: "", mode: "single", usage: {} }));
    const controller = new GuiController(runner);
    controller.activeBotId = "bot";
    controller.setSessionApiKey("key");
    const other = new GuiController();
    other.activeBotId = "bot";
    const { folderGrantVersion } = await controller.grantFolder("bot", folder);
    const revoke = vi.fn(() => other.revokeFolder("bot"));
    await controller.run({ task: "search notes", sessionId: "bot", local: true, folderGrantVersion }, { onLocalActivity: revoke });
    const files = runner.mock.calls[0]![3]!.localWorkspace!;
    const tool = files.toolHandlers[`local_${operation}`]!;
    await expect(Promise.resolve().then(() => tool({ path: operation === "read" ? "notes.txt" : ".", query: "needle" })))
      .rejects.toThrow("Folder access has changed");
    expect(revoke).toHaveBeenCalledOnce();
  });

  it.each(["list", "read", "search"])("cancels a desktop %s without blocking the event loop", async (operation) => {
    const folder = join(home.path, "notes");
    mkdirSync(folder);
    writeFileSync(join(folder, "one.txt"), "needle");
    const runner = vi.fn<TaskRunner>(async () => ({ content: "", mode: "single", usage: {} }));
    const controller = new GuiController(runner);
    controller.activeBotId = "bot";
    controller.setSessionApiKey("key");
    const { folderGrantVersion } = await controller.grantFolder("bot", folder);
    const abort = new AbortController();
    await controller.run({ task: "search", sessionId: "bot", local: true, folderGrantVersion }, { signal: abort.signal });
    const files = runner.mock.calls[0]![3]!.localWorkspace!;
    const pending = files.toolHandlers[`local_${operation}`]!({ path: operation === "read" ? "one.txt" : ".", query: "needle" });
    setImmediate(() => abort.abort(new Error("Stopped by the user")));
    await expect(pending).rejects.toThrow("Stopped by the user");
  });

  it("stops a mutation before approval even while the worker is still exiting", async () => {
    const child = new ChildProcess();
    const send = vi.fn(() => true);
    child.send = send;
    vi.spyOn(child, "kill").mockReturnValue(true);
    vi.mocked(fork).mockReturnValueOnce(child);
    const grants = new FolderGrants();
    const files = new GrantedFolderIO(grants, "bot", { path: home.path, version: "version", identity: "identity" });
    const stop = new AbortController();
    const confirm = vi.fn(async () => true);
    const result = files.mkdir("notes", confirm, stop.signal).catch((reason: unknown) => reason);
    const stopped = new Error("Stopped by the user");
    stop.abort(stopped);
    try {
      expect(await Promise.race([result, new Promise((r) => setImmediate(() => r("pending")))])).toBe(stopped);
      child.emit("message", { type: "preview", paths: ["notes"] });
      expect(confirm).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);
    } finally { child.emit("close", 1); }
  });

  it.each([false, true])("settles Stop while tracking an approved write (stalled worker: %s)", async (stalled) => {
    const child = new ChildProcess();
    child.connected = true;
    let approvalSent!: () => void;
    const committing = new Promise<void>((resolve) => { approvalSent = resolve; });
    child.send = (message) => { if (message === true) approvalSent(); return true; };
    const kill = vi.spyOn(child, "kill").mockReturnValue(true);
    vi.mocked(fork).mockReturnValueOnce(child);
    const stop = new AbortController();
    const onActivity = vi.fn();
    const onFileChange = vi.fn();
    const scopedFolder = new GrantedFolderIO(new FolderGrants(), "bot", { path: home.path, version: "version", identity: "identity" });
    const workspace = new LocalWorkspace(home.path, () => true, onActivity, { scopedFolder, signal: stop.signal, onFileChange });
    const write = workspace.write({ path: "notes.txt", content: "approved" });
    child.emit("message", { type: "preview", paths: ["notes.txt"] });
    await committing;
    stop.abort(new Error("Stopped by the user"));
    if (stalled) {
      await expect(write).rejects.toThrow("outcome is pending");
      expect(onActivity).toHaveBeenCalledWith({ operation: "write", paths: ["notes.txt"], status: "pending" });
      expect(onFileChange).not.toHaveBeenCalled();
    }
    child.emit("message", { type: "result", value: "written" });
    child.emit("close", 0);
    if (stalled) await vi.waitFor(() => expect(onFileChange).toHaveBeenCalledOnce());
    else expect(JSON.parse(await write).status).toBe("ok");
    expect(kill).not.toHaveBeenCalled();
    expect(onFileChange).toHaveBeenCalledWith(expect.objectContaining({ operation: "create", path: "notes.txt" }));
    expect(onActivity).toHaveBeenCalledWith({ operation: "write", paths: ["notes.txt"], status: "success" });
  });

  it("accepts another spelling of the same directory on case-insensitive volumes", async (context) => {
    const folder = join(home.path, "notes");
    mkdirSync(join(folder, "Drafts"), { recursive: true });
    if (!existsSync(join(folder, "drafts"))) return context.skip();
    writeFileSync(join(folder, "Drafts", "one.txt"), "needle");
    const grants = new FolderGrants();
    const files = new GrantedFolderIO(grants, "bot", await grants.grant("bot", folder));
    try {
      expect(JSON.parse(await files.search("drafts", "needle")).results).toEqual([
        { path: join("drafts", "one.txt"), match: "text", line: 1, text: "needle" },
      ]);
    } finally { grants.revoke("bot"); }
  });

  it.each([false, true])("abandons an approved write after the folder grant changes (existing file: %s)", async (existing) => {
    const folder = join(home.path, "notes");
    const replacement = join(home.path, "other");
    mkdirSync(folder);
    mkdirSync(replacement);
    if (existing) writeFileSync(join(folder, "note.txt"), "draft");
    writeFileSync(join(replacement, "note.txt"), "other");
    const grants = new FolderGrants();
    const files = new GrantedFolderIO(grants, "bot", await grants.grant("bot", folder));
    try {
      await expect(files.write("note.txt", "approved", async (previous) => {
        expect(previous).toBe(existing ? "draft" : undefined);
        await grants.grant("bot", replacement);
        return true;
      })).rejects.toThrow("Folder access has changed");
      expect(existing ? readFileSync(join(folder, "note.txt"), "utf8") : existsSync(join(folder, "note.txt"))).toBe(existing ? "draft" : false);
      expect(readFileSync(join(replacement, "note.txt"), "utf8")).toBe("other");
    } finally { grants.revoke("bot"); }
  });

  // Windows locks the child process's working directory for the lifetime of the approval.
  it.skipIf(process.platform === "win32")("abandons a new file when its parent directory is replaced during approval", async () => {
    const folder = join(home.path, "notes");
    const drafts = join(folder, "drafts");
    const archive = join(folder, "archive");
    mkdirSync(drafts, { recursive: true });
    const grants = new FolderGrants();
    const files = new GrantedFolderIO(grants, "bot", await grants.grant("bot", folder));
    try {
      await expect(files.write(join("drafts", "note.txt"), "approved", async () => {
        renameSync(drafts, archive);
        mkdirSync(drafts);
        return true;
      })).rejects.toThrow("directory has changed");
      expect(readdirSync(drafts)).toEqual([]);
      expect(readdirSync(archive)).toEqual([]);
    } finally { grants.revoke("bot"); }
  });

  it("preserves a newer revision saved while the write approval is open", async () => {
    const folder = join(home.path, "notes");
    mkdirSync(folder);
    const note = join(folder, "note.txt");
    writeFileSync(note, "draft");
    const grants = new FolderGrants();
    const files = new GrantedFolderIO(grants, "bot", await grants.grant("bot", folder));
    try {
      await expect(files.write("note.txt", "approved", async () => {
        writeFileSync(note, "user update");
        return true;
      })).rejects.toThrow("File changed during approval");
      expect(readFileSync(note, "utf8")).toBe("user update");
    } finally { grants.revoke("bot"); }
  });

  it("releases a pending move when the parent disconnects before approval", { timeout: 15_000 }, async () => {
    const directory = join(home.path, "notes");
    mkdirSync(directory);
    writeFileSync(join(directory, "draft.txt"), "draft");
    const grants = new FolderGrants();
    const grant = await grants.grant("bot", directory);
    const worker = fork(resolve("dist/typescript/gui/folder-io.js"), [], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const timeout = () => AbortSignal.timeout(5_000);
    try {
      const preview = once(worker, "message", { signal: timeout() });
      worker.send({ botId: "bot", grant, sessionDirectoryId: grants.sessionDirectoryId("bot", grant),
        operation: { kind: "move", path: "draft.txt", destination: "final.txt" }, identityExecutable: folderIdentityExecutable() });
      const [message] = await preview;
      expect(message).toMatchObject({ type: "preview" });
      const exited = once(worker, "exit", { signal: timeout() });
      worker.disconnect();
      const [exitCode] = await exited;
      expect(exitCode).toBe(0);
      expect(readdirSync(directory)).toEqual(["draft.txt"]);
    } finally {
      if (worker.exitCode === null) worker.kill();
      grants.revoke("bot");
    }
  });

  it("creates and replaces text using the approved directory and file handles", async () => {
    const folder = join(home.path, "notes");
    mkdirSync(folder);
    const grants = new FolderGrants();
    const files = new GrantedFolderIO(grants, "bot", await grants.grant("bot", folder));
    try {
      for (const [before, after] of [[undefined, "original draft"], ["original draft", "短"], ["短", "a longer draft"]] as const) {
        await expect(files.write("note.txt", after, async (previous) => previous === before)).resolves.toMatchObject({ approved: true });
        expect(await files.read("note.txt")).toBe(after);
      }
      await expect(files.write("note.txt", "discard", async () => false)).resolves.toMatchObject({ approved: false });
      expect(readFileSync(join(folder, "note.txt"), "utf8")).toBe("a longer draft");
    } finally { grants.revoke("bot"); }
  });

  it("keeps identity-bound grants from earlier releases usable until the next selection", async () => {
    const folder = join(home.path, "notes");
    mkdirSync(folder);
    const store = new FolderGrants(() => "persistent-directory-id");
    const { path, identity } = await store.grant("bot", folder);
    const directory = join(home.path, BOT_PERMISSIONS_DIR);
    writeFileSync(join(directory, readdirSync(directory)[0]!), JSON.stringify({ path, identity }));
    const legacy = store.read("bot")!;
    expect(legacy).toMatchObject({ path, identity });
    expect(new FolderGrants().read("bot")?.version).toBe(legacy.version);
    expect((await store.grant("bot", folder)).version).not.toBe(legacy.version);
  });

  it("requires the picker to renew a legacy path-only grant", async () => {
    const folder = join(home.path, "notes");
    mkdirSync(folder);
    const controller = new GuiController();
    controller.activeBotId = "reviewer";
    await controller.grantFolder("reviewer", folder);
    const store = join(home.path, BOT_PERMISSIONS_DIR);
    writeFileSync(join(store, readdirSync(store)[0]!), realpathSync(folder));
    expect((await controller.folderAccess()).validWorkspace).toBeUndefined();
    expect((await controller.grantFolder("reviewer", folder)).validWorkspace).toBe(realpathSync(folder));
  });

  it("keeps folder grants private when the user selects the Ya data directory", async () => {
    const runner = vi.fn<TaskRunner>(async () => ({ content: "", mode: "single", usage: {} }));
    const controller = new GuiController(runner);
    controller.setSessionApiKey("key");
    controller.activeBotId = "bot";
    const { folderGrantVersion } = await controller.grantFolder("bot", home.path);
    await expect(controller.workspaceEntries("bot", BOT_PERMISSIONS_DIR, folderGrantVersion)).rejects.toThrow("sensitive");
    await controller.run({ task: "write", sessionId: "bot", local: true, folderGrantVersion });
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
    const { folderGrantVersion } = await controller.grantFolder("bot", workspace);
    await controller.run({ task: "Create notes", sessionId: "bot", local: true, folderGrantVersion }, { onLocalAction: () => true });
    const options = calls[0]![3]!;
    expect(options.localWorkspace?.root).toBe(realpathSync(workspace));
    expect(options.onContent).toBeUndefined();
    expect(await options.localWorkspace?.confirm({ operation: "mkdir", paths: [join(workspace, "notes")], summary: "Create" })).toBe(true);
  });

  it("creates a task record without reopening a mount after the GUI verified its grant", async () => {
    const folder = join(home.path, "selected");
    mkdirSync(folder);
    const controller = new GuiController((key, task, config, options) => {
      // The verified mount becomes unavailable just as the real service starts.
      renameSync(folder, folder + "-detached");
      return runTask(key, task, config, {
        ...options, clientFactory: (credential) => new DeepSeekClient(credential, async () =>
          Response.json({ choices: [{ message: { role: "assistant", content: "done" } }] })),
      });
    });
    controller.setSessionApiKey("test-key");
    controller.activeBotId = "bot";
    const { workspace, folderGrantVersion } = await controller.grantFolder("bot", folder);
    const result = await controller.run({ task: "chat", sessionId: "bot", local: true, webMode: "off", folderGrantVersion });
    expect(controller.task(result.taskId!)?.workspace).toBe(workspace);
    expect(() => new TaskStore().create({ objective: "direct", workspace })).toThrow("does not exist");
    controller.revokeFolder("bot");
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
    const { folderGrantVersion } = await controller.grantFolder("a", first);
    const task = { task: "update notes", sessionId: "a", local: true, folderGrantVersion };
    await expect(controller.run({ ...task, sessionId: "b" })).rejects.toThrow("Select this bot");
    await expect(controller.run({ ...task, exec: true })).rejects.toThrow("Shell commands");
    expect(runner).not.toHaveBeenCalled();
    await controller.run(task, { onLocalAction: () => { controller.revokeFolder("a"); return true; } });
    const files = runner.mock.calls[0]![3]!.localWorkspace!;
    expect(files.commandsEnabled).toBe(false);
    await expect(files.list({ path: second })).rejects.toThrow("inside the authorized workspace");
    await expect(files.write({ path: "note", content: "hi" })).rejects.toThrow("Folder access has changed");
    await expect(Promise.resolve().then(() => files.list({ path: "." }))).rejects.toThrow("Folder access has changed");
    await controller.grantFolder("a", second);
    await expect(Promise.resolve().then(() => files.list({ path: "." }))).rejects.toThrow("Folder access has changed");
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
    const { folderGrantVersion } = await controller.grantFolder("bot", folder);
    await controller.run({ task: "write", sessionId: "bot", local: true, folderGrantVersion }, { onLocalAction: () => true });
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
    await expect(controller.run({ task: "test", sessionId: "bot", local: true })).rejects.toThrow(/Folder access has changed/u);
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
    await expect(controller.run(options)).rejects.toThrow(/Folder access has changed/u);
    expect(runner).not.toHaveBeenCalled();
    const { folderGrantVersion } = await controller.grantFolder("bot", selected);
    await expect(controller.run(options)).rejects.toThrow("Folder access has changed");
    expect(runner).not.toHaveBeenCalled();
    await controller.run({ ...options, folderGrantVersion });
    expect(runner.mock.calls[0]?.[3]?.localWorkspace?.root).toBe(realpathSync(selected));
  });

  it("lists navigation metadata without returning file contents", async () => {
    const workspace = join(home.path, "workspace");
    mkdirSync(workspace);
    mkdirSync(join(workspace, "folder"));
    writeFileSync(join(workspace, "notes.txt"), "private note", "utf8");
    const controller = new GuiController();
    controller.activeBotId = "bot";
    await controller.grantFolder("bot", workspace);
    const { entries, access } = await controller.workspaceEntries("bot");
    expect(access.validWorkspace).toBe(realpathSync(workspace));
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
    const { folderGrantVersion } = await controller.grantFolder("session-current", workspace);
    const result = await controller.run({
      sessionId: "session-current",
      task: "Run current GUI task",
      local: true, folderGrantVersion,
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
