from __future__ import annotations

import argparse
import getpass
import json
import sys

from .config import ModelConfig, load_config, model_id, save_config
from .deepseek import DeepSeekClient, DeepSeekError
from .keychain import load_api_key, save_api_key
from .memory import (
    DuplicateMemoryError,
    MemoryLimitError,
    cards_to_prune,
    create_candidate,
    list_cards,
    prune_cards,
    set_status,
)
from .orchestrator import RunResult, single_agent, toa_agent
from .terminal import format_output


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ya", description="Ya personal research agent")
    commands = parser.add_subparsers(dest="command", required=True)

    ask = commands.add_parser("ask", help="Run a research task")
    ask.add_argument("task")
    ask.add_argument("--model", choices=("flash", "pro"))
    ask.add_argument("--thinking", choices=("on", "off"))
    ask.add_argument("--reasoning-effort", choices=("high", "max"))
    ask.add_argument("--toa", action="store_true")
    ask.add_argument("--yes", action="store_true", help="Authorize this ToA run in a non-interactive shell")
    ask.add_argument("--toa-workers", type=int, choices=(1, 2), default=2)
    ask.add_argument("--toa-token-budget", type=int)
    ask.add_argument("--toa-timeout", type=int)
    ask.add_argument("--no-feedback", action="store_true")
    ask.add_argument("--format", choices=("auto", "terminal", "markdown"), default="auto")

    auth = commands.add_parser("auth", help="Store credentials")
    auth.add_argument("provider", choices=("deepseek",))

    config = commands.add_parser("config", help="Configure Ya defaults")
    config_subcommands = config.add_subparsers(dest="config_command", required=True)
    set_command = config_subcommands.add_parser("set")
    set_command.add_argument("key", choices=("model", "thinking", "reasoning-effort"))
    set_command.add_argument("value")

    memory = commands.add_parser("memory", help="Review local long-term memory")
    memory_subcommands = memory.add_subparsers(dest="memory_command", required=True)
    memory_subcommands.add_parser("review")
    for action in ("approve", "reject", "revoke"):
        action_parser = memory_subcommands.add_parser(action)
        action_parser.add_argument("card_id")
    prune = memory_subcommands.add_parser("prune", help="Delete rejected and revoked memory cards")
    prune.add_argument("--include-candidates", action="store_true")
    prune.add_argument("--yes", action="store_true", help="Confirm deletion without an interactive prompt")
    return parser


def _resolve_config(args: argparse.Namespace) -> ModelConfig:
    config = load_config()
    if args.model:
        config.model = model_id(args.model)
    if args.thinking:
        config.thinking_enabled = args.thinking == "on"
    if args.reasoning_effort:
        config.reasoning_effort = args.reasoning_effort
    if args.toa_token_budget is not None:
        config.toa_token_budget = args.toa_token_budget
    if args.toa_timeout is not None:
        config.toa_timeout = args.toa_timeout
    if not config.thinking_enabled and args.reasoning_effort:
        raise ValueError("--reasoning-effort requires --thinking on.")
    config.validate()
    return config


def _toa_confirm(args: argparse.Namespace, config: ModelConfig) -> bool:
    print("\nToA preflight")
    print(f"  model: {config.model}")
    print(f"  thinking: {'on' if config.thinking_enabled else 'off'} ({config.reasoning_effort})")
    print(f"  workers: {args.toa_workers} (evidence and risk roles, max 2)")
    print(f"  completion token budget: {config.toa_token_budget}")
    print(f"  timeout: {config.toa_timeout}s")
    if args.yes:
        return True
    if not sys.stdin.isatty():
        raise ValueError("--toa requires interactive confirmation or --yes in a non-interactive shell.")
    return input("Start ToA for this task? [y/N] ").strip().lower() in {"y", "yes"}


def _collect_feedback(result: RunResult, disabled: bool) -> None:
    if disabled or not sys.stdin.isatty():
        return
    answer = input("\nLearn from this answer? [y/N] ").strip().lower()
    if answer not in {"y", "yes"}:
        return
    text = input("Candidate preference or procedure: ").strip()
    if not text:
        print("No candidate created.")
        return
    kind = input("Kind [preference/procedure/knowledge] (procedure): ").strip() or "procedure"
    evidence = "Explicit user feedback after Ya task"
    if kind == "knowledge":
        source = input("Source URL for this knowledge: ").strip()
        if not source.startswith(("https://", "http://")):
            print("Knowledge candidates require a source URL.")
            return
        evidence += f"; source: {source}"
    try:
        card = create_candidate(text, evidence=evidence, kind=kind)
    except DuplicateMemoryError as error:
        print(f"Matching memory {error.card.id} already exists; no new candidate created.")
        return
    except MemoryLimitError as error:
        print(f"{error}. No candidate created.")
        return
    print(f"Created candidate {card.id}. Review it with: ya memory review")


def _ask(args: argparse.Namespace) -> int:
    config = _resolve_config(args)
    api_key = load_api_key()
    if not api_key:
        raise ValueError("No DeepSeek API key found. Run: ya auth deepseek")
    client = DeepSeekClient(api_key)
    if args.toa and _toa_confirm(args, config):
        result = toa_agent(client, args.task, config, args.toa_workers)
    else:
        result = single_agent(client, args.task, config)
    print(f"\n[Ya {result.mode} result]\n")
    print(format_output(result.content, args.format, sys.stdout.isatty()))
    if result.partial:
        print("\n[Some ToA worker results were unavailable; the synthesis may be incomplete.]", file=sys.stderr)
    _collect_feedback(result, args.no_feedback)
    return 0


def _config_set(args: argparse.Namespace) -> int:
    config = load_config()
    if args.key == "model":
        config.model = model_id(args.value)
    elif args.key == "thinking":
        if args.value not in {"on", "off"}:
            raise ValueError("thinking must be 'on' or 'off'.")
        config.thinking_enabled = args.value == "on"
    else:
        if args.value not in {"high", "max"}:
            raise ValueError("reasoning-effort must be 'high' or 'max'.")
        config.reasoning_effort = args.value
    config.validate()
    save_config(config)
    print(json.dumps(config.to_dict(), indent=2))
    return 0


def _memory(args: argparse.Namespace) -> int:
    if args.memory_command == "review":
        cards = list_cards()
        if not cards:
            print("No memory cards.")
        for card in cards:
            print(f"{card.id}  {card.status:9} {card.kind:10} {card.text}")
        return 0
    if args.memory_command == "prune":
        cards = cards_to_prune(args.include_candidates)
        if not cards:
            print("No matching memory cards to delete.")
            return 0
        print(f"Memory cards to delete ({len(cards)}):")
        for card in cards:
            print(f"  {card.id}  {card.status:9} {card.kind:10} {card.text}")
        if not args.yes:
            if not sys.stdin.isatty():
                raise ValueError("ya memory prune requires --yes in a non-interactive shell.")
            answer = input("Permanently delete these memory cards? [y/N] ").strip().lower()
            if answer not in {"y", "yes"}:
                print("No memory cards deleted.")
                return 0
        removed = prune_cards(args.include_candidates)
        print(f"Deleted {len(removed)} memory card(s).")
        return 0
    status = {"approve": "approved", "reject": "rejected", "revoke": "revoked"}[args.memory_command]
    card = set_status(args.card_id, status)
    print(f"{card.id}: {card.status}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "auth":
            api_key = getpass.getpass("DeepSeek API key: ")
            save_api_key(api_key)
            print("DeepSeek API key saved to the macOS Keychain.")
            return 0
        if args.command == "config":
            return _config_set(args)
        if args.command == "memory":
            return _memory(args)
        return _ask(args)
    except (ValueError, DeepSeekError) as error:
        print(f"Ya error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
