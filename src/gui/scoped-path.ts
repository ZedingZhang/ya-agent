import { execFileSync } from "node:child_process";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, parse, resolve, sep } from "node:path";
import { isSensitive } from "../local";
import type { FolderGrant } from "./folder-grants";

const denied = "Path must remain inside the authorized workspace.";

function parts(path: string): string[] {
  const names = path.slice(parse(path).root.length).split(sep).filter(Boolean);
  return names.filter((name, i) => name !== "." || i === names.length - 1);
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
  const raw = readlinkSync(path);
  const target = process.platform === "win32" ? raw.replaceAll("/", sep) : raw;
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
      const link = linkTarget(next);
      // Leading ".." starts at the verified parent. After a name it could cross another link.
      const names = parts(link);
      const firstChild = names.findIndex((part) => part !== "..");
      if (firstChild >= 0 && names.slice(firstChild).includes("..")) return false;
      const target = resolve(dir, link);
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
  const anchors = new Set([root, grant.path, grant.selectedPath]);
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
  const absoluteComponents = (input: string): string[] => {
    for (const anchor of anchors) {
      const tail = suffix(anchor, input);
      if (tail) {
        if (anchor === grant.selectedPath && anchor !== root && anchor !== grant.path && !selectedRootMatches(anchor, root, shortRootParts())) throw new Error(denied);
        return tail;
      }
    }
    if (process.platform === "win32" && parse(root).root.toLowerCase() === parse(input).root.toLowerCase()) {
      const tail = suffix(root, input, shortRootParts());
      if (tail) return tail;
    }
    throw new Error(denied);
  };

  // Keep link targets unnormalized: a link before ".." determines its actual parent.
  const walk = (input: string, directory: string, depth: number): string => {
    if (depth > 40) throw new Error("Too many symbolic links.");
    if (isSensitive(input)) throw new Error("Access to sensitive paths is blocked.");
    const absolute = isAbsolute(input);
    if (!absolute && parse(input).root) throw new Error(denied);
    let path = absolute ? root : directory;
    const names = absolute ? absoluteComponents(input) : parts(input);
    if (depth > 0 && input.endsWith(sep)) names.push(".");
    for (const name of names) {
      if (name === "." || name === "..") {
        const next = name === ".." ? dirname(path) : path;
        if (!suffix(root, next)) throw new Error(denied);
        if (!lstatSync(path).isDirectory()) throw new Error("Symbolic link target is not a directory.");
        path = next;
        continue;
      }
      if (process.platform === "win32" && (name.includes(":") || /[. ]$/u.test(name) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(name))) throw new Error(denied);
      path = join(path, name);
      if (isSensitive(path)) throw new Error("Access to sensitive paths is blocked.");
      const entry = lstatSync(path, { throwIfNoEntry: false });
      if (!entry) {
        if (depth > 0) throw new Error("Symbolic link target is unavailable.");
        continue;
      }
      if (entry.isSymbolicLink()) {
        path = walk(linkTarget(path), dirname(path), depth + 1);
      } else {
        path = realpathSync.native(path);
        if (!suffix(root, path)) throw new Error(denied);
        if (isSensitive(path)) throw new Error("Access to sensitive paths is blocked.");
      }
    }
    return path;
  };
  return (submitted) => {
    if (isSensitive(submitted)) throw new Error("Access to sensitive paths is blocked.");
    return walk(normalize(submitted), root, 0);
  };
}
