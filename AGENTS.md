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
year 105 — 178 citizens, 175 animals, 70 stockpiles, 7 squads, 25 guests.
Useful as a sanity check: if a refresh reports numbers wildly off from those,
something regressed rather than the fort changing.

It is also mid-build on a **sharsid**, which is the Instruments view's
fixture: of its four pieces the green glass chest and the turkey leather
bellows exist and the keyboard and ceramic pipes do not, so the card must
read "2 of 4 made" and the assembly must say it is waiting on the keyboard
and the pipes. Two more figures worth checking against: `akmam` is the one
blocked recipe, on silk thread the fort has none of despite holding 6,350
threads, and 22 of the 39 instruments in the fort are kinds it cannot make.

Its containers are the Containers view's fixture, and two figures are the
ones to check. **Every one of its six jugs is full**, so the view must say
so at high severity — that is the whole case for the feature, since DF
reports nothing when a job stalls for want of a jug. And it has **four
minecart routes but three minecarts**: "Quantum 4" has stops set and no
cart, which makes it silently inert. Two more that catch specific bugs: the
fort holds 133 bags of which about 40 are free (if that reads as zero, the
`empty - nested` arithmetic is back), and 22-ish wheelbarrows are assigned
to piles (if that reads as zero, the `item_type.WHEELBARROW` bug is back).

Of those 25 guests only 21 are standing up: three are corpses DF still keeps
in `world.units.active`, and one is a caged cyclops. That four-way split is
itself a fixture — if the Visitors view starts grading dead ettins again, the
presence filter broke.

It also has, at time of writing, a live agent in the tavern: unit 1472,
presenting as "Dakost Rakustes", really Iddim Tirekindling of the Kindled
Wisps, running a plot to steal artifact 400. That is the fixture the visitor
rules were written against. Two things to check against it: with spoilers on
the view names them outright, and with spoilers off it must *still* raise
"claims a trade they have no skill in" and must *not* leak the alias, the
plots, or the outcast band.

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
- **A z coordinate is not an elevation.** DF's own UI reads out an elevation
  against sea level: the pile at `z 175` shows as "Elevation 46". The offset
  is `world.map.region_z - 100`, the same figure DFHack's `aquifer` plugin
  uses, and it ships as `meta.elev_offset`. Nothing else in the game surfaces
  the raw index, so the web UI shows the elevation everywhere and only falls
  back to `z175` for a snapshot taken before the offset was dumped.
- **Lua 5.4 dropped `%z` from patterns.** Use `%c` for control characters.
- `os.time`, `io.open`, and `dofile` are all available in DFHack's Lua sandbox.
- **A nil value drops the key entirely** from the emitted JSON, because Lua
  tables cannot hold nils. The web UI must tolerate absent keys, not just null
  ones — hence `asList()` and `?.` on the JS side.

### Goods-flow gotchas

The flow dumper cost its own round of debugging. These are the traps.

- **A stockpile's bounding box is not its area.** Piles are painted, not
  rectangular: 11 of Shieldclosed's 61 are non-rectangular, and "Booze" has a
  72-tile box over 25 real tiles. `area` is now the true count, walked with
  `dfhack.buildings.containsTile`, and `box_area` keeps the old number. Fill
  percentages computed off the box are wrong by a factor of three.
- **`storage.max_bins` / `max_barrels` are DF's capacity ceiling, not a
  request.** They come out at roughly one slot per tile — a 250-tile stone
  pile reports "250 bins" and means nothing by it. Reading the shortfall as
  player intent flags almost every pile in a healthy fort; it is only
  meaningful as context on a pile that has run out of floor.
- **`world.stockpile.num_jobs[]` / `num_haulers[]` are DF's own hauling
  counters**, the pair its Labors screen shows, indexed by `hauler_type`.
  Free, live, and the most direct "what isn't moving" signal in the game.
- **`df.hauler_type`'s names are wrong at indices 3 and 4.** df-structures
  marks it "not an actual enum" and its `name` attributes read Item/Bin where
  the `original-name` sequence says Burial/Item. The original names match DF's
  hauling labors and a live fort agrees — lane 4 carries the bulk of the
  queue, which is Item Hauling. `HAULER_LABELS` in the dumper corrects them;
  `raw_key` ships the uncorrected name so a future fix upstream is visible.
- **DFHack has no "would this pile accept this item" predicate.** The answer
  lives in the stockpile settings screen — per subtype, per material, per
  quality — and reproducing it is what the `stockpiles` plugin spends most of
  its C++ on. Every flow rule therefore reasons from where goods *already*
  sit, and the wording has to match: "no pile **holds** stones", never "no
  pile **accepts** stones". An empty pile configured for exactly the missing
  thing is indistinguishable from no pile at all, so `diagnose` says so.
- **`item.pos` is only valid while the item is on the ground** — it stores
  the last such position. That is fine after filtering on `flags.on_ground`,
  and it avoids a `getPosition()` call per item across the whole world list.
  17k items scan in 38 ms; contents inside a barrel are `in_inventory` and
  correctly excluded, so a bin counts once rather than by its contents.
- **`building.contained_items` with `use_mode == PERM` is the building
  itself** (the blocks it was built from). Everything else is cargo. Judge it
  by the mix, not the count: a Fishery holding 1104 body parts is a refuse
  problem, a Trade Depot holding 588 goods is a caravan — which is why the
  clog rule skips depots and reports the dominant item type.

### Equipment gotchas

The squad-equipment analyser cost its own round of debugging, and the traps
are all about how DF models armour.

- **`armorlevel` is about layering, not protection.** A steel cap is
  `armorlevel 0`, the same as a headscarf, because both go under a hood.
  Filtering on `armorlevel >= 1` therefore reports a soldier in a steel cap
  as bare-headed. The working test is `armorlevel >= 1` **or** the material
  is a metal; metal at level 0 is real armour, just the open-faced kind.
- **`material.strength.fracture[SHEAR]` ranks armour metals exactly the way
  players do** — adamantine 5,000,000, divine metals 2,000,000, steel
  720,000, iron 310,000, bronze and bismuth bronze 241,000, copper 220,000.
  So the ladder is *derived*, not typed into JavaScript, and mods and divine
  metals sort themselves. Pig iron lands at 200,000, below copper, and is
  not flagged `ITEMS_ARMOR` — which is why nobody makes armour from it.
- **That number is not comparable across material classes.** For thread it
  is a tension figure: giant cave spider silk reads 1,200,000, above steel.
  Cow bone is 130,000 and cow leather 25,000, which *do* sit below copper as
  expected, but silk breaks the ordering completely. Rank by material class
  first (`MAT_CLASS_RANK` in `armory.js`), and only use the raw figure to
  separate metals from each other.
- **`ITEMS_ARMOR` is an inorganic flag.** It is `false` for leather and bone,
  which can obviously be made into armour. Only read it for metals.
- **Bolts are not in `unit.inventory`.** They are inside the quiver, so a
  scan of the inventory alone reports every archer as out of ammo. Walk
  `dfhack.items.getContainedItems(quiver)`.
- **The uniform lives at `squad.positions[i].equipment.uniform`**, a static
  array indexed by `uniform_category`, not at `squad_position.uniform`.
- **`material_class` is not coarse — it is the standard.** It is DF's
  `entity_material_category`, and the value the uniform screen writes for
  "metal armour" is `Armor`, whose original name is `ARMOR_METAL`.
  `Leather`, `Cloth` and `Silk` mean exactly what they say, and only `None`
  is "any material". Grading every soldier against a hardcoded metal kit
  therefore invents demands the player never made: a uniform of a mail
  shirt with leather trousers, gloves and boots — a normal build — reported
  three fabricated gaps per dwarf and filled the forge order with gauntlets
  and greaves nobody asked for. `targetKit()` reads the uniform; `ROLES` is
  only the fallback for a squad that has none.
- **`item_subtype` on a spec indexes the raws**, per item type
  (`itemdefs.armor`, `.helms`, `.gloves`, `.shoes`, `.pants`, `.shields`,
  `.weapons`), and `-1` means "any piece of this kind" rather than an
  error. The def also carries `armorlevel`, which is how the two body specs
  in a layered uniform tell the mail shirt from the leather over it.
- **`squad_uniform_spec.assigned` is what DF has earmarked**, which runs
  well ahead of what the soldier has picked up: DF assigns a piece the
  moment it exists and the dwarf collects it when they go on duty. So an
  off-duty squad reads as bare while a full set of iron waits in a pile,
  and the analyser that only looks at `unit.inventory` calls that "9 of 9
  wearing no metal armour" and orders nine more mail shirts. The dumper
  ships the earmarked items themselves, with `carried` saying whether the
  soldier has them, which is what lets "nothing exists" be told apart from
  "exists, not collected".
- **An off-duty month is the usual reason kit is uncollected.** It is
  visible: `squad.schedule[cur_routine_idx].months[m].orders` empty means
  no orders that month, and `meta.month` is 1-based against a 0-based
  `months[]`.
- **A crossbow is not a metal requirement.** DF's wooden and bone crossbows
  shoot exactly as well; material only matters when one is swung as a club.
  The `anyMaterial` flag on that slot spec is what keeps it out of the
  shopping list.

### Visitor gotchas

The visitors dumper is the one that reaches furthest into DF's world data,
and almost none of it is where you would first look.

- **`world.units.active` means "on the map", not "alive".** 349 of
  Shieldclosed's 765 entries are corpses. `dfhack.units.isActive` is
  `!flags1.inactive` and `isKilled` is `flags2.killed`; a dead visitor
  keeps every other flag it had, so a view that does not check will
  cheerfully grade three dead ettins as tavern guests. There is no
  `flags1.dead` — that bit is called `inactive`.
- **A caged beast keeps its visitor flags.** Shieldclosed's cyclops is
  `flags1.caged` and still reads as an uninvited visitor. `chained` and
  `tame` are the neighbouring cases.
- **A visitor is `flags2.visitor` or `flags2.visitor_uninvited`,** which is
  `dfhack.units.isVisitor`. `isVisiting` is a wider net that also catches
  merchants and diplomats, and those never petition. `visitor_uninvited`
  is not a synonym for "rude": it is how a cyclops in your tavern is
  flagged.
- **`dfhack.units.isInvader` is three flags OR'd together and only one of
  them is an attack.** It is `marauder || invader_origin ||
  active_invader`, and `invader_origin` means "arrived with an invasion"
  — it stays set on a goblin for good, long after the siege that brought
  them. Reporting it as "is flagged as an invader" reads as a live threat
  and is simply wrong; only `active_invader` means attacking now. The
  three ship separately for that reason.
- **Some visitors have no soul.** A merchant's wagon comes through the
  same list. Test for `unit.status.current_soul` before reading skills.
- **The name DF shows a player is not `unit.name`.** With a cover identity
  in play, `getVisibleName` returns the alias and `unit.name` the real
  figure — which is exactly the pair that makes an agent detectable.
  DFHack issue #1279 is about this. Both ship, as `name` and `real_name`.
- **Person names and entity names render differently.** DF shows people in
  their own language ("Dakost Rakustes") and entities and artifacts in
  translation ("The Kindled Wisps"). So person names go through
  `name_of(x, false)` and everything else through `name_of(x)`. Mixing
  the two makes a cover story unreadable, because the alias and the real
  name come out in different languages.
- **The cover identity lives on the historical figure, not the unit.**
  `hf.info.reputation.cur_identity`, reachable as
  `dfhack.units.getIdentity(unit)`. `identity_type` has six values and
  only four of them are a false face: `HidingCurse` is a vampire hiding
  *what* they are, which is a different finding.
- **`identity.id_tag` is a union discriminator.** For `FalseIdentity` the
  second field is a `nemesis_id`, not a `histfig_id`. Reading it as a
  histfig id gives you a plausible, wrong person. The dumper does not
  need it — the unit's own histfig is already the real figure, and the
  identity is the mask.
- **`intrigue_plotst.parameter` means three different things**, keyed by
  the plot type: artifact id for `Acquire_Artifact`, entity id for
  `Counterintelligence` and `Infiltrate_Society`, and an *actor index*
  into the same perspective's `intrigue` vector for the plots numbered
  5–11. `plot_target_kind` in the dumper is that table; decode with the
  wrong one and a plot to steal artifact 400 reads as a plot against
  entity 400.
- **A figure's plots are their own perspective**, at
  `hf.info.relationships.intrigues`. That vector is what they are doing,
  not what anyone in the fort suspects — which is why the finding can
  state it as fact.
- **`agreement_details.type` is a plain field, not `getType()`**, unlike
  most of DF's tagged unions. `plotinfo.petitions` holds the ids of
  agreements the player has not answered, and `flags.petition_not_accepted`
  is the same fact on the agreement itself; the dumper checks both.
- **Abstract buildings have no global `find`.** Temples, libraries and
  taverns are numbered within their site, so `occupation.location_id` is
  resolved against `world_site.buildings`, not `df.abstract_building`.
- **`reputation_type` and friends carry no captions.** Unlike `job_skill`
  and `item_quality`, none of `identity_type`, `intrigue_plot_type`,
  `reputation_type`, `plot_role_type` or `value_type` has an `attrs`
  table, so there is nothing to ship in `snapshot.enums`. The keys go out
  raw and `words()` in `visitors.js` recovers the prose — DF writes them
  in three different shapes (SCREAMING_SNAKE, Snake_Case, CamelCase) and
  that helper handles all three.
- **`world.artifacts.all` in fort mode is not the world's artifacts.**
  Every entry in Shieldclosed's had its item loaded, so "is this item on
  our map" is not a usable test for "is this artifact ours". Compare
  `artifact_record.site` with `plotinfo.site_id` instead.
- **`unit.curse` does not exist** by that name any more. Use the DFHack
  predicates — `isHidingCurse`, `isUndead(unit, true)`, `isNightCreature`,
  `isBloodsucker`, `isOpposedToLife`, `isCrazed` — which are the checks
  the game itself makes.

### Instrument gotchas

The instrument dumper is the one that got *easier* the further in it went,
because DF turns out to describe instrument-making to itself completely.
Finding that out is the whole trick.

- **Worldgen writes a real reaction per piece and per assembly.** They are
  in `world.raws.reactions.reactions` with codes like
  `MAKE_ENT300 INK1_KEYBOARD` ("make sharsid keyboard") and
  `MAKE_ENT300 INK1` ("assemble sharsid"), categorised `INSTRUMENT_PIECE`
  and `INSTRUMENT`. Each carries its building, its `job_skill`, its
  reagents and a `FUEL` flag. **Do not hardcode a material→workshop
  table** — an earlier pass nearly did, off the wiki, and it would have
  been wrong: DF sends a wooden `gökuz` yoke to the Craftsdwarf's
  Workshop under Wood Crafting and a wooden `akmam` body to the
  Carpenter's Workshop under Carpentry, and only the reaction knows which.
- **`entity.resources.reaction_idx` is the fort's permitted list.** For
  Shieldclosed that is exactly 40 entries — 14 `INSTRUMENT`, 26
  `INSTRUMENT_PIECE` — and it is civ-scoped, so another civilisation's
  `MAKE_ENT270 …` reactions are correctly absent. Filtering the global
  677-reaction list by hand is not needed and would be wrong.
- **`reaction.building` is a vector of alternatives, not one building**,
  and `building.subtype` is read against a different enum per class —
  `furnace_type` for Furnace, `workshop_type` for Workshop, the same trap
  `dump_workshops` hits. A glass piece lists both Glass Furnace and Magma
  Glass Furnace; either satisfies the step, so they must be held together
  or one recipe reads as two missing workshops.
- **A reagent's quantity is a dimension, not a count.** A whole metal bar
  is 150, a thread 15000, a cloth 10000, a sand powder 150 — so
  `[REAGENT:metal bars:300]` wants *two bars*. Nothing in the raws states
  the full-unit figure; the dumper reads it off the largest dimension any
  item of that type carries in the fort and only falls back to
  `DIMENSION_UNIT` for a type the fort holds none of.
- **`reagent:matchesRoot(item, reaction_index)` is DF's own item match,
  and it is callable from Lua.** Two arguments, not three. It is the
  difference between a right answer and a plausible one: "clay" is a
  `BOULDER` with a fired-material product and only 93 of Shieldclosed's
  730 boulders qualify, and of 6,350 `THREAD` items *none* are the silk
  the `akmam` strings want. Counting by item type would call that fort
  well-stocked.
- **`reagent:getDescription(str, reaction_index)` gives DF's own phrasing**
  — "Clay boulders", "Sand powder", "Unrotten shell body part" — which
  beats anything assembled from the item type and the reagent token. It
  writes into a `df.new('string')` you own, not into game state.
- **A reagent can name a material without an item type.** "shell" and
  "bone" are `item_type` -1 and resolve to `CORPSEPIECE` items; there is
  no single vector to scan, so those fall back to `items.other.IN_PLAY`.
  That is a full item walk, hence the stock cache keyed on the reagent's
  own terms — a civilisation's instruments ask for the same sand bag six
  times over. With the cache the whole section costs ~0.1s.
- **A corpse piece's `[4]` is not a stack.** `stack_size` is 1; the
  bracketed figure DFHack prints is the piece's material amount. One
  matching item satisfies a quantity-1 reagent, so counting items is
  right and summing stack sizes would be a fix for a bug that is not there.
- **`PRESERVE_REAGENT` is the sand bag**: needed to run the job, handed
  back after. Counting it as consumed would put a bag on every shopping
  list forever.
- **A one-piece instrument has no assembly.** `damol` and friends have
  `pieces` empty, and their `INSTRUMENT` reaction *is* the whole job
  rather than an assembly step. Owning one is not a reason to call that
  job finished — a fort can always make another.
- **`itemdef_instrumentst.flags` is a flagarray: index it by key.**
  `ipairs` over it yields nothing, silently, which reads as "this
  instrument has no material" rather than as an error.
- **`dominant_instrument_piece` names the piece whose material decides the
  finished instrument's**, and so the skill the assembly is graded on.
  Shieldclosed's sharsid assembles under Glassmaking because its chest is
  glass — a live fort confirms it.
- **`world.items.other.INSTRUMENT` is not your civilisation's.** A tavern
  fills up with traded instruments: 22 of Shieldclosed's 39 are kinds it
  has no recipe for. Compare the item's subtype against
  `resources.instrument_type` rather than assuming the fort made it.
- **Instruments are per world *and* per civilisation**, so this fort is a
  sample of one. Checked against all 245 civilisations in Shieldclosed's
  world: 25 have instruments (every dwarf, human, goblin, elf and kobold
  civ; the 220 without are all animal-people), holding 1 to 14 instruments
  each and 518 reactions between them. Across all of those, every
  instrument and every piece has its own reaction on its own civ's
  permitted list — so the `no-recipe` verdict in `instruments.js` is a
  guard against a case worldgen does not actually produce, not a normal
  state. The categories are only ever `INSTRUMENT` and `INSTRUMENT_PIECE`,
  no reaction uses a custom building or a building token, and the reagent
  item types are just `BOULDER`, `WOOD`, `BAR`, `THREAD`, `CLOTH`,
  `POWDER_MISC`, `SKIN_TANNED`, `TOOL` and typeless. Every dimensioned one
  of those is in `DIMENSION_UNIT`.
- **The same material goes to different workshops in different civs.**
  Shieldclosed's stone frame is Stonecrafting at the Craftsdwarf's
  Workshop; civ 270 — *also dwarves, same world* — makes a stone
  instrument body with Masonry at the Mason's Workshop. This is the
  single best argument against ever hardcoding a material→workshop table:
  it is not even stable within a race.

### Container gotchas

The container census is mostly counting, and every trap in it is a place
where the obvious field means something other than what it says.

- **`item.flags.container` does not mean "this one has something in it".**
  It means "this is a container", and it is `true` on an empty barrel. The
  only honest emptiness test is `dfhack.items.getContainedItems(item)` and
  asking whether the result is empty. It is cheap — the whole fort's ~1,200
  containers scan in well under a second.
- **There is no `item_type.WHEELBARROW`.** A wheelbarrow is a `TOOL`, and
  `stockpile.storage.container_type` therefore reads `TOOL` for it. The old
  `stockpile_containers` compared against `have.WHEELBARROW`, which does not
  exist, so `wheelbarrows_held` was `0` in every snapshot ever taken. The
  kind has to come from the item's tool definition, which means resolving
  each id in `container_item_id` rather than reading the types vector.
- **`itemdef_toolst.tool_use` is DF's own statement of what a tool is for**
  — `LIQUID_CONTAINER` for a jug, `FOOD_STORAGE` for a pot, `TRACK_CART`
  for a minecart, `HEAVY_OBJECT_HAULING` for a wheelbarrow. Reading it is
  what keeps a material→kind table out of this feature, and it is also the
  discriminator for "is this TOOL a container at all": an instrument piece
  has no `tool_use`, which is how a sharsid bellows stays out of the barrel
  census. `item:hasToolUse(use)` is the same fact as a vmethod.
- **Whole item types have no such field.** `item_type` carries no role flag
  and there is no `isContainer` predicate on `df.item`, so `CONTAINER_TYPES`
  in the dumper is a list, the same compromise `EQUIPMENT_TYPES` makes.
- **`BAG` is its own item type, not a soft `BOX`.** A `BOX` is a chest or a
  coffer and is always rigid; scanning `items.other.BOX` for cloth to find
  the bags returns nothing, and the fort's 133 bags are in
  `items.other.BAG`.
- **`stockpile.storage.container_item_id` is the exact container→pile map.**
  No position lookup is needed for an assigned bin, and it is the only place
  a wheelbarrow's assignment is visible at all. Its sibling `container_type`
  is parallel but, per the wheelbarrow trap above, too coarse to key on.
- **`use_mode == PERM` means "committed to this building", and it covers
  two cases that look nothing alike.** A coffer built as bedroom furniture
  is PERM in its own building, and so is the bucket built into a well or an
  ashery. DF draws no distinction; only the *holder building's type* tells
  the machine from the item installed as itself. Reporting both gives the
  player the news that their coffer is a coffer, which is why the dumper
  ships the holder's `kind` and `MACHINE_BUILDINGS` in `containers.js`
  filters on it.
- **`flags.in_inventory` covers a dwarf carrying a bag *and* a bag sitting
  inside a barrel.** `dfhack.items.getHolderUnit` is what separates them;
  without it, 46 nested bags read as 46 dwarves walking around with luggage.
- **Hauling routes live at `plotinfo.hauling.routes`, not `world.hauling`.**
  A route's carts are `route.vehicle_ids` → `df.vehicle.find(id).item_id`,
  and a route with an empty `vehicle_ids` is configured, listed and
  completely inert. DF reports nothing about it and the only way to notice
  in game is to open every route in turn.
- **`material_grade` had no stone branch**, because it was written to rank
  armour and nobody wears stone. Everything stone therefore came out as
  `other`, which is fatal for this view — the wood/stone split is the whole
  point of its material column. `IS_STONE` now splits out, and `stone` was
  added to `MAT_CLASS_RANK` at the same rank `other` had, so the equipment
  view is unaffected.

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
`label`), the link adjacency (`linksOf`), the skill categorisation, the
profession-to-category map DF hides in `job_skill.profession`
(`professionCategory`), and the fort's own ceiling per category
(`fortBest`). Views should read from `db`, not re-derive. That includes
elevations: `elevation(z)`
gives the number DF prints, `elevLabel` the standalone form ("elev 46") for
prose and coordinates, `elevShort` the bare figure for axes, and `elevCaption`
the word that axis needs. `formatPos`/`formatBox` take a `db` for the same
reason, and the pure modules take a label function (`elevOf`) rather than the
offset, so they stay ignorant of the snapshot.

Three modules serve the stockpile and flow views only:

- `web/js/geometry.js` — the hauling cost model, pure functions over the
  snapshot's boxes. Distances are **edge to edge** (`boxGap`), because a pile
  is an area; the in-plane term is Chebyshev (`walk`), because DF's diagonals
  are free. `haulCost` adds `zPenalty × dz` on top. Also holds the pod
  clustering and the network summary. Nothing here touches the DOM — keep it
  that way, it is the only part of the UI that can be checked without a
  browser.
- `web/js/strata.js` — the cross-section renderer, same shape as `graph.js`:
  `renderStrata(nodes, measured, opts)` returns an SVG element. The view
  decorates nodes with `short`/`tooltip`/`linked`/`alert` before handing them
  over, and passes loose heaps in through `opts.heaps`.
- `web/js/flow.js` — the diagnostic rules. `diagnose(input)` returns findings
  sorted worst-first; `summariseFlow` gives the headline numbers. Pure, like
  `geometry.js`, and worth keeping that way: the rules carry all the judgment
  in this feature and they are the part you most want to check without a
  browser. Both the Flow view and the strata overlay call it, so a rule added
  here shows up in the list *and* on the diagram.

The one thing `flow.js` must never claim is that a pile *accepts* something —
see the goods-flow gotchas above for why it can only speak about what piles
*hold*. Thresholds (`HEAP_MIN`, `FULL_RATIO`, `CLOG_MIN`, `STRAND_MIN`) are
exported constants; tune those rather than burying numbers in the rules.

Ask `isFull(pile)`, never `fillRatio(pile) >= FULL_RATIO`. A **quantum
stockpile** — a minecart dump — is full from its first item by design, and
nothing in the snapshot marks one: it is an ordinary pile with a route
pointed at it, so its name (`isQuantum` matches "quantum", either the
building name or `custom_name`) is the only signal there is. Every full rule
would otherwise fire on it forever, which is the one alert the player
definitely does not want. This also keeps `holders-full` honest — a quantum
pile holding the loose type means hauling still has somewhere to go.

### Reading the strata diagram

One row per occupied z level, highest first, labelled with the elevation DF
itself shows rather than the raw index (the `elev` caption on the gutter says
which is which). Horizontal position is real map X on one scale shared by
every row, so a pod drawn above another pod really is above it. Within a row, nodes cluster into *pods* by **complete** linkage —
every member within the radius of every other. Single linkage was tried first
and chains an entire level into one blob the moment the piles form a corridor,
which is the normal case in a fort.

A pod can only be anchored at its centroid, so a long pile gets drawn away
from a neighbour it actually touches. That is what the footprint strip under
each row is for: every node's true map-X extent, including the overlaps the
pod layout cannot show.

Two things do *not* mean what they look like. The vertical nudge inside a row
is map Y at a compressed scale — readable as north/south, not as elevation.
And with "compress empty levels" on, the void bands are log-squeezed; turn the
checkbox off for the honest vertical scale, where the gap between two rows is
the climb between them drawn to the same scale as the horizontal ruler.

A crowded level can want more width than the diagram has. `fitBand` reflows
the widest pod into fewer columns until the row fits, so chips never run off
the right edge — if you add to the chip contents, keep that path working.

One module serves the equipment view only:

- `web/js/armory.js` — the target kits, the material ranking, the per-slot
  verdicts, and the forge order. Pure, like `geometry.js` and `flow.js`, and
  worth keeping that way: `diagnose(input)` returns findings worst-first and
  `shoppingList(roster(input), input)` folds every gap in the fort into one
  line per piece, both checkable with `node` against a snapshot.

  **The standard is the player's uniform, not this module's idea of a kit.**
  `targetKit(position, role)` turns each `squad_uniform_spec` into a line to
  grade — the piece it names, how many, and what material class it insists
  on — and `matchesSpec` decides which worn item answers which line, strict
  specs first so a mail-shirt line takes the mail shirt and the leather-armour
  line beside it takes the leather. `ROLES`/`ARMOUR_SLOTS` are the fallback
  for a squad with no uniform at all, nothing more. Thresholds
  (`GREEN_ARMOR_SKILL`, `AMMO_TARGET`, `BARE_SQUAD_MIN`) are exported
  constants — tune those rather than burying numbers in the rules.

  The verdicts are ordered, and the order carries the judgment: `missing`
  (nothing worn, nothing earmarked — the only kind that reaches the forge),
  `wrong`, `soft`, `partial`, `unclaimed`, `light`, `downgrade`, `ok`.
  Everything but `unclaimed` is in `FORGE_VERDICTS`.

  Three things it must never claim. That DF *will* issue a piece: the gap
  means "this soldier is not wearing it", not "DF refuses to give it to
  them". That a bar can become a specific piece: bar stock says the metal
  exists, not that the smithy, the fuel, and the work orders do. And that
  an earmarked piece is a missing one — see the equipment gotchas above;
  that mistake is what put nine mail shirts on the forge order for a squad
  whose nine mail shirts were already made.

  Rules that fire per soldier need a roll-up when they are really a fact
  about the squad, and the roll-ups suppress different amounts. `rolled`
  takes the whole soldier (`squad-unarmoured`), `rolledWaiting` takes only
  their uncollected kit (`kit-waiting`), `rolledGaps` takes one slot verdict
  each (`squad-gap`, keyed by label and verdict), and `rolledAmmo` takes the
  bolt count. Folding this way turned Shieldclosed's 51 findings into 32, and
  the ones that remain are the ones with work in them: eight archers with no
  shield reads as one order, not eight.

One module serves the visitors view only:

- `web/js/visitors.js` — the grading and the concerns. Pure, like the
  other three: `roster(input)` returns every guest judged, `diagnose(input)`
  the concerns worst-first, both checkable with `node` against a snapshot.

  **A guest is graded on the trade they claim, not on their best skill.**
  `roleOf` takes the fort's own occupation record first, then the unit's
  profession, and only falls back to "whatever they are best at" for a
  traveller with no stated trade — and marks that case `stated: false` so
  the view can say the grade is ours rather than theirs. The category a
  profession is judged on is *derived*: DF hangs a profession off most
  skills (`job_skill.profession`), which `Db#professionCategory` reads out
  of the snapshot, so Maceman → Combat and Poet → Arts are never typed
  anywhere. `PROFESSION_CATEGORY` names only the professions DF leaves
  unattached, which is exactly the visiting set — scholar, mercenary,
  monster slayer — and `OCCUPATION_CATEGORY` does the same for
  `occupation_type`, which has no skills in the raws at all. Thresholds
  (`WEAK_RATING`, `GOOD_RATING`, `STRONG_RATING`, `VALUE_EXTREME`,
  `ROLLUP_MIN`) are exported constants; so are the judgement calls
  (`ALARMING_REPUTATIONS`, `COVER_IDENTITIES`, `CRIMINAL_PROFESSIONS`).
  Tune those rather than burying numbers in the rules.

  `Db#fortBest` is the other half of "worth taking in": the best rating
  any citizen has per category. A guest who beats it is the only kind
  whose arrival raises the fort's ceiling rather than its throughput, and
  that is what the `beatsFort` chip marks.

  **`presence(visitor)` is the first gate, and it is not cosmetic.**
  `roster` only returns guests that are actually standing in the tavern,
  because DF's "active" unit list is half corpses and a caged beast keeps
  the flags it arrived with. `summarise().absent` reports what was
  dropped and the view prints it — a filter this aggressive has to say so
  out loud, or a reader who counts bodies and gets a different number has
  no way to tell which way the difference goes.

  **Spoilers are a first-class concept here, not a display option.** Every
  concern carries a `spoiler` boolean and `assess` drops the spoiler ones
  before anything downstream sees them, so the risk column, the counts,
  the findings and the dossier are all consistently blind rather than
  blind in one place and knowing in another. The line is DF's own unit
  screen: race, profession, skills, age, values, entity membership and
  the uninvited flag are on it; a cover identity, an intrigue plot, a
  concealed curse, a journey and a foreign government's criminal file are
  not.

  Two traps in that gate, both of which leaked before they were closed.
  A *suppressed count* is still a spoiler — "3 hidden concerns" tells the
  player exactly what they asked not to be told — so hidden concerns
  vanish whole and the "false faces" tile is absent rather than zeroed.
  And `entity`, `groups` and `reputations` all hang off the **real**
  figure while DF shows the player the *identity's* civilisation, so for
  a masked guest every tie is hidden knowledge even though the same tie
  on an honest guest is right there on their screen. Hence `masked ||`
  on those spoiler flags, and hence the dossier dropping a masked guest's
  ties without a word about having dropped them.

  What survives with spoilers off is the point: the `mismatch` rule still
  catches Shieldclosed's agent, because "presents as a poet and has no
  arts skill at all" is exactly the manual inspection the wiki has
  recommended for a decade. The spy stays *findable*; only the
  confirmation is gated.

  Three things it must never claim. That an accepted petitioner *will*
  act on a plot: the plot is a fact, the acting on it is not. That a
  guest with an empty record is safe — an empty record is an empty
  record, which is why the risk column says `clear` and not `safe`. And
  that a bad performer is an agent: the skill mismatch is the wiki's
  oldest tell and it is still only medium severity on its own, because
  plenty of honest guests are simply bad at their jobs. It is the *pair*
  — no skill, plus a cover identity — that convicts, and the view puts
  them next to each other rather than folding them into one verdict.

  Rules that fire per guest stay per guest: unlike the equipment view,
  every one of these is a separate accept-or-reject decision, so folding
  them would destroy the thing the list is for. Only the low-severity
  personality notes roll up, once `ROLLUP_MIN` guests share one — eight
  guests who dislike the law is one note about the tavern.

One module serves the instruments view only:

- `web/js/instruments.js` — the recipe grading. Pure, like the other four:
  `roster(input)` returns every buildable instrument with each step judged
  and `summarise(input)` the headline figures, both checkable with `node`
  against a snapshot.

  **The recipe is DF's, not this module's.** The dumper ships the
  generated reactions whole — building, skill, reagents, fuel — so the
  only thing decided here is the fort-facing half: does the fort have the
  building, does it have the materials, and which step is it stuck on.
  There is deliberately **no material→workshop table** anywhere in this
  feature; see the instrument gotchas above for the two wooden pieces that
  go to two different workshops and would have broken one.

  `VERDICTS` is ordered and the order carries the judgement: `no-workshop`
  (a harder stop, since a player can buy clay and cannot buy a kiln),
  `no-material`, `waiting`, `ready`, `done`. `waiting` is the assembly's
  own state and is not a fault — it means the pieces are not all made yet,
  which is the normal condition of a half-built instrument.

  Three things it must never claim. That a job cannot run for want of
  skill: DF gates work on the labour, not the rating, so `unskilled` is a
  warning about quality and never a blocker — which is why it sits beside
  the verdict instead of inside it. That owning an instrument finishes its
  recipe: a one-piece instrument is gradeable on materials alone and a
  fort can always make another, so `in_stock` colours the card's status
  and nothing more. And that a piece in the fort is one the fort made —
  nothing in the snapshot marks a tool as belonging to a half-built
  instrument, which is exactly why the view is useful.

One module serves the containers view only:

- `web/js/containers.js` — the census, the roles, and the concerns. Pure,
  like the other five: `census(input)` groups every kind into its display
  section, `summarise(input)` gives the headline figures and
  `diagnose(input)` the concerns worst-first, all three checkable with
  `node` against a snapshot.

  **`free` is the column the view exists for, and it is not `empty`.** A
  coffer installed in a bedroom is empty and unavailable; a bag inside a
  barrel is empty and already doing its job; a forbidden one cannot be
  hauled at all. The dumper decides it per item — empty, lying in a pile or
  on the floor, not forbidden, not already claimed by a job — because it
  *cannot be recovered from the totals afterwards*: `empty` and `nested`
  count different sets of containers, so `empty - nested` goes negative and
  reported a fort holding forty spare bags as having none. Do not
  reintroduce that arithmetic.

  Hauling gear is the one exception to "assigned still counts as free".
  An empty bin assigned to a pile is precisely the capacity that pile is
  about to use, but an empty minecart parked on its route is working, so
  `free()` subtracts `deployed()` for gear only. The two halves of
  "deployed" live in different places — a wheelbarrow is claimed by a
  stockpile (`assigned`, off `container_item_id`) and a minecart by a
  hauling route — so a cart on a route reads as `assigned: 0` and would
  otherwise look spare.

  `ROLE_BY_USE` and `ROLE_BY_TYPE` are the only hardcoded taxonomy here,
  and only the second is really hardcoded: tool roles are derived from
  `tool_use`, so a modded tool sorts itself. `pileSlot()` mirrors the
  dumper's bin/barrel/wheelbarrow split and the two have to agree — it is
  what lets the `wood-bound` rule offer a stone *pot* in place of a wooden
  barrel and not a stone coffer, which stores no drink. Thresholds
  (`SCARCE_RATIO`, `SCARCE_FLOOR`, `IDLE_GEAR_MIN`, `MONOCULTURE_SHARE`)
  are exported constants; tune those rather than burying numbers in rules.

  Three things it must never claim. That a container will be *used* for
  anything: DF assigns bins and barrels by the pile's own settings and
  nothing in the snapshot says which job is about to want a bag, so every
  rule reasons from state and never from intent. That a full pile wants
  more containers *because DF has room for them* — `max_bins`/`max_barrels`
  are the one-slot-per-tile ceiling described in the goods-flow gotchas, so
  `pile-cramped` only fires on a full pile holding **no** containers at
  all, where the recommendation needs no such number. And that a wooden
  container is a mistake: `wood-bound` is informational, fires only for
  kinds a stockpile has actually claimed, and names a stone substitute only
  when the fort already makes one in the same pile slot.

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
| `meta` | `fort_name`, `civ_name`, `group_name`, `site_id`, `group_id`, `year`, `year_tick`, `month`, `month_name`, `day`, `season`, `generated_at` (unix), `df_version`, `dfhack_version`, `elev_offset` |
| `enums` | `job_skill[]` (`key`, `caption`, `caption_noun`, `labor`, `profession`, `class`), `unit_labor[]` (`key`, `caption`, `category`), `skill_rating[]` (`caption`, `xp_threshold`), `item_type[]` (`key`, `caption`), `item_quality[]` (`id`, `key`, `caption`), `workshop_type[]` / `furnace_type[]` (`id`, `key`, `caption`) |
| `units[]` | `id`, `name`, `short_name`, `nickname`, `profession`, `race`, `sex`, `age`, `is_child`/`is_baby`/`is_visitor`, `stress`, `stress_category` (0 worst … 6 best), `pos`, `job`, `idle`, `seeking_job`, `on_break`, `labors[]`, `work_details[]`, `skills[]` (`key`, `rating`, `experience`, `rusty`), `nobles[]`, `squad_id`, `squad_position`, `wave` |
| `work_details[]` | `index`, `name`, `mode`, `icon`, `labors[]`, `assigned_units[]` |
| `stockpiles[]` | `id`, `number`, `name`, `custom_name`, bounding box + `z`, `area` (true painted tiles), `box_area`, `used_tiles`, `categories[]`, `flags[]`, `containers` (`{bins,barrels,wheelbarrows}_wanted`/`_held`), `incoming_jobs`, `item_count`, `items_by_type` |
| `workshops[]` | `id`, `kind` (Workshop/Furnace/FarmPlot/TradeDepot), `subtype`, `name`, box + `z`, `jobs[]`, `permitted_workers[]`, `held_items`, `held_top_type`, `held_top_count` |
| `links[]` | `{from, to}` building ids, normalised to material-flow direction and deduplicated |
| `zones[]` | `id`, `number`, `name`, `type` (`civzone_type`, e.g. `Pen`), `active`, box + `z`, `area`, `assigned_units[]` |
| `animals[]` | `id`, `name`, `race`, `sex`, `age`, `zone_id`, `tame`/`grazer`/`milkable`/`egg_layer`/`war`/`hunting`/`gelded`, `marked_for_slaughter`, `training_level` |
| `squads[]` | `id`, `name`, `alias`, `display_name`, `cur_routine_idx`, `positions[]` (`index`, `unit_id`, `name`, `uniform[]` → `category`/`slot`/`type`/`subtype`/`armor_level`/`material_class`/`material`/`assigned`/`assigned_items[]`, `assigned_items` (count), `equipment[]`, `ammo`), `rooms[]` (`name`, `modes[]`), `schedule[]` (routines → `months[]` → `orders[]`) |
| `armory` | `total`, `free`, `groups[]` (`type`, `subtype`, `slot`, `armor_level`, `material`, `mat_class`, `grade`, `armor_material`, `count`, `claimed`, `worn`, `best_quality`, `stockpiles[]`), `bars[]` (`material`, `grade`, `armor_material`, `count`) |
| `flow` | `loose` (`total`, `claimed`, `forbidden`, `rotten`, `marked_dump`, `by_type[]` → `type`, `count`, `claimed`, `forbidden`, `rotten`, `levels[]` → `z`, `count`, `x1`/`x2`/`y1`/`y2`), `hauling[]` (`index`, `key`, `raw_key`, `jobs`, `haulers`), `store_jobs` (`total`, `unclaimed`) |
| `visitors[]` | `id`, `hf_id`, `name` (the face), `real_name` (only when masked), `full_name`, `nickname`, `profession`, `profession_key`, `race`, `sex`, `age`, `status` (`visitor`/`resident`), `uninvited`, `pos`, `arrived_year`, `years_here`, `entity` (`id`/`name`/`type`/`ours`), `groups[]` (same, plus `link`), `occupation` (`type`, `location`), `petition` (`kind`, `year`, `pending`, `agreement_id`), `skills[]`, `values[]` (`key`, `strength`), `identity` (`type`, `name`, `race`, `profession`, `entity`), `intrigue` (`plots[]` → `type`/`on_hold`/`target`, `roles[]`, `master`), `reputations[]` (`entity`, `ours`, `exiled`, `unsolved_murders`, `types[]` → `key`/`level`), `artifact_quest` (`id`, `name`, `ours`), `journey`, `curse` (`hiding`/`undead`/`night_creature`/`bloodsucker`/`opposed_to_life`/`crazed`), `threat` (`danger`/`great_danger`/`invader`/`active_invader`/`invader_origin`/`marauder`), `state` (`dead`/`ghost`/`caged`/`chained`/`tame`) |

| `instruments` | `types[]` (`id`, `name`, `name_plural`, `description`, `value`, `size`, `skill` + `skill_caption` (the *music* skill), `placed_as_building`, `in_stock`, `pieces[]` → `token`/`name`/`name_plural`/`tool_index`/`dominant`/`reaction`, `reaction` (the assembly, or the whole job for a one-piece instrument)), `foreign[]` (`id`, `name`, `count`) |

| `containers` | `kinds[]` (`key`, `name`, `item_type`, `subtype`, `uses[]`, counts: `total`, `empty`, `free`, `holding`, `contents`, `in_job`, `forbidden`, `marked_dump`, `artifact`, `assigned`, and one location bucket each of `built`/`carried`/`nested`/`stored`/`loose`; plus `holds` (item_type → containers whose top item is that), `materials[]` (`material`, `mat_class`, `count`, `empty`), `piles[]` (`id`, `total`, `empty`), `buildings[]` (`id`, `name`, `kind`, `count`)), `routes[]` (`id`, `name`, `stops`, `carts[]` → `vehicle_id`/`item_id`/`missing`) |

A container `kind` is either a whole item type (`key` is the `item_type`
key, `uses` empty) or one tool definition (`key` is `TOOL:<def name>`,
`uses` its `tool_use` list — which is what the view's roles are derived
from). The location buckets are **exclusive and sum to `total`**;
`assigned` cuts across them and is the count a stockpile has claimed as a
container slot. `free` is decided per item by the dumper and is narrower
than `empty` — see the containers module notes above for why it cannot be
recomputed from the totals. `piles` and `buildings` are capped
(`CONTAINER_PILE_CAP`, `CONTAINER_BUILDING_CAP`), so they are a summary,
not a census; `materials` is not capped.

`containers` is absent from snapshots taken before the container dumper
landed, which is what `Db#hasContainers` guards.

A `reaction` anywhere in `instruments` is one of DF's generated recipes:
`code`, `name`, `category` (`INSTRUMENT` or `INSTRUMENT_PIECE`), `skill` +
`skill_caption`, `fuel`, `buildings[]` (`kind`, `subtype`, `name` — a list
of *alternatives*, either of which will do), `product` (`item_type`,
`item_subtype`, `count`) and `reagents[]`. A reagent carries `code`,
`description` (DF's own phrasing), `item_type`, `item_subtype` (set when it
asks for a specific tool, which is how an assembly slot is matched to its
piece), `quantity` (DF's raw figure, a dimension for bars and thread),
`unit_dimension`, `units` (whole ones to fetch), `stock` / `stock_units`
(what the fort holds, counted with DF's own item match), `preserve` and
`in_container`.

`instruments` is absent from snapshots taken before the instrument dumper
landed, which is what `Db#hasInstruments` guards. `types` is the fort
civilisation's permitted list, so it is what this fort can build, not what
the world contains; `foreign` is everything the fort *owns* whose kind is
not on that list. A `reaction` is absent when the permitted list somehow
has no recipe for a piece, so the view must tolerate its absence.

`/api/snapshot` adds `idle_history`: unit id → array of 0/1 observations.

A squad position's `equipment[]` is one entry per worn or carried item —
`slot`, `subtype`, `material`, `mat_class`, `grade`, `armor_level`,
`quality`, `wear`, `mode` — and `ammo` is the bolt count out of the quiver.
`armory` is absent from snapshots taken before the equipment dumper landed,
which is what `Db#hasArmory` guards.

`flow` is absent from snapshots taken before the flow dumper landed, which is
what `Db#hasFlow` guards. `loose.by_type` is sorted by count and each type's
`levels` are capped at `LOOSE_LEVEL_CAP`, so it is a summary, not a census.

`visitors` is absent from snapshots taken before the visitors dumper landed,
which is what `Db#hasVisitors` guards. It ships the dead and the caged along
with the living — `state` is how they are told apart, and `presence()` in
`visitors.js` is what filters them, so the dumper stays a dumb reader and the
judgement stays in one place. It covers guests and long-term residents, not
citizens — a resident who is granted citizenship leaves this
list and joins `units`. `identity`, `real_name`, `intrigue`, `artifact_quest`
and `occupation` are only present when there is something to say, so the view
must tolerate their absence rather than test them for null. `petition` names
the residency or citizenship agreement they are party to; `pending` is the
one waiting on the player's answer.

Squad *positions* are all 10 slots whether filled or not; a filled one has
`unit_id`. Squad *schedules* carry every routine — `cur_routine_idx` picks the
one actually in force, and a squad can look correctly configured while sitting
on an empty routine.

## Ideas not yet built

- Stockpile contents are item-type counts only (`STONE 40`); materials would
  make that view far more useful. The equipment dumper reads materials for
  gear specifically, and the container dumper now reads them for containers,
  so the machinery exists twice over.
- The Containers view says a kind is exhausted but not what that will stop.
  DF knows: a reaction's reagents name the container they want, and
  `dump_reaction` in the instrument dumper already reads reagents whole. A
  jug shortage that named the honey-collection job would be the finished
  version of the feature's best finding.
- Container demand is read from what piles hold, never from work orders.
  `world.manager_orders` is where a player's standing "make 10 barrels"
  lives, and comparing it against the free count would separate "you are
  short" from "you are short and have already noticed".
- Nothing tracks containers across refreshes. A fort whose free-barrel count
  is falling every season is in a different situation from one sitting at a
  steady low number, and `idle_history` is the precedent for storing it.
- The forge order counts pieces, not bars. A breastplate is not one bar, and
  DF's own work-order screen knows the real figures.
- The forge order says "to make" for leather lines as well as metal ones,
  and a leather line is a tanner's job, not a smith's. Splitting the panel
  by workshop would make it an order list a player could work straight
  through.
- A squad's ammunition is configured on its own screen, not in the uniform,
  so the bolt target is still `AMMO_TARGET` rather than what the player
  asked for. `squad.ammunition` is where the real figure lives.
- Pasture cards get very tall for a 71-animal pen — collapse or paginate.
- No way to jump from a dwarf to where they are on the map.
- A visitor's equipment is the other half of the wiki's agent tell — a bard
  in mail carrying a battle axe. `unit_equipment()` already reads a
  soldier's kit for the Equipment view, so pointing it at guests is mostly
  wiring.
- A performance troupe petitions as a group and is accepted as a group, but
  the view grades each member alone. The troupe is a `PerformanceTroupe`
  entity in `hf.entity_links`, so the grouping is there to be read.
- Nothing watches a visitor across refreshes. An agent's plots move; a
  before-and-after would say which ones are progressing, the way
  `idle_history` does for dwarves.
- The Instruments view stops at "you could build this". It does not check
  whether a *player* wants to: `unit.skills` already says how many dwarves
  play keyboard instruments, and a fort with none of those gains nothing
  from a sharsid. The music skill ships for exactly this and is currently
  only printed.
- The instrument reactions are read, but no other generated reaction is —
  and `INSTRUMENT`/`INSTRUMENT_PIECE` are only two of DF's categories. The
  same `dump_reaction` would light up every custom reaction the fort's
  civilisation permits, which is the general form of this feature.
- Nothing links an instrument to the tavern that would hold it, or to a
  `PLACED_AS_BUILDING` one already built. `zones[]` has the locations.
- A piece sitting in a pile is indistinguishable from one a dwarf is
  hauling somewhere else. The flow dumper's tile map could say which pile
  each piece is in, the way `armory.groups[].stockpiles` does for gear.
