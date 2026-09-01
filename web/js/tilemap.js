// The floor plan: decoding the snapshot's tile section, and the two
// questions worth asking of it.
//
// Pure, like `geometry.js` and `flow.js` — nothing here touches the DOM, so
// the map can be checked with `node` against a snapshot before a browser is
// involved. The view owns the drawing; this owns the arithmetic.

import { asList } from './util.js';

/**
 * Expand one `value, count, value, count, …` run into a typed array.
 *
 * The dumper encodes this way because a fort is overwhelmingly undug rock
 * and undug rock is one long run: a quarter of a million tiles arrive as
 * about sixteen thousand numbers.
 */
export function inflate(runs, size, Type = Int32Array) {
  const out = new Type(size);
  let at = 0;
  for (let i = 0; i + 1 < runs.length; i += 2) {
    const value = runs[i];
    const end = Math.min(size, at + runs[i + 1]);
    if (value !== 0) out.fill(value, at, end);
    at = end;
  }
  return out;
}

/**
 * The snapshot's tile section, indexed.
 *
 * Returns null for a snapshot taken before the tile dumper landed, which is
 * what `Db#hasTiles` reports.
 */
export function buildTileMap(tiles) {
  if (!tiles || !Array.isArray(tiles.levels) || !tiles.levels.length) return null;

  const width = tiles.width;
  const height = tiles.height;
  const size = width * height;
  const legend = new Map(asList(tiles.legend).map((c) => [c.code, c]));

  const levels = tiles.levels
    .map((level) => ({
      z: level.z,
      buildings: level.buildings || 0,
      nodes: level.nodes || 0,
      walkable: level.walkable || 0,
      constructed: level.constructed || 0,
      terrain: inflate(asList(level.terrain), size, Uint8Array),
      owner: inflate(asList(level.owner), size, Int32Array),
    }))
    // Highest first, the order DF's own z-axis reads and the order the
    // strata diagram already uses.
    .sort((a, b) => b.z - a.z);

  const byZ = new Map(levels.map((level) => [level.z, level]));

  return {
    x1: tiles.x1,
    y1: tiles.y1,
    x2: tiles.x2,
    y2: tiles.y2,
    width,
    height,
    size,
    legend,
    levels,
    droppedLevels: tiles.dropped_levels || 0,

    /** Is this map coordinate inside the plan at all? */
    covers(x, y) {
      return x >= tiles.x1 && x <= tiles.x2 && y >= tiles.y1 && y <= tiles.y2;
    },

    /** Row-major index for a map coordinate, or -1 if outside the plan. */
    index(x, y) {
      if (!this.covers(x, y)) return -1;
      return (y - tiles.y1) * width + (x - tiles.x1);
    },

    levelAt: (z) => byZ.get(z) || null,

    /** The class entry — `key`, `walk`, `connects` — for a tile code. */
    classOf: (code) => legend.get(code) || legend.get(0),
  };
}

/**
 * Connected walkable regions on one level.
 *
 * This is the question a plan is for and a list of bounding boxes cannot
 * answer: two piles ten tiles apart with a wall between them are not ten
 * tiles apart. Movement is eight-way because DF's diagonals are free —
 * the same reason `geometry.js` measures in Chebyshev distance.
 *
 * It is deliberately **one level only**. A region with no stair and no ramp
 * in it is cut off *on this level*; it may still be reached from above, and
 * the caller has to say so rather than claim the fort is broken. Only the
 * building levels are dumped, so there is no honest vertical adjacency to
 * walk even if this wanted to.
 */
export function regions(map, level) {
  const { width, height, size } = map;
  const label = new Int32Array(size).fill(-1);
  const list = [];
  const queue = new Int32Array(size);

  for (let start = 0; start < size; start += 1) {
    if (label[start] !== -1) continue;
    if (!map.classOf(level.terrain[start]).walk) continue;

    const id = list.length;
    const region = { id, tiles: 0, exits: 0, owners: new Set() };
    label[start] = id;
    queue[0] = start;
    let head = 0;
    let tail = 1;

    while (head < tail) {
      const at = queue[head];
      head += 1;
      region.tiles += 1;
      if (map.classOf(level.terrain[at]).connects) region.exits += 1;
      const owner = level.owner[at];
      if (owner) region.owners.add(owner);

      const cx = at % width;
      const cy = (at - cx) / width;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = cy + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = cx + dx;
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= width) continue;
          const next = ny * width + nx;
          if (label[next] !== -1) continue;
          if (!map.classOf(level.terrain[next]).walk) continue;
          label[next] = id;
          queue[tail] = next;
          tail += 1;
        }
      }
    }
    list.push(region);
  }

  list.sort((a, b) => b.tiles - a.tiles);
  return { label, regions: list, byId: new Map(list.map((r) => [r.id, r])) };
}

// A region smaller than this is a closet, a stairwell landing or a bit of
// carved-out nothing; calling it a stranded pocket is noise.
export const POCKET_MIN = 4;

/**
 * Which buildings on this level share floor with which.
 *
 * `groups` is one entry per walkable region that holds a building, largest
 * first. `stranded` names the buildings whose region has no stair and no
 * ramp — nothing walks off that floor without going through a wall, so
 * either they are reached from a level this plan does not cover, or they
 * are genuinely sealed in.
 */
export function reachability(map, level) {
  const { label, regions: list } = regions(map, level);
  const groups = list
    .filter((region) => region.owners.size)
    .map((region) => ({
      id: region.id,
      tiles: region.tiles,
      exits: region.exits,
      buildings: [...region.owners],
    }));

  const stranded = groups
    .filter((group) => group.exits === 0 && group.tiles >= POCKET_MIN)
    .flatMap((group) => group.buildings);

  return { label, groups, areas: list.length, stranded: new Set(stranded) };
}

/**
 * Every tile a building owns on this level, and the box around them.
 *
 * The box in `stockpiles[]` is the bounding box; a painted pile fills less
 * of it than that, which is exactly what the owner mask is for.
 */
export function footprints(map, level) {
  const out = new Map();
  const { width } = map;
  for (let at = 0; at < level.owner.length; at += 1) {
    const id = level.owner[at];
    if (!id) continue;
    let entry = out.get(id);
    if (!entry) {
      entry = {
        id, tiles: [], x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity,
      };
      out.set(id, entry);
    }
    const x = map.x1 + (at % width);
    const y = map.y1 + ((at - (at % width)) / width);
    entry.tiles.push(at);
    if (x < entry.x1) entry.x1 = x;
    if (x > entry.x2) entry.x2 = x;
    if (y < entry.y1) entry.y1 = y;
    if (y > entry.y2) entry.y2 = y;
  }
  for (const entry of out.values()) {
    entry.cx = (entry.x1 + entry.x2 + 1) / 2;
    entry.cy = (entry.y1 + entry.y2 + 1) / 2;
  }
  return out;
}

/** Headline figures for one level, for the strip above the plan. */
export function summariseLevel(map, level) {
  const counts = new Map();
  for (let at = 0; at < level.terrain.length; at += 1) {
    const key = map.classOf(level.terrain[at]).key;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const known = level.terrain.length - (counts.get('unknown') || 0);
  return {
    counts,
    known,
    walkable: level.walkable,
    constructed: level.constructed,
    buildings: level.buildings,
  };
}
