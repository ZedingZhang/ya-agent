import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_COMMAND_OUTPUT_BYTES, runCommand, type CommandEvent, type CommandResult } from "../src/commands";
import { ModelConfig } from "../src/config";
import { DeepSeekClient, type FetchLike } from "../src/deepseek";
import { auditLogPath, LocalWorkspace, type LocalAction } from "../src/local";
import { runTask } from "../src/service";
import type { ChatMessage, ToolCall } from "../src/types";
import { tempHome, type TempHome } from "./helpers";

describe("command execution and verification", () => {
  let home: TempHome;
  let root: string;
  beforeEach(() => {
    home = tempHome();
    root = join(home.path, "workspace with spaces");
    mkdirSync(root);
  });
  afterEach(() => { vi.unstubAllEnvs(); home.cleanup(); });

  const nodeCommand = (file: string): string => `"${process.execPath}" "${file}"`;
  const execute = (command: string, options: Partial<Parameters<typeof runCommand>[0]> = {}) =>
    runCommand({ command, cwd: root, displayCwd: ".", timeoutSeconds: 10, ...options });

  it("runs in the requested directory, captures UTF-8 streams and nonzero exit codes", async () => {
    writeFileSync(join(root, "check.cjs"), 'process.stdout.write(process.cwd() + "\\n你好🙂"); process.stderr.write("check failed"); process.exitCode = 7;');
    const events: CommandEvent[] = [];
    const result = await execute(nodeCommand("check.cjs"), { onEvent: (event) => events.push(event) });
    expect(result).toMatchObject({ status: "failed", exitCode: 7, cwd: ".", stdoutTruncated: false, stderrTruncated: false });
    expect(result.stdout).toBe(`${root}\n你好🙂`);
    expect(result.stderr).toBe("check failed");
    expect(events[0]?.type).toBe("start");
    expect(events.at(-1)).toMatchObject({ type: "finish", result });
    expect(events.filter((event) => event.type === "output").map((event) => event.text).join("")).toContain("你好🙂");
  });

  it("handles a shell command and quoted executable paths", async () => {
    writeFileSync(join(root, "ok check.cjs"), 'console.log("verified");');
    const result = await execute(`${nodeCommand("ok check.cjs")} && ${nodeCommand("ok check.cjs")}`);
    expect(result).toMatchObject({ status: "success", exitCode: 0, stdout: "verified\nverified\n" });
  });

  it("bounds each output stream, preserves its tail and strips terminal controls", async () => {
    writeFileSync(join(root, "large.cjs"), 'process.stdout.write("x".repeat(200000) + "\\x1b[31mLAST\\x1b[0m"); process.stderr.write("y".repeat(200000) + "END");');
    const result = await execute(nodeCommand("large.cjs"));
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(MAX_COMMAND_OUTPUT_BYTES);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(MAX_COMMAND_OUTPUT_BYTES);
    expect(result.stdout).toMatch(/LAST$/u);
    expect(result.stdout).not.toContain("\x1b");
    expect(result.stderr).toMatch(/END$/u);
  });

  it("retains a valid UTF-8 tail when its byte boundary splits a codepoint", async () => {
    writeFileSync(join(root, "unicode.cjs"), 'process.stdout.write("你".repeat(30000) + "tail");');
    const result = await execute(nodeCommand("unicode.cjs"));
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout).not.toContain("\ufffd");
    expect(result.stdout).toMatch(/tail$/u);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(MAX_COMMAND_OUTPUT_BYTES);
  });

  it("closes stdin and excludes Ya credentials and runtime flags from the child", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "private-api-key");
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
    vi.stubEnv("NODE_OPTIONS", "--trace-warnings");
    writeFileSync(join(root, "env.cjs"), 'process.stdin.on("end", () => console.log(JSON.stringify({key:process.env.DEEPSEEK_API_KEY,home:process.env.YA_HOME,electron:process.env.ELECTRON_RUN_AS_NODE,options:process.env.NODE_OPTIONS}))); process.stdin.resume();');
    expect(await execute(nodeCommand("env.cjs"))).toMatchObject({ status: "success", stdout: "{}\n" });
  });

  it("kills a timed-out process tree, including a child with independent stdio", async () => {
    writeFileSync(join(root, "child.cjs"), 'setTimeout(() => require("node:fs").writeFileSync("survived.txt", "bad"), 2000);');
    writeFileSync(join(root, "parent.cjs"), 'const child = require("node:child_process").spawn(process.execPath, ["child.cjs"], {stdio:"ignore"}); console.log("child", child.pid); setInterval(() => {}, 1000);');
    const result = await execute(nodeCommand("parent.cjs"), { timeoutSeconds: 1 });
    expect(result.status).toBe("timed_out");
    expect(result.stdout).toMatch(/child \d+/u);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(existsSync(join(root, "survived.txt"))).toBe(false);
  }, 10_000);

  it("cancels a running command and emits its final status", async () => {
    writeFileSync(join(root, "wait.cjs"), 'console.log("started"); setInterval(() => {}, 1000);');
    const controller = new AbortController();
    const result = await execute(nodeCommand("wait.cjs"), {
      signal: controller.signal,
      onEvent: (event) => { if (event.type === "output") controller.abort(new Error("Stop")); },
    });
    expect(result.status).toBe("cancelled");
    expect(result.durationMs).toBeLessThan(5_000);
  }, 10_000);

  it("returns spawn errors with a terminal event", async () => {
    const finish = vi.fn();
    const result = await execute("echo check", { cwd: join(root, "missing"), onEvent: finish });
    expect(result.status).toBe("error");
    expect(result.error).toBeTruthy();
    expect(finish.mock.calls.at(-1)?.[0]).toMatchObject({ type: "finish", result });
  });

  it("requires opt-in and approval before executing a command", async () => {
    const disabled = new LocalWorkspace(root, () => true);
    expect(disabled.tools.map((tool) => tool.function.name)).not.toContain("local_run");
    expect(disabled.toolHandlers.local_run).toBeUndefined();
    await expect(disabled.run({ command: "echo forbidden" })).rejects.toThrow("not enabled");
    writeFileSync(join(root, "marker.cjs"), 'require("node:fs").writeFileSync("marker.txt", "ran");');
    const actions: LocalAction[] = [];
    const denied = new LocalWorkspace(root, (action) => { actions.push(action); return false; }, undefined, { commandsEnabled: true });
    const result = JSON.parse(await denied.run({ command: nodeCommand("marker.cjs") }));
    expect(result.status).toBe("denied");
    expect(actions[0]).toMatchObject({ operation: "run", paths: [root] });
    expect(actions[0]?.summary).toContain(nodeCommand("marker.cjs"));
    expect(actions[0]?.summary).toContain("Timeout: 120s");
    expect(existsSync(join(root, "marker.txt"))).toBe(false);
    expect(denied.commandResults).toEqual([]);
  });

  it.each([
    { command: "" }, { command: "a\0b" }, { command: "x".repeat(8_193) },
    { command: "echo ok", cwd: ".." }, { command: "echo ok", cwd: "missing" },
    { command: "echo ok", timeout_seconds: 0 }, { command: "echo ok", timeout_seconds: 601 },
    { command: "echo ok", timeout_seconds: 1.5 }, { command: "echo ok", timeout_seconds: "30" },
  ])("rejects invalid command arguments before approval (%j)", async (arguments_) => {
    const confirm = vi.fn(() => true);
    const workspace = new LocalWorkspace(root, confirm, undefined, { commandsEnabled: true });
    await expect(workspace.run(arguments_)).rejects.toThrow();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("rejects a cwd changed to a symlink outside the workspace while awaiting approval", async () => {
    const directory = join(root, "sub");
    const outside = join(home.path, "outside");
    mkdirSync(directory);
    mkdirSync(outside);
    const workspace = new LocalWorkspace(root, () => {
      renameSync(directory, join(root, "sub-old"));
      symlinkSync(outside, directory, process.platform === "win32" ? "junction" : "dir");
      return true;
    }, undefined, { commandsEnabled: true });
    await expect(workspace.run({ command: "echo check", cwd: "sub" })).rejects.toThrow(/inside|changed/u);
    expect(workspace.commandResults).toEqual([]);
  });

  it("cancels pending approval without spawning or making a subsequent file change", async () => {
    const controller = new AbortController();
    let approve!: (value: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => { approve = resolve; }));
    const workspace = new LocalWorkspace(root, confirm, undefined, { commandsEnabled: true, signal: controller.signal });
    const task = workspace.run({ command: "echo check" });
    controller.abort(new Error("Stop"));
    await expect(task).rejects.toThrow("Stop");
    approve(true);
    await expect(workspace.write({ path: "late.txt", content: "oops" })).rejects.toThrow("Stop");
    expect(workspace.commandResults).toEqual([]);
    expect(existsSync(join(root, "late.txt"))).toBe(false);
  });

  it("reports check failure to the model, allows a repair, then verifies the repaired code", async () => {
    writeFileSync(join(root, "check.cjs"), 'console.error("expected true"); process.exitCode = 1;');
    const command = nodeCommand("check.cjs");
    const calls: ToolCall[] = [
      { id: "check1", function: { name: "local_run", arguments: JSON.stringify({ command }) } },
      { id: "repair", function: { name: "local_write", arguments: JSON.stringify({ path: "check.cjs", content: 'console.log("test passed");' }) } },
      { id: "check2", function: { name: "local_run", arguments: JSON.stringify({ command }) } },
    ];
    const messages: ChatMessage[][] = [];
    let request = 0;
    const fetcher: FetchLike = async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      messages.push(payload.messages);
      const call = calls[request++];
      return Response.json({ choices: [{ message: call ? { role: "assistant", tool_calls: [call] } : { role: "assistant", content: "Fixed and verified." } }] });
    };
    const workspace = new LocalWorkspace(root, () => true, undefined, { commandsEnabled: true });
    const result = await runTask("key", "Fix the check and verify it", new ModelConfig(), {
      webMode: "off", localWorkspace: workspace, clientFactory: (key) => new DeepSeekClient(key, fetcher),
    });
    const firstCheck = JSON.parse(String(messages[1]?.find((message) => message.tool_call_id === "check1")?.content)) as CommandResult;
    expect(firstCheck).toMatchObject({ status: "failed", exitCode: 1, stderr: "expected true\n" });
    const finalCheck = JSON.parse(String(messages[3]?.find((message) => message.tool_call_id === "check2")?.content)) as CommandResult;
    expect(finalCheck).toMatchObject({ status: "success", exitCode: 0, stdout: "test passed\n" });
    expect(result.commands?.map((check) => check.status)).toEqual(["failed", "success"]);
    expect(result.content).toBe("Fixed and verified.");
    const audit = readFileSync(auditLogPath(), "utf8");
    expect(audit).toContain('"exitCode":1');
    expect(audit).toContain('"exitCode":0');
    expect(audit).not.toContain("expected true");
    expect(audit).not.toContain("test passed");
  });
});
