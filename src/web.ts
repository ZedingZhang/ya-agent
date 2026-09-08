import type { ToolArguments, ToolDefinition } from "./types";
import { VERSION } from "./version";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type Sleep = (milliseconds: number) => Promise<void>;

const defaultSleep: Sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export interface SearchResult {
  title: string;
  url: string;
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/giu, (entity, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
    return named[code.toLocaleLowerCase("und")] ?? entity;
  });
}

function attribute(attributes: string, name: string): string | undefined {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu"));
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

export function parseSearchResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/giu)) {
    const attributes = match[1] ?? "";
    const classes = attribute(attributes, "class") ?? "";
    if (!classes.split(/\s+/u).includes("result__a")) continue;
    const href = decodeHtml(attribute(attributes, "href") ?? "");
    if (!href) continue;
    let url: string;
    try {
      const parsed = new URL(href, "https://html.duckduckgo.com");
      const target = new URL(parsed.searchParams.get("uddg") ?? parsed.toString());
      if (target.protocol !== "https:" && target.protocol !== "http:") continue;
      url = target.toString();
    } catch {
      // Search-result links are untrusted; omit malformed and non-web targets.
      continue;
    }
    const title = decodeHtml((match[2] ?? "").replace(/<[^>]+>/gu, "")).replace(/\s+/gu, " ").trim();
    results.push({ title, url });
  }
  return results;
}

export async function search(
  arguments_: ToolArguments,
  fetcher: FetchLike = fetch,
  sleep: Sleep = defaultSleep,
): Promise<string> {
  const query = String(arguments_.query ?? "").trim();
  if (!query) throw new Error("web_search requires a query");
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query).replaceAll("%20", "+")}`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetcher(url, {
        headers: { "User-Agent": `Ya/${VERSION} research agent` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Web search returned HTTP ${response.status}`);
      return JSON.stringify(parseSearchResults(await response.text()).slice(0, 5));
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export const WEB_SEARCH_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the public web for current, citable sources.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
};
