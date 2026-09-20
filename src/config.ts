import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const VALID_MODELS = {
  flash: "deepseek-v4.1-flash",
  pro: "deepseek-v4-pro-0813",
} as const;

export type ModelAlias = keyof typeof VALID_MODELS;
export type ModelId = (typeof VALID_MODELS)[ModelAlias];
export type ReasoningEffort = "high" | "max";

/** V4.1-Flash has native vision support; the pro model is text-only. */
const VISION_MODELS: readonly ModelId[] = [VALID_MODELS.flash];

/** Names retired by the V4.1 line-up, still resolved so existing configuration keeps loading. */
const RETIRED_MODELS: Record<string, ModelId> = {
  vision: VALID_MODELS.flash,
  "deepseek-v4-flash": VALID_MODELS.flash,
  "deepseek-v4-pro": VALID_MODELS.pro,
  "deepseek-v4-flash-vision-exp": VALID_MODELS.flash,
};

function resolveModel(value: string): ModelId | undefined {
  if (value in VALID_MODELS) return VALID_MODELS[value as ModelAlias];
  if (Object.values(VALID_MODELS).includes(value as ModelId)) return value as ModelId;
  return RETIRED_MODELS[value];
}

export interface ModelConfigValues {
  model: ModelId;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  toaTokenBudget: number;
  toaTimeout: number;
}

interface StoredModelConfig {
  model: ModelId;
  thinking_enabled: boolean;
  reasoning_effort: ReasoningEffort;
  toa_token_budget: number;
  toa_timeout: number;
}

export class ModelConfig implements ModelConfigValues {
  model: ModelId;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  toaTokenBudget: number;
  toaTimeout: number;

  constructor(values: Partial<ModelConfigValues> = {}) {
    this.model = values.model ?? VALID_MODELS.flash;
    this.thinkingEnabled = values.thinkingEnabled ?? false;
    this.reasoningEffort = values.reasoningEffort ?? "high";
    this.toaTokenBudget = values.toaTokenBudget ?? 8_000;
    this.toaTimeout = values.toaTimeout ?? 90;
  }

  validate(): void {
    if (!Object.values(VALID_MODELS).includes(this.model)) {
      throw new Error(`Only ${Object.values(VALID_MODELS).join(", ")} are supported.`);
    }
    if (this.reasoningEffort !== "high" && this.reasoningEffort !== "max") {
      throw new Error("reasoning effort must be 'high' or 'max'.");
    }
    if (!Number.isInteger(this.toaTokenBudget) || this.toaTokenBudget < 1_000 || this.toaTokenBudget > 16_000) {
      throw new Error("ToA token budget must be between 1000 and 16000.");
    }
    if (!Number.isInteger(this.toaTimeout) || this.toaTimeout < 30 || this.toaTimeout > 180) {
      throw new Error("ToA timeout must be between 30 and 180 seconds.");
    }
  }

  toJSON(): StoredModelConfig {
    return {
      model: this.model,
      thinking_enabled: this.thinkingEnabled,
      reasoning_effort: this.reasoningEffort,
      toa_token_budget: this.toaTokenBudget,
      toa_timeout: this.toaTimeout,
    };
  }

  static fromJSON(value: unknown): ModelConfig {
    if (!isRecord(value)) {
      throw new Error("Ya configuration must be a JSON object.");
    }
    const config = new ModelConfig({
      model: readModel(value.model),
      thinkingEnabled: readBoolean(value.thinking_enabled ?? value.thinkingEnabled, false),
      reasoningEffort: readEffort(value.reasoning_effort ?? value.reasoningEffort),
      toaTokenBudget: readNumber(value.toa_token_budget ?? value.toaTokenBudget, 8_000),
      toaTimeout: readNumber(value.toa_timeout ?? value.toaTimeout, 90),
    });
    config.validate();
    return config;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readModel(value: unknown): ModelId {
  if (typeof value !== "string") return VALID_MODELS.flash;
  return resolveModel(value) ?? (value as ModelId);
}

function readEffort(value: unknown): ReasoningEffort {
  return typeof value === "string" ? (value as ReasoningEffort) : "high";
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

export function dataHome(): string {
  const override = process.env.YA_HOME;
  return resolve(expandHome(override || join(homedir(), ".ya")));
}

export function configPath(): string {
  return join(dataHome(), "config.json");
}

export function loadConfig(): ModelConfig {
  const path = configPath();
  if (!existsSync(path)) return new ModelConfig();
  return ModelConfig.fromJSON(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function saveConfig(config: ModelConfig): void {
  config.validate();
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config.toJSON(), null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

export function modelId(value: string): ModelId {
  const resolved = resolveModel(value);
  if (!resolved) throw new Error("model must be 'flash' or 'pro'.");
  return resolved;
}

export function isVisionModel(model: ModelId): boolean {
  return VISION_MODELS.includes(model);
}

export function assertImageInputSupported(model: ModelId, imageCount: number): void {
  if (imageCount > 0 && !isVisionModel(model)) {
    throw new Error(`Image input requires model ${VALID_MODELS.flash}.`);
  }
}
