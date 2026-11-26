#!/usr/bin/env node

import { Argument, Command, CommanderError, Option } from "commander";
import { REASONING_EFFORTS } from "./config";
import { DeepSeekError } from "./deepseek";
import type { StoredHistoryKind } from "./history";
import { VERSION } from "./version";
import {
  auditClear,
  authKeychain,
  authStatus,
  clearHistory,
  configSet,
  loginAccount,
  logoutAccount,
  memoryPrune,
  memoryReview,
  memorySetStatus,
} from "./cli/admin";
import { collectFeedback, localConfirm, resolveConfig, runAskCommand, toaConfirm } from "./cli/ask";
import { collectValue, makeIo, write } from "./cli/io";
import { makeRuntime, type AskOptions, type CliContext, type CliIo, type CliRuntime, type HistoryClearOptions } from "./cli/types";

export { collectFeedback, localConfirm, resolveConfig, toaConfirm };
export type { CliContext, CliIo };

export function createProgram(io: CliIo, runtime: CliRuntime): Command {
  const program = new Command()
    .name("ya")
    .description("Ya CLI agent for DeepSeek")
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
    .description("Run a task")
    .argument("<task>")
    .addOption(new Option("--model <model>").choices(["flash", "pro"]))
    .addOption(new Option("--thinking <state>").choices(["on", "off"]))
    .addOption(new Option("--reasoning-effort <effort>").choices([...REASONING_EFFORTS]))
    .option("--toa", "Use Tree of Agents", false)
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
    .option("--exec", "Enable approved shell commands for tests, type checks and builds (requires --local)", false)
    .option("--approve-commands", "Approve all commands for this non-interactive task (requires --exec)", false)
    .option("--image <source>", "Attach a local image, HTTP(S) URL, data URL, or file-api-* ID (repeatable)", collectValue, [])
    .addOption(new Option("--image-detail <detail>", "Image detail (low requires API-key authentication)").choices(["low", "high", "original", "auto"]).default("auto"))
    .action(async (task: string, options: AskOptions) => runAskCommand(task, options, io, runtime));

  program.command("auth")
    .description("Store credentials in macOS Keychain (other platforms: set DEEPSEEK_API_KEY)")
    .argument("<provider>", "credential provider")
    .action(async (provider: string) => authKeychain(provider, io, runtime));

  program.command("login")
    .description("Sign in to the DeepSeek platform in your browser")
    .argument("[provider]", "account provider", "deepseek")
    .action(async (provider: string) => loginAccount(provider, io, runtime));

  program.command("logout")
    .description("Remove the local DeepSeek account login and revoke its platform session")
    .argument("[provider]", "account provider", "deepseek")
    .action(async (provider: string) => logoutAccount(provider, io, runtime));

  program.command("auth-status")
    .description("Show DeepSeek account sign-in status without revealing credentials")
    .argument("[provider]", "account provider", "deepseek")
    .action((provider: string) => authStatus(provider, io, runtime));

  const config = program.command("config").description("Configure Ya defaults");
  config.command("set")
    .argument("<key>")
    .argument("<value>")
    .action((key: string, value: string) => configSet(key, value, io));

  const memory = program.command("memory").description("Review local long-term memory");
  memory.command("review").action(() => memoryReview(io));
  for (const [action, status] of [["approve", "approved"], ["reject", "rejected"], ["revoke", "revoked"]] as const) {
    memory.command(`${action} <card-id>`).action((cardId: string) => memorySetStatus(cardId, status, io));
  }
  memory.command("prune")
    .option("--include-candidates", "Also delete candidate cards", false)
    .option("--yes", "Confirm deletion without an interactive prompt", false)
    .action(async (options: { includeCandidates: boolean; yes: boolean }) => memoryPrune(options.includeCandidates, options.yes, io));

  const history = program.command("history").description("Manage local task and action audit history");
  history.command("clear")
    .description("Preview and delete history by local calendar date")
    .addArgument(new Argument("[kind]", "History category").choices(["tasks", "audit"]).default("tasks"))
    .option("--from <YYYY-MM-DD>", "First local date to include")
    .option("--to <YYYY-MM-DD>", "Last local date to include")
    .addOption(new Option("--older-than <days>", "Select records before the day this many days ago").default("30").conflicts(["from", "to"]))
    .addOption(new Option("--undated", "Select records with an unknown date").conflicts(["from", "to", "olderThan"]))
    .addOption(new Option("--all", "Select all dates, including unknown dates").conflicts(["from", "to", "olderThan", "undated"]))
    .option("--dry-run", "Show the matching count and estimated size, then exit")
    .option("--yes", "Confirm deletion without an interactive prompt")
    .action((kind: StoredHistoryKind, options: HistoryClearOptions) => clearHistory(kind, options, io));

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
