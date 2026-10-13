import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

const requireFromHere = createRequire(__filename);
const electronExecutable = requireFromHere("electron") as string;
const mainFile = join(__dirname, "../gui/main.js");

function runChecked(command: string, arguments_: string[], input?: string): string {
  const result = spawnSync(command, arguments_, { encoding: "utf8", input });
  if (result.error) throw result.error;
  if (result.status === 0) return result.stdout;
  const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${String(result.status)}`;
  throw new Error(`${command} failed: ${detail}`);
}

function updatePlist(file: string, values: Record<string, string>): void {
  const plist = JSON.parse(runChecked("/usr/bin/plutil", ["-convert", "json", "-o", "-", file])) as Record<string, unknown>;
  Object.assign(plist, values);
  runChecked("/usr/bin/plutil", ["-convert", "xml1", "-o", file, "-"], JSON.stringify(plist));
}

function macosDevelopmentExecutable(): string {
  const electronPackageDirectory = dirname(requireFromHere.resolve("electron/package.json"));
  const sourceBundle = dirname(dirname(dirname(electronExecutable)));
  const sourceName = basename(electronExecutable);
  const cacheDirectory = join(electronPackageDirectory, ".ya-development", "macos-v1");
  const targetBundle = join(cacheDirectory, "Ya.app");
  const targetExecutable = join(targetBundle, "Contents/MacOS/Ya");
  if (existsSync(targetExecutable)) return targetExecutable;

  mkdirSync(cacheDirectory, { recursive: true });
  const stagingDirectory = mkdtempSync(join(cacheDirectory, ".build-"));
  const stagingBundle = join(stagingDirectory, "Ya.app");
  const bundleIdentifier = "com.zedingzhang.ya.gui.development";
  try {
    // Keep the installed Electron runtime intact; cache a separately branded copy.
    runChecked("ditto", [sourceBundle, stagingBundle]);
    const contents = join(stagingBundle, "Contents");
    updatePlist(join(contents, "Info.plist"), {
      CFBundleDisplayName: "Ya",
      CFBundleName: "Ya",
      CFBundleExecutable: "Ya",
      CFBundleIdentifier: bundleIdentifier,
    });
    renameSync(join(contents, "MacOS", sourceName), join(contents, "MacOS", "Ya"));

    // Electron resolves helper bundles using CFBundleName, so rename their
    // bundles and executables together with the main application.
    const frameworks = join(contents, "Frameworks");
    for (const entry of readdirSync(frameworks)) {
      if (!entry.startsWith(`${sourceName} Helper`) || !entry.endsWith(".app")) continue;
      const oldName = basename(entry, ".app");
      const newName = `Ya${oldName.slice(sourceName.length)}`;
      const helperContents = join(frameworks, entry, "Contents");
      const suffix = newName.slice("Ya Helper".length).replace(/[^a-zA-Z0-9]/gu, "").toLowerCase();
      updatePlist(join(helperContents, "Info.plist"), {
        CFBundleDisplayName: newName,
        CFBundleName: newName,
        CFBundleExecutable: newName,
        CFBundleIdentifier: `${bundleIdentifier}.helper${suffix ? `.${suffix}` : ""}`,
      });
      renameSync(join(helperContents, "MacOS", oldName), join(helperContents, "MacOS", newName));
      renameSync(join(frameworks, entry), join(frameworks, `${newName}.app`));
    }
    runChecked("codesign", ["--force", "--deep", "--sign", "-", stagingBundle]);
    runChecked("codesign", ["--verify", "--deep", "--strict", stagingBundle]);
    // Publish only a complete bundle, allowing simultaneous launches to reuse it.
    try {
      renameSync(stagingBundle, targetBundle);
    } catch (error) {
      if (!existsSync(targetExecutable)) throw error;
    }
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
  return targetExecutable;
}

function launch(): void {
  const executable = process.platform === "darwin" ? macosDevelopmentExecutable() : electronExecutable;
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [mainFile, ...process.argv.slice(2)], { stdio: "inherit", env: environment });
  child.on("error", (error) => {
    process.stderr.write(`Unable to start Ya GUI: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on("close", (code, signal) => {
    if (signal) process.stderr.write(`Ya GUI exited with signal ${signal}.\n`);
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGUSR2"] as const) {
    process.on(signal, () => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); });
  }
}

try {
  launch();
} catch (error) {
  process.stderr.write(`Unable to start Ya GUI: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
