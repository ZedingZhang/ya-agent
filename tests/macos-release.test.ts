import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempHome, type TempHome } from "./helpers";

const bash = process.platform === "win32" ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe") : "/bin/bash";
const credentials = {
  MAC_CSC_LINK: Buffer.from("synthetic-certificate").toString("base64"), MAC_CSC_KEY_PASSWORD: "synthetic-certificate-password",
  APPLE_ID: "synthetic@example.invalid", APPLE_APP_SPECIFIC_PASSWORD: "synthetic-apple-password", APPLE_TEAM_ID: "SYNTHETIC1",
};

describe("macOS release packaging", () => {
  let home: TempHome;
  let environment: NodeJS.ProcessEnv;
  beforeEach(() => {
    home = tempHome("ya-macos-release-");
    cpSync(resolve(".github"), join(home.path, ".github"), { recursive: true });
    mkdirSync(join(home.path, "bin"));
    mkdirSync(join(home.path, "release-cli"));
    writeFileSync(join(home.path, "release-cli", "ya-macos-arm64"), "synthetic-cli");
    const driver = join(home.path, "fake-tool.cjs");
    writeFileSync(driver, `
      const fs = require("node:fs"), path = require("node:path");
      const [tool, ...args] = process.argv.slice(2);
      const signed = !!process.env.MAC_CSC_LINK;
      fs.appendFileSync(process.env.TOOL_LOG, JSON.stringify({tool,args,csc:process.env.CSC_LINK,auto:process.env.CSC_IDENTITY_AUTO_DISCOVERY})+"\\n");
      if (process.env.FAIL_TOOL === tool) process.exit(9);
      if (tool === "npx") { fs.mkdirSync("release/electron", {recursive:true}); fs.writeFileSync("release/electron/Ya.zip", "synthetic-zip"); }
      if (tool === "openssl") process.stdout.write("ab".repeat(32));
      if (tool === "security" && args[0] === "find-identity" && !process.env.NO_IDENTITY) process.stdout.write('1) 0123456789ABCDEF0123456789ABCDEF01234567 "Developer ID Application: Synthetic"\\n');
      if (tool === "security" && args[0] === "import" && fs.readFileSync(args[1],"utf8") !== "synthetic-certificate") {
        process.stderr.write("Synthetic certificate import failed"); process.exit(9);
      }
      if (tool === "codesign") {
        if (process.env.BAD_TEAM && args.includes("-R")) process.exit(8);
        if (args.includes("--display")) process.stderr.write(signed
          ? (process.env.NO_RUNTIME ? "CodeDirectory flags=0x0\\n" : "CodeDirectory flags=0x10000(runtime)\\n")
          : (process.env.BAD_ADHOC ? "Signature=wrong\\n" : "CodeDirectory flags=0x2(adhoc)\\nSignature=adhoc\\n"));
      }
      if (tool === "ditto") {
        const target = args.at(-1);
        if (args.includes("-x")) fs.mkdirSync(path.join(target,"Ya.app"), {recursive:true});
        else fs.writeFileSync(target,"synthetic-archive");
      }
      if (tool === "xcrun") {
        if (args[0] === "notarytool") process.stdout.write(JSON.stringify({status:process.env.REJECT_NOTARY ? "Invalid" : "Accepted"}));
        if (args[0] === "stapler" && process.env.BAD_STAPLE) process.exit(7);
      }
    `);
    for (const tool of ["npx", "security", "openssl", "codesign", "ditto", "xcrun", "spctl"]) {
      writeFileSync(join(home.path, "bin", tool), `#!/bin/sh\nexec "$TEST_NODE" "$TEST_DRIVER" "${tool}" "$@"\n`, { mode: 0o755 });
    }
    const portable = (path: string) => path.replace(/\\/gu, "/");
    environment = {
      PATH: [join(home.path, "bin"), dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
      SYSTEMROOT: process.env.SystemRoot, TEMP: home.path, TMP: home.path, HOME: home.path,
      RUNNER_TEMP: portable(home.path), TEST_NODE: portable(process.execPath), TEST_DRIVER: portable(driver),
      TOOL_LOG: join(home.path, "tools.jsonl"), CLI_ASSET: "ya-macos-arm64", ELECTRON_ARGS: "--mac zip --arm64",
    };
  });
  afterEach(() => home.cleanup());

  const commands = () => existsSync(environment.TOOL_LOG!)
    ? readFileSync(environment.TOOL_LOG!, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { tool: string; args: string[]; csc?: string; auto?: string })
    : [];
  const run = (extra: NodeJS.ProcessEnv = {}, script = "package-macos.sh", args: string[] = []) => spawnSync(bash,
    [`.github/scripts/${script}`, ...args], { cwd: home.path, env: { ...environment, ...extra }, encoding: "utf8", timeout: 20_000 });
  const modeFile = () => join(home.path, "release-cli", "ya-macos-arm64.signing-mode");

  it("builds and verifies an ad-hoc GUI with no credentials", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(modeFile(), "utf8").trim()).toBe("ad-hoc");
    const builder = commands().find((call) => call.tool === "npx")!;
    expect(builder.auto).toBe("false");
    expect(builder.args).toEqual(expect.arrayContaining(["--config.mac.identity=-", "--config.mac.hardenedRuntime=false", "--config.mac.notarize=false"]));
    expect(commands().some((call) => call.tool === "codesign" && call.args.includes("--verify"))).toBe(true);
    expect(commands().some((call) => call.tool === "xcrun" || call.tool === "security")).toBe(false);
  });

  it("selects formal signing, hardened runtime, notarization and verification with complete credentials", () => {
    const result = run(credentials);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(modeFile(), "utf8").trim()).toBe("signed");
    const calls = commands();
    const builder = calls.find((call) => call.tool === "npx")!;
    expect(builder.csc).toBe(credentials.MAC_CSC_LINK);
    expect(builder.auto).not.toBe("false");
    expect(builder.args).toEqual(expect.arrayContaining(["--config.forceCodeSigning=true", "--config.mac.hardenedRuntime=true", "--config.mac.notarize=true"]));
    expect(builder.args.some((arg) => arg.endsWith("=false") || arg === "--config.mac.identity=-")).toBe(false);
    expect(calls.some((call) => call.tool === "xcrun" && call.args[0] === "notarytool")).toBe(true);
    expect(calls.some((call) => call.tool === "xcrun" && call.args[0] === "stapler" && call.args[1] === "validate")).toBe(true);
    expect(calls.some((call) => call.tool === "spctl")).toBe(true);
    expect(calls.some((call) => call.tool === "security" && call.args[0] === "delete-keychain")).toBe(true);
  });

  it("passes complete secrets through the actual macOS workflow command without disabling signing", () => {
    const workflow = readFileSync(join(home.path, ".github", "workflows", "release.yml"), "utf8");
    const steps = workflow.split(/\n {6}- /u);
    const step = steps.find((text) => text.startsWith("name: Build and verify macOS release assets"))
      ?? steps.find((text) => text.startsWith("name: Build desktop application without publisher signing"))!;
    const runLine = /\n {8}run: (.+)/u.exec(step)!;
    const command = runLine[1] === ">-"
      ? [...step.slice(runLine.index + runLine[0].length).matchAll(/\n {10}(.+)/gu)].map((match) => match[1]).join(" ")
      : runLine[1]!;
    const result = spawnSync(bash, ["-c", command], { cwd: home.path, env: { ...environment, ...credentials }, encoding: "utf8", timeout: 20_000 });
    expect(result.status, result.stderr).toBe(0);
    const builder = commands().find((call) => call.tool === "npx")!;
    expect(builder.args.some((arg) => arg.endsWith("=false") || arg === "--config.mac.identity=-")).toBe(false);
    for (const name of Object.keys(credentials)) expect(step).toContain(name + ": ${{ secrets." + name + " }}");
    expect(commands().some((call) => call.tool === "xcrun" && call.args[0] === "notarytool")).toBe(true);
  });

  it("allows PR ad-hoc verification only in the CI step without credentials", () => {
    const ci = readFileSync(join(home.path, ".github", "workflows", "ci.yml"), "utf8");
    const step = ci.split(/\n {6}- /u).find((text) => text.startsWith("name: Verify macOS release packaging without credentials"))!;
    expect(step).toContain('CSC_FOR_PULL_REQUEST: "true"');
    expect(step).not.toContain("secrets.");
    for (const name of [...Object.keys(credentials), "CSC_LINK", "CSC_KEY_PASSWORD"]) expect(step).toContain(`${name}: ""`);
    expect(ci.match(/CSC_FOR_PULL_REQUEST:/gu)).toHaveLength(1);
    expect(readFileSync(join(home.path, ".github", "workflows", "release.yml"), "utf8")).not.toContain("CSC_FOR_PULL_REQUEST");
  });

  it.each(Array.from({ length: 30 }, (_, index) => index + 1))("rejects incomplete credential subset %i before building", (mask) => {
    const supplied = Object.fromEntries(Object.entries(credentials).filter((_entry, index) => mask & 1 << index));
    const result = run(supplied);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Incomplete macOS signing credentials");
    expect(commands()).toEqual([]);
    expect(existsSync(modeFile())).toBe(false);
  });

  it.each([
    { FAIL_TOOL: "npx" }, { NO_IDENTITY: "1" }, { REJECT_NOTARY: "1" }, { BAD_TEAM: "1" }, { BAD_STAPLE: "1" }, { FAIL_TOOL: "spctl" },
    { NO_RUNTIME: "1" }, { MAC_CSC_LINK: "invalid-base64" }, { MAC_CSC_LINK: Buffer.from("invalid-certificate").toString("base64") },
  ])("fails a signed build without downgrading when validation fails (%j)", (failure) => {
    const result = run({ ...credentials, ...failure });
    expect(result.status).not.toBe(0);
    expect(existsSync(modeFile())).toBe(false);
    expect(commands().filter((call) => call.tool === "npx")).toHaveLength(1);
    expect(commands().some((call) => call.args.includes("--config.mac.identity=-"))).toBe(false);
    expect(commands().some((call) => call.tool === "security" && call.args[0] === "delete-keychain")).toBe(failure.FAIL_TOOL !== "npx");
    for (const value of Object.values(credentials).filter((value) => value.includes("password"))) {
      expect(result.stdout + result.stderr).not.toContain(value);
    }
  });

  it("does not record success for an invalid ad-hoc signature", () => {
    const result = run({ BAD_ADHOC: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Expected an ad-hoc GUI signature");
    expect(existsSync(modeFile())).toBe(false);
  });

  it.each(["signed", "ad-hoc"])("renders release notes from both verified %s mode records", (mode) => {
    mkdirSync(join(home.path, "release"));
    for (const arch of ["arm64", "x64"]) writeFileSync(join(home.path, "release", `ya-macos-${arch}.signing-mode`), `${mode}\n`);
    const result = run({}, "release-notes.sh", ["release", "notes.md"]);
    expect(result.status, result.stderr).toBe(0);
    const notes = readFileSync(join(home.path, "notes.md"), "utf8");
    expect(notes).not.toContain("@@MACOS_SIGNING_");
    expect(notes).toContain(mode === "signed" ? "Developer ID signed" : "ad-hoc signatures");
    expect(notes).toContain(mode === "signed" ? "Apple notarization verified" : "without Apple notarization");
    expect(notes).toContain(mode === "signed" ? "已通过 Developer ID 签名" : "未经 Apple 公证");
  });

  it("rejects inconsistent mode records before producing release notes", () => {
    mkdirSync(join(home.path, "release"));
    writeFileSync(join(home.path, "release", "ya-macos-arm64.signing-mode"), "signed\n");
    writeFileSync(join(home.path, "release", "ya-macos-x64.signing-mode"), "ad-hoc\n");
    const result = run({}, "release-notes.sh", ["release", "notes.md"]);
    expect(result.status).not.toBe(0);
    expect(existsSync(join(home.path, "notes.md"))).toBe(false);
  });
});
