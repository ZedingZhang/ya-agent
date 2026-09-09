import { ModelConfig } from "./config";
import { DeepSeekClient } from "./deepseek";
import { LocalWorkspace } from "./local";
import { singleAgent, toaAgent, type RunResult } from "./orchestrator";
import type { ToolHandler, UserImageContentPart, WebMode } from "./types";

export interface RunTaskOptions {
  webMode?: WebMode;
  toa?: boolean;
  toaWorkers?: number;
  onContent?: (content: string) => void;
  localWorkspace?: LocalWorkspace;
  clientFactory?: (apiKey: string) => DeepSeekClient;
  webSearch?: ToolHandler;
  images?: UserImageContentPart[];
}

export async function runTask(
  apiKey: string,
  task: string,
  config: ModelConfig,
  options: RunTaskOptions = {},
): Promise<RunResult> {
  const client = options.clientFactory?.(apiKey) ?? new DeepSeekClient(apiKey);
  const images = options.images ?? [];
  if (options.toa) return toaAgent(client, task, config, options.toaWorkers ?? 2, options.webSearch, images);
  return singleAgent(
    client,
    task,
    config,
    options.webMode ?? "auto",
    options.onContent,
    options.localWorkspace,
    options.webSearch,
    images,
  );
}
