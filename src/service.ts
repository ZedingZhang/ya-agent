import { ModelConfig } from "./config";
import { DeepSeekClient } from "./deepseek";
import { LocalWorkspace } from "./local";
import { singleAgent, toaAgent, type RunResult } from "./orchestrator";
import type { ToolHandler, UserImageContentPart, WebMode } from "./types";
import { search } from "./web";

export interface RunTaskOptions {
  webMode?: WebMode;
  toa?: boolean;
  toaWorkers?: number;
  onContent?: (content: string) => void;
  localWorkspace?: LocalWorkspace;
  clientFactory?: (apiKey: string, signal?: AbortSignal) => DeepSeekClient;
  webSearch?: ToolHandler;
  images?: UserImageContentPart[];
  signal?: AbortSignal;
}

export async function runTask(
  apiKey: string,
  task: string,
  config: ModelConfig,
  options: RunTaskOptions = {},
): Promise<RunResult> {
  options.signal?.throwIfAborted();
  if (options.toa && options.localWorkspace) throw new Error("Local workspace mode cannot be used with Tree of Agents.");
  const client = options.clientFactory?.(apiKey, options.signal) ?? new DeepSeekClient(apiKey, undefined, undefined, options.signal);
  const webSearch = options.webSearch ?? ((arguments_) => search(arguments_, undefined, undefined, options.signal));
  const images = options.images ?? [];
  if (options.toa) return toaAgent(client, task, config, options.toaWorkers ?? 2, webSearch, images);
  return singleAgent(
    client,
    task,
    config,
    options.webMode ?? "auto",
    options.onContent,
    options.localWorkspace,
    webSearch,
    images,
  );
}
