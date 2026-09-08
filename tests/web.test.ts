import { describe, expect, it, vi } from "vitest";
import { parseSearchResults, search, type FetchLike } from "../src/web";

describe("web search", () => {
  it("parses DuckDuckGo result links and redirect targets", () => {
    const html = `
      <a class="result__a result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1%26y%3D2">
        Example <b>result</b> &amp; details
      </a>
      <a class="other" href="https://ignored.example">Ignored</a>
      <a class="result__a" href="javascript:alert(1)">Unsafe</a>
    `;
    expect(parseSearchResults(html)).toEqual([
      { title: "Example result & details", url: "https://example.com/a?x=1&y=2" },
    ]);
  });

  it("returns at most five JSON results with an encoded query", async () => {
    let requestUrl = "";
    let userAgent = "";
    const anchors = Array.from({ length: 7 }, (_, index) =>
      `<a href="https://example.com/${index}" class="result__a">Result ${index}</a>`,
    ).join("");
    const fetcher: FetchLike = async (url, init) => {
      requestUrl = String(url);
      userAgent = new Headers(init?.headers).get("user-agent") ?? "";
      return new Response(anchors, { status: 200 });
    };
    const results = JSON.parse(await search({ query: "Ya agent" }, fetcher)) as unknown[];
    expect(requestUrl).toContain("q=Ya+agent");
    expect(userAgent).toMatch(/^Ya\/0\.5\.15/u);
    expect(results).toHaveLength(5);
  });

  it("retries temporary failures", async () => {
    let attempts = 0;
    const fetcher: FetchLike = async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("temporary");
      return new Response('<a class="result__a" href="https://example.com">Example</a>');
    };
    const sleep = vi.fn(async () => undefined);
    expect(JSON.parse(await search({ query: "test" }, fetcher, sleep))).toHaveLength(1);
    expect(attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("requires a non-empty query", async () => {
    await expect(search({ query: " " })).rejects.toThrow(/requires a query/u);
  });
});
