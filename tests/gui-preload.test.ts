import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RendererTaskOptions, TaskEvent, TaskTransportEvent, YaBridge } from "../src/gui/shared";

type EventListener = (event: unknown, value: TaskTransportEvent) => void;
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  expose: vi.fn(),
  listeners: new Set<EventListener>(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: {
    invoke: mocks.invoke,
    send: vi.fn(),
    on: (_channel: string, listener: EventListener) => mocks.listeners.add(listener),
    off: (_channel: string, listener: EventListener) => mocks.listeners.delete(listener),
  },
}));

describe("GUI task event delivery", () => {
  let bridge: YaBridge;
  const options: RendererTaskOptions = {
    task: "Update notes", webMode: "off", toa: false, toaWorkers: 1, stream: false,
    local: true, imageIds: [], imageDetail: "auto",
  };
  const result = { content: "Updated notes.", mode: "single", usage: {} };
  const emit = (value: TaskTransportEvent): void => {
    for (const listener of mocks.listeners) listener({}, value);
  };

  beforeEach(async () => {
    vi.resetModules();
    mocks.invoke.mockReset();
    mocks.expose.mockReset();
    mocks.listeners.clear();
    await import("../src/gui/preload");
    bridge = mocks.expose.mock.calls[0]![1] as YaBridge;
  });

  it.each([false, true])("drains late file-change and activity events before settling a task (failure=%s)", async (failed) => {
    let flushId = "";
    mocks.invoke.mockImplementation(async (channel: string, id?: string) => {
      if (channel === "task:run") {
        if (failed) throw new Error("Task failed after writing");
        return result;
      }
      if (channel === "task:flush") { flushId = id!; return undefined; }
      throw new Error(`Unexpected channel: ${channel}`);
    });
    const delivered: TaskEvent[] = [];
    let active = true;
    const unsubscribe = bridge.onTaskEvent((event) => { if (active) delivered.push(event); });
    let outcome: { result?: unknown; error?: Error } | undefined;
    const running = bridge.runTask(options).then(
      (value) => { active = false; outcome = { result: value }; },
      (error: Error) => { active = false; outcome = { error }; },
    );
    // Invoke replies may arrive before messages already sent through task:event.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(outcome).toBeUndefined();
    expect(flushId).not.toBe("");
    const change: TaskEvent = { type: "file-change", change: {
      id: "change", path: "notes.txt", operation: "edit", additions: 1, deletions: 1,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] }], truncated: false,
    } };
    const activity: TaskEvent = { type: "activity", activity: { operation: "edit", paths: ["notes.txt"], status: "success" } };
    emit(change);
    emit(activity);
    emit({ type: "flush", id: "another-request" });
    await Promise.resolve();
    expect(outcome).toBeUndefined();
    emit({ type: "flush", id: flushId });
    await running;
    expect(delivered).toEqual([change, activity]);
    if (failed) expect(outcome?.error?.message).toBe("Task failed after writing");
    else expect(outcome?.result).toEqual(result);
    expect(mocks.listeners.size).toBe(1);
    unsubscribe();
    expect(mocks.listeners.size).toBe(0);
  });

  it("cleans up the completion listener if the flush request fails", async () => {
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === "task:run") return result;
      throw new Error("Renderer disconnected");
    });
    await expect(bridge.runTask(options)).rejects.toThrow("Renderer disconnected");
    expect(mocks.listeners.size).toBe(0);
  });
});
