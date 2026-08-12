"""Static file server plus a tiny JSON API for the df-query web viewer.

Stdlib only, so the whole thing runs with a bare `python3 -m df_query`.
"""

from __future__ import annotations

import json
import mimetypes
import threading
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .collect import (
    DEFAULT_HISTORY,
    DEFAULT_SNAPSHOT,
    REPO_ROOT,
    CollectError,
    collect,
    load_idle_history,
)

WEB_ROOT = REPO_ROOT / "web"

# Refreshes hit the game process; serialise them so a double-click on the
# refresh button cannot run two dumps at once.
_refresh_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server_version = "df-query"

    def __init__(self, *args, snapshot_path: Path, **kwargs):
        self.snapshot_path = snapshot_path
        super().__init__(*args, **kwargs)

    # -- plumbing ---------------------------------------------------------

    def log_message(self, format, *args):  # noqa: A002 — stdlib signature
        # Quieter than the default: only the API calls are worth seeing.
        if self.path.startswith("/api/"):
            print(f"{self.command} {self.path} -> {args[1] if len(args) > 1 else ''}")

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_json(self, status: int, payload: object) -> None:
        self._send(status, json.dumps(payload).encode(), "application/json; charset=utf-8")

    # -- routes -----------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        path = self.path.split("?", 1)[0]
        if path == "/api/snapshot":
            self._serve_snapshot()
        elif path == "/api/status":
            self._serve_status()
        else:
            self._serve_static(path)

    do_HEAD = do_GET

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] != "/api/refresh":
            self._send_json(404, {"error": "not found"})
            return
        if not _refresh_lock.acquire(blocking=False):
            self._send_json(409, {"error": "a refresh is already running"})
            return
        try:
            result = collect(self.snapshot_path)
        except CollectError as exc:
            self._send_json(503, {"error": str(exc)})
            return
        finally:
            _refresh_lock.release()
        self._send_json(200, {"ok": True, "message": result.output, "duration": result.duration})

    # -- handlers ---------------------------------------------------------

    def _serve_snapshot(self) -> None:
        if not self.snapshot_path.is_file():
            self._send_json(404, {"error": "no snapshot yet — hit Refresh with the game running"})
            return
        try:
            snapshot = json.loads(self.snapshot_path.read_text())
        except (OSError, ValueError) as exc:
            self._send_json(500, {"error": f"snapshot is unreadable: {exc}"})
            return
        snapshot["idle_history"] = load_idle_history(DEFAULT_HISTORY)
        self._send_json(200, snapshot)

    def _serve_status(self) -> None:
        exists = self.snapshot_path.is_file()
        self._send_json(200, {
            "has_snapshot": exists,
            "mtime": self.snapshot_path.stat().st_mtime if exists else None,
        })

    def _serve_static(self, path: str) -> None:
        relative = path.lstrip("/") or "index.html"
        target = (WEB_ROOT / relative).resolve()
        if not target.is_relative_to(WEB_ROOT.resolve()) or not target.is_file():
            self._send(404, b"not found", "text/plain; charset=utf-8")
            return
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in (
            "application/javascript", "application/json",
        ):
            content_type += "; charset=utf-8"
        self._send(200, target.read_bytes(), content_type)


def serve(host: str = "127.0.0.1", port: int = 8787,
          snapshot_path: Path = DEFAULT_SNAPSHOT) -> None:
    handler = partial(Handler, snapshot_path=Path(snapshot_path))
    httpd = ThreadingHTTPServer((host, port), handler)
    print(f"df-query serving http://{host}:{port}/  (snapshot: {snapshot_path})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        httpd.server_close()
