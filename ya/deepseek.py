from __future__ import annotations

from dataclasses import dataclass
from typing import Callable
import json
import urllib.error
import urllib.request

from .config import ModelConfig


API_URL = "https://api.deepseek.com/chat/completions"


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
    def __init__(self, api_key: str, opener: Callable = urllib.request.urlopen):
        self.api_key = api_key
        self.opener = opener

    def complete(self, messages: list[dict], config: ModelConfig, max_tokens: int, tools: list[dict] | None = None) -> ModelReply:
        config.validate()
        payload = {
            "model": config.model,
            "messages": messages,
            "thinking": {"type": "enabled" if config.thinking_enabled else "disabled"},
            "stream": False,
            "max_tokens": max_tokens,
        }
        if config.thinking_enabled:
            payload["reasoning_effort"] = config.reasoning_effort
        if tools:
            payload["tools"] = tools
        request = urllib.request.Request(
            API_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with self.opener(request, timeout=config.toa_timeout) as response:
                body = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise DeepSeekError(f"DeepSeek API returned HTTP {error.code}: {detail}") from error
        except urllib.error.URLError as error:
            raise DeepSeekError(f"DeepSeek API request failed: {error.reason}") from error

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
        for _ in range(3):
            reply = self.complete(transient_messages, config, max_tokens, tools)
            if not reply.tool_calls:
                return reply
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
        raise DeepSeekError("Tool-call limit reached before a final answer.")
