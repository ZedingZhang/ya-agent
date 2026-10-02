import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  listeners: new Map<string, (...args: any[]) => any>(),
  run: vi.fn(),
  windows: [] as any[],
}));

vi.mock("electron", () => ({
  app: { whenReady: () => Promise.resolve(), on: vi.fn(), exit: vi.fn() },
  BrowserWindow: class extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    });
    constructor() { super(); mocks.windows.push(this); }
    removeMenu() {}
    loadFile() { return Promise.resolve(); }
    isDestroyed() { return false; }
  },
  ipcMain: {
    handle: (name: string, handler: (...args: any[]) => any) => mocks.handlers.set(name, handler),
    on: (name: string, handler: (...args: any[]) => any) => mocks.listeners.set(name, handler),
  },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1200, height: 800 } }) },
  dialog: {}, net: {}, shell: {},
}));

vi.mock("../src/gui/controller", () => ({
  LANGUAGES: ["en"],
  GuiController: class {
    config = { model: "deepseek-v4-pro" };
    run = mocks.run;
  },
}));

describe("GUI pending action lifecycle", () => {
  let sender: any;
  let event: any;
  const options = { task: "Create notes", webMode: "off", toaWorkers: 1, local: true };
  const start = () => mocks.handlers.get("task:run")!(event, options);
  const respond = (approved: boolean) => {
    const payload = sender.send.mock.calls.at(-1)[1];
    mocks.listeners.get("local-action:response")!(event, { id: payload.id, approved });
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    mocks.handlers.clear();
    mocks.listeners.clear();
    mocks.windows.length = 0;
    mocks.run.mockReset().mockImplementation(async (_options, callbacks) => {
      await callbacks.onLocalAction({ operation: "mkdir", paths: ["notes"], summary: "Create" });
      return "done";
    });
    await import("../src/gui/main");
    sender = mocks.windows[0].webContents;
    event = { sender, senderFrame: { url: pathToFileURL(resolve("src/gui/index.html")).toString() } };
  });

  afterEach(() => { vi.useRealTimers(); });

  it.each([true, false])("clears the timer on approval response %s", async (approved) => {
    const task = start();
    expect(vi.getTimerCount()).toBe(1);
    respond(approved);
    await expect(task).resolves.toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a lost response and accepts the next task", async () => {
    const task = start();
    const rejection = expect(task).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(120_000);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
    respond(true); // A late response must be ignored.
    const nextTask = start();
    respond(true);
    await expect(nextTask).resolves.toBe("done");
  });

  it.each(["destroyed", "render-process-gone"])("rejects pending actions on %s and releases the task lock", async (name) => {
    const task = start();
    const rejection = expect(task).rejects.toThrow(/renderer/);
    sender.emit(name);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
    const nextTask = start();
    respond(true);
    await expect(nextTask).resolves.toBe("done");
  });

  it("cleans up when sending the approval request fails", async () => {
    sender.send.mockImplementationOnce(() => { throw new Error("send failed"); });
    await expect(start()).rejects.toThrow("send failed");
    expect(vi.getTimerCount()).toBe(0);
    const nextTask = start();
    respond(true);
    await expect(nextTask).resolves.toBe("done");
  });

  it("cancels a pending approval, rejects late approval and releases the task lock", async () => {
    const task = start();
    const rejection = expect(task).rejects.toThrow("cancelled");
    await mocks.handlers.get("task:cancel")!(event);
    await rejection;
    expect(mocks.run.mock.calls.at(-1)?.[1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    respond(true);
    const nextTask = start();
    respond(true);
    await expect(nextTask).resolves.toBe("done");
    expect(mocks.run.mock.calls.at(-1)?.[1].signal.aborted).toBe(false);
  });

  it("keeps the task lock until the running command has finished stopping", async () => {
    let finish!: () => void;
    mocks.run.mockImplementation((_options, callbacks) => new Promise((resolveTask) => {
      finish = () => resolveTask("cancelled");
      callbacks.onCommandEvent({ type: "start", id: "c", command: "npm test", cwd: "." });
    }));
    const task = start();
    expect(sender.send).toHaveBeenCalledWith("task:event", { type: "command", event: { type: "start", id: "c", command: "npm test", cwd: "." } });
    await mocks.handlers.get("task:cancel")!(event);
    await expect(start()).rejects.toThrow("already running");
    finish();
    await expect(task).resolves.toBe("cancelled");
  });

  it("rejects untrusted cancellation requests", async () => {
    const task = start();
    const untrusted = { ...event, senderFrame: { url: "https://untrusted.example/" } };
    expect(() => mocks.handlers.get("task:cancel")!(untrusted)).toThrow("Untrusted");
    expect(mocks.run.mock.calls.at(-1)?.[1].signal.aborted).toBe(false);
    respond(true);
    await task;
  });

  it("validates execution opt-in at the IPC boundary", async () => {
    await expect(mocks.handlers.get("task:run")!(event, { ...options, exec: "true" })).rejects.toThrow("Invalid command");
    await expect(mocks.handlers.get("task:run")!(event, { ...options, local: false, exec: true })).rejects.toThrow("requires local");
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
