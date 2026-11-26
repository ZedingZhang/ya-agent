import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileChange } from "../src/file-diff";
import { diffDisplayLines, fileChangeText } from "../src/gui/renderer/diff-view";
import { interpolate, translate } from "../src/gui/renderer/i18n";
import { savedActivities, validSavedCommand, validSavedFileChange } from "../src/gui/renderer/sessions";
import { rankSettingsSearch, settingsSearchCatalog } from "../src/gui/renderer/settings";

describe("GUI renderer modules", () => {
  it("translates and interpolates localized copy", () => {
    expect(translate("en", "settingsTabGeneral")).toBe("General");
    expect(translate("zh-CN", "settingsTabGeneral")).toBe("常规");
    expect(interpolate(translate("en", "changesSummary"), { files: 2, changes: 5 })).toBe("2 files · 5 changes");
  });

  it("validates persisted commands, file changes, and activities", () => {
    const change = createFileChange("notes.txt", "before\n", "after\n", "edit");
    expect(validSavedFileChange(change)).toBe(true);
    expect(validSavedFileChange({ ...change, additions: -1 })).toBe(false);

    expect(validSavedCommand({ id: "1", command: "npm test", cwd: ".", stdout: "", stderr: "" })).toBe(true);
    expect(validSavedCommand({ id: "1", command: "npm test", cwd: ".", stdout: "", stderr: "", result: { status: "bogus" } })).toBe(false);

    expect(savedActivities([{ operation: "read", paths: ["a.txt"], status: "success" }, { bad: true }])).toEqual([
      { operation: "read", paths: ["a.txt"], status: "success" },
    ]);
  });

  it("formats diff lines and clipboard text cleanly", () => {
    const change = createFileChange("src/a.ts", "one\n", "one\ntwo\n", "edit");
    const rows = diffDisplayLines(change, "en");
    expect(rows[0]).toEqual({ kind: "hunk", text: "@@ -1,1 +1,2 @@" });
    expect(rows.at(-1)).toMatchObject({ kind: "addition", newLine: 2, text: "two" });
    expect(fileChangeText(change, "en")).toContain("--- src/a.ts\n+++ src/a.ts");
  });

  it("ranks settings search queries across English and Chinese labels", () => {
    const catalog = settingsSearchCatalog("zh-CN", "darwin");
    const matches = rankSettingsSearch("超时", catalog);
    expect(matches[0]?.id).toBe("setting.timeout");
    expect(catalog.some((item) => item.id === "setting.keychain")).toBe(true);
    expect(settingsSearchCatalog("en", "linux").some((item) => item.id === "setting.keychain")).toBe(false);
  });

  it("keeps production build clean of smoke-test code and bundles renderer.js", () => {
    const mainJs = resolve("dist/typescript/gui/main.js");
    const rendererJs = resolve("dist/typescript/gui/renderer.js");
    const markdownJs = resolve("dist/typescript/gui/markdown.js");
    expect(existsSync(mainJs)).toBe(true);
    expect(existsSync(rendererJs)).toBe(true);
    expect(existsSync(markdownJs)).toBe(false);
    const mainSource = readFileSync(mainJs, "utf8");
    expect(mainSource).not.toContain("verifyRenderer");
    expect(mainSource).not.toContain("--smoke-test");
  });
});
