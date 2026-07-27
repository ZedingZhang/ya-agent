from __future__ import annotations

from dataclasses import dataclass
from typing import Callable
import json
import time
import urllib.error
import urllib.request

from .config import ModelConfig


API_URL = "https://api.deepseek.com/chat/completions"
MAX_TOOL_CALL_ROUNDS = 6
MAX_REQUEST_ATTEMPTS = 3


class DeepSeekError(RuntimeError):
    pass


@dataclass
class ModelReply:
    content: str
    reasoning_content: str | None
    tool_calls: list[dict]
    usage: dict
    assistant_message: dict


class DeepSeekClient:
    def __init__(
        self,
        api_key: str,
        opener: Callable = urllib.request.urlopen,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.api_key = api_key
        self.opener = opener
        self.sleep = sleep

    def _payload(
        self,
        messages: list[dict],
        config: ModelConfig,
        max_tokens: int,
        tools: list[dict] | None,
        stream: bool,
    ) -> dict:
        payload = {
            "model": config.model,
            "messages": messages,
            "thinking": {"type": "enabled" if config.thinking_enabled else "disabled"},
            "stream": stream,
            "max_tokens": max_tokens,
        }
        if config.thinking_enabled:
            payload["reasoning_effort"] = config.reasoning_effort
        if tools:
            payload["tools"] = tools
        if stream:
            payload["stream_options"] = {"include_usage": True}
        return payload

    def _request(self, payload: dict, timeout: int):
        request = urllib.request.Request(
            API_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        for attempt in range(MAX_REQUEST_ATTEMPTS):
            try:
                return self.opener(request, timeout=timeout)
            except urllib.error.HTTPError as error:
                if error.code < 500 or attempt == MAX_REQUEST_ATTEMPTS - 1:
                    detail = error.read().decode("utf-8", errors="replace")
                    raise DeepSeekError(f"DeepSeek API returned HTTP {error.code}: {detail}") from error
            except urllib.error.URLError as error:
                if attempt == MAX_REQUEST_ATTEMPTS - 1:
                    raise DeepSeekError(f"DeepSeek API request failed: {error.reason}") from error
            self.sleep(0.5 * (attempt + 1))
        raise AssertionError("unreachable")

    def complete(self, messages: list[dict], config: ModelConfig, max_tokens: int, tools: list[dict] | None = None) -> ModelReply:
        config.validate()
        payload = self._payload(messages, config, max_tokens, tools, stream=False)
        with self._request(payload, config.toa_timeout) as response:
            body = json.loads(response.read().decode("utf-8"))

        try:
            message = body["choices"][0]["message"]
        except (KeyError, IndexError, TypeError) as error:
            raise DeepSeekError(f"Unexpected DeepSeek response: {body}") from error
        return ModelReply(
            content=message.get("content") or "",
            reasoning_content=message.get("reasoning_content"),
            tool_calls=message.get("tool_calls") or [],
            usage=body.get("usage") or {},
            assistant_message=message,
        )

    def complete_stream(
        self,
        messages: list[dict],
        config: ModelConfig,
        max_tokens: int,
        on_content: Callable[[str], None],
    ) -> ModelReply:
        """Stream a tool-free final answer and return its accumulated reply."""
        config.validate()
        payload = self._payload(messages, config, max_tokens, tools=None, stream=True)
        content: list[str] = []
        reasoning: list[str] = []
        usage: dict = {}
        # Retry only before any text is emitted, so a reconnect cannot duplicate output.
        for attempt in range(MAX_REQUEST_ATTEMPTS):
            try:
                with self._request(payload, config.toa_timeout) as response:
                    for raw_line in response:
                        line = raw_line.decode("utf-8", errors="replace").strip()
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            return ModelReply(
                                content="".join(content),
                                reasoning_content="".join(reasoning) or None,
                                tool_calls=[],
                                usage=usage,
                                assistant_message={"role": "assistant", "content": "".join(content)},
                            )
                        chunk = json.loads(data)
                        usage.update(chunk.get("usage") or {})
                        delta = (chunk.get("choices") or [{}])[0].get("delta") or {}
                        hidden_reasoning = delta.get("reasoning_content")
                        if hidden_reasoning:
                            reasoning.append(hidden_reasoning)
                        text = delta.get("content")
                        if text:
                            content.append(text)
                            on_content(text)
                return ModelReply(
                    content="".join(content),
                    reasoning_content="".join(reasoning) or None,
                    tool_calls=[],
                    usage=usage,
                    assistant_message={"role": "assistant", "content": "".join(content)},
                )
            except (urllib.error.URLError, urllib.error.HTTPError) as error:
                if content or attempt == MAX_REQUEST_ATTEMPTS - 1:
                    if isinstance(error, urllib.error.HTTPError):
                        detail = error.read().decode("utf-8", errors="replace")
                        raise DeepSeekError(f"DeepSeek API returned HTTP {error.code}: {detail}") from error
                    raise DeepSeekError(f"DeepSeek API request failed: {error.reason}") from error
                self.sleep(0.5 * (attempt + 1))
        raise AssertionError("unreachable")

    def run_with_tools(
        self,
        messages: list[dict],
        config: ModelConfig,
        max_tokens: int,
        tools: list[dict] | None = None,
        tool_handlers: dict[str, Callable[[dict], str]] | None = None,
    ) -> ModelReply:
        """Preserve reasoning only inside a single tool-call turn."""
        transient_messages = list(messages)
        handlers = tool_handlers or {}
        for round_number in range(MAX_TOOL_CALL_ROUNDS + 1):
            reply = self.complete(transient_messages, config, max_tokens, tools)
            if not reply.tool_calls:
                return reply
            if round_number == MAX_TOOL_CALL_ROUNDS:
                break
            transient_messages.append(reply.assistant_message)
            for call in reply.tool_calls:
                function = call.get("function", {})
                name = function.get("name")
                if name not in handlers:
                    result = json.dumps({"error": f"Tool {name!r} is not available."})
                else:
                    try:
                        arguments = json.loads(function.get("arguments") or "{}")
                        result = handlers[name](arguments)
                    except Exception as error:  # Tool errors are returned to the model, not persisted.
                        result = json.dumps({"error": str(error)})
                transient_messages.append({"role": "tool", "tool_call_id": call["id"], "content": result})
        # Some models keep searching after the useful evidence is already available.
        # Give them one tool-free turn to synthesize an answer instead of failing the CLI.
        transient_messages.append(
            {
                "role": "user",
                "content": (
                    "The tool-call budget is exhausted. Return the best final answer to the "
                    "original request now without using any tools. Be concise and state "
                    "uncertainty when needed."
                ),
            }
        )
        reply = self.complete(transient_messages, config, max_tokens, tools=None)
        if not reply.tool_calls:
            return reply
        raise DeepSeekError(
            f"Tool-call limit ({MAX_TOOL_CALL_ROUNDS} rounds) reached before a final answer."
        )
