const { existsSync, unlinkSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const compiled = process.argv[2];
const home = process.env.YA_HOME;
const { ModelConfig } = require(join(compiled, "config.js"));
const { DeepSeekClient } = require(join(compiled, "deepseek.js"));
const { TaskStore, runTask } = require(join(compiled, "service.js"));

let holdWrite = false;
let releaseReply;
const store = new TaskStore({
  reconcileOnStartup: false,
  writeFile(path, content) {
    writeFileSync(path, content, { flag: "wx" });
    if (!holdWrite) return;
    holdWrite = false;
    process.send({ type: "holding" });
    const releasePath = join(home, `release-${process.pid}`);
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const deadline = performance.now() + 6000;
    while (!existsSync(releasePath)) {
      if (performance.now() >= deadline) throw new Error("Write hold timed out.");
      Atomics.wait(sleeper, 0, 0, 10);
    }
    unlinkSync(releasePath);
  },
});

process.on("message", async (message) => {
  try {
    if (message.action === "release-reply") {
      releaseReply();
      return;
    }
    if (message.action === "buffered") {
      let providerCalls = 0;
      const gate = new Promise((resolve) => { releaseReply = resolve; });
      const result = await runTask("test-key", message.objective ?? "Pending CLI question", new ModelConfig(), {
        taskStore: store,
        webMode: "off",
        onTaskCreated: (task) => process.send({ type: "pending", task }),
        clientFactory: (key) => new DeepSeekClient(key, async () => {
          providerCalls++;
          await gate;
          return Response.json({ choices: [{ message: { role: "assistant", content: "Buffered answer" } }] });
        }),
      });
      process.send({ type: "result", content: result.content, providerCalls });
      return;
    }
    if (message.action === "reconcile") {
      const interrupted = store.reconcileInterrupted();
      process.send({ type: "result", interrupted });
      return;
    }
    if (message.action === "create" || message.action === "transition") {
      holdWrite = Boolean(message.hold);
      process.send({ type: "attempting" });
      const task = message.action === "create"
        ? store.create({ objective: message.objective })
        : store.transition(message.id, message.status, { expectedRevision: message.revision });
      process.send({ type: "result", task });
      return;
    }
    throw new Error(`Unknown fixture action "${message.action}".`);
  } catch (error) {
    process.send({ type: "result", error: { name: error.name, message: error.message } });
  }
});
