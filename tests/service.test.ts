import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/config";
import { DeepSeekClient, type FetchLike } from "../src/deepseek";
import { LocalWorkspace } from "../src/local";
import {
  StaleTaskRecordError,
  TASK_STORE_VERSION,
  TaskStore,
  TaskTransitionError,
  getTask,
  listTasks,
  openTaskStore,
  readTask,
  reconcileInterruptedTasks,
  runTask,
  tasksPath,
  type TaskRecord,
  type TaskStatus,
} from "../src/service";
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

describe("durable task identity and lifecycle records", () => {
  let home: TempHome;
  const compiled = mkdtempSync(join(tmpdir(), "ya-tasks-build-"));
  beforeAll(() => {
    execFileSync(process.execPath, [
      resolve("node_modules/typescript/bin/tsc"),
      "-p",
      "tsconfig.json",
      "--outDir",
      compiled,
      "--declaration",
      "false",
      "--declarationMap",
      "false",
      "--sourceMap",
      "false",
    ], { timeout: 30_000 });
  }, 30_000);
  afterAll(() => rmSync(compiled, { recursive: true, force: true }));
  beforeEach(() => { home = tempHome(); });
  afterEach(() => home.cleanup());

  it.each([
    [null, "EOF"],
    ["aborted", "EOF"],
    ["aborted", "[DONE]"],
    ["insufficient_system_resource", "EOF"],
    ["insufficient_system_resource", "[DONE]"],
  ] as const)("records a failed task for finish reason %s followed by %s", async (reason, ending) => {
    let body = 'data: {"choices":[{"delta":{"content":"Partial answer"},"finish_reason":null}]}\n\n';
    if (reason) body += `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\n`;
    if (ending === "[DONE]") body += "data: [DONE]\n\n";
    const fetcher = vi.fn<FetchLike>(async () => new Response(body));
    const onContent = vi.fn();
    const taskStore = new TaskStore();
    await expect(runTask("test-key", "Stream an answer", new ModelConfig(), {
      taskStore,
      webMode: "off",
      onContent,
      clientFactory: (key) => new DeepSeekClient(key, fetcher),
    })).rejects.toThrow(reason ?? "DeepSeek API stream ended before completion.");

    expect(onContent).toHaveBeenCalledExactlyOnceWith("Partial answer");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(taskStore.list()).toMatchObject([{ status: "failed", revision: 2 }]);
    expect(taskStore.list({ status: "completed" })).toEqual([]);
  });

  it("creates one stable task ID and readable record across running and terminal states", async () => {
    const workspaceDir = join(home.path, "workspace");
    mkdirSync(workspaceDir);
    const physicalWorkspace = realpathSync(workspaceDir);
    const config = new ModelConfig({
      model: "deepseek-v4-pro",
      thinkingEnabled: true,
      reasoningEffort: "max",
      toaTokenBudget: 10_000,
      toaTimeout: 120,
    });
    let createdSnapshot: TaskRecord | undefined;
    let inFlightSnapshot: TaskRecord | undefined;

    const result = await runTask("test-key", "Inspect and verify repository", config, {
      sessionId: "session-alpha",
      history,
      webMode: "on",
      localWorkspace: new LocalWorkspace(workspaceDir, () => false, undefined, { commandsEnabled: true }),
      onTaskCreated: (record) => {
        createdSnapshot = record;
      },
      clientFactory: (key) => new DeepSeekClient(key, async () => {
        inFlightSnapshot = readTask(createdSnapshot!.id);
        return Response.json({ choices: [{ message: { role: "assistant", content: "Verified." } }] });
      }),
    });

    expect(createdSnapshot).toBeDefined();
    expect(inFlightSnapshot).toBeDefined();
    expect(result.taskId).toBe(createdSnapshot!.id);
    expect(inFlightSnapshot).toEqual({
      id: createdSnapshot!.id,
      objective: "Inspect and verify repository",
      sessionId: "session-alpha",
      workspace: physicalWorkspace,
      options: {
        model: "deepseek-v4-pro",
        thinkingEnabled: true,
        reasoningEffort: "max",
        webMode: "on",
        toa: false,
        toaWorkers: 2,
        toaTokenBudget: 10_000,
        toaTimeout: 120,
        local: true,
        commandsEnabled: true,
        stream: false,
        imageCount: 0,
        historyLength: 2,
      },
      status: "running",
      revision: 1,
      createdAt: createdSnapshot!.createdAt,
      updatedAt: createdSnapshot!.updatedAt,
    });

    const completed = getTask(result.taskId!);
    expect(completed).toEqual({
      id: createdSnapshot!.id,
      objective: "Inspect and verify repository",
      sessionId: "session-alpha",
      workspace: physicalWorkspace,
      options: inFlightSnapshot!.options,
      status: "completed",
      revision: 2,
      createdAt: createdSnapshot!.createdAt,
      updatedAt: completed!.updatedAt,
      endedAt: completed!.endedAt,
      completedAt: completed!.completedAt,
      mode: "single",
      partial: false,
    });
    expect(Date.parse(completed!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(createdSnapshot!.createdAt));
    expect(completed!.endedAt).toBe(completed!.updatedAt);
    expect(completed!.completedAt).toBe(completed!.updatedAt);
    expect(listTasks()).toEqual([completed]);
  });

  it("records failed and cancelled terminal states without changing task identity", async () => {
    let failedCreated: TaskRecord | undefined;
    await expect(runTask("test-key", "Failing task", new ModelConfig(), {
      webMode: "off",
      onTaskCreated: (record) => { failedCreated = record; },
      clientFactory: () => ({
        completeStream: async () => { throw new Error("Upstream failure"); },
        runWithTools: async () => { throw new Error("Upstream failure"); },
      }) as unknown as DeepSeekClient,
    })).rejects.toThrow("Upstream failure");

    const failedRecord = getTask(failedCreated!.id);
    expect(failedRecord).toMatchObject({
      id: failedCreated!.id,
      objective: "Failing task",
      status: "failed",
      revision: 2,
      createdAt: failedCreated!.createdAt,
      error: "Upstream failure",
    });
    expect(failedRecord?.completedAt).toBeUndefined();
    expect(failedRecord?.endedAt).toBe(failedRecord?.updatedAt);

    const controller = new AbortController();
    let cancelledCreated: TaskRecord | undefined;
    await expect(runTask("test-key", "Cancelled task", new ModelConfig(), {
      webMode: "off",
      signal: controller.signal,
      onTaskCreated: (record) => { cancelledCreated = record; },
      clientFactory: (key, signal) => new DeepSeekClient(key, async () => {
        controller.abort(new Error("Task cancelled by the user."));
        signal?.throwIfAborted();
        return Response.json({ choices: [{ message: { role: "assistant", content: "unreachable" } }] });
      }, undefined, signal),
    })).rejects.toThrow("Task cancelled by the user.");

    const cancelledRecord = getTask(cancelledCreated!.id);
    expect(cancelledRecord).toMatchObject({
      id: cancelledCreated!.id,
      objective: "Cancelled task",
      status: "cancelled",
      revision: 2,
      createdAt: cancelledCreated!.createdAt,
      error: "Task cancelled by the user.",
    });
    expect(cancelledRecord?.completedAt).toBeUndefined();
    expect(cancelledRecord?.endedAt).toBe(cancelledRecord?.updatedAt);
    expect(listTasks().map((record) => ({ id: record.id, status: record.status, revision: record.revision }))).toEqual([
      { id: failedCreated!.id, status: "failed", revision: 2 },
      { id: cancelledCreated!.id, status: "cancelled", revision: 2 },
    ]);
  });

  it("preserves objective, validated workspace, options, and terminal state across a new process and classifies active records as interrupted", () => {
    const realWorkspace = join(home.path, "real-project");
    const linkedWorkspace = join(home.path, "linked-project");
    mkdirSync(realWorkspace);
    symlinkSync(realWorkspace, linkedWorkspace, process.platform === "win32" ? "junction" : "dir");
    const physicalWorkspace = realpathSync(realWorkspace);

    const firstProcessStore = new TaskStore();
    const completed = firstProcessStore.create({
      objective: "Run unit tests",
      sessionId: "session-1",
      workspace: linkedWorkspace,
      config: new ModelConfig({
        model: "deepseek-v4-pro",
        thinkingEnabled: true,
        reasoningEffort: "low",
        toaTokenBudget: 12_000,
        toaTimeout: 150,
      }),
      options: {
        webMode: "off",
        local: true,
        commandsEnabled: true,
        stream: false,
        imageCount: 0,
        historyLength: 3,
      },
    });
    firstProcessStore.transition(completed.id, "completed", {
      expectedRevision: 1,
      mode: "single",
      partial: false,
    });

    const active = firstProcessStore.create({
      objective: "Long-running build that was interrupted by exit",
      sessionId: "session-2",
      workspace: linkedWorkspace,
      options: {
        webMode: "auto",
        local: true,
        commandsEnabled: true,
      },
    });
    expect(firstProcessStore.get(active.id)?.status).toBe("running");

    const reopenedStore = openTaskStore();
    const restoredCompleted = reopenedStore.get(completed.id);
    const restoredInterrupted = reopenedStore.get(active.id);

    expect(restoredCompleted).toEqual({
      id: completed.id,
      objective: "Run unit tests",
      sessionId: "session-1",
      workspace: physicalWorkspace,
      options: {
        model: "deepseek-v4-pro",
        thinkingEnabled: true,
        reasoningEffort: "low",
        webMode: "off",
        toa: false,
        toaWorkers: 2,
        toaTokenBudget: 12_000,
        toaTimeout: 150,
        local: true,
        commandsEnabled: true,
        stream: false,
        imageCount: 0,
        historyLength: 3,
      },
      status: "completed",
      revision: 2,
      createdAt: completed.createdAt,
      updatedAt: restoredCompleted!.updatedAt,
      endedAt: restoredCompleted!.endedAt,
      completedAt: restoredCompleted!.completedAt,
      mode: "single",
      partial: false,
    });

    expect(restoredInterrupted).toEqual({
      id: active.id,
      objective: "Long-running build that was interrupted by exit",
      sessionId: "session-2",
      workspace: physicalWorkspace,
      options: active.options,
      status: "interrupted",
      revision: 2,
      createdAt: active.createdAt,
      updatedAt: restoredInterrupted!.updatedAt,
      endedAt: restoredInterrupted!.endedAt,
    });

    // Reopening again must not re-increment the interrupted record's revision.
    const thirdStore = new TaskStore();
    expect(thirdStore.get(active.id)).toEqual(restoredInterrupted);
    expect(thirdStore.list({ status: "interrupted" })).toEqual([restoredInterrupted]);
    expect(thirdStore.list({ workspace: linkedWorkspace }).map((item) => item.id)).toEqual([completed.id, active.id]);
    expect(thirdStore.list({ sessionId: "session-1" }).map((item) => item.id)).toEqual([completed.id]);
  });

  it("classifies records left active by a separate OS process as interrupted without starting execution", () => {
    const workspace = join(home.path, "child-workspace");
    mkdirSync(workspace);
    const physicalWorkspace = realpathSync(workspace);
    const serviceModule = join(compiled, "service.js");
    const firstChild = spawnSync(
      process.execPath,
      [
        "-e",
        `
          const { TaskStore } = require(process.argv[1]);
          const store = new TaskStore();
          const completed = store.create({
            objective: "Completed in first process",
            sessionId: "session-child-1",
            workspace: process.argv[2],
            options: { local: true, commandsEnabled: true, webMode: "off" },
          });
          store.transition(completed.id, "completed", { expectedRevision: 1, mode: "single" });
          const running = store.create({
            objective: "Verify build in child process",
            sessionId: "session-child-2",
            workspace: process.argv[2],
            options: { local: true, commandsEnabled: true, webMode: "off", imageCount: 1 },
          });
          process.stdout.write(JSON.stringify({ completedId: completed.id, runningId: running.id }));
        `,
        serviceModule,
        physicalWorkspace,
      ],
      {
        env: { ...process.env, YA_HOME: home.path },
        encoding: "utf8",
      },
    );
    expect(firstChild.status).toBe(0);
    const { completedId, runningId } = JSON.parse(firstChild.stdout) as { completedId: string; runningId: string };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network call"));
    try {
      const interrupted = reconcileInterruptedTasks();
      expect(interrupted).toHaveLength(1);
      expect(interrupted[0]).toMatchObject({
        id: runningId,
        objective: "Verify build in child process",
        sessionId: "session-child-2",
        workspace: physicalWorkspace,
        status: "interrupted",
        revision: 2,
      });
      expect(readTask(runningId)).toEqual(interrupted[0]);
      expect(readTask(completedId)).toMatchObject({
        id: completedId,
        objective: "Completed in first process",
        sessionId: "session-child-1",
        workspace: physicalWorkspace,
        status: "completed",
        revision: 2,
      });
      expect(listTasks({ status: "running" })).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each(["completed", "failed", "cancelled", "interrupted"] as const)(
    "rejects invalid transitions from %s and stale updates without overwriting state",
    (terminalStatus) => {
      const store = new TaskStore();
      const created = store.create({ objective: `Task ending in ${terminalStatus}` });
      const settled = store.transition(created.id, terminalStatus, {
        expectedRevision: 1,
        ...(terminalStatus === "completed" ? { mode: "single" as const } : { error: `Ended as ${terminalStatus}` }),
      });
      expect(settled.status).toBe(terminalStatus);
      expect(settled.revision).toBe(2);

      for (const nextStatus of ["completed", "failed", "cancelled", "interrupted"] as const) {
        expect(() => store.transition(created.id, nextStatus)).toThrow(TaskTransitionError);
        expect(() => store.transition(created.id, nextStatus, { expectedRevision: 1 })).toThrow(StaleTaskRecordError);
      }
      expect(() => store.transition(created.id, "running" as Exclude<TaskStatus, "running">)).toThrow(TaskTransitionError);
      expect(store.get(created.id)).toEqual(settled);
    },
  );

  it("prevents a stale runtime or stale revision from overwriting an interrupted record", () => {
    const oldRuntime = new TaskStore();
    const active = oldRuntime.create({ objective: "Task interrupted by restart" });

    // A new store instance classifies the active record as interrupted at revision 2.
    const newRuntime = new TaskStore();
    const interrupted = newRuntime.get(active.id);
    expect(interrupted).toMatchObject({ status: "interrupted", revision: 2 });

    // The old runtime cannot overwrite the interrupted record with a late completion or failure.
    expect(() => oldRuntime.transition(active.id, "completed", { expectedRevision: 1 })).toThrow(StaleTaskRecordError);
    expect(() => oldRuntime.transition(active.id, "completed")).toThrow(TaskTransitionError);
    expect(() => oldRuntime.transition(active.id, "failed")).toThrow(TaskTransitionError);
    expect(newRuntime.get(active.id)).toEqual(interrupted);
  });

  it("leaves the last valid record readable when a write is interrupted or fails", () => {
    let shouldFailWrite = false;
    const store = new TaskStore({
      writeFile: (temporaryPath, content) => {
        if (shouldFailWrite) {
          // Simulate an interrupted write that leaves truncated JSON in the temporary file.
          writeFileSync(temporaryPath, content.slice(0, 24), { encoding: "utf8", mode: 0o600, flag: "wx" });
          throw new Error("Simulated disk write interruption");
        }
        writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      },
    });

    const first = store.create({ objective: "First durable task" });
    expect(store.get(first.id)).toMatchObject({ id: first.id, status: "running", revision: 1 });

    shouldFailWrite = true;
    expect(() => store.transition(first.id, "completed", { expectedRevision: 1 })).toThrow("Simulated disk write interruption");
    expect(store.get(first.id)).toEqual(first);
    expect(store.list()).toEqual([first]);

    // Recovery after the write fault clears can still complete the original record cleanly.
    shouldFailWrite = false;
    const completed = store.transition(first.id, "completed", { expectedRevision: 1, mode: "single" });
    expect(completed).toMatchObject({ id: first.id, status: "completed", revision: 2 });

    // A write failure when creating a subsequent task also leaves the completed record intact.
    shouldFailWrite = true;
    expect(() => store.create({ objective: "Second task that fails to write" })).toThrow("Simulated disk write interruption");

    // Also leave an uncleaned sibling .tmp file on disk as if a process crashed mid-write.
    writeFileSync(`${tasksPath()}.99999.crashed.tmp`, '{"version":1,"tasks":[', "utf8");

    expect(store.get(first.id)).toEqual(completed);
    expect(store.list()).toEqual([completed]);
    expect(new TaskStore().get(first.id)).toEqual(completed);
  });

  it("enforces the single-active-task limit and isolates onTaskCreated and completion writes", async () => {
    const store = new TaskStore();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let capturedId = "";

    const firstRun = runTask("test-key", "Active task", new ModelConfig(), {
      taskStore: store,
      webMode: "off",
      onTaskCreated: (record) => {
        capturedId = record.id;
        // Mutating the callback snapshot must not affect runTask's own completion update.
        record.id = "mutated-id";
        record.revision = 999;
      },
      clientFactory: () => ({
        completeStream: async () => ({ content: "unused", toolCalls: [], usage: {}, assistantMessage: { role: "assistant", content: "unused" } }),
        runWithTools: async () => {
          await firstBlocked;
          return { content: "First finished", toolCalls: [], usage: {}, assistantMessage: { role: "assistant", content: "First finished" } };
        },
      }) as unknown as DeepSeekClient,
    });

    await vi.waitFor(() => expect(capturedId).not.toBe(""));
    expect(() => store.create({ objective: "Concurrent store task" })).toThrow("A task is already running.");
    await expect(runTask("test-key", "Concurrent runTask", new ModelConfig(), {
      taskStore: store,
      webMode: "off",
    })).rejects.toThrow("A task is already running.");

    const active = store.get(capturedId);
    expect(active).toMatchObject({ id: capturedId, objective: "Active task", status: "running", revision: 1 });
    expect(store.list()).toEqual([active]);

    releaseFirst();
    const firstResult = await firstRun;
    expect(firstResult.taskId).toBe(capturedId);
    expect(store.get(capturedId)).toMatchObject({
      id: capturedId,
      status: "completed",
      revision: 2,
      mode: "single",
    });
  });

  it("does not downgrade a completed execution to failed if persisting completion fails", async () => {
    let failNextWrite = false;
    const store = new TaskStore({
      writeFile: (temporaryPath, content) => {
        if (failNextWrite) throw new Error("Disk full on completion write");
        writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      },
    });
    let createdId = "";

    await expect(runTask("test-key", "Task with completion write fault", new ModelConfig(), {
      taskStore: store,
      webMode: "off",
      onTaskCreated: (record) => { createdId = record.id; },
      clientFactory: (key) => new DeepSeekClient(key, async () => {
        failNextWrite = true;
        return Response.json({ choices: [{ message: { role: "assistant", content: "Model succeeded" } }] });
      }),
    })).rejects.toThrow("Disk full on completion write");

    expect(store.get(createdId)).toMatchObject({
      id: createdId,
      status: "running",
      revision: 1,
    });
  });

  it("performs no execution or disk writes on read/list and excludes API keys and account credentials", async () => {
    const apiKeySecret = "sk-private-api-key-do-not-persist";
    const accountSecret = "dsh-private-account-token-do-not-persist";

    await runTask(apiKeySecret, "Task with API key", new ModelConfig(), {
      webMode: "off",
      clientFactory: (key) => new DeepSeekClient(key, async () =>
        Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] })),
    });

    await expect(runTask(
      { kind: "account", token: accountSecret },
      "Task with account grant",
      new ModelConfig(),
      {
        webMode: "off",
        clientFactory: () => ({
          completeStream: async () => { throw new Error(`Auth failed for ${accountSecret} and Bearer ${ apiKeySecret }`); },
          runWithTools: async () => { throw new Error(`Auth failed for ${accountSecret} and Bearer ${ apiKeySecret }`); },
        }) as unknown as DeepSeekClient,
      },
    )).rejects.toThrow("Auth failed");

    const rawDisk = readFileSync(tasksPath(), "utf8");
    expect(rawDisk).not.toContain(apiKeySecret);
    expect(rawDisk).not.toContain(accountSecret);
    expect(JSON.parse(rawDisk)).toMatchObject({ version: TASK_STORE_VERSION });

    const store = new TaskStore({
      writeFile: () => {
        throw new Error("Read and list operations must not write to disk.");
      },
    });
    const records = store.list();
    expect(records).toHaveLength(2);
    expect(store.read(records[0]!.id)).toEqual(records[0]);
    expect(records[1]?.status).toBe("failed");
    expect(records[1]?.error).toContain("[redacted]");
    expect(JSON.stringify(records)).not.toContain(apiKeySecret);
    expect(JSON.stringify(records)).not.toContain(accountSecret);

    expect(() => store.create({
      objective: "Reject secret fields",
      options: { apiKey: apiKeySecret } as unknown as TaskRecord["options"],
    })).toThrow(/credential/iu);
    expect(() => store.create({
      objective: "Reject nested secret fields",
      options: { nested: [{ accessToken: accountSecret }] } as unknown as TaskRecord["options"],
    })).toThrow(/credential/iu);
    expect(() => store.create({
      objective: "Reject missing workspace",
      workspace: join(home.path, "does-not-exist"),
    })).toThrow(/does not exist/iu);

    const directStore = new TaskStore();
    const direct = directStore.create({ objective: "Direct transition redaction" });
    const failed = directStore.transition(direct.id, "failed", {
      expectedRevision: 1,
      error: `Auth failed Bearer ${apiKeySecret} x-dsh-auth-token=${accountSecret}`,
    });
    expect(failed.error).toBe("Auth failed Bearer [redacted] x-dsh-auth-token=[redacted]");
    expect(existsSync(tasksPath())).toBe(true);
  });
});
