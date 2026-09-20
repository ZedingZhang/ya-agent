// Behavior parity harness for the Rust core.
//
// Runs the same inputs through the compiled TypeScript core and the napi-rs
// binding, and fails on any divergence. Every ported module gets a section here
// so the rewrite is verified module by module instead of all at once.
//
// Usage: npm run test:parity   (needs `npm run build` and `npm run build:native`)

const assert = require("node:assert/strict");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

// Isolate the run from the real ~/.ya state: messagesForTask reads approved
// memory, and the comparison must not depend on the developer's own cards.
process.env.YA_HOME = mkdtempSync(path.join(tmpdir(), "ya-parity-"));

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
  images: require(path.join(tsRoot, "images.js")),
  web: require(path.join(tsRoot, "web.js")),
  deepseek: require(path.join(tsRoot, "deepseek.js")),
  orchestrator: require(path.join(tsRoot, "orchestrator.js")),
  local: require(path.join(tsRoot, "local.js")),
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

// Intentional divergences are listed here while a module is still being
// compared pre-switch. Once the TypeScript module delegates, both sides run the
// same code and the entry must be deleted; the golden checks below then carry
// the regression value.
const intentionalDivergences = [];

function checkWithDivergences(label, actual, expected, key = label) {
  const exception = intentionalDivergences.find((entry) => entry.key === key);
  if (!exception) {
    check(label, actual, expected);
    return;
  }
  checks += 1;
  try {
    assert.deepEqual(actual, exception.rust);
    assert.deepEqual(expected, exception.ts);
  } catch {
    failures.push(
      `  ${label}: documented divergence changed\n    rust:         ${JSON.stringify(actual)}\n    ts:           ${JSON.stringify(expected)}\n    expected rust: ${JSON.stringify(exception.rust)}\n    expected ts:   ${JSON.stringify(exception.ts)}`,
    );
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

// --- images: signature sniffing and inline limits ------------------------------

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const gif87Bytes = Buffer.from("GIF87a______", "ascii");
const gif89Bytes = Buffer.from("GIF89a______", "ascii");
const webpBytes = Buffer.from("RIFF____WEBP", "ascii");
const riffOnlyBytes = Buffer.from("RIFF________", "ascii");
const textBytes = Buffer.from("hello world!", "ascii");

const byteSamples = [
  ["png", pngBytes],
  ["jpeg", jpegBytes],
  ["gif87a", gif87Bytes],
  ["gif89a", gif89Bytes],
  ["webp", webpBytes],
  ["riff without webp", riffOnlyBytes],
  ["plain text", textBytes],
  ["empty", Buffer.alloc(0)],
  ["png signature truncated", pngBytes.subarray(0, 7)],
  ["jpeg truncated", jpegBytes.subarray(0, 2)],
];

for (const [label, bytes] of byteSamples) {
  check(
    `detectImageMimeType(${label})`,
    native.detectImageMimeType(bytes),
    ts.images.detectImageMimeType(bytes) ?? null,
  );
}

for (const value of ["low", "high", "original", "auto", "LOW", "", "medium"]) {
  check(`isImageDetail(${JSON.stringify(value)})`, native.isImageDetail(value), ts.images.isImageDetail(value));
}

for (const count of [0, 1, 600, 601, 1000]) {
  check(
    `assertImageCount(${count})`,
    capture(() => native.assertImageCount(count)),
    capture(() => ts.images.assertImageCount(count)),
  );
}

// --- images: source classification --------------------------------------------
//
// Mirrors the TypeScript branch order exactly. The final branch (a local file
// path) is still TypeScript-only, so it is asserted separately rather than
// compared against a Rust function that does not exist.

function tsImagePart(source) {
  return capture(() => ts.images.imageContentPartsFromSources([source.trim()], "auto")[0]);
}

function nativeImagePart(source) {
  const trimmed = source.trim();
  if (trimmed.startsWith("file-api-")) {
    return capture(() => ({ type: "file", file_id: native.fileApiImageId(trimmed) }));
  }
  if (trimmed.startsWith("data:")) {
    return capture(() => {
      const inline = native.imageDataUrlPart(trimmed);
      return { type: "image_url", image_url: { url: inline.url, detail: "auto" } };
    });
  }
  if (native.isHttpUrl(trimmed)) {
    return capture(() => ({
      type: "image_url",
      image_url: { url: native.externalImageUrl(trimmed), detail: "auto" },
    }));
  }
  if (native.isSchemeUrl(trimmed)) {
    return capture(() => {
      throw new Error("External images require an HTTP(S) URL.");
    });
  }
  return { localFile: true };
}

const imageSources = [
  `data:image/png;base64,${pngBytes.toString("base64")}`,
  `data:image/jpeg;base64,${jpegBytes.toString("base64")}`,
  `data:image/gif;base64,${gif89Bytes.toString("base64")}`,
  `data:image/webp;base64,${webpBytes.toString("base64")}`,
  `data:image/png;base64,${jpegBytes.toString("base64")}`,
  `data:image/png;base64,${textBytes.toString("base64")}`,
  "data:image/png;base64,AAAAA",
  "data:image/png;base64,AAAA=",
  "data:image/png;base64,A",
  "data:image/png;base64,!!!!",
  "data:image/bmp;base64,AAAA",
  "data:image/jpeg;base64,////",
  "file-api-abc123",
  "file-api-ABC_123-",
  "file-api-",
  "http://example.com/a.png",
  "https://example.com/a.png?x=1#f",
  "HTTP://EXAMPLE.com",
  "https://example.com/a b.png",
  "http://example.com:80/a.png",
  "ftp://example.com/a.png",
  "http://",
  "https://",
  `https://example.com/${"a".repeat(8200)}`,
];

for (const source of imageSources) {
  const label = source.length > 60 ? `${source.slice(0, 57)}...` : source;
  const actual = nativeImagePart(source);
  if (actual.localFile) {
    checks += 1;
    const fallThrough = tsImagePart(source);
    if (typeof fallThrough.error !== "string" || !fallThrough.error.startsWith("Image does not exist:")) {
      failures.push(
        `  local-file fall-through for ${JSON.stringify(label)}\n    expected the TypeScript file branch to reject it, got ${JSON.stringify(fallThrough)}`,
      );
    }
    continue;
  }
  checkWithDivergences(`image part for ${JSON.stringify(label)}`, actual, tsImagePart(source));
}

// Frozen expectations captured from the verified pre-switch implementation.
// These cover behaviour the vitest suite does not: Node's lenient base64
// decoding, WHATWG URL normalisation, and the malformed-URL message that used
// to leak Node's bare `new URL()` TypeError.
const pngBase64 = pngBytes.toString("base64");
check("golden: canonical PNG data URL", native.imageDataUrlPart(`data:image/png;base64,${pngBase64}`).url, `data:image/png;base64,${pngBase64}`);
check("golden: trailing group ignored like Node", native.imageDataUrlPart(`data:image/png;base64,${pngBase64}A`).url, `data:image/png;base64,${pngBase64}`);
check("golden: extra padding ignored like Node", native.imageDataUrlPart(`data:image/png;base64,${pngBase64}=`).url, `data:image/png;base64,${pngBase64}`);
check("golden: non-image payload rejected", capture(() => native.imageDataUrlPart("data:image/png;base64,AAAAA")), { error: "Image data URL does not contain supported JPEG, PNG, GIF, or WebP content." });
check("golden: host lowercased and path added", native.externalImageUrl("HTTP://EXAMPLE.com"), "http://example.com/");
check("golden: default port dropped", native.externalImageUrl("http://example.com:80/a.png"), "http://example.com/a.png");
check("golden: space escaped", native.externalImageUrl("https://example.com/a b.png"), "https://example.com/a%20b.png");
check("golden: file-api id is case-insensitive but returned unchanged", native.fileApiImageId("file-api-ABC_123-"), "file-api-ABC_123-");
check("golden: malformed URL message", capture(() => native.externalImageUrl("http://")), { error: "External images require an HTTP(S) URL." });

// Sources that reach the local-file branch in TypeScript, where Rust
// deliberately has no opinion.
for (const source of ["DATA:IMAGE/PNG;BASE64,AAAA", "FILE-API-abc", "/tmp/does-not-exist.png"]) {
  check(
    `neither HTTP nor scheme URL: ${JSON.stringify(source)}`,
    { http: native.isHttpUrl(source), scheme: native.isSchemeUrl(source) },
    { http: false, scheme: false },
  );
}

// --- web: search-result parsing -------------------------------------------------

const webSamples = [
  `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=x">Example &amp; Page</a>`,
  `<a class="result__a" href="https://example.com/direct">Direct</a>`,
  `<a class="other result__a" href="https://example.com/a">  Spaced   Title  </a>`,
  `<a class='result__a' href='https://example.com/single'>Single quoted</a>`,
  `<a class=result__a href=https://example.com/unquoted>Unquoted</a>`,
  `<a class="result__a">No href</a>`,
  `<a class="result__b" href="https://example.com/skip">Wrong class</a>`,
  `<a class="result__a" href="javascript:alert(1)">Blocked</a>`,
  `<a class="result__a" href="ftp://example.com/f">FTP</a>`,
  `<a class="result__a" href="https://example.com/tags"><b>Bold</b> and <i>italic</i></a>`,
  `<a class="result__a" href="https://example.com/entities">&#72;&#x69; &nbsp; &unknown; &lt;tag&gt;</a>`,
  `<a class="result__a" href="https://example.com/a">One</a><a class="result__a" href="https://example.com/b">Two</a>`,
  "",
  "<p>no anchors here</p>",
  `<a class="result__a"\u00a0href="https://example.com/nbsp">NBSP attribute separator</a>`,
  `<a class="result__a" href="https://example.com/bad">Unterminated</a`,
  `<a class="result__a" href="://nope">Malformed href</a>`,
  `<a class="result__a" href="https://example.com/x">&#x110000;</a>`,
  `<a class="result__a" href="https://example.com/z">&#xD800;</a>`,
  `<a class="result__a" href="https://example.com/y">Trailing text`,
  `<a class="result__a" href="HTTPS://EXAMPLE.com/UP">Scheme case</a>`,
];

for (const html of webSamples) {
  const label = html.length > 58 ? `${html.slice(0, 55)}...` : html;
  checkWithDivergences(
    `parseSearchResults(${JSON.stringify(label)})`,
    capture(() => native.parseSearchResults(html)),
    capture(() => ts.web.parseSearchResults(html)),
    html,
  );
}

// Frozen expectations for the search parser, captured from the verified
// pre-switch implementation.
const anchor = (attributes, inner) => `<a class="result__a" ${attributes}>${inner}</a>`;
check("golden: plain link", native.parseSearchResults(anchor('href="https://example.com/direct"', "Direct")), [{ title: "Direct", url: "https://example.com/direct" }]);
check(
  "golden: redirect wrapper unwrapped",
  native.parseSearchResults(anchor('href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=x"', "Wrapped")),
  [{ title: "Wrapped", url: "https://example.com/page" }],
);
check(
  "golden: entities, unknown entities and tags",
  native.parseSearchResults(anchor('href="https://example.com/e"', "&#72;&#x69; &nbsp; &unknown; &lt;tag&gt; <b>bold</b>")),
  [{ title: "Hi &unknown; <tag> bold", url: "https://example.com/e" }],
);
check("golden: whitespace collapsed", native.parseSearchResults(anchor('href="https://example.com/s"', "  Spaced   Title  ")), [{ title: "Spaced Title", url: "https://example.com/s" }]);
check("golden: non-web schemes dropped", native.parseSearchResults(anchor('href="javascript:alert(1)"', "Blocked")), []);
check("golden: ftp dropped", native.parseSearchResults(anchor('href="ftp://example.com/f"', "FTP")), []);
check("golden: lone surrogate becomes U+FFFD", native.parseSearchResults(anchor('href="https://example.com/z"', "&#xD800;")), [{ title: "\uFFFD", url: "https://example.com/z" }]);
check("golden: invalid code point rejected", capture(() => native.parseSearchResults(anchor('href="https://example.com/x"', "&#x110000;"))), { error: "Invalid code point 1114112" });

// --- deepseek: request payload -------------------------------------------------

const client = new ts.deepseek.DeepSeekClient("test-key", async () => {
  throw new Error("transport must not be reached by payload checks");
});
const payloadConfig = (options) => new ts.config.ModelConfig(options);

const payloadCases = [
  ["plain", [{ role: "user", content: "hello" }], payloadConfig({}), 100, undefined, false],
  ["thinking on", [{ role: "user", content: "hello" }], payloadConfig({ thinkingEnabled: true }), 256, undefined, false],
  ["thinking on, max effort", [{ role: "user", content: "hi" }], payloadConfig({ thinkingEnabled: true, reasoningEffort: "max" }), 10, undefined, false],
  ["streaming", [{ role: "user", content: "hi" }], payloadConfig({}), 100, undefined, true],
  ["with tools", [{ role: "user", content: "hi" }], payloadConfig({}), 100, [], false],
  [
    "with one tool",
    [{ role: "user", content: "hi" }],
    payloadConfig({}),
    100,
    [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    false,
  ],
  ["pro model", [{ role: "user", content: "hi" }], payloadConfig({ model: "deepseek-v4-pro-0813" }), 100, undefined, false],
];

for (const [label, messages, config, maxTokens, tools, stream] of payloadCases) {
  check(
    `payload(${label})`,
    capture(() => JSON.parse(native.buildChatPayload(
      JSON.stringify(messages),
      config.model,
      config.thinkingEnabled,
      config.reasoningEffort,
      maxTokens,
      tools === undefined ? undefined : JSON.stringify(tools),
      stream,
    ))),
    capture(() => client.payload(messages, config, maxTokens, tools, stream)),
  );
}

const pngPart = { type: "image_url", image_url: { url: "https://example.com/a.png" } };
const imagePayloadCases = [
  ["image in a user message", [{ role: "user", content: [pngPart] }], payloadConfig({})],
  ["image in a system message", [{ role: "system", content: [pngPart] }], payloadConfig({})],
  ["image with the pro model", [{ role: "user", content: [pngPart] }], payloadConfig({ model: "deepseek-v4-pro-0813" })],
  ["file part in a user message", [{ role: "user", content: [{ type: "file", file_id: "file-api-x" }] }], payloadConfig({})],
  ["text-only parts", [{ role: "user", content: [{ type: "text", text: "hi" }] }], payloadConfig({})],
];

for (const [label, messages, config] of imagePayloadCases) {
  check(
    `payload(${label})`,
    capture(() => JSON.parse(native.buildChatPayload(
      JSON.stringify(messages),
      config.model,
      config.thinkingEnabled,
      config.reasoningEffort,
      100,
      undefined,
      false,
    ))),
    capture(() => client.payload(messages, config, 100, undefined, false)),
  );
}

// --- deepseek: replies, streaming and SSE framing -------------------------------

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

/** Byte chunks, so a multi-byte character can be split across two chunks. */
function streamResponse(byteChunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of byteChunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** Mirrors the TypeScript assembly in completeStream, driven by the Rust reader. */
function nativeStreamReply(byteChunks) {
  const reader = new native.SseReader();
  const content = [];
  const reasoning = [];
  const streamed = [];
  const usage = {};
  let done = false;
  const handle = (data) => {
    let parsed;
    try {
      parsed = native.parseStreamChunk(data);
    } catch (error) {
      // completeStream wraps a chunk that keeps failing after its retries.
      throw new Error(`DeepSeek API request failed: ${error.message}`);
    }
    if (parsed.done) {
      done = true;
      return;
    }
    if (parsed.usageJson) Object.assign(usage, JSON.parse(parsed.usageJson));
    if (parsed.reasoningContent !== null && parsed.reasoningContent !== undefined) reasoning.push(parsed.reasoningContent);
    if (parsed.content !== null && parsed.content !== undefined) {
      content.push(parsed.content);
      streamed.push(parsed.content);
    }
  };
  for (const chunk of byteChunks) {
    for (const data of reader.push(Buffer.from(chunk))) {
      if (done) break;
      handle(data);
    }
  }
  const trailing = reader.finish();
  if (!done && trailing !== null && trailing !== undefined) handle(trailing);
  const joined = content.join("");
  const joinedReasoning = reasoning.join("");
  return {
    reply: {
      content: joined,
      ...(joinedReasoning ? { reasoningContent: joinedReasoning } : {}),
      toolCalls: [],
      usage,
      assistantMessage: { role: "assistant", content: joined },
    },
    streamed,
  };
}

async function tsCompleteReply(body, status) {
  const fetcher = async () => jsonResponse(body, status);
  const reply = await new ts.deepseek.DeepSeekClient("key", fetcher).complete(
    [{ role: "user", content: "hello" }],
    new ts.config.ModelConfig({}),
    100,
  );
  return reply;
}

async function tsStreamReply(byteChunks) {
  const streamed = [];
  const reply = await new ts.deepseek.DeepSeekClient("key", async () => streamResponse(byteChunks)).completeStream(
    [{ role: "user", content: "hello" }],
    new ts.config.ModelConfig({}),
    100,
    (piece) => streamed.push(piece),
  );
  return { reply, streamed };
}

async function deepseekChecks() {
  const responseBodies = [
    ["plain content", { choices: [{ message: { role: "assistant", content: "ok" } }] }],
    ["reasoning content", { choices: [{ message: { role: "assistant", content: "ok", reasoning_content: "because" } }] }],
    ["null content", { choices: [{ message: { role: "assistant", content: null } }] }],
    ["tool calls", { choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }] } }] }],
    ["usage", { choices: [{ message: { role: "assistant", content: "ok" } }], usage: { total_tokens: 7 } }],
    ["no choices", { error: { message: "bad" } }],
    ["empty choices", { choices: [] }],
    ["choice without message", { choices: [{}] }],
    ["not an object", [1, 2, 3]],
  ];

  for (const [label, body] of responseBodies) {
    const expected = await captureAsync(() => tsCompleteReply(body));
    check(`reply(${label})`, capture(() => JSON.parse(native.parseModelReply(JSON.stringify(body)))), expected);
  }

  const emoji = "😀 中文 mixed";
  const encoder = new TextEncoder();
  const emojiBytes = encoder.encode(`data: {"choices":[{"delta":{"content":"${emoji}"}}]}\n`);
  const splitAt = 20;

  const streamCases = [
    ["two content deltas", ['data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n']],
    ["reasoning then content with usage", ['data:{"choices":[{"delta":{"reasoning_content":"think"}}]}\ndata:{"choices":[{"delta":{"content":"ok"}}],"usage":{"total_tokens":5}}\ndata:[DONE]\n']],
    ["no trailing newline", ['data: {"choices":[{"delta":{"content":"tail"}}]}']],
    ["comments and blank lines", [': comment\n\ndata: {"choices":[{"delta":{"content":"x"}}]}\n\n']],
    ["malformed json chunk", ['data: {not json}\ndata: {"choices":[{"delta":{"content":"y"}}]}\n']],
    ["done only", ["data: [DONE]\n"]],
    ["empty", [""]],
    ["crlf line endings", ['data: {"choices":[{"delta":{"content":"crlf"}}]}\r\n\r\ndata: [DONE]\r\n']],
    ["json token split across chunks", ['data: {"choices":[{"delta":{"cont', 'ent":"split"}}]}\ndata: [DONE]\n']],
    ["multibyte split across chunks", [emojiBytes.slice(0, splitAt), emojiBytes.slice(splitAt)]],
  ];

  for (const [label, rawChunks] of streamCases) {
    const byteChunks = rawChunks.map((chunk) => (typeof chunk === "string" ? encoder.encode(chunk) : chunk));
    const expected = await captureAsync(() => tsStreamReply(byteChunks));
    const actual = capture(() => nativeStreamReply(byteChunks));
    checkWithDivergences(`stream(${label})`, actual, expected, label);
  }
}

function captureAsync(fn) {
  return fn().then(
    (value) => ({ value: value === undefined ? null : value }),
    (error) => ({ error: String((error && error.message) || error) }),
  );
}

// Frozen expectations for the DeepSeek client, captured from the verified
// pre-switch implementation.
const userMessage = [{ role: "user", content: "hi" }];
check("golden: payload with thinking and max effort", JSON.parse(native.buildChatPayload(JSON.stringify(userMessage), "deepseek-v4.1-flash", true, "max", 42, undefined, false)), {
  model: "deepseek-v4.1-flash",
  messages: userMessage,
  thinking: { type: "enabled" },
  stream: false,
  max_tokens: 42,
  reasoning_effort: "max",
});
check("golden: payload omits effort when thinking is off", JSON.parse(native.buildChatPayload(JSON.stringify(userMessage), "deepseek-v4.1-flash", false, "high", 42, undefined, false)), {
  model: "deepseek-v4.1-flash",
  messages: userMessage,
  thinking: { type: "disabled" },
  stream: false,
  max_tokens: 42,
});
check("golden: streaming payload asks for usage", JSON.parse(native.buildChatPayload(JSON.stringify(userMessage), "deepseek-v4.1-flash", false, "high", 42, undefined, true)).stream_options, { include_usage: true });
check("golden: empty tool list is omitted", JSON.parse(native.buildChatPayload(JSON.stringify(userMessage), "deepseek-v4.1-flash", false, "high", 42, "[]", false)), {
  model: "deepseek-v4.1-flash",
  messages: userMessage,
  thinking: { type: "disabled" },
  stream: false,
  max_tokens: 42,
});
check(
  "golden: image in a system message rejected",
  capture(() => native.buildChatPayload(JSON.stringify([{ role: "system", content: [{ type: "image_url", image_url: { url: "https://e.com/a.png" } }] }]), "deepseek-v4.1-flash", false, "high", 10, undefined, false)),
  { error: "DeepSeek image content is supported only in user messages." },
);
check(
  "golden: image with the pro model rejected",
  capture(() => native.buildChatPayload(JSON.stringify([{ role: "user", content: [{ type: "image_url", image_url: { url: "https://e.com/a.png" } }] }]), "deepseek-v4-pro-0813", false, "high", 10, undefined, false)),
  { error: "Image input requires model deepseek-v4.1-flash." },
);
check(
  "golden: reply parsing",
  JSON.parse(native.parseModelReply(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok", reasoning_content: "why" } }], usage: { total_tokens: 3 } }))),
  {
    content: "ok",
    reasoningContent: "why",
    toolCalls: [],
    usage: { total_tokens: 3 },
    assistantMessage: { role: "assistant", content: "ok", reasoning_content: "why" },
  },
);
check(
  "golden: unexpected response message",
  capture(() => native.parseModelReply(JSON.stringify({ error: { message: "bad" } }))),
  { error: 'Unexpected DeepSeek response: {"error":{"message":"bad"}}' },
);
check(
  "golden: malformed chunk fails the stream instead of dropping deltas",
  capture(() => nativeStreamReply([new TextEncoder().encode("data: {not json}\ndata: [DONE]\n")])),
  { error: "DeepSeek API request failed: Invalid streaming chunk: key must be a string at line 1 column 2" },
);
check(
  "golden: multibyte character split across chunks survives",
  nativeStreamReply((() => {
    const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"😀 中文"}}]}\ndata: [DONE]\n');
    return [bytes.slice(0, 30), bytes.slice(30)];
  })()).reply.content,
  "😀 中文",
);

// --- orchestrator: prompts, budgets and the ICM marker --------------------------

const webTasks = [
  ["plain question", "Explain recursion"],
  ["latest", "What is the latest news?"],
  ["uppercase", "LATEST NEWS"],
  ["chinese", "今天天气如何"],
  ["chinese keyword inside a sentence", "请给我最新的价格"],
  ["keyword next to a han character", "价格news"],
  ["keyword next to a han character, reversed", "news价格"],
  ["substring of a keyword", "priceless artefact"],
  ["keyword with underscore", "the_news_letter"],
  ["empty", ""],
];

for (const [label, task] of webTasks) {
  for (const mode of ["auto", "on", "off"]) {
    check(
      `shouldUseWeb(${label}, ${mode})`,
      native.shouldUseWeb(task, mode),
      ts.orchestrator.shouldUseWeb(task, mode),
    );
  }
}

for (const content of ["plain", "[ICM_GAP] here", "[icm_gap] lower", "[Icm_Gap] mixed", "double [ICM_GAP] [ICM_GAP]", ""]) {
  check(`icmFollowUpNeeded(${JSON.stringify(content)})`, native.icmFollowUpNeeded(content), ts.orchestrator.icmFollowUpNeeded(content));
  check(
    `stripIcmMarker(${JSON.stringify(content)})`,
    native.stripIcmMarker(content),
    content.replace(/\[ICM_GAP\]/iu, ""),
  );
}

const messageCases = [
  ["task only", "Explain recursion", "", false, []],
  ["with memory", "Explain recursion", "", false, []],
  ["with instruction", "Explain recursion", "Be brief.", false, []],
  ["local enabled", "Check my notes", "Use the files.", true, []],
  ["with images", "Describe this", "", false, [{ type: "image_url", image_url: { url: "https://e.com/a.png" } }]],
];

for (const [label, task, instruction, local, images] of messageCases) {
  check(
    `messagesForTask(${label})`,
    capture(() => JSON.parse(native.buildTaskMessages(task, "", instruction, local, JSON.stringify(images)))),
    capture(() => ts.orchestrator.messagesForTask(task, instruction, local, images)),
  );
}

check(
  "synthesis instruction",
  native.buildSynthesisInstruction(JSON.stringify([{ role: "evidence", content: "packet", usage: {} }])),
  // The TypeScript builder is inline in toaAgent; the same text is asserted
  // through the fake client below, and this pins the wording here.
  "You are the Ya ToA root coordinator. Synthesize the supplied evidence packets.\nTreat a worker's unsupported statement as an open question. Separate evidence, inference,\nrisks, and remaining uncertainty. Include cited URLs from the packets when available.\nEvidence packets:\n" + JSON.stringify([{ role: "evidence", content: "packet", usage: {} }]),
);

check(
  "icm supplement",
  native.buildIcmSupplement("draft [ICM_GAP] body", "supplement"),
  "draft  body\n\nEvidence supplement:\nsupplement",
);

// --- orchestrator: budgets observed through the real agents ---------------------

function recordingClient(content) {
  const calls = [];
  return {
    calls,
    async runWithTools(messages, _config, maxTokens) {
      calls.push({ messages, maxTokens });
      return { content, toolCalls: [], usage: { total_tokens: 1 }, assistantMessage: { role: "assistant", content } };
    },
    async completeStream(messages, _config, maxTokens, onContent) {
      calls.push({ messages, maxTokens });
      onContent(content);
      return { content, toolCalls: [], usage: { total_tokens: 1 }, assistantMessage: { role: "assistant", content } };
    },
  };
}

async function orchestratorBudgetChecks() {
  for (const toaTokenBudget of [1_000, 4_000, 8_000, 16_000]) {
    const config = new ts.config.ModelConfig({ toaTokenBudget, thinkingEnabled: true });

    const single = recordingClient("plain answer");
    await ts.orchestrator.singleAgent(single, "Explain recursion", config, "off");
    check(
      `singleAgent maxTokens(${toaTokenBudget})`,
      native.singleAgentBudget(toaTokenBudget).maxTokens,
      single.calls[0].maxTokens,
    );

    for (const workers of [1, 2]) {
      const toa = recordingClient("synthesis");
      await ts.orchestrator.toaAgent(toa, "Explain recursion", config, workers);
      const budget = native.toaAgentBudget(toaTokenBudget, workers);
      check(
        `toaAgent worker maxTokens(${toaTokenBudget}, ${workers} workers)`,
        budget.allocation,
        toa.calls[0].maxTokens,
      );
      check(
        `toaAgent synthesis maxTokens(${toaTokenBudget}, ${workers} workers)`,
        budget.synthesisBudget,
        toa.calls[toa.calls.length - 1].maxTokens,
      );
      check(
        `toaAgent call count(${toaTokenBudget}, ${workers} workers)`,
        workers + 1,
        toa.calls.length,
      );
    }
  }
}

// Frozen expectations for the orchestrator, captured from the verified
// pre-switch implementation.
check("golden: single budget caps at 4096", native.singleAgentBudget(8_000), { reserve: 1_024, maxTokens: 4_096 });
check("golden: single budget on the smallest config", native.singleAgentBudget(1_000), { reserve: 250, maxTokens: 750 });
check("golden: toa split for two workers", native.toaAgentBudget(8_000, 2), { icmReserve: 1_024, workingBudget: 6_976, allocation: 2_325, synthesisBudget: 2_326 });
check("golden: toa split for one worker", native.toaAgentBudget(8_000, 1), { icmReserve: 1_024, workingBudget: 6_976, allocation: 3_488, synthesisBudget: 3_488 });
check("golden: ascii word boundary next to a han character", native.shouldUseWeb("价格news", "auto"), true);
check("golden: underscore blocks the boundary", native.shouldUseWeb("the_news_letter", "auto"), false);
check("golden: substring is not a keyword", native.shouldUseWeb("priceless artefact", "auto"), false);
check("golden: unknown worker role", capture(() => native.workerPrompt("nope")), { error: "Unknown ToA worker role: nope" });
check("golden: core prompt opening", native.corePrompt().startsWith("You are Ya, a consent-first personal research assistant."), true);
check("golden: local prompt is offered only when local tools are on", native.buildTaskMessages("t", "", "", false, "[]").includes("Local workspace tools are available"), false);

// --- local: limits, tool contracts and file policy ------------------------------

check("local tool definitions", JSON.parse(native.localToolDefinitions()), ts.local.LOCAL_TOOLS);
check("local limits", native.localLimits(), {
  maxTextBytes: ts.local.MAX_TEXT_BYTES,
  maxListEntries: ts.local.MAX_LIST_ENTRIES,
  maxSearchResults: ts.local.MAX_SEARCH_RESULTS,
  maxDiffLines: ts.local.MAX_DIFF_LINES,
  maxAuditArchives: ts.local.MAX_AUDIT_ARCHIVES,
  auditLogMaxBytes: ts.local.AUDIT_LOG_MAX_BYTES,
});

// The sensitive-name rule is private in TypeScript, so the comparison runs the
// real workspace read over a directory of awkward names and derives the Rust
// outcome the same way local.ts layers its checks.
const localRoot = mkdtempSync(path.join(tmpdir(), "ya-local-"));
const localFiles = [
  ["notes.md", "hello\n"],
  [".env", "SECRET=1\n"],
  [".env.local", "SECRET=1\n"],
  ["id_rsa", "key\n"],
  ["credentials.json", "{}\n"],
  ["cert.pem", "cert\n"],
  ["store.kdbx", "vault\n"],
  ["mysecrets.txt", "shh\n"],
  ["solar.key", "key\n"],
  ["binary.bin", null],
  ["latin1.txt", null],
];
for (const [name, content] of localFiles) {
  if (content === null) writeFileSync(path.join(localRoot, name), Buffer.from(name === "binary.bin" ? [0x00, 0x01, 0x02] : [0xff, 0xfe, 0x41]));
  else writeFileSync(path.join(localRoot, name), content);
}
mkdirSync(path.join(localRoot, ".git"));
writeFileSync(path.join(localRoot, ".git", "config"), "[core]\n");

const localWorkspace = new ts.local.LocalWorkspace(localRoot, () => false);
const localTargets = [...localFiles.map(([name]) => name), path.join(".git", "config")];

for (const target of localTargets) {
  const full = path.join(localRoot, target);
  const relativePath = path.relative(localRoot, full) || ".";
  const expected = capture(() => JSON.parse(localWorkspace.read({ path: target })));
  const actual = capture(() => {
    if (native.isSensitiveFile(path.basename(full).toLowerCase(), relativePath.split(path.sep))) {
      throw new Error("Reading sensitive files is blocked in local mode.");
    }
    const bytes = readFileSync(full);
    native.assertTextSize(bytes.length);
    return { path: relativePath, content: native.decodeTextFile(bytes) };
  });
  check(`local read(${JSON.stringify(target)})`, actual, expected);
}

for (const size of [0, 1_048_576, 1_048_577]) {
  check(`assertTextSize(${size})`, capture(() => native.assertTextSize(size)), size > ts.local.MAX_TEXT_BYTES
    ? { error: "Text files larger than 1 MiB cannot be read or replaced." }
    : { value: null });
}

// tailCompleteLines is private in TypeScript; this restates its four lines so
// the port is compared against the same algorithm.
function tsTailCompleteLines(data, limit) {
  if (data.byteLength <= limit) return data;
  const tail = data.subarray(data.byteLength - limit);
  const newline = tail.indexOf(0x0a);
  return newline >= 0 ? tail.subarray(newline + 1) : Buffer.alloc(0);
}

const tailSamples = [
  [Buffer.from("a\nbb\nccc\n", "utf8"), 6],
  [Buffer.from("a\nbb\nccc\n", "utf8"), 100],
  [Buffer.from("no newline at all", "utf8"), 5],
  [Buffer.from("", "utf8"), 4],
  [Buffer.from("x\ny\n", "utf8"), 0],
];
for (const [data, limit] of tailSamples) {
  check(
    `tailCompleteLines(${JSON.stringify(data.toString("utf8"))}, ${limit})`,
    native.tailCompleteLines(data, limit),
    tsTailCompleteLines(data, limit),
  );
}

// Frozen expectations for the local-mode policy, captured from the verified
// pre-switch implementation.
check("golden: dotfile secrets", native.isSensitiveFile(".env", [".env"]), true);
check("golden: dotfile secret variant", native.isSensitiveFile(".env.local", [".env.local"]), true);
check("golden: private key name", native.isSensitiveFile("id_ed25519", ["id_ed25519"]), true);
check("golden: key extension", native.isSensitiveFile("server.key", ["server.key"]), true);
check("golden: substring match", native.isSensitiveFile("mysecrets.txt", ["mysecrets.txt"]), true);
check("golden: git directory anywhere in the path", native.isSensitiveFile("config", ["nested", ".git", "config"]), true);
check("golden: ordinary file", native.isSensitiveFile("notes.md", ["notes.md"]), false);
check("golden: dotted name that is not a secret", native.isSensitiveFile("report.final.md", ["report.final.md"]), false);
check("golden: NUL byte is binary", capture(() => native.decodeTextFile(Buffer.from([0x41, 0x00]))), { error: "Binary files cannot be read in local mode." });
check("golden: invalid utf-8", capture(() => native.decodeTextFile(Buffer.from([0xff, 0xfe]))), { error: "Only UTF-8 text files can be read in local mode." });
check("golden: audit tail starts on a line boundary", native.tailCompleteLines(Buffer.from("first\nsecond\nthird\n"), 10).toString("utf8"), "third\n");
check("golden: audit tail with no newline is dropped", native.tailCompleteLines(Buffer.from("no newline here"), 5).length, 0);

// --- report -------------------------------------------------------------------

deepseekChecks().then(orchestratorBudgetChecks).then(
  () => {
    if (failures.length > 0) {
      console.error(`parity FAILED: ${failures.length} of ${checks} checks diverged\n`);
      console.error(failures.join("\n\n"));
      process.exit(1);
    }
    console.log(`parity OK: ${checks} checks matched between the TypeScript core and the Rust binding`);
  },
  (error) => {
    console.error("parity harness error:", error);
    process.exit(1);
  },
);
