#!/usr/bin/env node

import { Command, CommanderError, Option } from "commander";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertImageInputSupported, ModelConfig, loadConfig, modelId, saveConfig } from "./config";
import { DeepSeekClient, DeepSeekError } from "./deepseek";
import { imageContentPartsFromSources } from "./images";
import { loadApiKey, saveApiKey } from "./keychain";
import {
  LocalWorkspace,
  auditLogFiles,
  auditLogTotalBytes,
  clearAuditLogs,
  type LocalAction,
} from "./local";
import {
  DuplicateMemoryError,
  MemoryLimitError,
  cardsToPrune,
  createCandidate,
  listCards,
  pruneCards,
  selectRelevantCards,
  setStatus,
  type MemoryKind,
} from "./memory";
import { shouldUseWeb, singleAgent, toaAgent, type RunResult } from "./orchestrator";
import { StreamingMarkdownRenderer, formatOutput } from "./terminal";
import type { ImageDetail, OutputFormat, WebMode } from "./types";
import { VERSION } from "./version";

interface InputStream extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
}

interface OutputStream extends NodeJS.WritableStream {
  isTTY?: boolean;
}

export interface CliIo {
  stdin: InputStream;
  stdout: OutputStream;
  stderr: OutputStream;
  prompt: (question: string, hidden?: boolean) => Promise<string>;
}

interface CliRuntime {
  loadApiKey: () => string | undefined;
  saveApiKey: (apiKey: string) => void;
  createClient: (apiKey: string) => DeepSeekClient;
}

export interface CliContext {
  io?: CliIo;
  runtime?: Partial<CliRuntime>;
}

interface AskOptions {
  model?: string;
  thinking?: "on" | "off";
  reasoningEffort?: "high" | "max";
  toa: boolean;
  yes: boolean;
  toaWorkers: string;
  toaTokenBudget?: string;
  toaTimeout?: string;
  feedback: boolean;
  format: OutputFormat;
  web: WebMode;
  stream: "auto" | "off";
  showMemory: boolean;
  local: boolean;
  workspace?: string;
  approve: boolean;
  image: string[];
  imageDetail: ImageDetail;
}

const defaultRuntime: CliRuntime = {
  loadApiKey,
  saveApiKey,
  createClient: (apiKey) => new DeepSeekClient(apiKey),
};

function write(stream: OutputStream, value: string): void {
  stream.write(value);
}

function defaultPrompt(stdin: InputStream, stdout: OutputStream): (question: string, hidden?: boolean) => Promise<string> {
  return async (question, hidden = false) => {
    if (hidden && stdin.isTTY && stdin.setRawMode) return readHidden(question, stdin, stdout);
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      return await prompt.question(question);
    } finally {
      prompt.close();
    }
  };
}

function readHidden(question: string, stdin: InputStream, stdout: OutputStream): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    write(stdout, question);
    const previousRaw = Boolean(stdin.isRaw);
    let value = "";
    stdin.setRawMode?.(true);
    stdin.resume();
    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode?.(previousRaw);
      stdin.pause();
      write(stdout, "\n");
    };
    const onData = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      for (const character of text) {
        if (character === "\r" || character === "\n") {
          cleanup();
          resolvePromise(value);
          return;
        }
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Credential entry cancelled."));
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    };
    stdin.on("data", onData);
  });
}

function makeIo(context?: CliContext): CliIo {
  if (context?.io) return context.io;
  const stdin = process.stdin as InputStream;
  const stdout = process.stdout as OutputStream;
  return { stdin, stdout, stderr: process.stderr as OutputStream, prompt: defaultPrompt(stdin, stdout) };
}

function makeRuntime(context?: CliContext): CliRuntime {
  return { ...defaultRuntime, ...context?.runtime };
}

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

function parseInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer.`);
  return parsed;
}

function collectValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export async function toaConfirm(options: AskOptions, config: ModelConfig, io: CliIo): Promise<boolean> {
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
  return ["y", "yes"].includes((await io.prompt("Start ToA for this task? [y/N] ")).trim().toLocaleLowerCase("und"));
}

export async function collectFeedback(result: RunResult, disabled: boolean, io: CliIo): Promise<void> {
  void result;
  if (disabled || !io.stdin.isTTY) return;
  const learn = (await io.prompt("\nLearn from this answer? [y/N] ")).trim().toLocaleLowerCase("und");
  if (learn !== "y" && learn !== "yes") return;
  const text = (await io.prompt("Candidate preference or procedure: ")).trim();
  if (!text) {
    write(io.stdout, "No candidate created.\n");
    return;
  }
  const rawKind = (await io.prompt("Kind [preference/procedure/knowledge] (procedure): ")).trim() || "procedure";
  let evidence = "Explicit user feedback after Ya task";
  if (rawKind === "knowledge") {
    const source = (await io.prompt("Source URL for this knowledge: ")).trim();
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
    write(io.stdout, "  No approved memory met the relevance threshold.\n");
    return;
  }
  for (const match of matches) {
    write(io.stdout, `  ${match.card.id}  score ${String(match.score).padEnd(2)} ${match.card.kind.padEnd(10)} ${match.card.text}\n`);
  }
}

export async function localConfirm(action: LocalAction, approveNoninteractive: boolean, io: CliIo): Promise<boolean> {
  write(io.stdout, `\n[Ya local action]\n  ${action.summary}\n`);
  if (action.diff) write(io.stdout, `\n${action.diff}${action.diff.endsWith("\n") ? "" : "\n"}`);
  if (!io.stdin.isTTY) {
    if (approveNoninteractive) {
      write(io.stdout, "  Approved by --approve for this non-interactive task.\n");
      return true;
    }
    write(io.stdout, "  Denied: non-interactive local changes require --approve.\n");
    return false;
  }
  return ["y", "yes"].includes((await io.prompt("Apply this file change? [y/N] ")).trim().toLocaleLowerCase("und"));
}

async function ask(task: string, options: AskOptions, io: CliIo, runtime: CliRuntime): Promise<void> {
  if (options.local && options.toa) throw new Error("--local and --toa cannot be used together.");
  if (options.workspace && !options.local) throw new Error("--workspace requires --local.");
  if (options.approve && !options.local) throw new Error("--approve requires --local.");
  const config = resolveConfig(options);
  assertImageInputSupported(config.model, options.image.length);
  const apiKey = runtime.loadApiKey();
  if (!apiKey) {
    throw new Error("No DeepSeek API key found. Set DEEPSEEK_API_KEY or, on macOS, run: ya auth deepseek");
  }
  if (options.showMemory) showMemory(task, io);
  const images = imageContentPartsFromSources(options.image, options.imageDetail);

  const workspace = options.local
    ? new LocalWorkspace(resolve(options.workspace ? expandHome(options.workspace) : process.cwd()), (action) => localConfirm(action, options.approve, io))
    : undefined;
  const canStream = options.stream === "auto"
    && !options.toa
    && !options.local
    && !shouldUseWeb(task, options.web)
    && options.format !== "markdown"
    && Boolean(io.stdout.isTTY);
  const renderer = canStream ? new StreamingMarkdownRenderer(!("NO_COLOR" in process.env)) : undefined;
  const emit = renderer
    ? (chunk: string): void => {
      const rendered = renderer.write(chunk);
      if (rendered) write(io.stdout, rendered);
    }
    : undefined;
  if (renderer) write(io.stdout, "\n[Ya single result]\n\n");

  const client = runtime.createClient(apiKey);
  let result: RunResult;
  if (options.toa && await toaConfirm(options, config, io)) {
    result = await toaAgent(client, task, config, Number(options.toaWorkers), undefined, images);
  } else {
    result = await singleAgent(client, task, config, options.web, emit, workspace, undefined, images);
  }
  if (renderer) {
    const tail = renderer.finish();
    if (tail) write(io.stdout, `${tail}\n`);
  } else {
    write(io.stdout, `\n[Ya ${result.mode} result]\n\n`);
    write(io.stdout, `${formatOutput(result.content, options.format, Boolean(io.stdout.isTTY))}\n`);
  }
  if (result.partial) write(io.stderr, "\n[Some ToA worker results were unavailable; the synthesis may be incomplete.]\n");
  await collectFeedback(result, !options.feedback, io);
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

function configSet(key: string, value: string, io: CliIo): void {
  if (key !== "model" && key !== "thinking" && key !== "reasoning-effort") {
    throw new Error("config key must be model, thinking, or reasoning-effort.");
  }
  const config = loadConfig();
  if (key === "model") config.model = modelId(value);
  else if (key === "thinking") {
    if (value !== "on" && value !== "off") throw new Error("thinking must be 'on' or 'off'.");
    config.thinkingEnabled = value === "on";
  } else {
    if (value !== "high" && value !== "max") throw new Error("reasoning-effort must be 'high' or 'max'.");
    config.reasoningEffort = value;
  }
  config.validate();
  saveConfig(config);
  write(io.stdout, `${JSON.stringify(config.toJSON(), null, 2)}\n`);
}

async function memoryPrune(includeCandidates: boolean, yes: boolean, io: CliIo): Promise<void> {
  const cards = cardsToPrune(includeCandidates);
  if (cards.length === 0) {
    write(io.stdout, "No matching memory cards to delete.\n");
    return;
  }
  write(io.stdout, `Memory cards to delete (${cards.length}):\n`);
  for (const card of cards) write(io.stdout, `  ${card.id}  ${card.status.padEnd(9)} ${card.kind.padEnd(10)} ${card.text}\n`);
  if (!yes) {
    if (!io.stdin.isTTY) throw new Error("ya memory prune requires --yes in a non-interactive shell.");
    const answer = (await io.prompt("Permanently delete these memory cards? [y/N] ")).trim().toLocaleLowerCase("und");
    if (answer !== "y" && answer !== "yes") {
      write(io.stdout, "No memory cards deleted.\n");
      return;
    }
  }
  const removed = pruneCards(includeCandidates);
  write(io.stdout, `Deleted ${removed.length} memory card(s).\n`);
}

async function auditClear(yes: boolean, io: CliIo): Promise<void> {
  const logs = auditLogFiles();
  if (logs.length === 0) {
    write(io.stdout, "No audit logs to delete.\n");
    return;
  }
  write(io.stdout, `Audit log files to delete (${logs.length}, ${auditLogTotalBytes()} bytes):\n`);
  for (const path of logs) write(io.stdout, `  ${path}\n`);
  if (!yes) {
    if (!io.stdin.isTTY) throw new Error("ya audit clear requires --yes in a non-interactive shell.");
    const answer = (await io.prompt("Permanently delete these audit logs? [y/N] ")).trim().toLocaleLowerCase("und");
    if (answer !== "y" && answer !== "yes") {
      write(io.stdout, "No audit logs deleted.\n");
      return;
    }
  }
  write(io.stdout, `Deleted ${clearAuditLogs().length} audit log file(s).\n`);
}

export function createProgram(io: CliIo, runtime: CliRuntime): Command {
  const program = new Command()
    .name("ya")
    .description("Ya personal research agent")
    .version(VERSION)
    .showHelpAfterError()
    .configureOutput({
      writeOut: (text) => write(io.stdout, text),
      writeErr: (text) => write(io.stderr, text),
    });
  // Install the exit override before creating children so parse errors from
  // nested commands never terminate embedders such as the desktop app/tests.
  program.exitOverride();

  program.command("ask")
    .description("Run a research task")
    .argument("<task>")
    .addOption(new Option("--model <model>").choices(["flash", "pro"]))
    .addOption(new Option("--thinking <state>").choices(["on", "off"]))
    .addOption(new Option("--reasoning-effort <effort>").choices(["high", "max"]))
    .option("--toa", "Use the bounded Tree of Agents", false)
    .option("--yes", "Authorize this ToA run in a non-interactive shell", false)
    .addOption(new Option("--toa-workers <count>").choices(["1", "2"]).default("2"))
    .option("--toa-token-budget <tokens>")
    .option("--toa-timeout <seconds>")
    .option("--no-feedback", "Do not ask to create a memory candidate")
    .addOption(new Option("--format <format>").choices(["auto", "terminal", "markdown"]).default("auto"))
    .addOption(new Option("--web <mode>").choices(["auto", "on", "off"]).default("auto"))
    .addOption(new Option("--stream <mode>").choices(["auto", "off"]).default("auto"))
    .option("--show-memory", "Show approved memory selected for this task", false)
    .option("--local", "Allow workspace file tools for this task", false)
    .option("--workspace <path>", "Workspace root for --local (default: current directory)")
    .option("--approve", "Allow local file changes in a non-interactive shell", false)
    .option("--image <source>", "Attach a local image, HTTP(S) URL, data URL, or file-api-* ID (repeatable)", collectValue, [])
    .addOption(new Option("--image-detail <detail>").choices(["low", "high", "original", "auto"]).default("auto"))
    .action(async (task: string, options: AskOptions) => ask(task, options, io, runtime));

  program.command("auth")
    .description("Store credentials")
    .argument("<provider>", "credential provider")
    .action(async (provider: string) => {
      if (provider !== "deepseek") throw new Error("provider must be 'deepseek'.");
      const apiKey = await io.prompt("DeepSeek API key: ", true);
      runtime.saveApiKey(apiKey);
      write(io.stdout, "DeepSeek API key saved to the macOS Keychain.\n");
    });

  const config = program.command("config").description("Configure Ya defaults");
  config.command("set")
    .argument("<key>")
    .argument("<value>")
    .action((key: string, value: string) => configSet(key, value, io));

  const memory = program.command("memory").description("Review local long-term memory");
  memory.command("review").action(() => {
    const cards = listCards();
    if (cards.length === 0) write(io.stdout, "No memory cards.\n");
    for (const card of cards) write(io.stdout, `${card.id}  ${card.status.padEnd(9)} ${card.kind.padEnd(10)} ${card.text}\n`);
  });
  for (const [action, status] of [["approve", "approved"], ["reject", "rejected"], ["revoke", "revoked"]] as const) {
    memory.command(`${action} <card-id>`).action((cardId: string) => {
      const card = setStatus(cardId, status);
      write(io.stdout, `${card.id}: ${card.status}\n`);
    });
  }
  memory.command("prune")
    .option("--include-candidates", "Also delete candidate cards", false)
    .option("--yes", "Confirm deletion without an interactive prompt", false)
    .action(async (options: { includeCandidates: boolean; yes: boolean }) => memoryPrune(options.includeCandidates, options.yes, io));

  const audit = program.command("audit").description("Manage local action audit logs");
  audit.command("clear")
    .description("Permanently delete local action audit logs")
    .option("--yes", "Confirm deletion without an interactive prompt", false)
    .action(async (options: { yes: boolean }) => auditClear(options.yes, io));
  return program;
}

export async function main(argv = process.argv.slice(2), context?: CliContext): Promise<number> {
  const io = makeIo(context);
  const runtime = makeRuntime(context);
  const program = createProgram(io, runtime);
  try {
    await program.parseAsync(["node", "ya", ...argv]);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    if (error instanceof Error || error instanceof DeepSeekError) {
      write(io.stderr, `Ya error: ${error.message}\n`);
      return 2;
    }
    write(io.stderr, `Ya error: ${String(error)}\n`);
    return 2;
  }
}

if (require.main === module) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
