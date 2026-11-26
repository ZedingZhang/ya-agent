import { spawn } from "node:child_process";
import { loginDeepSeek, logoutDeepSeek, type AccountLoginOptions } from "../account";
import type { ReasoningEffort } from "../config";
import { loadAccountCredential, type AccountCredential, type DeepSeekCredential } from "../credentials";
import { DeepSeekClient } from "../deepseek";
import { loadApiKey, saveApiKey } from "../keychain";
import type { ImageDetail, OutputFormat, WebMode } from "../types";

export interface InputStream extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
}

export interface OutputStream extends NodeJS.WritableStream {
  isTTY?: boolean;
}

export interface CliIo {
  stdin: InputStream;
  stdout: OutputStream;
  stderr: OutputStream;
  prompt: (question: string, hidden?: boolean, signal?: AbortSignal) => Promise<string>;
}

export interface CliRuntime {
  platform: NodeJS.Platform;
  loadApiKey: () => string | undefined;
  saveApiKey: (apiKey: string) => void;
  loadAccountCredential: () => AccountCredential | undefined;
  loginDeepSeek: (options: AccountLoginOptions) => Promise<void>;
  logoutDeepSeek: () => Promise<boolean>;
  openBrowser: (url: string) => Promise<void>;
  createClient: (apiKey: DeepSeekCredential, signal?: AbortSignal) => DeepSeekClient;
}

export interface CliContext {
  io?: CliIo;
  runtime?: Partial<CliRuntime>;
}

export interface AskOptions {
  model?: string;
  thinking?: "on" | "off";
  reasoningEffort?: ReasoningEffort;
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
  exec: boolean;
  approveCommands: boolean;
  image: string[];
  imageDetail: ImageDetail;
}

export interface HistoryClearOptions {
  from?: string;
  to?: string;
  olderThan: string;
  all?: boolean;
  undated?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

export const defaultRuntime: CliRuntime = {
  platform: process.platform,
  loadApiKey,
  saveApiKey,
  loadAccountCredential,
  loginDeepSeek,
  logoutDeepSeek,
  openBrowser: (url) => new Promise((resolve, reject) => {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
    const arguments_ = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    const child = spawn(command, arguments_, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => reject(new Error("Could not open the browser.")));
    child.once("spawn", () => { child.unref(); resolve(); });
  }),
  createClient: (apiKey, signal) => new DeepSeekClient(apiKey, undefined, undefined, signal),
};

export function makeRuntime(context?: CliContext): CliRuntime {
  return { ...defaultRuntime, ...context?.runtime };
}
