import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BOT_PERMISSIONS_DIR } from "./config";

export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_LIST_ENTRIES = 200;
export const MAX_SEARCH_RESULTS = 100;

const EXCLUDED_SEARCH_DIRECTORIES = new Set(["node_modules", "dist", ".next"]);

/** Returns true when `path` targets sensitive credentials, secrets, or git/grant metadata. */
export function isSensitive(path: string): boolean {
  const lowered = basename(path).toLocaleLowerCase("und");
  const extension = lowered.includes(".") ? lowered.slice(lowered.lastIndexOf(".")) : "";
  const parts = path.toLocaleLowerCase("und").split(sep);
  if (parts.includes(".git") || parts.includes(BOT_PERMISSIONS_DIR)) return true;
  if (lowered === ".env" || lowered.startsWith(".env.")) return true;
  if (["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials", "credentials.json", ".git-credentials", ".netrc", ".npmrc"].includes(lowered)) return true;
  return [".pem", ".key", ".p12", ".pfx", ".kdbx", ".der", ".token"].includes(extension) || lowered.includes("secret");
}

/** Reads a non-sensitive UTF-8 text file up to `MAX_TEXT_BYTES`. */
export function readText(path: string): string {
  if (isSensitive(path)) throw new Error("Reading sensitive files is blocked in local mode.");
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Not a file: ${path}`);
  if (statSync(path).size > MAX_TEXT_BYTES) throw new Error("Text files larger than 1 MiB cannot be read or replaced.");
  return decodeText(readFileSync(path));
}

function decodeText(data: Buffer): string {
  if (data.includes(0)) throw new Error("Binary files cannot be read in local mode.");
  try {
    // Preserve the BOM as content so reads, approval diffs, and writes agree.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    throw new Error("Only UTF-8 text files can be read in local mode.");
  }
}

// Open the leaf without truncating or following it. Check the handle against
// its directory entry before reading data or publishing an approved change.
export function openRegularFile(name: string, flags = constants.O_RDONLY): number {
  if (!lstatSync(name).isFile()) throw new Error("Not a regular file.");
  const fd = openSync(name, flags | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const file = fstatSync(fd, { bigint: true });
    const entry = lstatSync(name, { bigint: true });
    if (!file.isFile() || !entry.isFile() || file.dev !== entry.dev || file.ino !== entry.ino) {
      throw new Error("Not a regular file.");
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function readOpenedText(fd: number): string {
  const size = fstatSync(fd).size;
  if (size > MAX_TEXT_BYTES) throw new Error("Text files larger than 1 MiB cannot be read or replaced.");
  // Positioned reads keep the descriptor usable across approval. Some virtual
  // files report a size of zero, so enforce the limit on bytes actually read.
  const chunkSize = Math.min(64 * 1024, Math.max(4096, size + 1));
  const chunks: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(chunkSize, MAX_TEXT_BYTES - offset + 1));
    const count = readSync(fd, chunk, 0, chunk.length, offset);
    if (!count) break;
    offset += count;
    if (offset > MAX_TEXT_BYTES) throw new Error("Text files larger than 1 MiB cannot be read or replaced.");
    chunks.push(chunk.subarray(0, count));
  }
  return decodeText(Buffer.concat(chunks, offset));
}

export function readRegularText(name: string): string {
  const fd = openRegularFile(name);
  try { return readOpenedText(fd); } finally { closeSync(fd); }
}

export function searchFiles(root: string, query: string, displayPath: (path: string) => string, checkAccess?: () => void, verifyCwd?: (directory: string) => void): string {
  const needle = query.toLocaleLowerCase("und");
  const results: Array<Record<string, unknown>> = [];
  for (const path of walkFiles(root, checkAccess, verifyCwd)) {
    const relativePath = displayPath(path);
    if (basename(path).toLocaleLowerCase("und").includes(needle)) {
      results.push({ path: relativePath, match: "filename" });
      if (results.length >= MAX_SEARCH_RESULTS) break;
    }
    let text: string;
    try {
      text = verifyCwd ? readRegularText(basename(path)) : readText(path);
    } catch {
      // Binary, oversized, and unreadable files are intentionally skipped.
      continue;
    }
    verifyCwd?.(dirname(path));
    const lines = text.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (line.toLocaleLowerCase("und").includes(needle)) {
        results.push({ path: relativePath, match: "text", line: index + 1, text: line.slice(0, 400) });
        if (results.length >= MAX_SEARCH_RESULTS) break;
      }
    }
    if (results.length >= MAX_SEARCH_RESULTS) break;
  }
  verifyCwd?.(root);
  checkAccess?.();
  return JSON.stringify({ query, results, limited: results.length >= MAX_SEARCH_RESULTS });
}

function* walkFiles(root: string, checkAccess?: () => void, verifyCwd?: (directory: string) => void): Generator<string> {
  checkAccess?.();
  verifyCwd?.(root);
  const entries = readdirSync(verifyCwd ? "." : root, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
  for (const entry of entries) {
    checkAccess?.();
    const path = join(root, entry.name);
    if (entry.isSymbolicLink() || isSensitive(path)) continue;
    if (entry.isDirectory()) {
      if (EXCLUDED_SEARCH_DIRECTORIES.has(entry.name)) continue;
      if (verifyCwd) process.chdir(entry.name);
      try {
        yield* walkFiles(path, checkAccess, verifyCwd);
      } finally {
        if (verifyCwd) {
          process.chdir("..");
          verifyCwd(root);
        }
      }
    } else if (entry.isFile()) {
      verifyCwd?.(root);
      yield path;
    }
  }
}

export function listDirectory(path: string, displayPath: string): string {
  const allEntries = readdirSync(path, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
  const entries = allEntries.slice(0, MAX_LIST_ENTRIES).map((entry) => {
    const child = join(displayPath, entry.name);
    const type = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file";
    return { path: child, type };
  });
  return JSON.stringify({ path: displayPath, entries, limited: allEntries.length > MAX_LIST_ENTRIES });
}

/** Returns true if a relative path escapes its base directory. */
export function outsideWorkspace(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(".." + sep) || isAbsolute(relativePath);
}

export function physicalWorkspacePath(root: string, input: string, resolveAncestor: (path: string) => string = realpathSync): string {
  const candidate = resolve(root, input);
  let ancestor = candidate;
  // lstat sees dangling links; realpath below must reject them rather than
  // treating the link itself as a new file inside the workspace.
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const physicalAncestor = resolveAncestor(ancestor);
  const physical = resolve(physicalAncestor, relative(ancestor, candidate));
  const fromRoot = relative(root, physical);
  if (outsideWorkspace(fromRoot)) {
    throw new Error("Path must remain inside the authorized workspace.");
  }
  return physical;
}
