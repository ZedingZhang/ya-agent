import { ModelConfig } from "./config";
import { DeepSeekClient } from "./deepseek";
import { LocalWorkspace } from "./local";
import { singleAgent, toaAgent, type RunResult } from "./orchestrator";
import type { ToolHandler, WebMode } from "./types";

export interface RunTaskOptions {
  webMode?: WebMode;
  toa?: boolean;
  toaWorkers?: number;
  onContent?: (content: string) => void;
  localWorkspace?: LocalWorkspace;
  clientFactory?: (apiKey: string) => DeepSeekClient;
  webSearch?: ToolHandler;
}

export async function runTask(
  apiKey: string,
  task: string,
  config: ModelConfig,
  options: RunTaskOptions = {},
): Promise<RunResult> {
  const client = options.clientFactory?.(apiKey) ?? new DeepSeekClient(apiKey);
  if (options.toa) return toaAgent(client, task, config, options.toaWorkers ?? 2, options.webSearch);
  return singleAgent(
    client,
    task,
    config,
    options.webMode ?? "auto",
    options.onContent,
    options.localWorkspace,
    options.webSearch,
  );
}
