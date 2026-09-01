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
| **Stockpiles** | Every pile with its accepted categories, contents, and links, in three modes. **Table** lists them with an average haul cost per pile. **Strata** draws the fort in cross-section — one row per z level, labelled with the same elevation DF's own z-axis shows, piles grouped into pods of mutually close neighbours, feed links coloured by hauling cost — and puts numbers on the empty space: the walk across each gap, the climb through each band of solid rock. **Graph** is the force-directed flow diagram, ignoring geometry entirely. |
| **Map** | The floor plan, one z level at a time, drawn where it actually is. Walls, floors, stairs, ramps, water and magma from the real tile map; stockpiles and workshops outlined by their *painted* tiles rather than their bounding boxes; feed links drawn between them, with the ones leaving the level counted at the building instead of drawn to nowhere. The level below can be ghosted underneath. Click anything for its footprint, contents and links. Undiscovered rock is left blank, because DF hides it from you too. |
| **Flow** | What is stuck and why: goods lying on the floor grouped by type and level, piles that have run out of room, workshops clogged with their own output, and DF's own hauling queue per class. Findings are ranked worst-first and click through to the pile on the cross-section. |
| **Containers** | How many bins, barrels, bags, buckets, pots, jugs, minecarts and wheelbarrows the fort has — and, the part the stocks screen leaves out, how many of them are *free*. One row per kind with what the full ones hold, what they are made of, and which piles the spare ones are sitting in, grouped into storage, hauling gear, animals, personal kit, furniture and records. Findings lead with the kinds you have run dry and the minecart routes with no cart assigned. |
| **Animals** | Livestock grouped by pasture, with tiles-per-grazer and a species summary per pen, or a by-species table across the whole fort. Unpastured animals and empty pastures are both called out, since those are what you're usually hunting for. |
| **Squads** | Roster with each soldier's combat skills and current job, barracks assignments and their uses, and the 12-month training schedule as a grid with minimum-soldier counts. |
| **Equipment** | Where the military's armour is thin, graded against each squad's own uniform. Findings worst-first, a forge order folding every gap in the fort into one line per piece against the metal actually in stock — with kit that is made and merely uncollected counted separately — and a roster with one cell per armour slot. |
| **Visitors** | Who is in the tavern asking to stay, what they are worth, and what they are hiding. Every guest and long-term resident graded on the trade they claim — so a novice poet reads as a novice poet — alongside the concerns DF records against them and never puts on the petition popup. The spoilery half (cover identities, intrigue plots, concealed curses) is behind a **Show spoilers** switch that is off by default. Click a guest for the full dossier. |
| **Instruments** | How to actually build one. Every instrument your civilisation knows, as a recipe card: each piece, the workshop that makes it, the exact ingredients with how many you have, whether the job burns fuel, and who in the fort is best at it — then the assembly step and what it is still waiting on. Half-built instruments lead, because a fort that already has two of the four pieces is the case DF makes hardest to see. |

## Idleness

A single snapshot only knows whether a dwarf happens to have no job at this
instant, which is close to a coin flip. Every refresh appends a per-dwarf idle
observation to `data/idle_history.json`, so after a handful of refreshes the
roster shows an idle *rate* ("32% of 12 refreshes") instead.

Refreshes taken at the same game tick are ignored, so pausing and mashing
Refresh won't skew the numbers — but it also means the metric only grows while
the game is actually running.

## Hauling cost

The strata view scores every feed link with one number, in tiles:

```
cost = max(dx, dy) + stair_cost × dz
```

`dx`/`dy`/`dz` are the *edge-to-edge* gaps between two footprints, not the
distance between their centres — a pile is an area, and a dwarf walks to the
near corner. The in-plane term is Chebyshev rather than Euclidean because DF
units move diagonally for the same cost as orthogonally, so Euclidean would
overstate every diagonal haul.

`stair_cost` is a slider, defaulting to 2 tiles per z level. It is the one
figure the model cannot read off the map: what a level of climbing is worth
depends on whether your shaft is ramps, stairs, or a minecart. Slide it and
watch which links turn red — and watch the "is stairs" figure, the share of
the whole network's cost that is pure vertical travel.

Distances ignore walls. There is no pathfinding here, so a cost is a lower
bound: two piles either side of an unmined wall look adjacent.

## The map

The Map view is the cross-section's opposite number, and the two are meant to
be used together. Strata compresses every level onto one screen and pays for
it with a layout that is nobody's real geometry — piles cluster into pods at a
centroid, and map Y is squeezed into a vertical nudge. The plan gives that up
to draw one level exactly where it is, so what you work out here transfers
straight back to the game's own screen.

Every level shares one coordinate frame, so paging up and down keeps the fort
in the same place under your eye, and the "ghost level below" checkbox draws
the floor directly underneath faintly beneath the current one.

Two things the plan can say that a list of boxes cannot. A stockpile is
*painted*, not rectangular — 11 of Shieldclosed's 61 are not boxes — so the
outline follows the tiles the pile really owns. And the walkable tiles on a
level fall into separate areas: the view counts them, and if a pile or
workshop sits on an area with no stair and no ramp anywhere in it, it says so.

That last one is a lead, not a verdict. The plan only walks one level at a
time, so a floor with no way off it may still be reached from above; the
finding says which question it is answering. Undiscovered rock is drawn as
nothing at all, so the plan shows you what your dwarves have seen and no more.

## Goods flow

The Flow view answers a different question: not how far things are, but what
is not moving. It reads what is lying on the floor outside every stockpile,
how many tiles of each pile are occupied, what is parked inside each workshop,
and DF's own count of queued hauling jobs against dwarves enabled for them.

Turn on **Flow problems** in the Strata toolbar and the same data lands on the
cross-section: a dot on every pile a finding names, the fill bar turning
orange when a pile runs out of floor, and loose goods drawn over the footprint
strip where they actually lie. Levels with no stockpile at all get their tally
in the rock band they fall inside — which is usually where the surprise is.

One honest limit. Dwarf Fortress does not expose whether a given stockpile
would *accept* a given item; that lives in the settings screen, per subtype,
per material, per quality. So every finding reasons from where goods already
sit, and says so: *"no pile is holding ammo"*, never *"no pile accepts ammo"*.
An empty pile configured for exactly the missing thing looks, from here,
identical to no pile at all — so when there are empty piles, the finding
mentions them. Treat the list as a set of leads, not a verdict.

## Containers

DF's stocks screen will tell you the fort has 122 barrels. It will not tell
you that 96 of them are full, which is the only figure that decides whether
the brewery keeps running. The one place that number surfaces in game is a
work-order condition — one container kind at a time, buried three screens
deep — so the Containers view leads with it and calls it **free**.

Free is deliberately narrower than empty. A coffer installed in a bedroom is
empty and unavailable. A bag sitting inside a barrel is empty and already
doing its job. A bucket built into a well belongs to the well now. A
forbidden container cannot be hauled at all. What is left — empty, lying in
a pile or on the floor, not already claimed by a job — is what a dwarf can
actually pick up, and it is usually a much smaller number than the stocks
screen implies.

The kinds come from the game rather than from a list here. DF states what
each tool is *for* in the raws — a jug is a `LIQUID_CONTAINER`, a minecart
is a `TRACK_CART`, a wheelbarrow is `HEAVY_OBJECT_HAULING` — so the view
groups by that, and a modded tool sorts itself.

Two findings are worth the view on their own. **A kind you have run dry**:
when every jug is full, honey and milk collection simply stops, and DF
issues no warning of any kind — the job never starts and nothing says why.
And **a minecart route with no cart**: a route with stops set and no vehicle
assigned is listed, looks configured, and is completely inert. The only way
to catch it in game is to open every route in turn.

Hauling gear is counted differently from storage, because it works
differently. An empty bin assigned to a stockpile is exactly the capacity
that pile is about to use, so it still counts as free. An empty minecart
parked on its route is working, and does not.

One thing the view will not do is guess what a container is *for*. DF
assigns bins and barrels by each pile's own settings, and nothing in the
snapshot says which job is about to want a bag — so every finding reasons
from what containers are doing now, never from intent. In the same spirit,
a full pile is only flagged as short of containers when it holds none at
all: DF's `max_bins` figure is a one-slot-per-tile ceiling, not a request,
and a 322-tile stone pile claiming room for 322 bins means nothing by it.

## Squad equipment

The Equipment view grades every soldier against **their own squad's
uniform** — the pieces it names, and the material class it asks for on each
one — and tells you what it would take to close the gap. A uniform that says
"mail shirt, leather trousers, leather gloves" is graded as written: leather
in those slots is the standard met, not a shortfall. Only a squad with no
uniform at all falls back to a full-metal kit, and it gets told that its
uniform is missing first.

The ranking of armour metals is not a list typed into the code. It is DF's
own `strength.fracture[SHEAR]` for each material, read out of the running
game, which happens to order them exactly the way players do:

```
adamantine ≫ divine metals ≫ steel > iron > bronze ≈ bismuth bronze > copper > bone > leather
```

Modded metals and the divine ones sort themselves, and pig iron lands below
copper — which is why DF does not let you make armour from it. "The fort has
steel" in a finding means the fort really does, either worn, in stock, or as
bars.

Three panels, in the order you act on them:

- **Findings**, worst first. A whole squad in leather is one finding, not
  nine, and eight archers with no shield is one order rather than eight —
  the roll-ups are deliberate, and without them a fort like this reports
  fifty problems where it has a dozen.
- **Forge order** — every gap in the fort folded into one line per piece,
  with what is already in stock, what must be made, and the armour-grade bars
  on hand as the ceiling on what can be made before more is smelted.
- **Soldiers** — one row each, one cell per slot, coloured by how far that
  slot is from the standard. This is the evidence for everything above.

Green recruits are flagged, not exempted. Armor User 0 or 1 means metal will
slow them until they train out of it, so the finding says so — but the target
kit stays the same, because the answer is drill, not lighter armour.

### Made, but not collected

A soldier not wearing their armour has not necessarily lost it. DF earmarks
each piece for a specific dwarf the moment it exists, and the dwarf goes and
puts it on when the squad next goes on duty — so a squad with a month off
walks around in civilian clothes with a full set of iron waiting for it in a
stockpile.

The view keeps those apart. A slot reads **waiting** when the piece exists
and has that soldier's name on it, and the forge order counts it in its own
column rather than as work: nine mail shirts already made are not nine mail
shirts to make. When the squad has no orders that month, the finding says so,
because that is the whole explanation.

Two more things the view will not tell you. Whether DF *will* actually issue
a piece: a gap means "this soldier is not wearing it", not "DF refuses to
give it to them". And whether a bar can become a specific piece: bar stock
says the metal exists, not that the smithy, the fuel and the work orders do.

## Judging a petition

When a visitor petitions for residency, DF shows a popup with a name and a
stated purpose on it. Dismiss it and there is no screen that will show you
that person again — not their skills, not their history. The Visitors view is
that screen.

### What they are worth

Every guest is graded on **the trade they claim**, not on their best skill.
DF attaches a profession to most skills, so "a Maceman is judged on Mace" and
"a Poet on Poetry" is read out of the snapshot rather than typed into the
viewer; the visiting professions DF leaves unattached — scholar, mercenary,
monster slayer — are the short list the code names itself.

The verdict is the rating in that trade, in DF's own words. A Human Bard whose
best musical skill is Novice reads **novice**, whatever else they are good at,
because that is what you would be housing. The one grade that outranks the
ladder is *would raise the ceiling*: a guest better at something than any
citizen is the only kind whose arrival changes what the fort can do rather
than how fast it does it, and their chip is marked.

### Who is actually there

DF's "active" unit list means *on the map*, not *alive* — in a year-105 fort
roughly half of it is corpses, and a caged beast keeps the visitor flag it
arrived with. The roster shows only guests who are standing up, and says what
it left out: "3 dead guests, 1 caged or chained not listed".

### What they are hiding

**This half is behind the Show spoilers switch, off by default.** Everything
under it is something DF means you to work out for yourself, and knowing it
cannot be un-known. With the switch off the view says only what the game
would show you on a guest's own screen — and hidden concerns disappear
completely rather than leaving a count behind, because "3 hidden concerns"
would give the game away just as thoroughly.

The switch does not make an agent invisible, only unconfirmed. Shieldclosed's
spy is still flagged with spoilers off, by the tell the wiki has recommended
for a decade: *presents as a poet, and has no arts skill at all.*

None of the following is a reading of how someone looks. Each is a field in
the save:

- **A cover identity.** `unit.name` is the real historical figure;
  `getVisibleName` is the face. When they differ, DF is running a
  `FalseIdentity` — its own name for the scout's cover — and the view shows
  both names, the claimed profession, and the civilisation they claim to be
  from, which is often yours.
- **Intrigue plots.** A figure's plots carry a target. When the target is
  your site government or an artifact in your fort, the finding says so and
  names the artifact.
- **Criminal ties.** A `CRIMINAL` link to a government is that government
  wanting them. Membership of an `Outcast` entity is DF's word for a bandit
  band.
- **Reputation.** Murderer, thief, brigand, psychopath — filed per entity,
  with a 1–100 level, and flagged harder when the entity is your own
  civilisation.
- **Curses and flags.** Vampires hiding what they are, and night creatures.
- **How they got here.** `isInvader` is three DF flags OR'd together and
  only one of them is an attack in progress; the other two mean "arrived
  with an invasion", which stays true of a goblin for good. The view keeps
  those apart, so a goblin who came with a siege years ago is not reported
  as a live threat.
- **The oldest tell.** A guest who claims a trade and has no skill in it at
  all. On its own this only means they are bad at their job, so it sits at
  medium — but next to a cover identity it is the giveaway the wiki has
  described for a decade.

What the view will not claim: that an accepted petitioner *will* act on a
plot, or that a guest with nothing on file is safe. An empty record is an
empty record.

## Building an instrument

Instruments are the most awkward thing a fort makes. A sharsid is four
separate pieces — a glass keyboard, a glass chest, ceramic pipes, a leather
bellows — each made at a different building by a different trade, and none
of that is written down anywhere in the game. The build menu lists the jobs;
it never lists the recipe.

It turns out DF knows the whole thing. Worldgen writes a real reaction for
every piece and every assembly your civilisation can make — *make sharsid
keyboard*, *assemble sharsid* — and each one names its building, its skill,
its reagents and whether it needs fuel. So nothing in this view is
transcribed from the wiki: it is the game's own recipe, which means a
modded instrument comes through the same way a vanilla one does.

That matters because **instruments are generated per world and handed out
per civilisation** — your fort's are not the ones in this README, and a
lookup table keyed on material would be wrong even for another dwarf civ
in the same world. In the world this was built against, one dwarf
civilisation makes a stone instrument body with Masonry at the Mason's
Workshop while another makes its stone piece with Stonecrafting at the
Craftsdwarf's Workshop. Only the reaction knows which.

Against that, the view puts what your fort actually has:

- **Ingredients, in units you can count.** DF stores bars, thread, cloth
  and powder as a dimension rather than a count — a whole metal bar is
  150, a whole thread 15000 — so a reagent asking for 300 wants two bars.
  The counts come from DF's own item-match predicate rather than from the
  item type, which matters more than it sounds: only 93 of Shieldclosed's
  730 boulders are clay, and of its 6,350 threads, none at all are silk.
  That last one is why one instrument reads as blocked.
- **Which workshop, and whether you have one.** Alternatives are joined
  with "or", because DF offers a magma twin for every heated job. A
  workshop the fort lacks is called out at the top of the view with the
  recipes it would unlock.
- **How far along you already are.** A piece is a tool like any other, and
  nothing in the game marks one as belonging to a half-built instrument —
  so a fort quietly accumulates two of the four pieces it needs and never
  mentions it. Half-built instruments sort to the front.
- **Who should be at the bench.** The best hand in the fort at that exact
  skill, which for an instrument is not a detail: quality is most of what
  an instrument is worth.

Two things it will not say. That a job cannot run for want of skill — DF
gates work on the labour, not the rating, so an unskilled fort gets a poor
instrument, not no instrument. And that a piece you own is one you made:
it might have arrived with a caravan, which is also why the view can list
the instruments the fort owns but has no recipe for.

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

## License

MIT — see [LICENSE](./LICENSE).
