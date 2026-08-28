// Distance and hauling-cost model for the stockpile/workshop network.
//
// Everything here is pure: it takes the boxes the snapshot already carries
// (`x1,y1,x2,y2,z`) and returns tiles. The views decide what to draw with it.

/** Tiles of walking a dwarf "spends" per z level. Stairs are slow. */
export const DEFAULT_Z_PENALTY = 2;

/** Nodes closer than this in-plane are treated as one place. */
export const DEFAULT_CLUSTER_RADIUS = 10;

export function centroid(box) {
  return { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2, z: box.z };
}

function axisGap(a, b, lo, hi) {
  // Overlapping footprints have no gap at all, hence the 0 floor.
  return Math.max(0, a[lo] - b[hi], b[lo] - a[hi]);
}

/** Edge-to-edge gap between two footprints. Piles are areas, not points. */
export function boxGap(a, b) {
  return {
    dx: axisGap(a, b, 'x1', 'x2'),
    dy: axisGap(a, b, 'y1', 'y2'),
    dz: Math.abs(a.z - b.z),
  };
}

/**
 * In-plane walking distance. DF units move diagonally for the same cost as
 * orthogonally, so the tile count between two footprints is the Chebyshev
 * gap — Euclidean would overstate every diagonal haul.
 */
export function walk(a, b) {
  const { dx, dy } = boxGap(a, b);
  return Math.max(dx, dy);
}

/** Straight-line gap, for the "how far apart are these really" readout. */
export function straight(a, b) {
  const { dx, dy } = boxGap(a, b);
  return Math.hypot(dx, dy);
}

/** The one number the whole view is built on: a haul's cost in tiles. */
export function haulCost(a, b, zPenalty = DEFAULT_Z_PENALTY) {
  const { dx, dy, dz } = boxGap(a, b);
  return Math.max(dx, dy) + zPenalty * dz;
}

// Bands are absolute rather than relative to the fort: a 40-tile haul is a
// long walk whether or not the rest of the fort is worse.
export const COST_BANDS = [
  { key: 'tight', label: 'tight', max: 8 },
  { key: 'fine', label: 'fine', max: 20 },
  { key: 'long', label: 'long', max: 40 },
  { key: 'severe', label: 'severe', max: Infinity },
];

export function costBand(cost) {
  return COST_BANDS.find((b) => cost <= b.max) || COST_BANDS[COST_BANDS.length - 1];
}

export function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Resolve `{from,to}` ids against a node map and attach the cost model.
 * Links pointing at something filtered out are dropped.
 */
export function measureLinks(links, nodeById, zPenalty) {
  const out = [];
  for (const link of links) {
    const a = nodeById.get(link.from);
    const b = nodeById.get(link.to);
    if (!a || !b) continue;
    const { dx, dy, dz } = boxGap(a, b);
    const plan = Math.max(dx, dy);
    const cost = plan + zPenalty * dz;
    out.push({
      from: link.from, to: link.to, a, b,
      plan, dz, cost, band: costBand(cost).key,
      // Items sitting at the source are a rough stand-in for traffic: a full
      // pile feeding a distant shop costs more dwarf-hours than an empty one.
      load: cost * Math.max(1, a.item_count || 0),
    });
  }
  return out;
}

export function summarise(measured, zPenalty) {
  const costs = measured.map((l) => l.cost).sort((a, b) => a - b);
  const vertical = measured.reduce((sum, l) => sum + zPenalty * l.dz, 0);
  const total = measured.reduce((sum, l) => sum + l.cost, 0);
  return {
    count: measured.length,
    total,
    median: quantile(costs, 0.5),
    p90: quantile(costs, 0.9),
    max: costs.length ? costs[costs.length - 1] : 0,
    verticalShare: total ? vertical / total : 0,
    load: measured.reduce((sum, l) => sum + l.load, 0),
    worst: [...measured].sort((a, b) => b.cost - a.cost).slice(0, 5),
    histogram: COST_BANDS.map((band) => ({
      ...band,
      count: measured.filter((l) => l.band === band.key).length,
    })),
  };
}

/**
 * Group nodes into pods of mutually close neighbours — this is what "grouped
 * by distance" means on screen: one pod is one place in the fort.
 *
 * Complete linkage, not single: a node joins a pod only when it is within
 * `radius` of *every* member. Single linkage chains a whole z level into one
 * blob as soon as the piles form a line, which is exactly the case in a
 * fortress corridor. Seeded west-to-east so the result is deterministic.
 */
export function clusterByProximity(nodes, radius) {
  const remaining = [...nodes].sort((a, b) =>
    centroid(a).x - centroid(b).x || centroid(a).y - centroid(b).y);
  const pods = [];
  while (remaining.length) {
    const pod = [remaining.shift()];
    for (let i = 0; i < remaining.length;) {
      if (pod.every((member) => walk(member, remaining[i]) <= radius)) {
        pod.push(remaining.splice(i, 1)[0]);
      } else {
        i++;
      }
    }
    pods.push(pod);
  }
  return pods;
}

/** Closest other node, by walking cost. Used for the isolation readout. */
export function nearestNeighbour(node, others, zPenalty) {
  let best = null;
  for (const other of others) {
    if (other.id === node.id) continue;
    const cost = haulCost(node, other, zPenalty);
    if (!best || cost < best.cost) best = { node: other, cost };
  }
  return best;
}
