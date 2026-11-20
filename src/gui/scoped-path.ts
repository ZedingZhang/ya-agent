import { execFileSync } from "node:child_process";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, parse, resolve, sep } from "node:path";
import { isSensitive } from "../local";
import type { FolderGrant } from "./folder-grants";

const denied = "Path must remain inside the authorized workspace.";

function parts(path: string): string[] {
  return path.slice(parse(path).root.length).split(sep).filter(Boolean);
}

// Only inspect a case variant of an approved component, from its trusted
// parent. In particular, never resolve an unrecognized drive or UNC share.
function suffix(root: string, candidate: string, short?: string[]): string[] | undefined {
  const volume = parse(root).root;
  const device = parse(candidate).root;
  if (volume !== device && !(process.platform === "win32" && volume.toLowerCase() === device.toLowerCase())) return;
  const approved = parts(root);
  const input = parts(candidate);
  if (input.length < approved.length || approved.some((name, i) => name.toLowerCase() !== input[i]!.toLowerCase() && short?.[i]?.toLowerCase() !== input[i]!.toLowerCase())) return;
  let parent = volume;
  for (const [index, name] of approved.entries()) {
    const canonical = join(parent, name);
    if (input[index] !== name) {
      const expected = lstatSync(canonical, { bigint: true });
      const alternate = lstatSync(join(parent, input[index]!), { bigint: true, throwIfNoEntry: false });
      if (!expected.ino || expected.dev !== alternate?.dev || expected.ino !== alternate.ino) return;
    }
    parent = canonical;
  }
  return input.slice(approved.length);
}

function linkTarget(path: string): string {
  const target = readlinkSync(path);
  // Windows junctions can return the extended spelling of a DOS or UNC path.
  if (process.platform === "win32" && target.startsWith("\\\\?\\")) {
    const plain = target.slice(4);
    if (plain.startsWith("UNC\\")) return "\\\\" + plain.slice(4);
    if (/^[a-z]:\\/iu.test(plain)) return plain;
  }
  return target;
}

// Recheck the spelling returned by the picker without following a replacement
// link to an unrelated volume. Accepted link targets lead along the verified root.
function selectedRootMatches(selected: string, root: string, short?: string[]): boolean {
  let dir = parse(selected).root;
  for (const name of parts(selected)) {
    const next = join(dir, name);
    const entry = lstatSync(next, { throwIfNoEntry: false });
    if (!entry) return false;
    if (entry.isSymbolicLink()) {
      const target = resolve(dir, linkTarget(next));
      const count = parts(target).length;
      const ancestor = join(parse(root).root, ...parts(root).slice(0, count));
      if (suffix(ancestor, target, short)?.length !== 0) return false;
      dir = ancestor;
    } else {
      if (!entry.isDirectory()) return false;
      dir = next;
    }
  }
  return realpathSync.native(dir) === root;
}

export function folderPathResolver(root: string, grant: FolderGrant, identityExecutable: string): (submitted: string) => string {
  const anchors = new Set([root, grant.path, ...(grant.selectedPath ? [grant.selectedPath] : [])]);
  if (process.platform === "darwin") {
    for (const alias of ["/tmp", "/var", "/etc"]) {
      if ((root === "/private" + alias || root.startsWith("/private" + alias + "/"))
        && realpathSync.native(alias) === "/private" + alias) anchors.add(root.slice("/private".length));
    }
  }
  let shortParts: string[] | undefined;
  const shortRootParts = (): string[] | undefined => {
    if (process.platform !== "win32") return;
    if (!shortParts) {
      try {
        const shortRoot = execFileSync(identityExecutable, ["short-path", root], { encoding: "utf8", windowsHide: true });
        shortParts = parts(shortRoot);
      } catch { shortParts = []; }
    }
    return shortParts;
  };
  const components = (input: string): string[] => {
    if (isSensitive(input)) throw new Error("Access to sensitive paths is blocked.");
    if (!isAbsolute(input)) {
      if (parse(input).root || normalize(input).split(sep).includes("..")) throw new Error(denied);
      return normalize(input).split(sep).filter((name) => name && name !== ".");
    }
    for (const anchor of anchors) {
      const tail = suffix(anchor, normalize(input));
      if (tail) {
        if (anchor === grant.selectedPath && anchor !== root && !selectedRootMatches(anchor, root, shortRootParts())) throw new Error(denied);
        return tail;
      }
    }
    if (process.platform === "win32" && parse(root).root.toLowerCase() === parse(input).root.toLowerCase()) {

      const tail = suffix(root, normalize(input), shortRootParts());
      if (tail) return tail;
    }
    throw new Error(denied);
  };

  // Inspect links themselves before following them. Restart from the pinned
  // root after translating each target, including absolute junction targets.
  const walk = (names: string[], depth: number, mustExist: boolean): string => {
    if (depth > 40) throw new Error("Too many symbolic links.");
    let path = root;
    for (const name of names) {
      if (process.platform === "win32" && (name.includes(":") || /[. ]$/u.test(name) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(name))) throw new Error(denied);
      path = join(path, name);
      if (isSensitive(path)) throw new Error("Access to sensitive paths is blocked.");
      const entry = lstatSync(path, { throwIfNoEntry: false });
      if (!entry) {
        if (mustExist) throw new Error("Symbolic link target is unavailable.");
        continue;
      }
      if (entry.isSymbolicLink()) {
        const target = resolve(dirname(path), linkTarget(path));
        path = walk(components(target), depth + 1, true);
      } else {
        path = realpathSync.native(path);
        if (!suffix(root, path)) throw new Error(denied);
        if (isSensitive(path)) throw new Error("Access to sensitive paths is blocked.");
      }
    }
    return path;
  };
  return (submitted) => walk(components(submitted), 0, false);
}
