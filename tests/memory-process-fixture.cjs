const fs = require("node:fs");
const memory = require(process.argv[2]);
const operation = JSON.parse(process.argv[3]);
if (operation.delayRead) {
  const original = fs.readFileSync;
  let first = true;
  fs.readFileSync = function (path, ...args) {
    const result = original.call(this, path, ...args);
    if (first && String(path) === memory.memoryPath()) {
      first = false;
      process.send("loaded");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, operation.delayRead);
    }
    return result;
  };
}
process.once("message", () => {
  try {
    if (operation.kind === "status") memory.setStatus(operation.id, operation.status);
    else for (let index = 0; index < operation.count; index++) {
      try { memory.createCandidate(`${operation.prefix} ${index}`, "process test"); }
      catch (error) { if (!(error instanceof memory.MemoryLimitError)) throw error; }
    }
    process.exit(0);
  } catch (error) { console.error(error); process.exit(1); }
});
process.send("ready");
