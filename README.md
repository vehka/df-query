# df-query

A local web viewer for the Dwarf Fortress data that's tedious to dig out of
the game's own interface: who your best crafters are, where every stockpile
sends its goods, which pasture that lost yak is assigned to, and what your
squads are actually scheduled to do.

It reads a **static snapshot**, not a live feed. Hit **Refresh** in the UI (or
run `python3 -m df_query refresh`) and it pulls fresh data out of the running
game via DFHack.

## Requirements

- Python 3.11+ (standard library only — no dependencies, no build step)
- Dwarf Fortress running with DFHack injected, with a fortress loaded

## Running

```sh
python3 -m df_query serve          # http://127.0.0.1:8787
python3 -m df_query refresh        # snapshot from the CLI instead
```

If your DFHack install isn't in one of the usual Steam locations, point at it:

```sh
DFHACK_DIR=/path/to/DFHack python3 -m df_query serve
```

## Views

| View | What it answers |
|---|---|
| **Skills** | Best dwarf per DF skill category (combat, crafts, farming, arts, social…), plus a filterable roster. Filter by migration wave, work detail, squad, or idleness. |
| **Stockpiles** | Every pile with its accepted categories, contents, and links — including a flow graph of which piles feed which workshops. |
| **Animals** | Livestock grouped by pasture, with tiles-per-grazer, or summarised by species. Unpastured animals are called out. |
| **Squads** | Roster with combat skills, barracks assignments, and the 12-month training schedule grid. |

## Idleness

A single snapshot only knows whether a dwarf happens to have no job at this
instant, which isn't very informative on its own. Every refresh appends a
per-dwarf idle observation to `data/idle_history.json`, so after a handful of
refreshes the roster shows an idle *rate* ("32% of 12 refreshes") instead of a
coin flip. Refreshes taken at the same game tick are ignored, so pausing and
mashing Refresh won't skew it.

## How it works

```
browser  ──HTTP──▶  df_query/server.py  ──subprocess──▶  dfhack-run lua
                            │                                   │
                            │                            lua/dump.lua
                            │                          (runs inside DF)
                            ▼                                   │
                    data/snapshot.json  ◀───────writes──────────┘
```

`lua/dump.lua` does all the game-side work: it walks DF's structures and
writes one JSON file. It is strictly read-only — it never modifies game state
— and every field read is wrapped so a structure change in a future DF version
costs one value rather than the whole snapshot.

The snapshot also carries DF's own skill and labor enum tables, so the web UI
derives its categories from whatever the running game actually has rather than
from a hardcoded list.

## Layout

```
lua/dump.lua        game-side dumper (read-only)
df_query/collect.py locates DFHack, invokes the dumper, tracks idle history
df_query/server.py  static files + /api/snapshot, /api/refresh, /api/status
web/                the viewer (vanilla ES modules, no build step)
data/               snapshots and idle history (gitignored)
```
