# df-query

A local web viewer for the Dwarf Fortress data that's tedious to dig out of
the game's own interface: who your best crafters are, where every stockpile
sends its goods, which pasture that lost yak is assigned to, and what your
squads are actually scheduled to do.

It reads a **static snapshot**, not a live feed. Press **Refresh** in the UI
(or run `python3 -m df_query refresh`) and it pulls fresh data out of the
running game through DFHack.

Nothing here modifies the game. The dumper that runs inside Dwarf Fortress
only reads.

## Requirements

- Python 3.11+ — standard library only, no dependencies, no build step
- Dwarf Fortress running with DFHack injected, with a fortress loaded

Tested against DFHack 53.16-r1.1 / DF v0.53.16 on Linux.

## Running

```sh
python3 -m df_query serve          # http://127.0.0.1:8787
python3 -m df_query refresh        # take a snapshot from the CLI instead
```

`serve` works with the game closed — it just shows the last snapshot. Only
**Refresh** needs a live game.

df-query looks for the DFHack install in the usual Steam locations. If yours
is elsewhere, point at it:

```sh
DFHACK_DIR=/path/to/DFHack python3 -m df_query serve
```

## Views

| View | What it answers |
|---|---|
| **Skills** | Best dwarf per DF skill category — combat, mining, crafts, farming, arts, scholarship… — as ranked cards, plus a filterable roster. Filter by migration wave, work detail, squad, or idleness; click any dwarf for their full skill breakdown and labours. |
| **Stockpiles** | Every pile with its accepted categories, contents, and links. The graph mode draws which piles feed which workshops, so a broken supply chain is visible instead of inferred. |
| **Animals** | Livestock grouped by pasture, with tiles-per-grazer and a species summary per pen, or a by-species table across the whole fort. Unpastured animals and empty pastures are both called out, since those are what you're usually hunting for. |
| **Squads** | Roster with each soldier's combat skills and current job, barracks assignments and their uses, and the 12-month training schedule as a grid with minimum-soldier counts. |

## Idleness

A single snapshot only knows whether a dwarf happens to have no job at this
instant, which is close to a coin flip. Every refresh appends a per-dwarf idle
observation to `data/idle_history.json`, so after a handful of refreshes the
roster shows an idle *rate* ("32% of 12 refreshes") instead.

Refreshes taken at the same game tick are ignored, so pausing and mashing
Refresh won't skew the numbers — but it also means the metric only grows while
the game is actually running.

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
writes one JSON file. Every field read is wrapped so a structure change in a
future DF version costs one value rather than the whole snapshot.

The snapshot also carries DF's own skill and labour enum tables, so the web UI
derives its categories from whatever the running game actually has rather than
from a list baked into the JavaScript.

## Layout

```
lua/dump.lua        game-side dumper (read-only)
df_query/collect.py locates DFHack, invokes the dumper, tracks idle history
df_query/server.py  static files + /api/snapshot, /api/refresh, /api/status
web/                the viewer (vanilla ES modules, no build step)
data/               snapshots and idle history (gitignored)
```

See [AGENTS.md](./AGENTS.md) for the snapshot schema, DF structure gotchas,
and conventions for working on the code.
