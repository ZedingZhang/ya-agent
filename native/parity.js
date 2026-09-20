// Behavior parity harness for the Rust core.
//
// Runs the same inputs through the compiled TypeScript core and the napi-rs
// binding, and fails on any divergence. Every ported module gets a section here
// so the rewrite is verified module by module instead of all at once.
//
// Usage: npm run test:parity   (needs `npm run build` and `npm run build:native`)

const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const path = require("node:path");

const tsRoot = path.join(__dirname, "..", "dist", "typescript");
const bindingPath = path.join(__dirname, "index.js");

if (!existsSync(path.join(tsRoot, "config.js"))) {
  console.error("Missing " + tsRoot + ". Run `npm run build` in the repository root first.");
  process.exit(1);
}
if (!existsSync(bindingPath)) {
  console.error("Missing " + bindingPath + ". Run `npm run build:native` first.");
  process.exit(1);
}

const ts = {
  config: require(path.join(tsRoot, "config.js")),
  keychain: require(path.join(tsRoot, "keychain.js")),
};
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

/** Captures a value or the thrown message, normalising undefined/null. */
function capture(fn) {
  try {
    const value = fn();
    return { value: value === undefined ? null : value };
  } catch (error) {
    return { error: String((error && error.message) || error) };
  }
}

// --- config: supported models -------------------------------------------------

check("supportedModels()", native.supportedModels(), Object.values(ts.config.VALID_MODELS));
check("defaultModel()", native.defaultModel(), ts.config.VALID_MODELS.flash);

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
  check(
    `resolveModel(${JSON.stringify(value)})`,
    capture(() => native.resolveModel(value)),
    capture(() => ts.config.modelId(value)),
  );
}

// --- config: vision capability ------------------------------------------------

for (const id of Object.values(ts.config.VALID_MODELS)) {
  check(`isVisionModel(${JSON.stringify(id)})`, native.isVisionModel(id), ts.config.isVisionModel(id));
}
check(
  "isVisionModel(retired vision id)",
  native.isVisionModel("deepseek-v4-flash-vision-exp"),
  ts.config.isVisionModel("deepseek-v4-flash-vision-exp"),
);

// --- keychain: identity and platform rules ------------------------------------

check("keychainService()", native.keychainService(), ts.keychain.KEYCHAIN_SERVICE);
check("keychainAccount()", native.keychainAccount(), ts.keychain.KEYCHAIN_ACCOUNT);
check("currentPlatform()", native.currentPlatform(), process.platform);

for (const platform of ["darwin", "win32", "linux"]) {
  for (const securityPath of ["/usr/bin/security", "/definitely/missing/security"]) {
    check(
      `macosKeychainAvailable(${platform}, ${securityPath})`,
      native.macosKeychainAvailable(platform, securityPath),
      ts.keychain.macosKeychainAvailable(platform, securityPath),
    );
  }
}

// --- keychain: API key resolution and validation ------------------------------

const originalApiKey = process.env.DEEPSEEK_API_KEY;
try {
  for (const value of [undefined, "", "   ", "  env-key  "]) {
    if (value === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = value;
    check(
      `loadApiKey() with DEEPSEEK_API_KEY=${JSON.stringify(value)}`,
      capture(() => native.loadApiKey()),
      capture(() => ts.keychain.loadApiKey()),
    );
  }
} finally {
  if (originalApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalApiKey;
}

// Validation only; neither side reaches a real Keychain on a non-macOS host.
for (const key of ["", "   ", "test-key"]) {
  check(
    `saveApiKey(${JSON.stringify(key)})`,
    capture(() => native.saveApiKey(key)),
    capture(() => ts.keychain.saveApiKey(key)),
  );
}

// --- report -------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`parity FAILED: ${failures.length} of ${checks} checks diverged\n`);
  console.error(failures.join("\n\n"));
  process.exit(1);
}
console.log(`parity OK: ${checks} checks matched between the TypeScript core and the Rust binding`);
