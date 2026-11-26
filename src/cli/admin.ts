import { auditLogFiles, auditLogTotalBytes, clearAuditLogs } from "../audit-log";
import { isReasoningEffort, loadConfig, modelId, saveConfig } from "../config";
import { deleteStoredHistory, listStoredHistory, type StoredHistoryKind } from "../history";
import { cardsToPrune, listCards, pruneCards, setStatus, type MemoryStatus } from "../memory";
import { write } from "./io";
import type { CliIo, CliRuntime, HistoryClearOptions } from "./types";

export async function authKeychain(provider: string, io: CliIo, runtime: CliRuntime): Promise<void> {
  if (provider !== "deepseek") throw new Error("provider must be 'deepseek'.");
  if (runtime.platform !== "darwin") {
    throw new Error("ya auth deepseek is available only on macOS. Set DEEPSEEK_API_KEY instead.");
  }
  const apiKey = await io.prompt("DeepSeek API key: ", true);
  runtime.saveApiKey(apiKey);
  write(io.stdout, "DeepSeek API key saved to the macOS Keychain.\n");
}

export async function loginAccount(provider: string, io: CliIo, runtime: CliRuntime): Promise<void> {
  if (provider !== "deepseek") throw new Error("provider must be 'deepseek'.");
  const cancellation = new AbortController();
  const interrupt = (): void => cancellation.abort(new Error("DeepSeek sign-in cancelled."));
  process.once("SIGINT", interrupt);
  try {
    await runtime.loginDeepSeek({
      signal: cancellation.signal,
      locale: process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG,
      openBrowser: async (url) => {
        write(io.stdout, `Complete DeepSeek sign-in in your browser:\n${url}\nPress Ctrl+C to cancel.\n`);
        try { await runtime.openBrowser(url); }
        catch { write(io.stderr, "Could not open the browser. Open the URL above manually.\n"); }
      },
    });
    write(io.stdout, "Signed in to the DeepSeek platform.\n");
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}

export async function logoutAccount(provider: string, io: CliIo, runtime: CliRuntime): Promise<void> {
  if (provider !== "deepseek") throw new Error("provider must be 'deepseek'.");
  const revoked = await runtime.logoutDeepSeek();
  write(io.stdout, "Signed out of the DeepSeek account on this device.\n");
  if (!revoked) write(io.stderr, "The platform session could not be revoked. The local credential was removed.\n");
}

export function authStatus(provider: string, io: CliIo, runtime: CliRuntime): void {
  if (provider !== "deepseek") throw new Error("provider must be 'deepseek'.");
  write(io.stdout, runtime.loadAccountCredential() ? "DeepSeek account is signed in.\n" : "DeepSeek account is signed out.\n");
}

export function configSet(key: string, value: string, io: CliIo): void {
  if (key !== "model" && key !== "thinking" && key !== "reasoning-effort") {
    throw new Error("config key must be model, thinking, or reasoning-effort.");
  }
  const config = loadConfig();
  if (key === "model") config.model = modelId(value);
  else if (key === "thinking") {
    if (value !== "on" && value !== "off") throw new Error("thinking must be 'on' or 'off'.");
    config.thinkingEnabled = value === "on";
  } else {
    if (!isReasoningEffort(value)) throw new Error("reasoning-effort must be 'low', 'high', or 'max'.");
    config.reasoningEffort = value;
  }
  config.validate();
  saveConfig(config);
  write(io.stdout, `${JSON.stringify(config.toJSON(), null, 2)}\n`);
}

export function memoryReview(io: CliIo): void {
  const cards = listCards();
  if (cards.length === 0) write(io.stdout, "No memory cards.\n");
  for (const card of cards) write(io.stdout, `${card.id}  ${card.status.padEnd(9)} ${card.kind.padEnd(10)} ${card.text}\n`);
}

export function memorySetStatus(cardId: string, status: Exclude<MemoryStatus, "candidate">, io: CliIo): void {
  const card = setStatus(cardId, status);
  write(io.stdout, `${card.id}: ${card.status}\n`);
}

export async function memoryPrune(includeCandidates: boolean, yes: boolean, io: CliIo): Promise<void> {
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
  const removed = pruneCards(cards.map((card) => card.id), includeCandidates);
  write(io.stdout, `Deleted ${removed.length} memory card(s).\n`);
}

function parseHistoryDate(value: string): Date {
  const day = new Date(value + "T00:00:00");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || day.getDate() !== Number(value.slice(-2))) {
    throw new Error("Use a valid local date in YYYY-MM-DD format.");
  }
  return day;
}

function historyPeriod(options: HistoryClearOptions): { label: string; matches: (timestamp: number | null) => boolean } {
  if (options.all) return { label: "all dates", matches: () => true };
  if (options.undated) return { label: "unknown date", matches: (timestamp) => timestamp === null };
  let start = -Infinity;
  let end = Infinity;
  let label: string;
  if (options.from !== undefined || options.to !== undefined) {
    if (options.from !== undefined) start = parseHistoryDate(options.from).getTime();
    if (options.to !== undefined) {
      const last = parseHistoryDate(options.to);
      if (start > last.getTime()) throw new Error("--from must be on or before --to.");
      last.setDate(last.getDate() + 1);
      end = last.setHours(0, 0, 0, 0);
    }
    label = [options.from && `from ${options.from}`, options.to && `through ${options.to}`].filter(Boolean).join(" ");
  } else {
    const days = Number(options.olderThan);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    end = cutoff.setHours(0, 0, 0, 0);
    if (!/^\d+$/u.test(options.olderThan) || days < 1 || !Number.isFinite(end)) {
      throw new Error("--older-than must be a positive whole number of days within the supported date range.");
    }
    label = `older than ${days} days`;
  }
  return { label, matches: (timestamp) => timestamp !== null && timestamp >= start && timestamp < end };
}

export async function clearHistory(kind: StoredHistoryKind, options: HistoryClearOptions, io: CliIo): Promise<void> {
  const period = historyPeriod(options);
  const selected = listStoredHistory(kind).filter((entry) => period.matches(entry.timestamp));
  const bytes = selected.reduce((total, entry) => total + entry.bytes, 0);
  const scope = kind === "tasks" ? "Finished task records (CLI and desktop)" : "Action audit records";
  write(io.stdout, `${scope}, ${period.label}: ${selected.length} matching record(s), approximately ${bytes} bytes.\n`);
  if (options.dryRun || selected.length === 0) return;
  if (!options.yes) {
    if (!io.stdin.isTTY) throw new Error("ya history clear requires --yes for non-interactive deletion. Use --dry-run to preview.");
    const answer = await io.prompt("Permanently delete these records? [y/N] ");
    if (!/^(y|yes)$/iu.test(answer.trim())) {
      write(io.stdout, "No records deleted.\n");
      return;
    }
  }
  const count = deleteStoredHistory(kind, selected.map((entry) => entry.id));
  write(io.stdout, `Deleted ${count} record(s).\n`);
}

export async function auditClear(yes: boolean, io: CliIo): Promise<void> {
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
