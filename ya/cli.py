from __future__ import annotations

import argparse
import getpass
import json
import os
from pathlib import Path
import sys

from .config import ModelConfig, load_config, model_id, save_config
from .deepseek import DeepSeekClient, DeepSeekError
from .keychain import load_api_key, save_api_key
from .local import LocalAction, LocalWorkspace, audit_log_files, audit_log_total_bytes, clear_audit_logs
from .memory import (
    DuplicateMemoryError,
    MemoryLimitError,
    cards_to_prune,
    create_candidate,
    list_cards,
    prune_cards,
    select_relevant_cards,
    set_status,
)
from .orchestrator import RunResult, should_use_web, single_agent, toa_agent
from .terminal import StreamingMarkdownRenderer, format_output


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
    ask.add_argument("--web", choices=("auto", "on", "off"), default="auto")
    ask.add_argument("--stream", choices=("auto", "off"), default="auto")
    ask.add_argument("--show-memory", action="store_true", help="Show approved memory selected for this task")
    ask.add_argument("--local", action="store_true", help="Allow workspace file tools for this task")
    ask.add_argument("--workspace", metavar="PATH", help="Workspace root for --local (default: current directory)")
    ask.add_argument("--approve", action="store_true", help="Allow local file changes in a non-interactive shell")

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

    audit = commands.add_parser("audit", help="Manage local action audit logs")
    audit_subcommands = audit.add_subparsers(dest="audit_command", required=True)
    clear = audit_subcommands.add_parser("clear", help="Permanently delete local action audit logs")
    clear.add_argument("--yes", action="store_true", help="Confirm deletion without an interactive prompt")
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


def _show_memory(task: str) -> None:
    matches = select_relevant_cards(task)
    print("\n[Ya memory context]")
    if not matches:
        print("  No approved memory met the relevance threshold.")
        return
    for match in matches:
        print(f"  {match.card.id}  score {match.score:<2} {match.card.kind:10} {match.card.text}")


def _local_confirm(action: LocalAction, approve_noninteractive: bool) -> bool:
    print(f"\n[Ya local action]\n  {action.summary}")
    if action.diff:
        print("\n" + action.diff, end="" if action.diff.endswith("\n") else "\n")
    if not sys.stdin.isatty():
        if approve_noninteractive:
            print("  Approved by --approve for this non-interactive task.")
            return True
        print("  Denied: non-interactive local changes require --approve.")
        return False
    return input("Apply this file change? [y/N] ").strip().lower() in {"y", "yes"}


def _ask(args: argparse.Namespace) -> int:
    if args.local and args.toa:
        raise ValueError("--local and --toa cannot be used together.")
    if args.workspace and not args.local:
        raise ValueError("--workspace requires --local.")
    if args.approve and not args.local:
        raise ValueError("--approve requires --local.")
    config = _resolve_config(args)
    api_key = load_api_key()
    if not api_key:
        raise ValueError("No DeepSeek API key found. Run: ya auth deepseek")
    if args.show_memory:
        _show_memory(args.task)
    workspace = None
    if args.local:
        root = Path(args.workspace).expanduser() if args.workspace else Path.cwd()
        workspace = LocalWorkspace(root, lambda action: _local_confirm(action, args.approve))
    can_stream = (
        args.stream == "auto"
        and not args.toa
        and not args.local
        and not should_use_web(args.task, args.web)
        and args.format != "markdown"
        and sys.stdout.isatty()
    )
    renderer = StreamingMarkdownRenderer(color="NO_COLOR" not in os.environ) if can_stream else None

    def emit(chunk: str) -> None:
        assert renderer is not None
        rendered = renderer.write(chunk)
        if rendered:
            print(rendered, end="", flush=True)

    if renderer is not None:
        print("\n[Ya single result]\n")
    client = DeepSeekClient(api_key)
    if args.toa and _toa_confirm(args, config):
        result = toa_agent(client, args.task, config, args.toa_workers)
    else:
        kwargs = {"web_mode": args.web, "on_content": emit if renderer else None}
        if workspace is not None:
            kwargs["local_workspace"] = workspace
        result = single_agent(client, args.task, config, **kwargs)
    if renderer is not None:
        tail = renderer.finish()
        if tail:
            print(tail)
    else:
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


def _audit(args: argparse.Namespace) -> int:
    if args.audit_command != "clear":
        raise ValueError(f"Unsupported audit command: {args.audit_command}")
    logs = audit_log_files()
    if not logs:
        print("No audit logs to delete.")
        return 0
    total = audit_log_total_bytes()
    print(f"Audit log files to delete ({len(logs)}, {total} bytes):")
    for path in logs:
        print(f"  {path} ({path.stat().st_size} bytes)")
    if not args.yes:
        if not sys.stdin.isatty():
            raise ValueError("ya audit clear requires --yes in a non-interactive shell.")
        answer = input("Permanently delete these audit logs? [y/N] ").strip().lower()
        if answer not in {"y", "yes"}:
            print("No audit logs deleted.")
            return 0
    removed = clear_audit_logs()
    print(f"Deleted {len(removed)} audit log file(s).")
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
        if args.command == "audit":
            return _audit(args)
        return _ask(args)
    except (ValueError, DeepSeekError) as error:
        print(f"Ya error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
