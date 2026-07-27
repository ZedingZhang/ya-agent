from __future__ import annotations

from html.parser import HTMLParser
from urllib.parse import parse_qs, quote_plus, unquote, urlparse
from urllib.request import Request, urlopen
import json
import time
import urllib.error


class _ResultParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.results: list[dict] = []
        self._url: str | None = None
        self._title: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "a" and "result__a" in (attributes.get("class") or ""):
            self._url = attributes.get("href")
            self._title = []

    def handle_data(self, data: str) -> None:
        if self._url:
            self._title.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._url:
            parsed = urlparse(self._url)
            redirect_target = parse_qs(parsed.query).get("uddg", [None])[0]
            url = unquote(redirect_target) if redirect_target else self._url
            self.results.append({"title": "".join(self._title).strip(), "url": url})
            self._url = None


def search(arguments: dict, opener=urlopen, sleep=time.sleep) -> str:
    query = str(arguments.get("query", "")).strip()
    if not query:
        raise ValueError("web_search requires a query")
    request = Request(
        f"https://html.duckduckgo.com/html/?q={quote_plus(query)}",
        headers={"User-Agent": "Ya/0.1 research agent"},
    )
    for attempt in range(3):
        try:
            with opener(request, timeout=15) as response:
                parser = _ResultParser()
                parser.feed(response.read().decode("utf-8", errors="replace"))
            break
        except (urllib.error.HTTPError, urllib.error.URLError):
            if attempt == 2:
                raise
            sleep(0.5 * (attempt + 1))
    return json.dumps(parser.results[:5], ensure_ascii=False)


WEB_SEARCH_TOOL = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": "Search the public web for current, citable sources.",
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
    },
}
