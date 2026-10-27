import { execFileSync, fork, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCandidate, listCards, MAX_MEMORY_CARDS, memoryPath, setStatus } from "../src/memory";
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
  }, 30_000);
  afterAll(() => rmSync(compiled, { recursive: true, force: true }));
  beforeEach(() => { home = tempHome(); });
  afterEach(() => home.cleanup());

  it.each([20, 40])("persists concurrent creates and enforces the shared cap (%i per process)", async (count) => {
    if (count === 40) {
      const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      await once(exited, "exit");
      writeFileSync(`${memoryPath()}.lock`, JSON.stringify({ pid: exited.pid, token: "concurrent-recovery" }));
    }
    const children = ["cli", "gui", "other"].map((prefix) => launch(home.path, { kind: "create", prefix, count }));
    try {
      await Promise.all(children.map(({ ready }) => ready));
      for (const { child } of children) child.send("go");
      await Promise.all(children.map(({ done }) => done));
      const cards = listCards();
      expect(cards).toHaveLength(Math.min(3 * count, MAX_MEMORY_CARDS));
      expect(new Set(cards.map((card) => card.text)).size).toBe(cards.length);
      expect(readdirSync(home.path)).toEqual(["memory.json"]);
    } finally { await stop(children); }
  }, 15_000);

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
  }, 15_000);

  it("recovers the lock of an exited process", async () => {
    const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(exited, "exit");
    writeFileSync(`${memoryPath()}.lock`, JSON.stringify({ pid: exited.pid, token: "exited-owner" }));
    expect(createCandidate("after recovery", "evidence").text).toBe("after recovery");
    expect(readdirSync(home.path)).toEqual(["memory.json"]);
  });
});
