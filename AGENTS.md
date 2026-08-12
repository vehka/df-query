# AGENTS.md — df-query

A web viewer for Dwarf Fortress fortress data pulled through DFHack. See
[README.md](./README.md) for what it does and how to run it. This file is what
you need to *work on* it.

## Ground rules

- **The game-side dumper is read-only.** `lua/dump.lua` runs inside a live
  Dwarf Fortress process. It must never write to game structures. Discovery
  and inspection are free; if a task seems to want a mutating DFHack command,
  that belongs outside this project — ask first.
- **No dependencies.** Python standard library only, vanilla ES modules in the
  browser, no build step, no bundler, no CDN. Keeping `python3 -m df_query
  serve` as the entire setup is a deliberate constraint, not an accident.
- **Don't hardcode DF taxonomies.** Skill categories, labour names, and skill
  level captions come from the enum tables the dumper ships in the snapshot
  (`snapshot.enums`). If you find yourself typing a list of DF skill names into
  JavaScript, read it from the snapshot instead — with one documented
  exception, see *Skill categories* below.

## Reaching a live game

The dumper needs Dwarf Fortress running with DFHack injected and a fortress
loaded. Check before assuming it's down:

```sh
ps aux | grep -i [d]warfort
```

DFHack lives at `~/backup/SteamLibrary/steamapps/common/DFHack` on this
machine (override with the `DFHACK_DIR` environment variable). Always go
through the `dfhack-run` wrapper in that directory — it sets `LD_LIBRARY_PATH`
for the bundled shared objects. `hack/dfhack-run` called directly will fail.

That directory is also the place for **ad-hoc** live queries — poking at
structures, checking a field name, trying an approach before committing to it:

```sh
cd ~/backup/SteamLibrary/steamapps/common/DFHack
./dfhack-run lua "print(df.global.plotinfo.site_id)"
./dfhack-run ls stockpiles     # discover commands; don't guess flags
./dfhack-run help <command>
```

It has its own `AGENTS.md` with safety rules and worked query recipes. Use it
to explore; bring the result back here as code.

The fort in use during development is **Shieldclosed** (site 708, group 1000),
year 104 — 156 citizens, 235 animals, 60 stockpiles, 6 squads. Useful as a
sanity check: if a refresh reports numbers wildly off from those, something
regressed rather than the fort changing.

## Architecture

```
browser  ──HTTP──▶  df_query/server.py  ──subprocess──▶  dfhack-run lua
                            │                                   │
                            │                            lua/dump.lua
                            ▼                                   │
                    data/snapshot.json  ◀───────writes──────────┘
```

The dumper writes the file itself rather than printing JSON to stdout, which
keeps DFHack's console encoding and line handling out of the data path. It
prints one status line, which `collect.py` checks for — **`dfhack-run` exits 0
even when the Lua raises**, so the marker is the only reliable success signal.

## Working on the dumper

`lua/dump.lua` returns a single function taking the output path:

```sh
dfhack-run lua "dofile([[/path/to/lua/dump.lua]])([[/path/to/out.json]])"
```

Long-bracket strings keep both the shell and Lua's escape rules out of path
handling.

Conventions inside it:

- Wrap every DF field read that might move between versions in `try(fn,
  fallback)`. A missing field should cost one value, not the snapshot.
- Run every DF-sourced string through `u()` (CP437 → UTF-8) exactly once, at
  the point it enters the snapshot.
- Build JSON arrays with `A{}` so empty ones still encode as `[]`. Plain
  tables encode as objects.
- The JSON encoder is hand-rolled rather than `require('json')`, because
  json.lua cannot distinguish an empty array from an empty object.

### DF structure gotchas, learned the hard way

These cost real debugging time. They are not obvious from the XML alone.

- **`squad.schedule.routine[r].month[m].orders[i]` is a `squad_schedule_order`
  wrapper, not a `squad_order`.** The real order is `.order`; `min_count` is on
  the wrapper. Calling `getType()` on the wrapper yields nothing and silently
  produces schedules that look empty.
- **`building.type` is a different enum per building class** — `workshop_type`
  for workshops, `furnace_type` for furnaces, absent for farm plots and the
  trade depot. Decoding with the wrong enum gives plausible, wrong names.
- **`dfhack.buildings.getName()` ignores the player's custom name.** It returns
  "Stockpile #14" even when the player typed "Fuel buffer". The custom name is
  `building.name`; prefer it.
- **`unit.status.labors[]` is indexed by `unit_labor`**, and
  `df.unit_labor.attrs[i].category` is DF's own Labors-screen grouping — but it
  is `None` for `MINE` and for every `UNUSED_*` slot.
- **`df.skill_rating` stops at Legendary+5 (20).** Ratings climb past it; the
  UI formats the overflow itself.
- **`dfhack.units.getReadableName()` returns name + nickname + profession**,
  which is too long for a table cell. `translateName(getVisibleName(unit),
  false)` gives the short form DF's own unit list shows.
- **`unit.sex` is `pronoun_type`**: 0 female, 1 male, -1/-2 unknown.
- **`ipairs` over a DF vector yields 0-based indices**, which is what you want
  — they line up with `cur_routine_idx`, squad position indices, and work
  detail indices.
- **Lua 5.4 dropped `%z` from patterns.** Use `%c` for control characters.
- `os.time`, `io.open`, and `dofile` are all available in DFHack's Lua sandbox.
- **A nil value drops the key entirely** from the emitted JSON, because Lua
  tables cannot hold nils. The web UI must tolerate absent keys, not just null
  ones — hence `asList()` and `?.` on the JS side.

### Structure references

In order of usefulness:

- `~/git/df-structures/df.*.xml` — the struct and enum definitions themselves.
  `df.d_basics.xml` holds most enums (`unit_labor`, `civzone_type`,
  `squad_order_type`, `pronoun_type`); `df.skill_enum.xml` holds `job_skill`.
- `~/git/dfhack/docs/dev/Lua API.rst` — the `dfhack.units.*`,
  `dfhack.buildings.*`, `dfhack.translation.*` helpers the dumper leans on.
- `~/git/dfhack/scripts/` and the install's `hack/scripts/` — worked examples.
  `list-waves.lua` is the source of the migration-wave grouping used here.

## Working on the web UI

Each view module in `web/js/views/` exports `render(root, db)`, keeps its
filter state in a module-level `state` object, and redraws by calling a
`redraw` closure threaded down from `draw()`. There is no framework and no
virtual DOM — `h()` from `util.js` builds elements directly.

`web/js/db.js` owns all interpretation of the raw snapshot: indexes by id,
per-unit derived fields (`best` skill per category, `topSkills`, `idleRate`,
`label`), and the skill categorisation. Views should read from `db`, not
re-derive.

### Skill categories

The one place with real judgment in it. DF exposes two groupings and neither
covers everything:

1. Labour skills carry a `unit_labor` whose `category` is the grouping DF's
   Labors screen uses (Woodworking, Crafts, Farming, Hauling…).
2. Everything else carries a `job_skill_class` (Combat, Social, Cultural,
   Medical, Personal).

`Db#categoriseSkills` prefers the labour category and falls back to the class.
That leaves ~35 skills — mining, the performing arts, the scholarly skills, the
bookkeeping skills — as class `Normal` with no labour, which would all land in
"Other". DF has no third grouping to read; its own UI hardcodes these too. So
`SKILL_CATEGORY_OVERRIDES` names those explicitly. That map is the *only*
sanctioned hardcoded taxonomy; extend it rather than adding a second one, and
leave the derived path alone.

## Testing loop

Without the game, catch the syntax errors:

```sh
luac5.4 -p lua/dump.lua
for f in $(find web/js -name '*.js'); do node --check "$f"; done
```

With the game running and a fort loaded:

```sh
python3 -m df_query refresh
python3 -c "import json; d=json.load(open('data/snapshot.json')); \
  print({k: len(v) for k, v in d.items() if isinstance(v, list)})"
```

Inspecting the JSON catches more than the UI does — a field that silently
failed to read shows up as a missing key, not a visible error. Check the
section you touched before opening a browser.

The server sends `Cache-Control: no-store`, but changing the hash (`#skills`)
is a same-document navigation and will **not** reload the ES modules. Force a
real reload after editing JavaScript or CSS.

## Snapshot schema

`format: 1`. Top-level keys, with the fields most worth knowing:

| Key | Shape |
|---|---|
| `meta` | `fort_name`, `civ_name`, `group_name`, `site_id`, `group_id`, `year`, `year_tick`, `month`, `month_name`, `day`, `season`, `generated_at` (unix), `df_version`, `dfhack_version` |
| `enums` | `job_skill[]` (`key`, `caption`, `caption_noun`, `labor`, `profession`, `class`), `unit_labor[]` (`key`, `caption`, `category`), `skill_rating[]` (`caption`, `xp_threshold`) |
| `units[]` | `id`, `name`, `short_name`, `nickname`, `profession`, `race`, `sex`, `age`, `is_child`/`is_baby`/`is_visitor`, `stress`, `stress_category` (0 worst … 6 best), `pos`, `job`, `idle`, `seeking_job`, `on_break`, `labors[]`, `work_details[]`, `skills[]` (`key`, `rating`, `experience`, `rusty`), `nobles[]`, `squad_id`, `squad_position`, `wave` |
| `work_details[]` | `index`, `name`, `mode`, `icon`, `labors[]`, `assigned_units[]` |
| `stockpiles[]` | `id`, `number`, `name`, `custom_name`, bounding box + `z`, `area`, `categories[]`, `flags[]`, `item_count`, `items_by_type` |
| `workshops[]` | `id`, `kind` (Workshop/Furnace/FarmPlot/TradeDepot), `subtype`, `name`, box + `z`, `jobs[]`, `permitted_workers[]` |
| `links[]` | `{from, to}` building ids, normalised to material-flow direction and deduplicated |
| `zones[]` | `id`, `number`, `name`, `type` (`civzone_type`, e.g. `Pen`), `active`, box + `z`, `area`, `assigned_units[]` |
| `animals[]` | `id`, `name`, `race`, `sex`, `age`, `zone_id`, `tame`/`grazer`/`milkable`/`egg_layer`/`war`/`hunting`/`gelded`, `marked_for_slaughter`, `training_level` |
| `squads[]` | `id`, `name`, `alias`, `display_name`, `cur_routine_idx`, `positions[]` (`index`, `unit_id`, `name`), `rooms[]` (`name`, `modes[]`), `schedule[]` (routines → `months[]` → `orders[]`) |

`/api/snapshot` adds `idle_history`: unit id → array of 0/1 observations.

Squad *positions* are all 10 slots whether filled or not; a filled one has
`unit_id`. Squad *schedules* carry every routine — `cur_routine_idx` picks the
one actually in force, and a squad can look correctly configured while sitting
on an empty routine.

## Ideas not yet built

- Stockpile contents are item-type counts only (`STONE 40`); materials would
  make that view far more useful.
- Pasture cards get very tall for a 71-animal pen — collapse or paginate.
- No way to jump from a dwarf to where they are on the map.
