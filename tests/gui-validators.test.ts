import { describe, expect, it } from "vitest";
import {
  assertTrustedSender,
  isTrustedRendererUrl,
  validateSettings,
  validateTaskOptions,
  validateWorkspaceModelSelection,
  validBotId,
} from "../src/gui/main/validators";

describe("GUI main IPC validators (without Electron mocks)", () => {
  const expectedUrl = "file:///app/dist/typescript/gui/index.html";

  it("validates trusted renderer URLs and sender frames", () => {
    expect(isTrustedRendererUrl(`${expectedUrl}#settings`, expectedUrl)).toBe(true);
    expect(isTrustedRendererUrl("https://evil.example/index.html", expectedUrl)).toBe(false);
    expect(isTrustedRendererUrl("not-a-url", expectedUrl)).toBe(false);

    expect(() => assertTrustedSender({
      sender: { getURL: () => expectedUrl },
      senderFrame: { url: expectedUrl },
    } as never, expectedUrl)).not.toThrow();

    expect(() => assertTrustedSender({
      sender: { getURL: () => expectedUrl },
      senderFrame: { url: "https://evil.example/" },
    } as never, expectedUrl)).toThrow("Untrusted renderer request.");
  });

  it("validates bot IDs, task options, settings, and model selections", () => {
    expect(validBotId("bot-1")).toBe(true);
    expect(validBotId(" padded ")).toBe(false);
    expect(validBotId("bad\ncontrol")).toBe(false);

    const parsedTask = validateTaskOptions({
      sessionId: " bot-1 ",
      task: "  Summarize changes ",
      webMode: "off",
      toaWorkers: 1,
      history: [{ role: "user", content: "hi" }],
    });
    expect(parsedTask).toMatchObject({
      sessionId: "bot-1",
      task: "Summarize changes",
      webMode: "off",
      toaWorkers: 1,
      history: [{ role: "user", content: "hi" }],
    });

    expect(() => validateTaskOptions({ task: "hi", webMode: "off", toaWorkers: 1, exec: true }))
      .toThrow("Shell commands are unavailable for folder-scoped bots.");
    expect(() => validateTaskOptions({ task: "hi", webMode: "off", toaWorkers: 3 }))
      .toThrow("ToA workers must be 1 or 2.");

    expect(validateSettings({
      language: "zh-CN",
      stream: false,
      thinkingEnabled: true,
      toaTokenBudget: 4000,
      toaTimeout: 90,
      keyStorage: "keychain",
    })).toEqual({
      language: "zh-CN",
      stream: false,
      thinkingEnabled: true,
      toaTokenBudget: 4000,
      toaTimeout: 90,
      keyStorage: "keychain",
    });
    expect(() => validateSettings({ language: "fr" })).toThrow("Invalid language.");

    expect(validateWorkspaceModelSelection({ model: "deepseek-flash", reasoningEffort: "max" })).toEqual({
      model: "deepseek-flash",
      reasoningEffort: "max",
    });
    expect(() => validateWorkspaceModelSelection({ model: "unknown", reasoningEffort: "high" })).toThrow("Invalid model.");
  });
});
