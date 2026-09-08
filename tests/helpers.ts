import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempHome {
  path: string;
  cleanup(): void;
}

export function tempHome(prefix = "ya-test-"): TempHome {
  const previous = process.env.YA_HOME;
  const path = mkdtempSync(join(tmpdir(), prefix));
  process.env.YA_HOME = path;
  return {
    path,
    cleanup: () => {
      if (previous === undefined) delete process.env.YA_HOME;
      else process.env.YA_HOME = previous;
      rmSync(path, { recursive: true, force: true });
    },
  };
}
