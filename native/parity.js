// Behavior parity harness for the Rust core.
//
// Runs the same inputs through the compiled TypeScript core and the napi-rs
// binding, and fails on any divergence. Every ported module gets a section here
// so the rewrite can be verified module by module instead of all at once.
//
// Usage: node native/parity.js   (requires `npm run build` and `npm run build` in native/)

const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const path = require("node:path");

const tsConfigPath = path.join(__dirname, "..", "dist", "typescript", "config.js");
const bindingPath = path.join(__dirname, "index.js");

if (!existsSync(tsConfigPath)) {
  console.error("Missing " + tsConfigPath + ". Run `npm run build` in the repository root first.");
  process.exit(1);
}
if (!existsSync(bindingPath)) {
  console.error("Missing " + bindingPath + ". Run `npm run build` in native/ first.");
  process.exit(1);
}

const ts = require(tsConfigPath);
const native = require(bindingPath);

const failures = [];
let checks = 0;

function check(label, actual, expected) {
  checks += 1;
  try {
    assert.deepEqual(actual, expected);
  } catch {
    failures.push(`  ${label}\n    rust: ${JSON.stringify(actual)}\n    ts:   ${JSON.stringify(expected)}`);
  }
}

// --- config: supported models -------------------------------------------------

check("supportedModels()", native.supportedModels(), Object.values(ts.VALID_MODELS));
check("defaultModel()", native.defaultModel(), ts.VALID_MODELS.flash);

// --- config: model resolution -------------------------------------------------

const resolutionCases = [
  "flash",
  "pro",
  "vision",
  "deepseek-v4.1-flash",
  "deepseek-v4-pro-0813",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-vision-exp",
  "legacy",
  "",
  "Flash",
];

for (const value of resolutionCases) {
  let expected;
  try {
    expected = { ok: ts.modelId(value) };
  } catch (error) {
    expected = { error: error.message };
  }
  let actual;
  try {
    actual = { ok: native.resolveModel(value) };
  } catch (error) {
    actual = { error: String(error.message || error) };
  }
  check(`resolveModel(${JSON.stringify(value)})`, actual, expected);
}

// --- config: vision capability ------------------------------------------------

for (const id of Object.values(ts.VALID_MODELS)) {
  check(`isVisionModel(${JSON.stringify(id)})`, native.isVisionModel(id), ts.isVisionModel(id));
}
check("isVisionModel(retired vision id)", native.isVisionModel("deepseek-v4-flash-vision-exp"), ts.isVisionModel("deepseek-v4-flash-vision-exp"));

// --- report -------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`parity FAILED: ${failures.length} of ${checks} checks diverged\n`);
  console.error(failures.join("\n\n"));
  process.exit(1);
}
console.log(`parity OK: ${checks} checks matched between the TypeScript core and the Rust binding`);
