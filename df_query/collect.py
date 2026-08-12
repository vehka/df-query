"""Pull a fortress snapshot out of a running Dwarf Fortress via DFHack.

The heavy lifting happens in ``lua/dump.lua``, which runs inside the game
process and writes JSON straight to disk. This module only locates the
DFHack install, invokes it, and reports what happened.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DUMP_LUA = REPO_ROOT / "lua" / "dump.lua"
DEFAULT_SNAPSHOT = REPO_ROOT / "data" / "snapshot.json"
DEFAULT_HISTORY = REPO_ROOT / "data" / "idle_history.json"

# Where to look for the DFHack install, in order. Override with DFHACK_DIR.
DFHACK_DIR_CANDIDATES = (
    "~/backup/SteamLibrary/steamapps/common/DFHack",
    "~/.steam/steam/steamapps/common/DFHack",
    "~/.local/share/Steam/steamapps/common/DFHack",
    "~/DFHack",
)

# How many refresh observations to keep per unit for the idleness metric.
IDLE_HISTORY_LIMIT = 50


class CollectError(RuntimeError):
    """Raised when a snapshot could not be collected."""


@dataclass
class CollectResult:
    snapshot_path: Path
    output: str
    duration: float


def find_dfhack_dir() -> Path:
    """Locate the DFHack install directory containing the dfhack-run wrapper."""
    override = os.environ.get("DFHACK_DIR")
    candidates = [override] if override else list(DFHACK_DIR_CANDIDATES)
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate).expanduser()
        if (path / "dfhack-run").is_file():
            return path
    raise CollectError(
        "Could not find a DFHack install (looked for a dfhack-run wrapper in: "
        + ", ".join(str(Path(c).expanduser()) for c in candidates if c)
        + "). Set DFHACK_DIR to point at it."
    )


def collect(snapshot_path: Path = DEFAULT_SNAPSHOT, timeout: float = 120.0) -> CollectResult:
    """Run the dumper against the live game and write ``snapshot_path``."""
    dfhack_dir = find_dfhack_dir()
    snapshot_path = Path(snapshot_path)
    snapshot_path.parent.mkdir(parents=True, exist_ok=True)

    # Long-bracket string literals keep both the shell and Lua's escape rules
    # out of the picture for paths.
    lua = f"dofile([[{DUMP_LUA}]])([[{snapshot_path}]])"

    started = time.monotonic()
    try:
        proc = subprocess.run(
            [str(dfhack_dir / "dfhack-run"), "lua", lua],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise CollectError(f"dfhack-run timed out after {timeout:.0f}s") from exc
    except OSError as exc:
        raise CollectError(f"could not run dfhack-run: {exc}") from exc

    duration = time.monotonic() - started
    output = (proc.stdout + proc.stderr).strip()

    if proc.returncode != 0:
        raise CollectError(
            "dfhack-run failed. Is Dwarf Fortress running with DFHack injected, "
            f"and a fortress loaded?\n{output or f'exit code {proc.returncode}'}"
        )
    # dfhack-run happily exits 0 while reporting a Lua error, so check that the
    # dumper actually produced a file for this run.
    if not snapshot_path.is_file() or snapshot_path.stat().st_mtime < time.time() - 300:
        raise CollectError(f"the dumper did not write a snapshot.\n{output}")
    if "df-query: wrote" not in output:
        raise CollectError(f"unexpected output from the dumper:\n{output or '(no output)'}")

    record_idle_history(snapshot_path, DEFAULT_HISTORY)
    return CollectResult(snapshot_path=snapshot_path, output=output, duration=duration)


def record_idle_history(snapshot_path: Path, history_path: Path) -> None:
    """Append this snapshot's per-unit idle observations to the history file.

    A single snapshot only says whether a dwarf happens to be jobless right
    now. Accumulating observations across refreshes turns that into a usable
    "how often is this dwarf idle" figure, which is what the skills view shows.
    """
    try:
        snapshot = json.loads(snapshot_path.read_text())
    except (OSError, ValueError):
        return

    history: dict = {"observations": {}}
    if history_path.is_file():
        try:
            history = json.loads(history_path.read_text())
        except (OSError, ValueError):
            pass
    observations = history.setdefault("observations", {})

    meta = snapshot.get("meta", {})
    stamp = [meta.get("year"), meta.get("year_tick")]
    if stamp == history.get("last_stamp"):
        # Same game tick as the previous refresh — nothing new was observed.
        return
    history["last_stamp"] = stamp

    for unit in snapshot.get("units", []):
        samples = observations.setdefault(str(unit["id"]), [])
        samples.append(1 if unit.get("idle") else 0)
        del samples[:-IDLE_HISTORY_LIMIT]

    history_path.parent.mkdir(parents=True, exist_ok=True)
    history_path.write_text(json.dumps(history))


def load_idle_history(history_path: Path = DEFAULT_HISTORY) -> dict[str, list[int]]:
    if not history_path.is_file():
        return {}
    try:
        return json.loads(history_path.read_text()).get("observations", {})
    except (OSError, ValueError):
        return {}
