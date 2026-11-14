import { execFileSync, fork, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCandidate, listCards, MAX_MEMORY_CARDS, setStatus } from "../src/memory";
import { tempHome, type TempHome } from "./helpers";

const compiled = mkdtempSync(join(tmpdir(), "ya-memory-build-"));

function launch(home: string, operation: Record<string, unknown>) {
  const child = fork(resolve("tests/memory-process-fixture.cjs"), [join(compiled, "memory.js"), JSON.stringify(operation)], {
    env: { ...process.env, YA_HOME: home }, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });
  const done = new Promise<void>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(stderr || `Memory process exited ${code}`)));
  });
  void done.catch(() => undefined);
  const waitFor = (expected: string): Promise<void> => new Promise((resolvePromise, reject) => {
    const message = (value: unknown): void => { if (value === expected) { cleanup(); resolvePromise(); } };
    const exit = (): void => { cleanup(); reject(new Error(stderr || `Exited before ${expected}`)); };
    const cleanup = (): void => { child.off("message", message); child.off("exit", exit); };
    child.on("message", message); child.on("exit", exit);
  });
  return { child, done, ready: waitFor("ready"), waitFor };
}

async function stop(children: Array<{ child: ChildProcess; done: Promise<void> }>): Promise<void> {
  for (const { child } of children) if (child.exitCode === null) child.kill();
  await Promise.allSettled(children.map(({ done }) => done));
}

describe("cross-process memory transactions", () => {
  let home: TempHome;
  beforeAll(() => {
    execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.json", "--outDir", compiled,
      "--declaration", "false", "--declarationMap", "false", "--sourceMap", "false"], { timeout: 30_000 });
    copyFileSync(resolve("src/octop-memory.py"), join(compiled, "octop-memory.py"));
  }, 30_000);
  afterAll(() => rmSync(compiled, { recursive: true, force: true }));
  beforeEach(() => { home = tempHome(); });
  afterEach(() => home.cleanup());

  it.each([
    { module: "octop_memory", pythonPath: "unset", override: false },
    { module: "json", pythonPath: "unset", override: true },
    { module: "sitecustomize", pythonPath: "relative", override: false },
    { module: "octop_memory", pythonPath: "absolute-and-empty", override: true },
  ])("ignores workspace $module imports with $pythonPath PYTHONPATH (override=$override)", ({ module, pythonPath, override }) => {
    const workspace = join(home.path, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(home.path, "memory.json"), "[]");
    writeFileSync(join(workspace, `${module}.py`),
      `with open(${JSON.stringify(join(workspace, "shadow-imported"))}, 'w') as marker: marker.write('executed')\nraise RuntimeError('workspace module executed')\n`);
    const env = { ...process.env, YA_HOME: home.path };
    delete env.PYTHONPATH;
    delete env.YA_MEMORY_PYTHON;
    if (pythonPath === "relative") env.PYTHONPATH = ".";
    if (pythonPath === "absolute-and-empty") env.PYTHONPATH = `${workspace}${delimiter}`;
    if (override) {
      env.YA_MEMORY_PYTHON = execFileSync(process.env.YA_MEMORY_PYTHON ?? (process.platform === "win32" ? "python" : "python3"),
        ["-E", "-P", "-X", "utf8", "-c", "import sys; print(sys.executable)"], { encoding: "utf8", timeout: 10_000 }).trim();
    }
    const result = spawnSync(process.execPath, ["-e", `
      const assert = require('node:assert/strict');
      const memory = require(process.argv[1]);
      assert.deepEqual(memory.listCards(), []);
      const card = memory.createCandidate('Use Python for automation', 'evidence');
      assert.deepEqual(memory.selectRelevantCards('Python automation'), []);
      memory.setStatus(card.id, 'approved');
      assert.equal(memory.selectRelevantCards('Python automation')[0].card.id, card.id);
      memory.setStatus(card.id, 'revoked');
      assert.deepEqual(memory.selectRelevantCards('Python automation'), []);
      assert.equal(memory.pruneCards([card.id])[0].id, card.id);
      assert.deepEqual(memory.listCards(), []);
    `, join(compiled, "memory.js")], { cwd: workspace, env, encoding: "utf8", timeout: 30_000 });
    expect(existsSync(join(workspace, "shadow-imported"))).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  }, 30_000);

  it.skipIf(process.platform !== "win32").each([true, false])("ignores a workspace python.exe (existing store=%s)", (existing) => {
    const workspace = join(home.path, "workspace");
    const store = join(home.path, "store");
    mkdirSync(workspace);
    // Node rejects Python's flags, making accidental execution observable without running untrusted code.
    copyFileSync(process.execPath, join(workspace, "python.exe"));
    if (existing) {
      mkdirSync(store);
      writeFileSync(join(store, "memory.json"), "[]");
    }
    const env = { ...process.env, YA_HOME: store };
    delete env.YA_MEMORY_PYTHON;
    const result = spawnSync(process.execPath, ["-e", `
      const assert = require('node:assert/strict');
      const memory = require(process.argv[1]);
      assert.deepEqual(memory.listCards(), []);
      const card = memory.createCandidate('Use Python for automation', 'evidence');
      assert.equal(memory.listCards()[0].id, card.id);
    `, join(compiled, "memory.js")], { cwd: workspace, env, encoding: "utf8", timeout: 30_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  }, 30_000);

  it.each([20, 40])("persists concurrent creates and enforces the shared cap (%i per process)", async (count) => {
    const children = ["cli", "gui", "other"].map((prefix) => launch(home.path, { kind: "create", prefix, count }));
    try {
      await Promise.all(children.map(({ ready }) => ready));
      for (const { child } of children) child.send("go");
      await Promise.all(children.map(({ done }) => done));
      const cards = listCards();
      expect(cards).toHaveLength(Math.min(3 * count, MAX_MEMORY_CARDS));
      expect(new Set(cards.map((card) => card.text)).size).toBe(cards.length);
      expect(readdirSync(home.path)).toContain("memory.sqlite");
    } finally { await stop(children); }
  }, 60_000);

  it("cannot overwrite a revoke with another process's earlier memory snapshot", async () => {
    const target = setStatus(createCandidate("revocation target", "evidence").id, "approved");
    const other = createCandidate("unrelated approval", "evidence");
    const writer = launch(home.path, { kind: "status", id: other.id, status: "approved", delayRead: 250 });
    const revoker = launch(home.path, { kind: "status", id: target.id, status: "revoked" });
    try {
      await Promise.all([writer.ready, revoker.ready]);
      const loaded = writer.waitFor("loaded");
      writer.child.send("go");
      await loaded;
      revoker.child.send("go");
      await Promise.all([writer.done, revoker.done]);
      expect(listCards().find((card) => card.id === target.id)?.status).toBe("revoked");
      expect(listCards().find((card) => card.id === other.id)?.status).toBe("approved");
    } finally { await stop([writer, revoker]); }
  }, 60_000);

});
