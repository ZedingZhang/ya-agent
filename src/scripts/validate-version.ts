import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VERSION } from "../version";

const tag = process.argv[2] ?? process.env.RELEASE_TAG;
if (!tag) throw new Error("Pass a release tag such as v0.5.15.");
const expected = tag.replace(/^v/u, "");
const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as { version?: unknown };
if (packageJson.version !== expected || VERSION !== expected) {
  throw new Error(`Release tag (${expected}), package version (${String(packageJson.version)}), and VERSION (${VERSION}) must match.`);
}
process.stdout.write(`Validated Ya ${VERSION}.\n`);
