import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const rootDir = resolve(__dirname, "..");
const entryPath = join(rootDir, "gui", "renderer", "index.js");
const outputPath = join(rootDir, "gui", "renderer.js");
const REQUIRE_PATTERN = /(?<![.\w$])require\((["'])([^"']+)\1\)/gu;

function canonicalId(filePath: string): string {
  return relative(rootDir, filePath).replaceAll(sep, "/");
}

function resolveDependency(fromFile: string, specifier: string): string {
  if (!specifier.startsWith(".")) {
    throw new Error(`Renderer bundle cannot require non-relative module "${specifier}" from ${canonicalId(fromFile)}.`);
  }
  const base = resolve(dirname(fromFile), specifier);
  const candidate = base.endsWith(".js") && existsSync(base) ? base : `${base}.js`;
  if (!candidate.startsWith(`${rootDir}${sep}`) || !existsSync(candidate)) {
    throw new Error(`Renderer bundle could not resolve "${specifier}" from ${canonicalId(fromFile)}.`);
  }
  return candidate;
}

function bundleRenderer(): void {
  const queue = [entryPath];
  const modules = new Map<string, string>();
  while (queue.length > 0) {
    const filePath = queue.shift()!;
    const id = canonicalId(filePath);
    if (modules.has(id)) continue;
    const raw = readFileSync(filePath, "utf8").replace(/\r?\n\/\/# sourceMappingURL=.*$/u, "");
    const transformed = raw.replace(REQUIRE_PATTERN, (_match, _quote: string, specifier: string) => {
      const target = resolveDependency(filePath, specifier);
      queue.push(target);
      return `__require(${JSON.stringify(canonicalId(target))})`;
    });
    modules.set(id, transformed);
  }

  const lines = [
    "(() => {",
    '  "use strict";',
    "  const __modules = {",
  ];
  for (const [id, code] of modules) {
    lines.push(`    ${JSON.stringify(id)}: (exports, require, module) => {`);
    lines.push(code);
    lines.push("    },");
  }
  lines.push(
    "  };",
    "  const __cache = {};",
    "  function __require(id) {",
    "    if (__cache[id]) return __cache[id].exports;",
    "    const factory = __modules[id];",
    '    if (!factory) throw new Error("Missing bundled module: " + id);',
    "    const module = { exports: {} };",
    "    __cache[id] = module;",
    "    factory(module.exports, __require, module);",
    "    return module.exports;",
    "  }",
    `  __require(${JSON.stringify(canonicalId(entryPath))});`,
    "})();",
    "",
  );
  writeFileSync(outputPath, lines.join("\n"), "utf8");
}

bundleRenderer();
