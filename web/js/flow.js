// Goods-flow diagnostics: pure functions over the snapshot, no DOM.
//
// The snapshot reports what *is* -- what lies on the floor, how full each
// pile is, what DF's hauling queue holds. This module turns that into
// statements about what is *wrong*, which is the part with judgment in it.
//
// One thing it deliberately does not attempt: deciding whether a given pile
// would accept a given item. DF keeps that in the stockpile settings screen
// -- per subtype, per material, per quality -- and exposes no predicate for
// it, so every rule below reasons from where goods *already* sit rather than
// from where they *could*. That is weaker, and the wording of each finding
// says so: "no pile holds stones" rather than "no pile accepts stones".

import { haulCost, DEFAULT_Z_PENALTY } from './geometry.js';

/** A pile with this share of its tiles occupied has effectively stopped. */
export const FULL_RATIO = 0.95;

/** Below this, a heap on the floor is just goods in transit. */
export const HEAP_MIN = 10;

/** Items parked in a workshop before it counts as clogged. */
export const CLOG_MIN = 6;

/** Full piles named individually before the rest are rolled into one line. */
export const FULL_DETAIL = 6;

/** A heap has to be this big on one level before its distance is a story. */
export const STRAND_MIN = 5;

export const SEVERITY = { high: 0, medium: 1, low: 2 };

/** Share of a pile's tiles that are occupied, 0 when it has no tiles. */
export function fillRatio(pile) {
  const area = pile.area || 0;
  if (!area) return 0;
  return Math.min(1, (pile.used_tiles || 0) / area);
}

/**
 * A quantum stockpile -- a minecart dump the player built to be full.
 *
 * There is no flag for one: a quantum pile is an ordinary pile with a
 * minecart route pointed at it, and the tile it dumps on reads as occupied
 * from the first item onward. Every full-pile rule would fire on it forever,
 * which is exactly the alert the player does not want. The name is the only
 * signal the snapshot carries, and naming these "Quantum ..." is the
 * convention, so that is what this reads.
 */
export function isQuantum(pile) {
  return /quantum/i.test(pile.name || '') || /quantum/i.test(pile.custom_name || '');
}

/**
 * A pile that has run out of room *and* minds it.
 *
 * Quantum piles are full by design, so they never count -- see `isQuantum`.
 * This is the test every full-related rule should use; bare `fillRatio`
 * comparisons re-introduce the noise.
 */
export function isFull(pile) {
  return !isQuantum(pile) && fillRatio(pile) >= FULL_RATIO;
}

/** Piles currently holding at least one item of `type`. */
export function holdersOf(stockpiles, type) {
  return stockpiles.filter((p) => (p.items_by_type || {})[type] > 0);
}

/**
 * Containers a pile holds against the number that would fit.
 *
 * `max_bins` and `max_barrels` are DF's *capacity ceiling*, not a request the
 * player made: they come out at roughly one slot per tile, so a 250-tile
 * stone pile reports "250 bins" and means nothing by it. Treating the
 * shortfall as a demand flags almost every pile in a healthy fort, so the
 * gap is only ever reported as context on a pile that has actually run out
 * of floor. Wheelbarrows are left out entirely -- every stone pile defaults
 * to one and hardly any fort assigns them.
 */
export function containerUse(pile) {
  const c = pile.containers;
  if (!c) return null;
  const held = (c.bins_held || 0) + (c.barrels_held || 0);
  const cap = (c.bins_wanted || 0) + (c.barrels_wanted || 0);
  if (!cap) return null;
  return { held, cap };
}

/**
 * Why a full pile is full, in plain terms.
 *
 * Tiles are the honest measure of "full" -- but a tile holding a bin can
 * still take more inside it, so the item-to-tile ratio is what separates a
 * pile that is genuinely out of room from one whose containers are working.
 */
export function describeFull(pile) {
  const bits = [`${pile.used_tiles} of ${pile.area} tiles occupied`];
  const containers = containerUse(pile);
  if (containers) {
    bits.push(containers.held
      ? `${containers.held} of ${containers.cap} container slots filled`
      : `no bins or barrels, though ${containers.cap} would fit`);
  }
  const items = pile.item_count || 0;
  const leverage = items / Math.max(1, pile.used_tiles);
  bits.push(leverage >= 1.5
    ? `${items} items, so its containers are still absorbing goods`
    : `${items} items — about one per tile, so it is genuinely out of room`);
  return `${bits.join('; ')}.`;
}

/** Cheapest haul from a loose heap to any pile, or null when there are none. */
export function nearestPile(level, stockpiles, zPenalty = DEFAULT_Z_PENALTY) {
  const box = { x1: level.x1, x2: level.x2, y1: level.y1, y2: level.y2, z: level.z };
  let best = null;
  for (const pile of stockpiles) {
    const cost = haulCost(box, pile, zPenalty);
    if (!best || cost < best.cost) best = { pile, cost };
  }
  return best;
}

function finding(key, severity, title, detail, extra = {}) {
  return { key, severity, title, detail, nodes: [], types: [], ...extra };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Every flow problem the snapshot can support, worst first.
 *
 * `captionOf` maps an item_type key to DF's own caption; pass the identity
 * to get raw keys.
 */
export function diagnose(input) {
  const {
    stockpiles = [],
    workshops = [],
    loose = null,
    hauling = [],
    storeJobs = null,
    inboundOf = () => [],
    captionOf = (t) => t,
    // How the fort names a level. DF says "elev 46" where the snapshot says
    // z175; a caller without the offset gets the raw index back.
    elevOf = (z) => `z${z}`,
    zPenalty = DEFAULT_Z_PENALTY,
  } = input;

  const out = [];
  const byType = (loose && loose.by_type) || [];

  // --- Goods with nowhere to go -----------------------------------------
  const emptyPiles = stockpiles.filter((p) => !(p.item_count > 0)).length;

  for (const heap of byType) {
    const name = captionOf(heap.type);
    const holders = holdersOf(stockpiles, heap.type);
    // Forbidden goods are not waiting on a stockpile, they are waiting on the
    // player. Counting them as unhauled blames the wrong thing.
    const haulable = heap.count - (heap.forbidden || 0);
    if (haulable < HEAP_MIN) continue;
    const unclaimed = haulable - (heap.claimed || 0);
    const aside = heap.forbidden
      ? ` A further ${heap.forbidden} are forbidden and out of the running.`
      : '';

    if (!holders.length) {
      // "No pile *holds* this" is not the same as "no pile *accepts* it" --
      // an empty pile configured for exactly this looks identical from here.
      // Say what was observed and point at the ambiguity.
      const caveat = emptyPiles
        ? ` ${plural(emptyPiles, 'pile is', 'piles are')} standing empty, so one `
          + `of them may accept ${name} and be failing to fill for another reason.`
        : '';
      out.push(finding(
        'homeless', 'high',
        `${plural(haulable, name, name)} loose, and no pile is holding any`,
        `Nothing in the fort currently stores ${name}.${caveat}${aside}`,
        { types: [heap.type], count: haulable },
      ));
      continue;
    }

    const full = holders.filter(isFull);
    if (full.length === holders.length && unclaimed >= HEAP_MIN) {
      out.push(finding(
        'holders-full', 'high',
        `${plural(haulable, name, name)} loose, every pile holding ${name} is full`,
        `${full.map((p) => p.name).join(', ')} — all at or near their tile `
          + `limit, so hauling has nowhere left to put anything.${aside}`,
        { types: [heap.type], nodes: full.map((p) => p.id), count: haulable },
      ));
      continue;
    }

    // Goods sitting still while space exists means the haul itself is the
    // problem -- too far, or nobody assigned to it.
    if (unclaimed >= HEAP_MIN) {
      const worst = (heap.levels || [])
        .filter((level) => level.count >= STRAND_MIN)
        .map((level) => ({ level, near: nearestPile(level, stockpiles, zPenalty) }))
        .filter((entry) => entry.near)
        .sort((a, b) => b.near.cost - a.near.cost)[0];
      if (worst && worst.near.cost >= 30) {
        out.push(finding(
          'stranded', 'medium',
          `${plural(worst.level.count, name, name)} stranded on ${elevOf(worst.level.z)}`,
          `Nearest pile that could take them is ${worst.near.pile.name}, `
            + `${Math.round(worst.near.cost)}t away.`,
          { types: [heap.type], nodes: [worst.near.pile.id], count: worst.level.count },
        ));
      }
    }
  }

  // --- Piles that have run out of floor ---------------------------------
  //
  // The biggest by contents get spelled out; the tail is rolled up, because
  // a quarter of a mature fort's piles being full is normal and the list is
  // only useful for the ones actually carrying goods.
  const full = stockpiles
    .filter((p) => p.area > 0 && isFull(p))
    .sort((a, b) => (b.item_count || 0) - (a.item_count || 0));

  for (const pile of full.slice(0, FULL_DETAIL)) {
    out.push(finding(
      'pile-full', 'medium',
      `${pile.name} is full`,
      describeFull(pile),
      { nodes: [pile.id], count: pile.item_count || 0 },
    ));
  }
  if (full.length > FULL_DETAIL) {
    const rest = full.slice(FULL_DETAIL);
    out.push(finding(
      'piles-full', 'low',
      `${plural(rest.length, 'more stockpile is', 'more stockpiles are')} full`,
      rest.map((p) => `${p.name} (${p.used_tiles}/${p.area})`).join(', ') + '.',
      { nodes: rest.map((p) => p.id) },
    ));
  }

  // --- Piles that cannot accept in the first place -----------------------
  for (const pile of stockpiles) {
    if ((pile.flags || []).includes('use_links_only') && !inboundOf(pile.id).length) {
      out.push(finding(
        'links-only-orphan', 'high',
        `${pile.name} takes from links only, and has none`,
        'Nothing can ever be brought here until it is linked to a source '
          + 'or the links-only setting is cleared.',
        { nodes: [pile.id] },
      ));
    }

    if (!(pile.categories || []).length) {
      out.push(finding(
        'accepts-nothing', 'medium',
        `${pile.name} accepts nothing`,
        `${pile.area} tiles with every category switched off.`,
        { nodes: [pile.id] },
      ));
    }
  }

  // --- Workshops nobody is clearing --------------------------------------
  //
  // A trade depot full of goods is a caravan, not a fault, so it sits this
  // rule out.
  const clogged = workshops
    .filter((w) => w.kind !== 'TradeDepot' && (w.held_items || 0) >= CLOG_MIN)
    .sort((a, b) => b.held_items - a.held_items);
  for (const shop of clogged.slice(0, 8)) {
    const top = shop.held_top_type
      ? `mostly ${captionOf(shop.held_top_type)} (${shop.held_top_count})`
      : 'mixed goods';
    out.push(finding(
      'workshop-clog', shop.held_items >= 100 ? 'high' : 'medium',
      `${shop.name} is holding ${plural(shop.held_items, 'item', 'items')}`,
      `${top}. Clutter slows a workshop down, and nothing here is going to `
        + `move until something hauls it out.`,
      { nodes: [shop.id], count: shop.held_items },
    ));
  }

  // --- DF's own hauling queue -------------------------------------------
  for (const lane of hauling) {
    if (lane.key === 'Any' || lane.jobs <= 0) continue;
    if (lane.haulers === 0) {
      out.push(finding(
        'no-haulers', 'high',
        `${lane.jobs} ${lane.key.toLowerCase()} hauling jobs, nobody assigned`,
        'DF has the work queued and no dwarf enabled for it.',
        { count: lane.jobs },
      ));
    } else if (lane.jobs > lane.haulers * 8) {
      out.push(finding(
        'hauling-backlog', 'low',
        `${lane.key} hauling is backed up`,
        `${lane.jobs} jobs across ${plural(lane.haulers, 'hauler', 'haulers')}.`,
        { count: lane.jobs },
      ));
    }
  }

  if (storeJobs && storeJobs.total > 0 && storeJobs.unclaimed / storeJobs.total > 0.5
      && storeJobs.unclaimed >= 20) {
    out.push(finding(
      'store-jobs-unclaimed', 'medium',
      `${storeJobs.unclaimed} of ${storeJobs.total} storage jobs have no worker`,
      'The jobs exist and nobody has picked them up — usually too few '
        + 'haulers, or they are all busy further away.',
      { count: storeJobs.unclaimed },
    ));
  }

  // --- Goods excluded from hauling by the player -------------------------
  if (loose) {
    if (loose.forbidden >= HEAP_MIN) {
      out.push(finding(
        'forbidden', 'low',
        `${loose.forbidden} loose items are forbidden`,
        'Forbidden goods are invisible to hauling. Common after a siege or '
          + 'a reclaim.',
        { count: loose.forbidden },
      ));
    }
    if (loose.rotten > 0) {
      out.push(finding(
        'rotten', 'low',
        `${plural(loose.rotten, 'loose item has', 'loose items have')} rotted`,
        'Rot on the floor means it never reached a pile in time.',
        { count: loose.rotten },
      ));
    }
  }

  return out.sort((a, b) =>
    SEVERITY[a.severity] - SEVERITY[b.severity]
    || (b.count || 0) - (a.count || 0));
}

/** Headline numbers for the top of the view. */
export function summariseFlow(input) {
  const { stockpiles = [], loose = null, storeJobs = null } = input;
  const withTiles = stockpiles.filter((p) => p.area > 0);
  const tiles = withTiles.reduce((sum, p) => sum + p.area, 0);
  const used = withTiles.reduce((sum, p) => sum + (p.used_tiles || 0), 0);
  return {
    loose: loose ? loose.total : null,
    claimed: loose ? loose.claimed : null,
    tiles,
    used,
    fill: tiles ? used / tiles : 0,
    full: withTiles.filter(isFull).length,
    queued: storeJobs ? storeJobs.total : null,
    unclaimed: storeJobs ? storeJobs.unclaimed : null,
  };
}
