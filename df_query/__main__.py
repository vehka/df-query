"""Command line entry point: `python3 -m df_query [serve|refresh]`."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .collect import DEFAULT_SNAPSHOT, CollectError, collect
from .server import serve


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="df-query", description=__doc__)
    parser.add_argument("--snapshot", type=Path, default=DEFAULT_SNAPSHOT,
                        help="path to the snapshot JSON file")
    sub = parser.add_subparsers(dest="command")

    serve_cmd = sub.add_parser("serve", help="run the web viewer (default)")
    serve_cmd.add_argument("--host", default="127.0.0.1")
    serve_cmd.add_argument("--port", type=int, default=8787)

    sub.add_parser("refresh", help="pull a fresh snapshot from the running game")

    args = parser.parse_args(argv)

    if args.command == "refresh":
        try:
            result = collect(args.snapshot)
        except CollectError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        print(f"{result.output} in {result.duration:.1f}s -> {result.snapshot_path}")
        return 0

    serve(host=getattr(args, "host", "127.0.0.1"),
          port=getattr(args, "port", 8787),
          snapshot_path=args.snapshot)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
