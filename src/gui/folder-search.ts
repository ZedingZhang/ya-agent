import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { dataHome } from "../config";
import { searchFiles } from "../local";
import { FolderGrants, folderIdentityExecutable, nativeIdentity, type FolderGrant } from "./folder-grants";

interface SearchRequest {
  botId: string;
  grant: FolderGrant;
  sessionDirectoryId?: { dev: string; ino: string };
  directory: string;
  query: string;
  identityExecutable: string;
}

export function searchGrantedFolder(grants: FolderGrants, botId: string, grant: FolderGrant, directory: string, query: string): string {
  const request: SearchRequest = {
    botId, grant, directory, query, sessionDirectoryId: grants.sessionDirectoryId(botId, grant), identityExecutable: folderIdentityExecutable(),
  };
  const worker = __filename.endsWith(".js") ? __filename : resolve(__dirname, "../../dist/typescript/gui/folder-search.js");
  const result = spawnSync(process.execPath, [worker], {
    input: JSON.stringify(request), encoding: "utf8", windowsHide: true, maxBuffer: Infinity,
    env: { ...process.env, YA_HOME: dataHome(), ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "", NODE_PATH: "" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Folder search stopped.");
  return result.stdout;
}

function searchFromWorkingDirectory(request: SearchRequest): string {
  const { botId, grant, directory, query, sessionDirectoryId, identityExecutable } = request;
  if (isAbsolute(directory) || directory.split(sep).includes("..")) throw new Error("Invalid search directory.");

  // The OS holds the working directory for this process. Relative reads remain
  // anchored to that instance even when another volume takes its original path.
  process.chdir(grant.path);
  const fd = openSync(".", constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    const held = fstatSync(fd, { bigint: true });
    const verified = grant.identity.startsWith("session:")
      ? sessionDirectoryId?.dev === String(held.dev) && sessionDirectoryId.ino === String(held.ino)
      : nativeIdentity(".", false, identityExecutable) === grant.identity;
    if (!verified) throw new Error("Folder access has changed.");

    const grants = new FolderGrants();
    const checkAccess = (): void => {
      const current = grants.read(botId);
      const attached = statSync(grant.path, { bigint: true, throwIfNoEntry: false });
      if (current?.version !== grant.version || current.path !== grant.path || current.identity !== grant.identity
        || !attached || attached.dev !== held.dev || attached.ino !== held.ino || realpathSync(grant.path) !== grant.path
        || (!held.ino && nativeIdentity(grant.path, false, identityExecutable) !== grant.identity)) {
        throw new Error("Folder access has changed.");
      }
    };
    const root = realpathSync.native(".");
    const verifyCwd = (subdirectory: string): void => {
      if (relative(join(root, subdirectory), realpathSync.native(".")) !== "") throw new Error("Search directory has changed.");
    };
    checkAccess();
    process.chdir(directory);
    return searchFiles(directory, query, (path) => path, checkAccess, verifyCwd);
  } finally {
    closeSync(fd);
  }
}

if (require.main === module) {
  try {
    // All application modules are loaded. Treat workspace .asar files as ordinary files.
    if (process.versions.electron) process.noAsar = true;
    const request = JSON.parse(readFileSync(0, "utf8")) as SearchRequest;
    process.stdout.write(searchFromWorkingDirectory(request));
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
