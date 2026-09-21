import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Makes the native binding loadable from a packaged executable.
 *
 * `pkg` packs JavaScript into a virtual filesystem inside the executable. A
 * native addon cannot be loaded from there, because `process.dlopen` needs a
 * real path, but the file *can* be read as an asset — so it is written to a
 * stable temporary path once and `NAPI_RS_NATIVE_LIBRARY_PATH` points the
 * generated loader at it. A binding sitting next to the executable wins, which
 * is what the Electron build relies on.
 *
 * This must be imported before anything that imports the binding, which is why
 * it is the first import of `cli.ts`. It is a no-op for a normal run.
 */
function looseBinding(): string | undefined {
  const beside = dirname(process.execPath);
  for (const name of ["ya-core.node", `ya-core.${process.platform}-${process.arch}.node`]) {
    const candidate = join(beside, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** The crate root as seen from `dist/typescript`, inside the snapshot or on disk. */
function embeddedBinding(): string | undefined {
  const nativeDir = join(__dirname, "..", "..", "native");
  if (!existsSync(nativeDir)) return undefined;
  const name = readdirSync(nativeDir).find((entry) => entry.endsWith(".node"));
  return name === undefined ? undefined : join(nativeDir, name);
}

function extract(source: string): string | undefined {
  try {
    const target = join(tmpdir(), `ya-core-${process.platform}-${process.arch}.node`);
    const bytes = readFileSync(source);
    // Rewrite only when the embedded binding actually differs, so repeated runs
    // do not touch the file and an antivirus scan is not triggered each time.
    if (!existsSync(target) || readFileSync(target).length !== bytes.length) writeFileSync(target, bytes);
    return target;
  } catch {
    return undefined;
  }
}

if (!process.env.NAPI_RS_NATIVE_LIBRARY_PATH) {
  const loose = looseBinding();
  if (loose) {
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH = loose;
  } else {
    const embedded = embeddedBinding();
    const extracted = embedded === undefined ? undefined : extract(embedded);
    if (extracted) process.env.NAPI_RS_NATIVE_LIBRARY_PATH = extracted;
  }
}
