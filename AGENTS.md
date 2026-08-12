# AGENTS.md — df-query

A web viewer for Dwarf Fortress fortress data pulled through DFHack. See
[README.md](./README.md) for what it does and how to run it.

## Ground rules

- **The game-side dumper is read-only.** `lua/dump.lua` runs inside a live
  Dwarf Fortress process. It must never write to game structures. If you need
  a mutating DFHack command for something, that belongs outside this project —
  ask the user first.
- **No dependencies.** Python standard library only, vanilla ES modules in the
  browser, no build step, no bundler, no CDN. Keeping `python3 -m df_query
  serve` as the entire setup is a deliberate constraint.
- **Don't hardcode DF taxonomies.** Skill categories, labor names, and skill
  level captions all come from the enum tables the dumper ships in the
  snapshot (`snapshot.enums`). If you find yourself typing a list of DF skill
  names into JavaScript, read it from the snapshot instead.

## Working on the dumper

`lua/dump.lua` is invoked as:

```sh
dfhack-run lua "dofile([[/path/to/lua/dump.lua]])([[/path/to/out.json]])"
```

Long-bracket strings keep both the shell and Lua's escape rules out of path
handling. The file returns a single function taking the output path.

Conventions inside it:

- Wrap every DF field read that might move between versions in `try(fn,
  fallback)`. A missing field should cost one value, not the snapshot.
- Run every DF-sourced string through `u()` (CP437 → UTF-8) exactly once, at
  the point it enters the snapshot.
- Build JSON arrays with `A{}` so empty ones still encode as `[]`. Plain
  tables encode as objects.
- The JSON encoder is hand-rolled rather than `require('json')`, because
  json.lua cannot distinguish an empty array from an empty object.

To iterate quickly, syntax-check without the game:

```sh
luac5.4 -p lua/dump.lua
```

Then, with DF running and a fort loaded:

```sh
python3 -m df_query refresh
python3 -c "import json;d=json.load(open('data/snapshot.json'));print(list(d), len(d['units']))"
```

## Structure references

The authoritative sources for what DF actually stores, in order of usefulness:

- `~/git/df-structures/df.*.xml` — the struct/enum definitions themselves
- `~/git/dfhack/docs/dev/Lua API.rst` — the `dfhack.units.*`, `dfhack.buildings.*`
  helpers the dumper leans on
- `~/git/dfhack/scripts/` and the installed `hack/scripts/` — worked examples;
  `list-waves.lua` is the source of the migration-wave grouping used here
- The sibling DFHack install has its own `AGENTS.md` with recipes for querying
  a live game ad hoc

## Working on the web UI

`web/js/db.js` owns the one piece of real interpretation: mapping each skill
to a display category. DF groups labour skills by their `unit_labor`'s
`category` (the Labors screen grouping) and everything else by
`job_skill_class`; `Db#categoriseSkills` prefers the former and falls back to
the latter. Change it there, not in the views.

Each view module in `web/js/views/` exports `render(root, db)`, keeps its
filter state in a module-level `state` object, and redraws by calling a
`redraw` closure. There is no framework and no virtual DOM — `h()` from
`util.js` builds elements directly.
