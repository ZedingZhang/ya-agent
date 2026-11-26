import { spawn, spawnSync } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BOT_PERMISSIONS_DIR, dataHome } from "../config";
import { isSensitive } from "../local-files";

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
}

function checkEndpoints(source: string, destination: string): void {
  if (isSensitive(resolve(source)) || isSensitive(resolve(destination))) throw new Error("Moving sensitive paths is blocked.");
  if (lstatSync(destination, { throwIfNoEntry: false })) throw new Error("Destination already exists.");
  const entry = lstatSync(source, { bigint: true });
  if (!entry.isDirectory()) return;
  if (containsPath(resolve(source), resolve(destination))) throw new Error("Cannot move a directory into itself.");
  // Compare directory identities as different spellings can name the same directory.
  let ancestor = realpathSync(join(dataHome(), BOT_PERMISSIONS_DIR));
  for (;;) {
    const dir = statSync(ancestor, { bigint: true });
    if (dir.dev === entry.dev && dir.ino === entry.ino) throw new Error("Moving a directory containing bot folder permissions is blocked.");
    const parent = dirname(ancestor);
    if (ancestor === parent) break;
    ancestor = parent;
  }
}

function moveExecutable(identityExecutable: string): string {
  return join(dirname(identityExecutable), process.platform === "win32" ? "ya-folder-move.exe" : "ya-folder-move");
}

/** Both names are direct children of the worker's pinned current directory. */
export function publishNewFile(identityExecutable: string, stage: string, destination: string): void {
  const result = spawnSync(moveExecutable(identityExecutable), ["1", stage, destination], { input: "Y", windowsHide: true });
  if (result.status !== 0) throw new Error("Could not publish the new file. Check the destination and retry.");
}

/** Called only from the file worker, with the verified grant as its cwd. */
export async function moveInGrantedFolder(identityExecutable: string, source: string, destination: string,
  checkAccess: () => void, confirm: () => Promise<boolean>): Promise<boolean> {
  const from = source.split(sep);
  const to = destination.split(sep);
  if ([...from, ...to].some((part) => !part || part === "." || part === "..")) throw new Error("Invalid move path.");
  const check = (): void => { checkAccess(); checkEndpoints(source, destination); };
  check();
  const child = spawn(moveExecutable(identityExecutable), [String(from.length), ...from, ...to], { stdio: "pipe", windowsHide: true });
  let failure: Error | undefined;
  let detail = "";
  child.on("error", (error) => { failure = error; });
  child.stdin.on("error", (error: Error) => { failure = error; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { detail += chunk; });
  const done = new Promise<number | null>((settle) => child.once("close", settle));
  let approved = false;
  try {
    for await (const ready of child.stdout) {
      if (ready.toString() !== "R") throw new Error("Invalid response from the folder move helper.");
      check();
      approved = await confirm();
      if (approved) check();
      child.stdin.end(approved ? "Y" : "N");
    }
    const code = await done;
    if (failure) throw failure;
    if (code !== (approved ? 0 : 2)) throw new Error(detail.trim() || "Folder move did not complete.");
    return approved;
  } finally {
    if (!child.stdin.writableEnded) child.stdin.end();
    await done;
  }
}
