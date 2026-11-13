const memory = require(process.argv[2]);
const operation = JSON.parse(process.argv[3]);
process.once("message", () => {
  try {
    if (operation.delayRead) {
      memory.listCards();
      process.send("loaded");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, operation.delayRead);
    }
    if (operation.kind === "status") memory.setStatus(operation.id, operation.status);
    else for (let index = 0; index < operation.count; index++) {
      try { memory.createCandidate(`${operation.prefix} ${index}`, "process test"); }
      catch (error) { if (!(error instanceof memory.MemoryLimitError)) throw error; }
    }
    process.exit(0);
  } catch (error) { console.error(error); process.exit(1); }
});
process.send("ready");
