// Container census and diagnostics: pure functions over the snapshot, no DOM.
//
// DF's stocks screen counts containers but never their state. "How many
// empty barrels have I got?" is only answerable in game by opening the
// work-order conditions screen and reading a threshold off it, and "which
// of my minecart routes has no cart" is not answerable at all without
// opening every route in turn. Those are the questions this module exists
// to answer.
//
// One thing it deliberately does not attempt: saying what a container will
// be *used for*. DF assigns bins and barrels to piles by the pile's own
// settings, and nothing in the snapshot says which job is about to want a
// bag. So every rule reasons from state — full, empty, assigned, parked —
// and never from intent.

import { asList } from './util.js';

export const SEVERITY = { high: 0, medium: 1, low: 2 };

/** Below this share of a kind still free, the fort is running it dry. */
export const SCARCE_RATIO = 0.15;

/** ...but only worth saying when the absolute number is small too. */
export const SCARCE_FLOOR = 6;

/** Unassigned hauling gear worth mentioning as idle. */
export const IDLE_GEAR_MIN = 3;

/** Share of a kind in one material before that is the story. */
export const MONOCULTURE_SHARE = 0.9;

/** Kinds named individually in a roll-up before the rest become "and N more". */
export const DETAIL_CAP = 4;

/**
 * What a kind of container is *for*, which decides the section it lands in.
 *
 * For tools this is derived: `tool_use` is DF's own statement of purpose —
 * LIQUID_CONTAINER for a jug, TRACK_CART for a minecart — and the dumper
 * ships it verbatim, so a modded tool sorts itself.
 *
 * Whole item types have no such field. `item_type` carries no role and DF's
 * own stocks screen hardcodes its grouping too, so `ROLE_BY_TYPE` names
 * them. That map and `ROLE_BY_USE` are the only hardcoded taxonomy here;
 * extend them rather than adding a third.
 */
export const ROLE_BY_USE = {
  LIQUID_CONTAINER: 'storage',
  FOOD_STORAGE: 'storage',
  SMALL_OBJECT_STORAGE: 'storage',
  MEAL_CONTAINER: 'storage',
  TRACK_CART: 'hauling',
  HEAVY_OBJECT_HAULING: 'hauling',
  NEST_BOX: 'animals',
  HIVE: 'animals',
  BOOKCASE: 'furniture',
  DISPLAY_OBJECT: 'furniture',
  PLACE_OFFERING: 'furniture',
  CONTAIN_WRITING: 'records',
  PROTECT_FOLDED_SHEETS: 'records',
  ROLL_UP_SHEET: 'records',
};

export const ROLE_BY_TYPE = {
  BIN: 'storage',
  BARREL: 'storage',
  BAG: 'storage',
  BUCKET: 'storage',
  BOX: 'storage',
  CAGE: 'animals',
  ANIMALTRAP: 'animals',
  CABINET: 'furniture',
  COFFIN: 'furniture',
  ARMORSTAND: 'furniture',
  WEAPONRACK: 'furniture',
  FLASK: 'personal',
  BACKPACK: 'personal',
  QUIVER: 'personal',
};

export const ROLES = [
  {
    key: 'storage',
    label: 'Storage',
    blurb: 'The containers a fort runs out of. An empty one is capacity; '
      + 'a full one is not.',
  },
  {
    key: 'hauling',
    label: 'Hauling gear',
    blurb: 'Wheelbarrows earn their keep only once a pile is assigned one, '
      + 'and a minecart only once a route is.',
  },
  {
    key: 'animals',
    label: 'Animals',
    blurb: 'Cages and traps get consumed; nest boxes and hives want placing.',
  },
  {
    key: 'personal',
    label: 'Personal kit',
    blurb: 'Carried by dwarves rather than stored. Full is the normal state.',
  },
  {
    key: 'furniture',
    label: 'Furniture',
    blurb: 'Holds things once installed. Emptiness here means unbuilt, not spare.',
  },
  { key: 'records', label: 'Records', blurb: 'The library\'s writing materials.' },
  { key: 'tools', label: 'Other tools', blurb: 'Everything else DF states a use for.' },
];

const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.key, r.label]));

/** Human-readable form of a SCREAMING_SNAKE enum key. */
export function words(key) {
  if (!key) return '';
  return String(key).replace(/_/g, ' ').toLowerCase();
}

/**
 * English plural of a kind's name.
 *
 * DF ships a plural for instruments and for creatures but not for item
 * types, so "box" has to be pluralised here rather than read.
 *
 * A name that already ends in "s" is left alone: some tool defs are named
 * in the plural ("scroll rollers"), and "scroll rollerses" is worse than
 * an unchanged word. "x", "z", "ch" and "sh" still take "es", which is what
 * turns "box" into "boxes".
 */
export function pluralName(name) {
  if (!name) return '';
  if (/s$/.test(name)) return name;
  if (/(x|z|ch|sh)$/.test(name)) return `${name}es`;
  if (/[^aeiou]y$/.test(name)) return `${name.slice(0, -1)}ies`;
  return `${name}s`;
}

/**
 * Buildings that swallow a container rather than *being* one.
 *
 * A bucket built into a well and a coffer built as bedroom furniture are
 * both `in_building` and both `use_mode == PERM` — DF draws no distinction.
 * The building's own type is what separates them, and only the machines are
 * worth reporting: a coffer installed as a coffer is not news.
 */
export const MACHINE_BUILDINGS = new Set([
  'Workshop', 'Furnace', 'Well', 'TradeDepot', 'ScrewPump', 'Windmill',
  'WaterWheel',
]);

/** Which section a kind belongs to. Tool uses win; item types are the fallback. */
export function roleOf(kind) {
  for (const use of asList(kind.uses)) {
    if (ROLE_BY_USE[use]) return ROLE_BY_USE[use];
  }
  return ROLE_BY_TYPE[kind.item_type] || 'tools';
}

/**
 * Which of a stockpile's container slots this kind fills, if any.
 *
 * DF pools bins, barrels and wheelbarrows into one container list per pile
 * but counts them against separate wanted-slots, and a pot or a jug answers
 * the barrel slot — which is exactly why a stone pot is a substitute for a
 * wooden barrel and a stone coffer is not. `stockpile_containers` in the
 * dumper makes the same split; the two have to agree.
 */
export function pileSlot(kind) {
  if (kind.item_type === 'BIN') return 'bin';
  if (kind.item_type === 'BARREL' || kind.item_type === 'BUCKET') return 'barrel';
  const uses = asList(kind.uses);
  if (uses.includes('FOOD_STORAGE') || uses.includes('LIQUID_CONTAINER')) return 'barrel';
  return null;
}

/** Is this kind hauling gear, which is only ever used through an assignment? */
export function isGear(kind) {
  return asList(kind.uses).some((u) => ROLE_BY_USE[u] === 'hauling');
}

/**
 * Hauling gear DF has actually put to work.
 *
 * The two halves live in different places: a wheelbarrow is claimed by the
 * stockpile that owns it (`assigned`, read off `container_item_id`), and a
 * minecart by the hauling route it runs on. Neither shows up in the other's
 * count, so a cart on a route reads as `assigned: 0` and would otherwise
 * look spare.
 */
export function deployed(kind, routes = []) {
  if (asList(kind.uses).includes('TRACK_CART')) {
    return asList(routes).reduce((n, route) => n + asList(route.carts)
      .filter((cart) => !cart.missing).length, 0);
  }
  return kind.assigned || 0;
}

/**
 * Containers of this kind a job could take right now.
 *
 * The dumper decides this per item — empty, lying in a pile or on the floor,
 * not forbidden, not already claimed by a job — because it cannot be
 * recovered from the totals afterwards. `empty` and `nested` count different
 * sets of containers, so subtracting one from the other goes negative and
 * reports a fort with forty spare bags as having none.
 *
 * Hauling gear subtracts what is deployed on top of that: an empty minecart
 * parked on its route is working, not spare. For a bin or barrel the
 * opposite holds — an empty one assigned to a pile is precisely the capacity
 * that pile is about to use — so nothing is subtracted there.
 */
export function free(kind, routes = []) {
  const spare = kind.free || 0;
  return isGear(kind) ? Math.max(0, spare - deployed(kind, routes)) : spare;
}

/** Share of this kind that is free, 0 when there are none at all. */
export function freeRatio(kind, routes = []) {
  return kind.total ? free(kind, routes) / kind.total : 0;
}

/** The material most of this kind is made of, with its share. */
export function dominantMaterial(kind) {
  const materials = asList(kind.materials);
  if (!materials.length || !kind.total) return null;
  const top = materials.reduce((a, b) => (b.count > a.count ? b : a));
  return { ...top, share: top.count / kind.total };
}

/** Materials of this kind folded to DF's material classes, biggest first. */
export function byMatClass(kind) {
  const classes = new Map();
  for (const mat of asList(kind.materials)) {
    const key = mat.mat_class || 'other';
    const entry = classes.get(key) || { mat_class: key, count: 0, empty: 0 };
    entry.count += mat.count || 0;
    entry.empty += mat.empty || 0;
    classes.set(key, entry);
  }
  return [...classes.values()].sort((a, b) => b.count - a.count);
}

/** What the full ones hold, biggest first. `captionOf` maps an item_type key. */
export function contentsOf(kind, captionOf = (t) => t) {
  return Object.entries(kind.holds || {})
    .map(([type, count]) => ({ type, caption: captionOf(type) || type, count }))
    .sort((a, b) => b.count - a.count);
}

/** Every kind, grouped into the display sections, empty sections dropped. */
export function census(input) {
  const routes = asList(input.routes);
  const kinds = asList(input.kinds).map((kind) => ({
    ...kind,
    role: roleOf(kind),
    free: free(kind, routes),
    deployed: isGear(kind) ? deployed(kind, routes) : 0,
  }));
  const sections = ROLES.map((role) => ({
    ...role,
    kinds: kinds.filter((k) => k.role === role.key),
  })).filter((section) => section.kinds.length > 0);
  return { kinds, sections };
}

/** Headline figures for the stat strip. */
export function summarise(input) {
  const { kinds } = census(input);
  const storage = kinds.filter((k) => k.role === 'storage');
  const sum = (list, field) => list.reduce((n, k) => n + (k[field] || 0), 0);
  const routes = asList(input.routes);
  return {
    total: sum(kinds, 'total'),
    storage: sum(storage, 'total'),
    storageFree: sum(storage, 'free'),
    holding: sum(storage, 'holding'),
    goodsStored: sum(storage, 'contents'),
    assigned: sum(kinds, 'assigned'),
    kinds: kinds.length,
    routes: routes.length,
    routesIdle: routes.filter((r) => !asList(r.carts)
      .some((c) => !c.missing)).length,
  };
}

function finding(key, severity, title, detail, extra = {}) {
  return { key, severity, title, detail, kinds: [], ...extra };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function listNames(names, cap = DETAIL_CAP) {
  if (names.length <= cap) {
    if (names.length <= 1) return names[0] || '';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, cap).join(', ')} and ${names.length - cap} more`;
}

/**
 * Every container problem the snapshot can support, worst first.
 *
 * `captionOf` maps an item_type key to DF's own caption; pass the identity
 * to get raw keys. `pileOf` maps a stockpile id to its record.
 */
export function diagnose(input) {
  const {
    kinds: rawKinds = [],
    routes = [],
    stockpiles = [],
    captionOf = (t) => t,
    pileOf = () => null,
  } = input;

  const { kinds } = census({ kinds: rawKinds, routes });
  const storage = kinds.filter((k) => k.role === 'storage' && k.total > 0);
  const out = [];

  // --- a kind the fort has run completely dry -------------------------
  //
  // The sharpest signal here, and invisible in game: DF will not warn that
  // a job is waiting on a container, it simply never starts the job.
  for (const kind of storage) {
    if (kind.free > 0) continue;
    const holds = contentsOf(kind, captionOf);
    const what = holds.length
      ? holds.slice(0, 3).map((h) => `${h.count} holding ${h.caption}`).join(', ')
      : 'none of them free';
    const use = asList(kind.uses).map(words).join(', ');
    out.push(finding(
      'exhausted', 'high',
      `No free ${pluralName(kind.name)} — all ${kind.total} are in use`,
      `${what}. Any job that wants one now waits`
      + `${use ? ` — DF classes this kind as a ${use}` : ''}. `
      + 'Nothing in game reports this: the job simply never starts.',
      { kinds: [kind.key] },
    ));
  }

  // --- a kind running low ---------------------------------------------
  for (const kind of storage) {
    const spare = kind.free;
    if (spare === 0) continue;
    if (spare > SCARCE_FLOOR || spare / kind.total > SCARCE_RATIO) continue;
    out.push(finding(
      'scarce', 'medium',
      `Only ${plural(spare, `free ${kind.name}`, `free ${pluralName(kind.name)}`)} left of ${kind.total}`,
      `${kind.holding} are holding goods${kind.built
        ? `, ${kind.built} are installed as furniture` : ''}`
      + `${kind.nested ? `, ${kind.nested} sit inside other containers` : ''}. `
      + 'Worth queueing more before a job stalls on one.',
      { kinds: [kind.key] },
    ));
  }

  // --- a route with nothing to run it ---------------------------------
  //
  // A route with no cart is configured, listed and completely inert. DF
  // says nothing, and the only way to notice is to open each route.
  const idleRoutes = routes.filter((r) => !asList(r.carts)
    .some((c) => !c.missing));
  if (idleRoutes.length) {
    const cart = kinds.find((k) => asList(k.uses).includes('TRACK_CART'));
    const spare = cart ? cart.free : 0;
    const names = idleRoutes.map((r) => r.name || `route ${r.id}`);
    out.push(finding(
      'route-no-cart', 'high',
      `${plural(idleRoutes.length, 'hauling route')} with no minecart`,
      `${listNames(names)} ${idleRoutes.length === 1 ? 'has' : 'have'} stops `
      + 'set but no vehicle assigned, so nothing ever moves along '
      + `${idleRoutes.length === 1 ? 'it' : 'them'}. `
      + (spare > 0
        ? `${plural(spare, 'free minecart')} in the fort — assign one on the route's own screen.`
        : 'No free minecart to assign, so one has to be made first.'),
      { routes: idleRoutes.map((r) => r.id) },
    ));
  }

  // --- hauling gear nobody has assigned -------------------------------
  //
  // An unassigned wheelbarrow is not idle stock, it is a wheelbarrow doing
  // nothing: DF only ever uses one through a pile that has claimed it.
  for (const kind of kinds) {
    if (kind.role !== 'hauling') continue;
    const idle = Math.max(0, (kind.total || 0) - kind.deployed);
    if (idle < IDLE_GEAR_MIN) continue;
    const cart = asList(kind.uses).includes('TRACK_CART');
    out.push(finding(
      'gear-unassigned', 'low',
      `${plural(idle, `${kind.name}`)} not assigned to anything`,
      `${kind.deployed} of ${kind.total} are in service. DF only ever uses `
      + `${cart ? 'a minecart through a hauling route' : 'a wheelbarrow through the stockpile that owns it'}, `
      + 'so the rest do nothing until assigned — and if they are sitting on '
      + 'pile tiles, they are taking up storage while they wait.',
      { kinds: [kind.key] },
    ));
  }

  // --- storage built into a machine -----------------------------------
  //
  // Only machines. A coffer installed in a bedroom is `in_building` too,
  // and reporting it would just be telling the player that their coffer
  // is a coffer — see `MACHINE_BUILDINGS`.
  for (const kind of storage) {
    const where = asList(kind.buildings)
      .filter((b) => MACHINE_BUILDINGS.has(b.kind));
    const total = where.reduce((n, b) => n + (b.count || 0), 0);
    if (!total) continue;
    out.push(finding(
      'committed', 'low',
      `${plural(total, kind.name, pluralName(kind.name))} built into machines`,
      `${listNames(where.map((b) => `${b.name} (${b.count})`))}. `
      + 'DF counts these on the stocks screen, but they are part of the '
      + 'building now — a well keeps its bucket for good. They are not '
      + 'capacity the fort can spend.',
      { kinds: [kind.key] },
    ));
  }

  // --- forbidden or about to be destroyed -----------------------------
  const forbidden = kinds.filter((k) => (k.forbidden || 0) > 0);
  if (forbidden.length) {
    const total = forbidden.reduce((n, k) => n + k.forbidden, 0);
    out.push(finding(
      'forbidden', 'medium',
      `${plural(total, 'container')} forbidden`,
      `${listNames(forbidden.map((k) => plural(k.forbidden, k.name, pluralName(k.name))))}. `
      + 'Forbidden containers are counted by the stocks screen but cannot be '
      + 'hauled or filled, so they read as capacity the fort does not have.',
      { kinds: forbidden.map((k) => k.key) },
    ));
  }

  const dumping = kinds.filter((k) => (k.marked_dump || 0) > 0);
  if (dumping.length) {
    const total = dumping.reduce((n, k) => n + k.marked_dump, 0);
    out.push(finding(
      'marked-dump', 'medium',
      `${plural(total, 'container')} marked for dumping`,
      `${listNames(dumping.map((k) => plural(k.marked_dump, k.name, pluralName(k.name))))}. `
      + 'Dumping a container destroys storage the fort paid for. Usually this '
      + 'is a mass-designation that caught more than it meant to.',
      { kinds: dumping.map((k) => k.key) },
    ));
  }

  // --- everything of a kind made of one material ----------------------
  //
  // Informational, not a fault: it is the standing answer to "why am I out
  // of logs". A rock pot stores food exactly as a wooden barrel does.
  for (const kind of storage) {
    if (kind.total < SCARCE_FLOOR) continue;
    // Only for kinds a stockpile has actually claimed. A bucket is wooden
    // too, but it is well-and-water gear rather than storage, so "make them
    // out of stone instead" is advice about a job it does not do.
    if (!(kind.assigned > 0)) continue;
    // The material *class*, not the species. A fort's barrels are spread
    // over a dozen kinds of wood, so no single material ever dominates —
    // but they are all still wood, which is the fact that matters.
    const top = byMatClass(kind)[0];
    if (!top || top.count / kind.total < MONOCULTURE_SHARE) continue;
    if (top.mat_class !== 'wood') continue;
    // The substitute has to fill the same stockpile slot, or the advice is
    // wrong: a stone coffer stores no drink, so offering one in place of a
    // barrel would be worse than saying nothing. And it only counts if the
    // fort already makes it in stone — otherwise this is a link to the wiki.
    const slot = pileSlot(kind);
    const alt = slot && storage.find((k) => k !== kind && pileSlot(k) === slot
      && byMatClass(k).some((c) => c.mat_class === 'stone' && c.count > 0));
    out.push(finding(
      'wood-bound', 'low',
      `${top.count === kind.total ? 'Every' : 'Nearly every'} ${kind.name} in the fort is wooden`,
      `${top.count} of ${kind.total} are wooden, and each one cost a log. `
      + (alt
        ? `The fort already makes stone ${pluralName(alt.name)}, which fill the `
          + `same ${slot} slot in a stockpile without touching the wood supply.`
        : 'Worth knowing if logs are the constraint.'),
      { kinds: [kind.key] },
    ));
  }

  // --- a full pile with nothing to stack into -------------------------
  //
  // Deliberately *not* phrased against `max_bins`/`max_barrels`. Those are
  // DF's capacity ceiling, one slot per tile, not a request the player made
  // — a 322-tile stone pile reports room for 322 bins and means nothing by
  // it, so quoting the shortfall would invent a demand. A pile that is out
  // of floor and holds no containers at all needs no such number: the
  // recommendation is the same whatever the ceiling says.
  const cramped = stockpiles.filter((pile) => {
    const c = pile.containers;
    if (!c) return false;
    const area = pile.area || 0;
    if (!area || (pile.used_tiles || 0) / area < 0.95) return false;
    if (/quantum/i.test(pile.name || '')
      || /quantum/i.test(pile.custom_name || '')) return false;
    if (!((c.bins_wanted || 0) + (c.barrels_wanted || 0))) return false;
    return !((c.bins_held || 0) + (c.barrels_held || 0));
  });
  if (cramped.length) {
    out.push(finding(
      'pile-cramped', 'medium',
      `${plural(cramped.length, 'full stockpile')} holding no containers`,
      `${listNames(cramped.map((p) => p.name))}. `
      + `${cramped.length === 1 ? 'It is' : 'They are'} out of floor with no `
      + 'bin or barrel to stack into, so hauling to '
      + `${cramped.length === 1 ? 'it' : 'them'} has stopped. `
      + 'DF would accept containers here; whether it should get them is a '
      + 'judgement about what the pile is for.',
      { piles: cramped.map((p) => p.id) },
    ));
  }

  return out.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]);
}
