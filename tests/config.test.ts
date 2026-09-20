import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultModel, supportedModels } from "ya-core";
import {
  ModelConfig,
  VALID_MODELS,
  assertImageInputSupported,
  configPath,
  isVisionModel,
  loadConfig,
  modelId,
  saveConfig,
} from "../src/config";
import { tempHome, type TempHome } from "./helpers";

describe("configuration", () => {
  let home: TempHome;
  beforeEach(() => { home = tempHome(); });
  afterEach(() => home.cleanup());

  it("defaults to flash without thinking", () => {
    const config = loadConfig();
    expect(config.model).toBe("deepseek-v4.1-flash");
    expect(config.thinkingEnabled).toBe(false);
    expect(config.reasoningEffort).toBe("high");
    expect(config.toaTokenBudget).toBe(8_000);
    expect(config.toaTimeout).toBe(90);
  });

  it("round-trips through the Python-compatible storage schema", () => {
    const config = new ModelConfig({ model: modelId("pro"), reasoningEffort: "max" });
    saveConfig(config);
    expect(loadConfig()).toEqual(config);
    const stored = JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
    expect(stored).toMatchObject({
      model: "deepseek-v4-pro-0813",
      thinking_enabled: false,
      reasoning_effort: "max",
      toa_token_budget: 8_000,
      toa_timeout: 90,
    });
  });

  it("loads the existing snake-case Python configuration and migrates its model", () => {
    writeFileSync(configPath(), JSON.stringify({
      model: "deepseek-v4-pro",
      thinking_enabled: true,
      reasoning_effort: "max",
      toa_token_budget: 12_000,
      toa_timeout: 120,
    }));
    expect(loadConfig()).toEqual(new ModelConfig({
      model: "deepseek-v4-pro-0813",
      thinkingEnabled: true,
      reasoningEffort: "max",
      toaTokenBudget: 12_000,
      toaTimeout: 120,
    }));
  });

  it("migrates every model retired by the V4.1 line-up", () => {
    for (const retired of ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "vision"]) {
      writeFileSync(configPath(), JSON.stringify({
        model: retired,
        thinking_enabled: false,
        reasoning_effort: "high",
        toa_token_budget: 8_000,
        toa_timeout: 90,
      }));
      expect(loadConfig().model).toBe("deepseek-v4.1-flash");
    }
  });

  it("rejects unsupported models and invalid budgets", () => {
    expect(() => new ModelConfig({ model: "deepseek-chat" as never }).validate()).toThrow(/Only deepseek/u);
    expect(() => new ModelConfig({ toaTokenBudget: 999 }).validate()).toThrow(/between 1000 and 16000/u);
    expect(() => new ModelConfig({ toaTimeout: 181 }).validate()).toThrow(/between 30 and 180/u);
    expect(() => modelId("legacy")).toThrow(/flash.*pro/u);
  });

  it("treats V4.1-Flash as the vision model and keeps pro text-only", () => {
    const flash = "deepseek-v4.1-flash";
    expect(modelId("flash")).toBe(flash);
    expect(modelId("vision")).toBe(flash);
    expect(isVisionModel(modelId("flash"))).toBe(true);
    expect(isVisionModel(modelId("pro"))).toBe(false);
    expect(() => assertImageInputSupported(modelId("flash"), 1)).not.toThrow();
    expect(() => assertImageInputSupported(modelId("pro"), 1)).toThrow(flash);
  });

  it("keeps the TypeScript model table in step with the Rust core", () => {
    // VALID_MODELS carries the compile-time ModelId union, so it cannot be
    // derived from the binding; this pins the two together instead.
    expect(supportedModels()).toEqual(Object.values(VALID_MODELS));
    expect(defaultModel()).toBe(VALID_MODELS.flash);
  });
});
