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
  memory: require(path.join(tsRoot, "memory.js")),
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

// --- memory: text normalisation and ranking -----------------------------------

const memoryTexts = [
  "",
  "   ",
  "Hello World",
  "  Multiple   spaces\tand\nnewlines  ",
  "ß straße STRASSE",
  "ＡＢＣ１２３",
  "foo-bar_baz 42",
  "İstanbul",
  "café CAFÉ",
  "混合 mixed 内容 content",
  "什么是 Ya 的记忆？",
  "知识 卡片 排列",
  "emoji 😀 test",
  "a",
  "ab",
  "\u00a0non\u2009breaking\u3000space\ufeff",
];

for (const text of memoryTexts) {
  check(
    `normalizeMemoryText(${JSON.stringify(text)})`,
    native.normalizeMemoryText(text),
    ts.memory.normalizeMemoryText(text),
  );
}

const memoryCard = (text) => ({
  id: "card",
  kind: "knowledge",
  text,
  evidence: "",
  status: "approved",
  createdAt: "2026-01-01T00:00:00.000Z",
  version: 1,
});

const memoryPairs = [
  ["Explain recursion", "recursion is a technique"],
  ["Explain recursion", "Recursion technique explained"],
  ["what is recursion", "recursion"],
  ["数据结构 排序", "排序 算法 数据结构"],
  ["什么是排序", "排序算法"],
  ["abcd", "abcd"],
  ["abc", "abcdef"],
  ["", "anything"],
  ["anything", ""],
  ["foo bar baz", "baz bar foo"],
  ["机器 学习 模型", "机器学习模型"],
  ["😀 test", "😀"],
  ["如何配置 DeepSeek API key", "配置 DeepSeek API key 的步骤"],
  ["the quick brown fox", "quick brown foxes"],
  ["a-b_c 12", "a-b_c 12"],
  ["知识卡片", "知识 卡片"],
];

for (const [task, text] of memoryPairs) {
  check(
    `memoryScore(${JSON.stringify(task)}, ${JSON.stringify(text)})`,
    native.memoryScore(task, text),
    ts.memory.memoryScore(task, memoryCard(text)),
  );
}

// --- report -------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`parity FAILED: ${failures.length} of ${checks} checks diverged\n`);
  console.error(failures.join("\n\n"));
  process.exit(1);
}
console.log(`parity OK: ${checks} checks matched between the TypeScript core and the Rust binding`);
