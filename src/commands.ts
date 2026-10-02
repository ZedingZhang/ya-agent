import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripTerminalControls } from "./terminal";

export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 120;
export const MAX_COMMAND_TIMEOUT_SECONDS = 600;
export const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

export function validateCommand(command: unknown): asserts command is string {
  if (typeof command !== "string" || !command.trim() || command.length > 8_192) {
    throw new Error("Command must be a non-empty string with at most 8192 characters.");
  }
  // LF and tab are visible shell whitespace; other controls can disguise approval text.
  if (/[\x00-\x08\x0B-\x1F\x7F-\x9F]/u.test(command)) {
    throw new Error("Command contains unsafe control characters. Use printable text, LF and tab only.");
  }
}

export interface CommandResult {
  status: "success" | "failed" | "timed_out" | "cancelled" | "error";
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  error?: string;
}

export type CommandEvent =
  | { type: "start"; id: string; command: string; cwd: string }
  | { type: "output"; id: string; stream: "stdout" | "stderr"; text: string }
  | { type: "finish"; id: string; result: CommandResult };

export interface CommandOptions {
  command: string;
  cwd: string;
  displayCwd: string;
  timeoutSeconds: number;
  signal?: AbortSignal;
  onEvent?: (event: CommandEvent) => void;
}

class OutputTail {
  private tail = Buffer.alloc(0);
  truncated = false;

  append(text: string): void {
    const bytes = Buffer.from(text);
    const combined = Buffer.concat([this.tail, bytes]);
    this.truncated ||= combined.length > MAX_COMMAND_OUTPUT_BYTES;
    this.tail = combined.subarray(Math.max(0, combined.length - MAX_COMMAND_OUTPUT_BYTES));
  }

  text(): string {
    // A byte-limited tail can start inside a multi-byte codepoint.
    let start = 0;
    while (start < this.tail.length && (this.tail[start]! & 0xc0) === 0x80) start += 1;
    return stripTerminalControls(this.tail.subarray(start).toString("utf8"));
  }
}

/** Runs an explicitly approved shell command. cwd confinement is not a sandbox. */
export function runCommand(options: CommandOptions): Promise<CommandResult> {
  options.signal?.throwIfAborted();
  validateCommand(options.command);
  if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 1 || options.timeoutSeconds > MAX_COMMAND_TIMEOUT_SECONDS) {
    throw new Error(`Command timeout must be an integer from 1 to ${MAX_COMMAND_TIMEOUT_SECONDS} seconds.`);
  }
  const id = randomUUID();
  const started = Date.now();
  const emit = (event: CommandEvent): void => {
    try { options.onEvent?.(event); } catch { /* Presentation cannot affect execution. */ }
  };
  const environment = { ...process.env };
  // Project programs do not need Ya's API credentials or application runtime flags.
  const privateNames = ["DEEPSEEK_API_KEY", "YA_HOME", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "NAPI_RS_NATIVE_LIBRARY_PATH"];
  for (const name of Object.keys(environment)) {
    if (privateNames.includes(name.toUpperCase())) delete environment[name];
  }
  const windows = process.platform === "win32";
  const shell = windows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe") : "/bin/sh";
  // cmd /s strips the outer quotes; preserve quoted executables/paths inside them.
  const args = windows ? ["/d", "/s", "/c", `"${options.command}"`] : ["-c", options.command];
  emit({ type: "start", id, command: options.command, cwd: options.displayCwd });

  return new Promise<CommandResult>((resolve) => {
    const stdout = new OutputTail();
    const stderr = new OutputTail();
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const pending = { stdout: new OutputTail(), stderr: new OutputTail() };
    let outputTimer: ReturnType<typeof setTimeout> | undefined;
    const flushOutput = (): void => {
      if (outputTimer) clearTimeout(outputTimer);
      outputTimer = undefined;
      for (const stream of ["stdout", "stderr"] as const) {
        const text = pending[stream].text();
        if (text) emit({ type: "output", id, stream, text });
        pending[stream] = new OutputTail();
      }
    };
    const child = spawn(shell, args, {
      cwd: options.cwd, env: environment, stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true, windowsVerbatimArguments: windows, detached: !windows,
    });
    let stopped: "timed_out" | "cancelled" | undefined;
    let failure: string | undefined;
    let killPromise: Promise<void> | undefined;
    let drainDeadline: ReturnType<typeof setTimeout> | undefined;
    let finished = false;

    const killTree = (): Promise<void> => {
      if (!child.pid) return Promise.resolve();
      const pid = child.pid;
      if (windows) {
        return new Promise((done) => {
          execFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
            ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 }, (error) => {
              if (error) {
                failure = "Process-tree cleanup could not be confirmed; background processes may still be running.";
                try { child.kill(); } catch { /* It may have exited. */ }
              }
              done();
            });
        });
      }
      try { process.kill(-pid, "SIGTERM"); } catch { /* The process may have already exited. */ }
      return new Promise((done) => {
        setTimeout(() => {
          try { process.kill(-pid, "SIGKILL"); } catch { /* The process group has exited. */ }
          done();
        }, 500);
      });
    };
    const stop = (reason: "timed_out" | "cancelled"): void => {
      if (stopped) return;
      stopped = reason;
      killPromise = killTree();
      // A detached descendant can keep a pipe open after its parent has exited.
      // Bound draining as well as execution so cancellation cannot hang forever.
      drainDeadline = setTimeout(() => {
        failure = "Process-tree cleanup could not be confirmed; background processes may still be running.";
        try { child.kill(); } catch { /* It may have exited. */ }
        child.stdout.destroy();
        child.stderr.destroy();
        finish(child.exitCode, child.signalCode);
      }, 6_000);
    };
    const abort = (): void => stop("cancelled");
    const timer = setTimeout(() => stop("timed_out"), options.timeoutSeconds * 1_000);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    const output = (stream: "stdout" | "stderr", text: string): void => {
      if (finished) return;
      const tail = stream === "stdout" ? stdout : stderr;
      tail.append(text);
      pending[stream].append(text);
      if (text && !outputTimer) outputTimer = setTimeout(flushOutput, 100);
    };
    child.stdout.on("data", (bytes: Buffer) => output("stdout", decoders.stdout.write(bytes)));
    child.stderr.on("data", (bytes: Buffer) => output("stderr", decoders.stderr.write(bytes)));
    child.on("error", (error) => { failure = error.message; });
    const finish = (exitCode: number | null, signal: string | null): void => {
      if (finished) return;
      clearTimeout(timer);
      if (drainDeadline) clearTimeout(drainDeadline);
      options.signal?.removeEventListener("abort", abort);
      output("stdout", decoders.stdout.end());
      output("stderr", decoders.stderr.end());
      flushOutput();
      finished = true;
      void (async () => {
        await killPromise;
        const result: CommandResult = {
          status: stopped ?? (failure ? "error" : exitCode === 0 ? "success" : "failed"),
          command: options.command, cwd: options.displayCwd, exitCode, signal,
          stdout: stdout.text(), stderr: stderr.text(),
          stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated,
          durationMs: Date.now() - started, ...(failure ? { error: failure } : {}),
        };
        emit({ type: "finish", id, result });
        resolve(result);
      })();
    };
    child.on("close", finish);
  });
}
