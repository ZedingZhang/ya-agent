import { parseSearchResults as nativeParseSearchResults } from "ya-core";
import type { ToolArguments, ToolDefinition } from "./types";
import { VERSION } from "./version";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type Sleep = (milliseconds: number) => Promise<void>;

const defaultSleep: Sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export interface SearchResult {
  title: string;
  url: string;
}

/**
 * Parses DuckDuckGo result markup into title/URL pairs.
 *
 * Entity decoding, tag stripping, and redirect unwrapping live in the Rust
 * core; untrusted or malformed links are dropped there.
 */
export function parseSearchResults(html: string): SearchResult[] {
  return nativeParseSearchResults(html) as SearchResult[];
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
