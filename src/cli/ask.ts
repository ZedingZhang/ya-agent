import { resolve } from "node:path";
import { abortable } from "../cancellation";
import type { CommandEvent } from "../commands";
import { assertImageInputSupported, loadConfig, ModelConfig, modelId } from "../config";
import { expandHome } from "../fs-utils";
import { imageContentPartsFromSources } from "../images";
import { LocalWorkspace } from "../local";
import type { LocalAction } from "../local-tools";
import {
  createCandidate,
  DuplicateMemoryError,
  MemoryLimitError,
  selectRelevantCards,
  type MemoryKind,
} from "../memory";
import { shouldUseWeb, type RunResult } from "../orchestrator";
import { runTask } from "../service";
import { escapeTerminalControls, formatOutput, StreamingMarkdownRenderer } from "../terminal";
import { parseInteger, write } from "./io";
import type { AskOptions, CliIo, CliRuntime } from "./types";

export function resolveConfig(options: AskOptions): ModelConfig {
  const config = loadConfig();
  if (options.model) config.model = modelId(options.model);
  if (options.thinking) config.thinkingEnabled = options.thinking === "on";
  if (options.reasoningEffort) config.reasoningEffort = options.reasoningEffort;
  if (options.toaTokenBudget !== undefined) config.toaTokenBudget = parseInteger(options.toaTokenBudget, "ToA token budget");
  if (options.toaTimeout !== undefined) config.toaTimeout = parseInteger(options.toaTimeout, "ToA timeout");
  if (!config.thinkingEnabled && options.reasoningEffort) throw new Error("--reasoning-effort requires --thinking on.");
  config.validate();
  return config;
}

export async function toaConfirm(options: AskOptions, config: ModelConfig, io: CliIo, signal?: AbortSignal): Promise<boolean> {
  write(io.stdout, "\nToA preflight\n");
  write(io.stdout, `  model: ${config.model}\n`);
  write(io.stdout, `  thinking: ${config.thinkingEnabled ? "on" : "off"} (${config.reasoningEffort})\n`);
  write(io.stdout, `  workers: ${options.toaWorkers} (evidence and risk roles, max 2)\n`);
  write(io.stdout, `  completion token budget: ${config.toaTokenBudget}\n`);
  write(io.stdout, `  timeout: ${config.toaTimeout}s\n`);
  if (options.image.length > 0) {
    write(io.stdout, `  images: ${options.image.length} (re-sent to every worker, the root synthesis, and follow-up requests)\n`);
  }
  if (options.yes) return true;
  if (!io.stdin.isTTY) throw new Error("--toa requires interactive confirmation or --yes in a non-interactive shell.");
  return ["y", "yes"].includes((await abortable(io.prompt("Start ToA for this task? [y/N] ", false, signal), signal)).trim().toLocaleLowerCase("und"));
}

export async function collectFeedback(result: RunResult, disabled: boolean, io: CliIo, signal?: AbortSignal): Promise<void> {
  void result;
  if (disabled || !io.stdin.isTTY || !io.stdout.isTTY) return;
  const prompt = (question: string): Promise<string> => abortable(io.prompt(question, false, signal), signal);
  const learn = (await prompt("\nLearn from this answer? [y/N] ")).trim().toLocaleLowerCase("und");
  if (learn !== "y" && learn !== "yes") return;
  const text = (await prompt("Candidate preference or procedure: ")).trim();
  if (!text) {
    write(io.stdout, "No candidate created.\n");
    return;
  }
  const rawKind = (await prompt("Kind [preference/procedure/knowledge] (procedure): ")).trim() || "procedure";
  let evidence = "Explicit user feedback after Ya task";
  if (rawKind === "knowledge") {
    const source = (await prompt("Source URL for this knowledge: ")).trim();
    if (!source.startsWith("https://") && !source.startsWith("http://")) {
      write(io.stdout, "Knowledge candidates require a source URL.\n");
      return;
    }
    evidence += `; source: ${source}`;
  }
  try {
    const card = createCandidate(text, evidence, rawKind as MemoryKind);
    write(io.stdout, `Created candidate ${card.id}. Review it with: ya memory review\n`);
  } catch (error) {
    if (error instanceof DuplicateMemoryError) {
      write(io.stdout, `Matching memory ${error.card.id} already exists; no new candidate created.\n`);
      return;
    }
    if (error instanceof MemoryLimitError) {
      write(io.stdout, `${error.message}. No candidate created.\n`);
      return;
    }
    throw error;
  }
}

function showMemory(task: string, io: CliIo): void {
  const matches = selectRelevantCards(task);
  write(io.stdout, "\n[Ya memory context]\n");
  if (matches.length === 0) {
    write(io.stdout, "  No relevant approved memory found.\n");
    return;
  }
  for (const match of matches) {
    write(io.stdout, `  ${match.card.id}  ${match.card.kind.padEnd(10)} ${match.card.text}\n`);
  }
}

export async function localConfirm(action: LocalAction, approveNoninteractive: boolean, io: CliIo, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  write(io.stdout, `\n[Ya local action]\n  ${escapeTerminalControls(action.summary)}\n`);
  if (action.diff) write(io.stdout, `\n${escapeTerminalControls(action.diff)}${action.diff.endsWith("\n") ? "" : "\n"}`);
  if (!io.stdin.isTTY) {
    const flag = action.operation === "run" ? "--approve-commands" : "--approve";
    if (approveNoninteractive) {
      write(io.stdout, `  Approved by ${flag} for this non-interactive task.\n`);
      return true;
    }
    write(io.stdout, `  Denied: non-interactive ${action.operation === "run" ? "commands" : "local changes"} require ${flag}.\n`);
    return false;
  }
  const question = action.operation === "run" ? "Run this command? [y/N] " : "Apply this file change? [y/N] ";
  return ["y", "yes"].includes((await abortable(io.prompt(question, false, signal), signal)).trim().toLocaleLowerCase("und"));
}

function showCommandEvent(event: CommandEvent, io: CliIo): void {
  if (event.type === "start") write(io.stderr, `\n[Ya command] ${escapeTerminalControls(event.command)}\n  cwd: ${escapeTerminalControls(event.cwd)}\n`);
  else if (event.type === "output") write(io.stderr, event.text);
  else {
    const result = event.result;
    write(io.stderr, `\n[Ya command ${result.status}] exit=${result.exitCode ?? "null"} ${(result.durationMs / 1_000).toFixed(1)}s\n`);
    if (result.stdoutTruncated || result.stderrTruncated) write(io.stderr, "  Output truncated; Ya receives the last 64 KiB of each stream.\n");
    if (result.error) write(io.stderr, `  ${result.error}\n`);
  }
}

export async function runAskCommand(task: string, options: AskOptions, io: CliIo, runtime: CliRuntime): Promise<void> {
  if (options.local && options.toa) throw new Error("--local and --toa cannot be used together.");
  if (options.workspace && !options.local) throw new Error("--workspace requires --local.");
  if (options.approve && !options.local) throw new Error("--approve requires --local.");
  if (options.exec && !options.local) throw new Error("--exec requires --local.");
  if (options.approveCommands && !options.exec) throw new Error("--approve-commands requires --exec.");
  const config = resolveConfig(options);
  assertImageInputSupported(config.model, options.image.length);
  const apiKey = runtime.loadAccountCredential() ?? runtime.loadApiKey();
  if (!apiKey) {
    throw new Error("Sign in with: ya login deepseek. Alternatively, set DEEPSEEK_API_KEY or, on macOS, run: ya auth deepseek");
  }
  if (options.showMemory) showMemory(task, io);
  const images = imageContentPartsFromSources(options.image, options.imageDetail);
  const cancellation = new AbortController();
  const interrupt = (): void => cancellation.abort(new Error("Task cancelled by the user."));
  process.once("SIGINT", interrupt);
  try {
    if (options.toa && !(await toaConfirm(options, config, io, cancellation.signal))) {
      write(io.stdout, "ToA cancelled; nothing was sent.\n");
      return;
    }
    const workspace = options.local
      ? new LocalWorkspace(
        resolve(options.workspace ? expandHome(options.workspace) : process.cwd()),
        (action) => localConfirm(action, action.operation === "run" ? options.approveCommands : options.approve, io, cancellation.signal),
        undefined,
        { commandsEnabled: options.exec, signal: cancellation.signal, onCommandEvent: (event) => showCommandEvent(event, io) },
      )
      : undefined;
    const stdoutIsTty = Boolean(io.stdout.isTTY);
    const canStream = options.stream === "auto"
      && !options.toa
      && !options.local
      && !shouldUseWeb(task, options.web)
      && options.format !== "markdown"
      && stdoutIsTty;
    const renderer = canStream ? new StreamingMarkdownRenderer(!("NO_COLOR" in process.env)) : undefined;
    const emit = renderer
      ? (chunk: string): void => {
        const rendered = renderer.write(chunk);
        if (rendered) write(io.stdout, rendered);
      }
      : undefined;
    if (renderer) write(io.stdout, "\n[Ya single result]\n\n");

    const result = await runTask(apiKey, task, config, {
      webMode: options.web,
      toa: options.toa,
      toaWorkers: Number(options.toaWorkers),
      onContent: emit,
      localWorkspace: workspace,
      clientFactory: (key, signal) => runtime.createClient(key, signal),
      images,
      signal: cancellation.signal,
    });
    cancellation.signal.throwIfAborted();
    if (renderer) {
      const tail = renderer.finish();
      if (tail) write(io.stdout, `${tail}\n`);
    } else {
      const bannerStream = stdoutIsTty || options.format === "terminal" ? io.stdout : io.stderr;
      write(bannerStream, `\n[Ya ${result.mode} result]\n\n`);
      write(io.stdout, `${formatOutput(result.content, options.format, stdoutIsTty)}\n`);
    }
    if (result.partial) write(io.stderr, "\n[Some ToA worker results were unavailable; the synthesis may be incomplete.]\n");
    await collectFeedback(result, !options.feedback, io, cancellation.signal);
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}
