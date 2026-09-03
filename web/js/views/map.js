// Map view: the fortress floor plan, one level at a time.
//
// The strata diagram compresses every level onto one screen and pays for it
// with a layout that is nobody's real geometry — pods at a centroid, map Y
// squeezed into a nudge. This view is the other half of that trade: one
// level, drawn where it actually is, so what you learn here transfers
// straight back to the game's own screen.
//
// Everything it knows about walls and floors comes from `snapshot.tiles`;
// everything it knows about what is *in* them comes from the same
// stockpile and workshop records the other views read.

import { h, clear, plural, pct, asList } from '../util.js';
import { reachability, footprints, summariseLevel } from '../tilemap.js';
import { isFull, fillRatio, isQuantum } from '../flow.js';
import { focus as focusStockpile } from './stockpiles.js';

const state = {
  z: null,
  tile: 0,          // 0 = fit the plan to the panel
  ghost: true,
  links: true,
  labels: true,
  selected: null,
  // Where the scroller was left. A level change rebuilds the whole panel,
  // and without this every step through the fort snaps back to the top-left
  // corner — which makes ctrl-scroll useless at any zoom worth having.
  pan: { x: 0, y: 0 },
};

// Set on every render, so a chip deep in the side panel can move the plan
// to another level without knowing where the view was mounted.
let rerender = () => {};
// Repaint the canvas and the side panel without rebuilding the toolbar.
// Set on every `draw`, so the key handler can clear a selection.
let repaint = () => {};
// One live observer at a time: `draw` runs on every toggle, and an
// observer per redraw would keep every stale canvas alive.
let watching = null;
// One live key handler at a time, for the same reason. The view has no
// unmount hook — `app.js` just empties the container — so the handler
// checks whether its own root is still in the document and retires itself.
let keying = null;

/** Jump here from another view, on the level the building sits on. */
export function focus(id, z) {
  state.selected = id;
  if (typeof z === 'number') state.z = z;
}

// Flat colour per tile class. A plan is read by shape, not by shading, so
// these only have to separate "stood on" from "walked into" from "not
// discovered" — the ladder runs dark for solid, light for open floor.
// The five `connects` classes share the accent, because on a plan they are
// one thing — the way off this level — and which way they go is the
// legend's business, not the eye's.
const TILE_COLOURS = {
  unknown: null,            // left as background: nobody has seen it
  open: '#100f0d',
  floor: '#544d3d',
  floor_built: '#6d6149',
  wall: '#2a2620',
  wall_built: '#403830',
  ramp: '#a37c33',
  ramp_top: '#7d6535',
  stair_up: '#c09338',
  stair_down: '#c09338',
  stair_updown: '#e0ab3f',
  fortification: '#4d4638',
  tree: '#38492f',
  water: '#2b4a63',
  magma: '#8a3218',
};

const PILE_TINT = 'rgba(63, 150, 152, 0.38)';
const SHOP_TINT = 'rgba(217, 164, 65, 0.32)';
const PILE_EDGE = '#7fd4d6';
const SHOP_EDGE = '#d9a441';
const FULL_EDGE = '#cc6440';

// A link partner on another level. Cool for above, violet for below —
// neither is any of the colours the plan already spends on terrain, piles,
// workshops or trouble, so a patch never reads as part of this level.
const ABOVE_EDGE = '#8ec8f5';
const BELOW_EDGE = '#c79bef';
// Tiles of that level's own terrain drawn around the partner. The patch has
// to be big enough to recognise the place by its shape — a bare outline
// floating over this level's rock says where, but not where *in the fort*.
const PATCH_PAD = 5;
// Past this many off-level partners the patches carpet the plan and say
// less than the ▲/▼ count already over the building.
const PATCH_CAP = 8;
// Clear pixels kept between two windows, so a frame never touches a frame.
const WINDOW_GAP = 6;
// Candidate positions carried from one round of the layout to the next.
const SPOT_KEEP = 24;
// Below this much displacement a window is near enough its true place that
// the ghost and the thread back to it would be noise.
const MOVED_MIN = 10;

const LABEL_FONT = '11px "DejaVu Sans", system-ui, sans-serif';
const LABEL_LINE = 14;
const LABEL_PAD = 4;
const LABEL_MAX = 190;
const BADGE_R = 7;

const ZOOMS = [
  { value: 0, label: 'fit' },
  { value: 4, label: '4px' },
  { value: 7, label: '7px' },
  { value: 11, label: '11px' },
  { value: 16, label: '16px' },
];

export function render(root, db) {
  clear(root);
  const map = db.tileMap();
  if (!map) {
    root.append(h('p', { class: 'empty' },
      'This snapshot predates the tile dumper. Hit Refresh to collect the '
      + 'floor plan.'));
    return;
  }

  // Open on the level with the most piles and workshops, not the most
  // buildings: a bedroom floor has six hundred beds and doors on it and
  // nothing this view has anything to say about.
  if (state.z === null || !map.levelAt(state.z)) {
    state.z = map.levels.reduce((best, level) =>
      (level.nodes > best.nodes ? level : best), map.levels[0]).z;
  }

  rerender = () => render(root, db);

  const toolbar = h('div', { class: 'toolbar' });
  const body = h('div', { class: 'view-body' });
  root.append(toolbar, body);

  const redraw = () => draw(body, db, map);

  listenForKeys(body, map);

  toolbar.append(
    h('label', { class: 'field' }, h('span', {}, `Level (${db.elevCaption})`),
      h('div', { class: 'level-pick' },
        h('button', {
          title: 'Up one level — e, or ctrl-scroll on the plan',
          disabled: map.levels[0].z === state.z,
          onclick: () => step(map, -1),
        }, '▲'),
        h('select', {
          onchange: (e) => { state.z = Number(e.target.value); rerender(); },
        }, map.levels.map((level) => h('option', {
          value: level.z,
          selected: level.z === state.z,
          title: `${plural(level.buildings, 'building')} in all, beds and doors included`,
        }, `${db.elevShort(level.z)} · ${level.nodes ? `${level.nodes} piles + shops` : 'nothing stored'}`))),
        h('button', {
          title: 'Down one level — c, or ctrl-scroll on the plan',
          disabled: map.levels[map.levels.length - 1].z === state.z,
          onclick: () => step(map, 1),
        }, '▼'))),
    // Redrawing the plan does not rebuild the toolbar, so these have to
    // restate which of them is on. Marking the class at build time only
    // leaves the highlight stuck on whatever was selected when the view
    // was last mounted.
    h('label', { class: 'field' }, h('span', {}, 'Tile size'),
      h('div', { class: 'segmented' }, zoomButtons(redraw))),
    h('label', { class: 'field check' },
      h('input', {
        type: 'checkbox',
        checked: state.ghost,
        onchange: (e) => { state.ghost = e.target.checked; redraw(); },
      }),
      h('span', {
        title: map.levelAt(state.z - 1)
          ? 'Draw the level directly underneath, faintly, so you can see what you are standing over'
          : 'The plan has no level directly under this one — nothing is built there',
      }, 'Ghost level below',
      map.levelAt(state.z - 1) ? null : h('span', { class: 'muted' }, ' · none'))),
    h('label', { class: 'field check' },
      h('input', {
        type: 'checkbox',
        checked: state.links,
        onchange: (e) => { state.links = e.target.checked; redraw(); },
      }),
      h('span', {
        title: 'Arrows between linked buildings on this level, and — when one'
          + ' is selected — a window onto the level each off-level partner'
          + ' sits on',
      }, 'Links')),
    h('label', { class: 'field check' },
      h('input', {
        type: 'checkbox',
        checked: state.labels,
        onchange: (e) => { state.labels = e.target.checked; redraw(); },
      }),
      h('span', {}, 'Labels')),
    h('span', { class: 'field muted small' },
      h('span', {}, 'ctrl-scroll, e / c, or < / > to change level'),
      h('span', {}, 'click a pile or shop to trace its links · esc clears')),
  );

  redraw();
}

/** Move `delta` entries through the level list — negative is up. */
function step(map, delta) {
  const at = map.levels.findIndex((level) => level.z === state.z);
  const next = map.levels[at + delta];
  if (!next) return;
  state.z = next.z;
  rerender();
}

/**
 * DF's own level keys, on the window rather than the canvas.
 *
 * A canvas cannot take focus without a tabindex, and a plan you have to
 * click before the keys work is a plan whose keys nobody finds. The cost is
 * a listener outliving the view, which is what the `isConnected` check is
 * for — `app.js` empties the container and never tells anyone.
 *
 * The thing it watches has to be an element this view made. `app.js` hands
 * every view the same container and only empties it, so a container that is
 * still in the document says nothing about which view is on screen — and a
 * map that keeps stepping levels while you are reading the Skills table is
 * what that mistake looks like.
 */
function listenForKeys(body, map) {
  if (keying) window.removeEventListener('keydown', keying);
  keying = (event) => {
    if (!body.isConnected) {
      window.removeEventListener('keydown', keying);
      keying = null;
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    // Never eat a keystroke meant for a filter box or the level select's
    // own type-ahead. A button is not on that list: clicking ▲ leaves the
    // focus on it, and keys that stop working after one click would be
    // worse than no keys at all.
    if (target && (target.isContentEditable
      || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName))) return;

    if (event.key === 'e' || event.key === '<') step(map, -1);
    else if (event.key === 'c' || event.key === '>') step(map, 1);
    else if (event.key === 'Escape' && state.selected !== null) {
      state.selected = null;
      repaint();
    } else return;
    event.preventDefault();
  };
  window.addEventListener('keydown', keying);
}

function zoomButtons(redraw) {
  const buttons = ZOOMS.map((zoom) => h('button', {
    class: state.tile === zoom.value ? 'active' : '',
    onclick: () => {
      state.tile = zoom.value;
      for (const [at, button] of buttons.entries()) {
        button.className = ZOOMS[at].value === state.tile ? 'active' : '';
      }
      redraw();
    },
  }, zoom.label));
  return buttons;
}

function draw(body, db, map) {
  clear(body);
  const level = map.levelAt(state.z);
  // Only the level *immediately* under this one. The plan skips levels
  // nothing is built on, so the next entry in the list can be ten z down —
  // ghosting that would draw a floor the player is nowhere near standing on.
  const below = map.levelAt(state.z - 1);
  const prints = footprints(map, level);
  const reach = reachability(map, level);
  const stats = summariseLevel(map, level);

  // Footprints for the levels a link reaches onto, worked out once per
  // level and only when something asks. Most selections touch one or two.
  const printCache = new Map([[level.z, prints]]);
  const printsAt = (z) => {
    if (!printCache.has(z)) {
      const other = map.levelAt(z);
      printCache.set(z, other ? footprints(map, other) : new Map());
    }
    return printCache.get(z);
  };

  body.append(headline(db, map, level, stats, reach, prints));

  const canvas = h('canvas', { class: 'plan' });
  const tooltip = h('div', { class: 'plan-tip', hidden: true });
  const scroller = h('div', { class: 'plan-scroll' }, canvas, tooltip);
  const side = h('aside', { class: 'plan-side' });

  body.append(h('div', { class: 'plan-wrap' }, scroller, side));
  body.append(legend(db, map, level, stats));

  // The canvas has to be in the document before it can be measured, and
  // the fit zoom is a function of the space it actually got.
  const paint = () => {
    const scale = tileSize(scroller, map);
    paintPlan(canvas, db, map, level, below, prints, printsAt, reach, scale);
  };
  paint();
  if (watching) watching.disconnect();
  watching = new ResizeObserver(() => { if (!state.tile) paint(); });
  watching.observe(scroller);

  repaint = () => { paint(); drawSide(side, db, level, prints, reach); };

  // A level change rebuilds this element, so the scroll position has to be
  // carried over by hand or every step lands back at the top-left corner.
  scroller.scrollLeft = state.pan.x;
  scroller.scrollTop = state.pan.y;
  scroller.addEventListener('scroll', () => {
    state.pan = { x: scroller.scrollLeft, y: scroller.scrollTop };
  });

  // Ctrl-scroll changes level, the way DF's own map does. The listener has
  // to be non-passive: without `preventDefault` the browser reads it as a
  // page zoom and the fort comes out twice the size instead.
  scroller.addEventListener('wheel', (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    if (wheelStep(event.deltaY)) step(map, event.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  const locate = (event) => {
    const scale = tileSize(scroller, map);
    const rect = canvas.getBoundingClientRect();
    const x = map.x1 + Math.floor((event.clientX - rect.left) / scale);
    const y = map.y1 + Math.floor((event.clientY - rect.top) / scale);
    return map.covers(x, y) ? { x, y, at: map.index(x, y) } : null;
  };

  canvas.addEventListener('mousemove', (event) => {
    const spot = locate(event);
    if (!spot) {
      tooltip.hidden = true;
      return;
    }
    clear(tooltip);
    tooltip.hidden = false;
    tooltip.style.left = `${event.offsetX + 14}px`;
    tooltip.style.top = `${event.offsetY + 14}px`;
    const node = db.nodeById.get(level.owner[spot.at]);
    tooltip.append(
      h('strong', {}, node ? node.name : map.classOf(level.terrain[spot.at]).key),
      h('span', { class: 'muted' },
        ` ${spot.x}, ${spot.y}, ${db.elevLabel(level.z)}`),
      node ? h('em', {}, map.classOf(level.terrain[spot.at]).key) : null);
  });
  canvas.addEventListener('mouseleave', () => { tooltip.hidden = true; });
  canvas.addEventListener('click', (event) => {
    const spot = locate(event);
    const id = spot ? level.owner[spot.at] : 0;
    state.selected = id && id !== state.selected ? id : null;
    paint();
    drawSide(side, db, level, prints, reach);
  });

  drawSide(side, db, level, prints, reach);
}

// One mouse notch is 100-ish pixels of delta and one trackpad flick is a
// dozen events of three, so a level per event would either crawl or fly.
// Accumulate instead, and reset on a change of direction so a reversal
// starts from scratch rather than from whatever was left over.
const WHEEL_STEP = 45;
let wheelAcc = 0;

function wheelStep(delta) {
  if (delta === 0) return false;
  if (Math.sign(delta) !== Math.sign(wheelAcc)) wheelAcc = 0;
  wheelAcc += delta;
  if (Math.abs(wheelAcc) < WHEEL_STEP) return false;
  wheelAcc = 0;
  return true;
}

/** Pixels per tile: whatever the panel can give, or the pinned size. */
function tileSize(scroller, map) {
  if (state.tile) return state.tile;
  const room = Math.max(240, scroller.clientWidth - 2);
  return Math.max(2, Math.min(14, Math.floor(room / map.width)));
}

// -------------------------------------------------------------- the canvas

function paintPlan(canvas, db, map, level, below, prints, printsAt, reach, scale) {
  const width = map.width * scale;
  const height = map.height * scale;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (state.ghost && below) paintTerrain(ctx, map, below, scale, 0.22);
  paintTerrain(ctx, map, level, scale, 1);
  paintOwners(ctx, db, map, level, scale);
  paintOutlines(ctx, db, map, level, prints, reach, scale);
  if (state.links) paintLinks(ctx, db, map, level, prints, scale);
  if (state.labels && scale >= 5) paintLabels(ctx, db, prints, map, scale);
  // Last, because it is a layer over this level rather than part of it.
  if (state.links) paintOffLevel(ctx, db, map, level, prints, printsAt, scale);
}

/** Colour per tile *code*, resolved once against the snapshot's legend. */
function palette(map) {
  const out = [];
  for (const [code, cls] of map.legend) out[code] = TILE_COLOURS[cls.key] || null;
  return out;
}

/**
 * Terrain, optionally clipped to one window of the box.
 *
 * `area` is in grid coordinates — indices into the plan's box, not map
 * coordinates — because that is what the fill loop and the owner mask both
 * work in. Absent, it paints the whole level.
 */
function paintTerrain(ctx, map, level, scale, alpha, area) {
  ctx.globalAlpha = alpha;
  const { width, height } = map;
  const gx1 = area ? area.gx1 : 0;
  const gx2 = area ? area.gx2 : width - 1;
  const gy1 = area ? area.gy1 : 0;
  const gy2 = area ? area.gy2 : height - 1;
  const colours = palette(map);
  // One pass per colour: a dozen fillStyle changes for ten thousand tiles
  // rather than ten thousand, which is the difference between a smooth
  // level change and a visible stutter.
  for (let code = 0; code < colours.length; code += 1) {
    if (!colours[code]) continue;
    ctx.fillStyle = colours[code];
    for (let gy = gy1; gy <= gy2; gy += 1) {
      const row = gy * width;
      for (let gx = gx1; gx <= gx2; gx += 1) {
        if (level.terrain[row + gx] !== code) continue;
        ctx.fillRect(gx * scale, gy * scale, scale, scale);
      }
    }
  }
  ctx.globalAlpha = 1;
}

function paintOwners(ctx, db, map, level, scale) {
  const { width } = map;
  for (let at = 0; at < level.owner.length; at += 1) {
    const id = level.owner[at];
    if (!id) continue;
    const node = db.nodeById.get(id);
    ctx.fillStyle = node && node.node === 'workshop' ? SHOP_TINT : PILE_TINT;
    const cx = at % width;
    ctx.fillRect(cx * scale, ((at - cx) / width) * scale, scale, scale);
  }
}

/**
 * An outline around each building's real tiles.
 *
 * Drawn edge by edge rather than as a box: a painted stockpile is not a
 * rectangle — 11 of Shieldclosed's 61 are not — and drawing its bounding
 * box is precisely the lie this view exists to stop telling.
 */
function paintOutlines(ctx, db, map, level, prints, reach, scale) {
  ctx.lineWidth = Math.max(1, scale >= 8 ? 1.5 : 1);

  for (const [id, print] of prints) {
    const node = db.nodeById.get(id);
    const pile = node && node.node === 'stockpile';
    let colour = pile ? PILE_EDGE : SHOP_EDGE;
    if (pile && isFull(node)) colour = FULL_EDGE;
    if (reach.stranded.has(id)) colour = FULL_EDGE;
    const selected = state.selected === id;
    ctx.strokeStyle = selected ? '#fff6e2' : colour;
    ctx.lineWidth = selected ? 2.5 : ctx.lineWidth;

    tracePrint(ctx, map, level.owner, id, print, scale);
    ctx.stroke();
    ctx.lineWidth = Math.max(1, scale >= 8 ? 1.5 : 1);
  }
}

/** The outline path around one building's tiles, ready to stroke. */
function tracePrint(ctx, map, owner, id, print, scale) {
  const { width, height } = map;
  ctx.beginPath();
  for (const at of print.tiles) {
    const cx = at % width;
    const cy = (at - cx) / width;
    const px = cx * scale;
    const py = cy * scale;
    // Only the edges that face a tile this building does not own.
    if (cy === 0 || owner[at - width] !== id) {
      ctx.moveTo(px, py); ctx.lineTo(px + scale, py);
    }
    if (cy === height - 1 || owner[at + width] !== id) {
      ctx.moveTo(px, py + scale); ctx.lineTo(px + scale, py + scale);
    }
    if (cx === 0 || owner[at - 1] !== id) {
      ctx.moveTo(px, py); ctx.lineTo(px, py + scale);
    }
    if (cx === width - 1 || owner[at + 1] !== id) {
      ctx.moveTo(px + scale, py); ctx.lineTo(px + scale, py + scale);
    }
  }
}

/**
 * Links, in map space.
 *
 * A link with both ends on this level is a line you can follow. A link with
 * one end elsewhere is a count at the building, not a line to nowhere —
 * the plan cannot draw where it goes and should not pretend to.
 */
function paintLinks(ctx, db, map, level, prints, scale) {
  const point = (print) => ({
    x: (print.cx - map.x1) * scale,
    y: (print.cy - map.y1) * scale,
  });
  const offLevel = new Map();

  ctx.strokeStyle = '#8c7a55';
  ctx.fillStyle = '#8c7a55';
  ctx.lineWidth = 1.2;

  for (const link of db.links) {
    const from = prints.get(link.from);
    const to = prints.get(link.to);
    const focused = state.selected
      && (link.from === state.selected || link.to === state.selected);
    if (from && to) {
      const a = point(from);
      const b = point(to);
      ctx.save();
      if (focused) {
        ctx.strokeStyle = '#fff6e2';
        ctx.lineWidth = 2;
      } else if (state.selected) {
        ctx.globalAlpha = 0.25;
      }
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      arrowHead(ctx, a, b, Math.max(4, scale * 0.7));
      ctx.restore();
      continue;
    }
    // One end on this level, one somewhere else.
    const here = from ? link.from : (to ? link.to : null);
    if (here === null) continue;
    const other = db.nodeById.get(from ? link.to : link.from);
    if (!other) continue;
    if (!offLevel.has(here)) offLevel.set(here, { up: 0, down: 0 });
    offLevel.get(here)[other.z > level.z ? 'up' : 'down'] += 1;
  }

  if (scale < 5) return;
  ctx.font = `${Math.min(13, Math.max(9, scale))}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#d9c9a4';
  for (const [id, counts] of offLevel) {
    const at = point(prints.get(id));
    const text = [counts.up ? `▲${counts.up}` : '', counts.down ? `▼${counts.down}` : '']
      .filter(Boolean).join(' ');
    ctx.fillText(text, at.x, at.y - scale);
  }
}

function arrowHead(ctx, a, b, size) {
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const tipX = b.x - Math.cos(angle) * size;
  const tipY = b.y - Math.sin(angle) * size;
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(tipX - Math.sin(angle) * size * 0.4, tipY + Math.cos(angle) * size * 0.4);
  ctx.lineTo(tipX + Math.sin(angle) * size * 0.4, tipY - Math.cos(angle) * size * 0.4);
  ctx.closePath();
  ctx.fill();
}

/**
 * Where a selected building's off-level partners are, drawn in place.
 *
 * A link that leaves the level is the one thing a one-level plan cannot
 * show, and a count over the building — which is all it had — says how many
 * without saying where. So each partner gets a window onto its own level:
 * that level's terrain, in the same map coordinates as everything else, big
 * enough (`PATCH_PAD`) that the shape around it is recognisable as a place
 * in the fort rather than an outline floating in rock.
 *
 * It is a window, not a merge. The patch is a layer *over* this level with
 * its own dashed frame and its own colour per direction, because the tiles
 * inside it are somewhere the dwarf standing here cannot walk to — the plan
 * would be lying if the two blended.
 *
 * Windows from different levels can want the same pixels, and stacked they
 * are worth less than either alone. `layOut` keeps each one where it really
 * is when that spot is free and moves it the shortest way that clears the
 * others when it is not; a window that moved draws its buildings' true
 * extents and a thread back to them, so the plan never quietly relocates a
 * pile.
 */
function paintOffLevel(ctx, db, map, level, prints, printsAt, scale) {
  const anchor = state.selected && prints.get(state.selected);
  if (!anchor) return;

  const { inbound, outbound } = db.linksOf(state.selected);
  const seen = new Set();
  const partners = [];
  for (const [links, dir, pick] of [
    [outbound, 'out', (l) => l.to], [inbound, 'in', (l) => l.from]]) {
    for (const link of links) {
      const id = pick(link);
      if (seen.has(id)) continue;
      const node = db.nodeById.get(id);
      if (!node || node.z === level.z) continue;
      const other = map.levelAt(node.z);
      const print = other ? printsAt(node.z).get(id) : null;
      const area = patchArea(map, node, print);
      if (!area) continue;
      seen.add(id);
      partners.push({ node, dir, other, print, area });
    }
  }
  if (!partners.length) return;

  const from = {
    x: (anchor.cx - map.x1) * scale,
    y: (anchor.cy - map.y1) * scale,
  };
  const centre = (partner) => (partner.print
    ? { x: (partner.print.cx - map.x1) * scale, y: (partner.print.cy - map.y1) * scale }
    : {
      x: ((partner.area.gx1 + partner.area.gx2 + 1) / 2) * scale,
      y: ((partner.area.gy1 + partner.area.gy2 + 1) / 2) * scale,
    });
  const reach = (partner) => {
    const at = centre(partner);
    return Math.hypot(at.x - from.x, at.y - from.y);
  };
  // Nearest first, so the cap keeps the partners a reader can place.
  partners.sort((a, b) => reach(a) - reach(b));
  const shown = partners.slice(0, PATCH_CAP);

  // One window per level, not per building. Two partners on the same floor
  // that fall in each other's padding merge into a single window, because
  // that is one continuous piece of that floor and drawing it as two
  // overlapping frames invents a seam the fort does not have.
  const byLevel = new Map();
  for (const partner of shown) {
    if (!byLevel.has(partner.node.z)) byLevel.set(partner.node.z, []);
    byLevel.get(partner.node.z).push(partner);
  }
  const windows = [];
  for (const [z, group] of byLevel) {
    for (const win of mergeAreas(group)) {
      windows.push({
        ...win,
        z,
        colour: z > level.z ? ABOVE_EDGE : BELOW_EDGE,
        other: map.levelAt(z),
        box: pixels(win, scale),
        label: labelBlock(ctx, db, win, z, level.z),
      });
    }
  }

  // Windows keep their true place when they can and are moved when they
  // cannot. Nearest level first, so the floor just under your feet is the
  // one that stays put and the far ones give way.
  windows.sort((a, b) => Math.abs(a.z - level.z) - Math.abs(b.z - level.z));
  layOut(windows, map.width * scale, map.height * scale, anchorGuard(anchor, map, scale));

  // Furthest first, so a nearer floor is the one on top wherever the layout
  // could not pull two windows fully apart.
  const drawn = [...windows]
    .sort((a, b) => Math.abs(b.z - level.z) - Math.abs(a.z - level.z));

  for (const win of drawn) {
    const { box, colour, dx, dy } = win;
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x + dx, box.y + dy, box.w, box.h);
    ctx.clip();
    // Push this level back rather than paint it out. The other floor's
    // tiles go on at full strength on top, so nothing reads as a blend;
    // what survives underneath shows through the window's *undiscovered*
    // tiles, which the plan draws as nothing on every level — and a
    // window with no landmark left in it is one nobody can place.
    ctx.fillStyle = 'rgba(6, 6, 8, 0.78)';
    ctx.fillRect(box.x + dx, box.y + dy, box.w, box.h);
    ctx.translate(dx, dy);
    if (win.other) paintTerrain(ctx, map, win.other, scale, 1, win);
    for (const partner of win.members) paintPartner(ctx, map, partner, colour, scale);
    if (win.members.length > 1) {
      // Which one is which. The same numbers head the window's own list, so
      // a window holding four piles is still four named piles.
      win.members.forEach((partner, at) => {
        const spot = centre(partner);
        badge(ctx, spot.x, spot.y, at + 1, colour, Math.max(5, Math.min(BADGE_R, scale)));
      });
    }
    ctx.restore();

    ctx.save();
    ctx.setLineDash([5, 3]);
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.4;
    ctx.strokeRect(box.x + dx + 0.5, box.y + dy + 0.5, box.w - 1, box.h - 1);
    ctx.restore();
  }

  // A window that had to move says where it really is: its buildings' true
  // extents, and a thread back to them. Without this the plan would be
  // quietly drawing a pile somewhere it is not.
  ctx.save();
  for (const win of drawn) {
    if (Math.hypot(win.dx, win.dy) < MOVED_MIN) continue;
    ctx.strokeStyle = win.colour;
    ctx.globalAlpha = 0.75;
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    for (const partner of win.members) {
      const spot = extent(partner, map, scale);
      ctx.strokeRect(spot.x, spot.y, spot.w, spot.h);
    }
    const home = { x: win.box.x + win.box.w / 2, y: win.box.y + win.box.h / 2 };
    const moved = { x: home.x + win.dx, y: home.y + win.dy };
    ctx.setLineDash([1, 4]);
    ctx.beginPath();
    ctx.moveTo(home.x, home.y);
    const edge = entryPoint(home, moved, {
      x: win.box.x + win.dx, y: win.box.y + win.dy, w: win.box.w, h: win.box.h,
    });
    ctx.lineTo(edge.x, edge.y);
    ctx.stroke();
  }
  ctx.restore();

  // Connectors over every window, so a line into the far one is not buried
  // under the near one. They run to where the partner really is, not to
  // where its window was put. The head sits on the end goods arrive at.
  ctx.save();
  ctx.setLineDash([5, 3]);
  ctx.lineWidth = 1.6;
  for (const partner of shown) {
    const colour = partner.node.z > level.z ? ABOVE_EDGE : BELOW_EDGE;
    const to = centre(partner);
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.save();
    ctx.setLineDash([]);
    const head = Math.max(6, scale * 0.8);
    if (partner.dir === 'out') arrowHead(ctx, from, to, head);
    else arrowHead(ctx, to, from, head);
    ctx.restore();
  }
  ctx.restore();

  // The building you clicked, restated: a window can land on top of it, and
  // a trace whose own starting point is buried is hard to read.
  ctx.strokeStyle = '#fff6e2';
  ctx.lineWidth = 2.5;
  tracePrint(ctx, map, level.owner, state.selected, anchor, scale);
  ctx.stroke();

  // Last of all, over every window: the layout already kept them apart.
  for (const win of drawn) drawLabel(ctx, win);
}

/** Keep windows off the building you clicked. */
function anchorGuard(anchor, map, scale) {
  return {
    x: (anchor.x1 - map.x1) * scale,
    y: (anchor.y1 - map.y1) * scale,
    w: (anchor.x2 - anchor.x1 + 1) * scale,
    h: (anchor.y2 - anchor.y1 + 1) * scale,
  };
}

/** One partner's true extent on the plan, in pixels. */
function extent(partner, map, scale) {
  const { print, node } = partner;
  const box = print
    ? { x1: print.x1, y1: print.y1, x2: print.x2, y2: print.y2 }
    : {
      x1: node.x1, y1: node.y1, x2: node.x2, y2: node.y2,
    };
  return {
    x: (box.x1 - map.x1) * scale,
    y: (box.y1 - map.y1) * scale,
    w: (box.x2 - box.x1 + 1) * scale,
    h: (box.y2 - box.y1 + 1) * scale,
  };
}

/** One partner's tiles inside its window: tinted, then outlined. */
function paintPartner(ctx, map, partner, colour, scale) {
  const { node, print, other } = partner;
  if (other && print) {
    ctx.fillStyle = node.node === 'workshop' ? SHOP_TINT : PILE_TINT;
    for (const at of print.tiles) {
      const cx = at % map.width;
      ctx.fillRect(cx * scale, ((at - cx) / map.width) * scale, scale, scale);
    }
    ctx.strokeStyle = colour;
    ctx.lineWidth = scale >= 8 ? 2 : 1.5;
    tracePrint(ctx, map, other.owner, node.id, print, scale);
    ctx.stroke();
    return;
  }
  // The plan has no level there — only the levels with something built on
  // them are dumped. The bounding box is all this can honestly show.
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(
    (node.x1 - map.x1) * scale, (node.y1 - map.y1) * scale,
    (node.x2 - node.x1 + 1) * scale, (node.y2 - node.y1 + 1) * scale);
}

/** Grid rect → canvas pixels. */
function pixels(area, scale) {
  return {
    x: area.gx1 * scale,
    y: area.gy1 * scale,
    w: (area.gx2 - area.gx1 + 1) * scale,
    h: (area.gy2 - area.gy1 + 1) * scale,
  };
}

/**
 * Fold a level's partner windows into disjoint ones.
 *
 * Two that touch or overlap become the box around both, repeatedly, until
 * none of them meet. They show the same floor, so a merged window is the
 * same picture with one frame instead of two crossing ones.
 */
function mergeAreas(partners) {
  const out = partners.map((partner) => ({ ...partner.area, members: [partner] }));
  for (let merged = true; merged;) {
    merged = false;
    search:
    for (let i = 0; i < out.length; i += 1) {
      for (let j = i + 1; j < out.length; j += 1) {
        const a = out[i];
        const b = out[j];
        if (a.gx1 > b.gx2 + 1 || b.gx1 > a.gx2 + 1) continue;
        if (a.gy1 > b.gy2 + 1 || b.gy1 > a.gy2 + 1) continue;
        out[i] = {
          gx1: Math.min(a.gx1, b.gx1),
          gy1: Math.min(a.gy1, b.gy1),
          gx2: Math.max(a.gx2, b.gx2),
          gy2: Math.max(a.gy2, b.gy2),
          members: [...a.members, ...b.members],
        };
        out.splice(j, 1);
        merged = true;
        break search;
      }
    }
  }
  return out;
}

/** The window of the box to draw for one off-level partner, in grid coords. */
function patchArea(map, node, print) {
  const box = print
    ? { x1: print.x1, y1: print.y1, x2: print.x2, y2: print.y2 }
    : {
      x1: node.x1, y1: node.y1, x2: node.x2, y2: node.y2,
    };
  if (![box.x1, box.y1, box.x2, box.y2].every(Number.isFinite)) return null;
  const clamp = (v, hi) => Math.max(0, Math.min(hi, v));
  return {
    gx1: clamp(box.x1 - map.x1 - PATCH_PAD, map.width - 1),
    gy1: clamp(box.y1 - map.y1 - PATCH_PAD, map.height - 1),
    gx2: clamp(box.x2 - map.x1 + PATCH_PAD, map.width - 1),
    gy2: clamp(box.y2 - map.y1 + PATCH_PAD, map.height - 1),
  };
}

/**
 * The tag on one window: which floor it is, and every building in it.
 *
 * One line each, never a joined-up list: a window holding four piles used to
 * name them in one strip that ran off its own end, which is the same as not
 * naming them. The numbers match the badges drawn on the plan.
 */
function labelBlock(ctx, db, win, z, levelZ) {
  ctx.font = LABEL_FONT;
  const arrow = z > levelZ ? '▲' : '▼';
  const lines = win.members.length === 1
    ? [{ text: `${arrow} ${db.elevLabel(z)} · ${win.members[0].node.name}` }]
    : [
      { text: `${arrow} ${db.elevLabel(z)}` },
      ...win.members.map((partner, at) => ({
        badge: at + 1,
        text: fit(ctx, partner.node.name, LABEL_MAX) || partner.node.name,
      })),
    ];
  const width = Math.max(...lines.map((line) =>
    ctx.measureText(line.text).width + (line.badge ? BADGE_R * 2 + 3 : 0)));
  return {
    lines,
    w: Math.ceil(width) + LABEL_PAD * 2,
    h: lines.length * LABEL_LINE + LABEL_PAD * 2,
  };
}

function drawLabel(ctx, win) {
  const { label, colour } = win;
  const x = win.box.x + win.dx;
  const y = win.box.y + win.dy - label.h;
  ctx.save();
  ctx.fillStyle = 'rgba(10, 9, 7, 0.92)';
  ctx.fillRect(x, y, label.w, label.h);
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, label.w - 1, label.h - 1);
  ctx.font = LABEL_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  let row = y + LABEL_PAD;
  for (const line of label.lines) {
    if (line.badge) {
      badge(ctx, x + LABEL_PAD + BADGE_R, row + LABEL_LINE / 2, line.badge, colour);
      ctx.fillStyle = '#e8e0d0';
      ctx.fillText(line.text, x + LABEL_PAD + BADGE_R * 2 + 3, row);
    } else {
      ctx.fillStyle = colour;
      ctx.fillText(line.text, x + LABEL_PAD, row);
    }
    row += LABEL_LINE;
  }
  ctx.restore();
}

/**
 * A numbered disc, on the plan and in the window's own list.
 *
 * On the plan it shrinks with the tile size — at 4px a fixed disc is wider
 * than the pile it is naming.
 */
function badge(ctx, x, y, number, colour, radius = BADGE_R) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = colour;
  ctx.fill();
  ctx.strokeStyle = 'rgba(10, 9, 7, 0.9)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = '#100f0d';
  ctx.font = `bold ${BADGE_R + 2}px "DejaVu Sans", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(number), x, y);
  ctx.restore();
}

/**
 * Put the windows down so none of them covers another.
 *
 * Each keeps its true position when that position is free — which is the
 * whole point of drawing them in map space — and is moved the shortest way
 * that clears everything already placed when it is not. `keepClear` is the
 * building you clicked, which no window may sit on.
 *
 * A window's box includes its label, so the tags cannot collide either.
 */
function layOut(windows, canvasW, canvasH, keepClear) {
  const placed = keepClear ? [keepClear] : [];
  for (const win of windows) {
    const want = {
      x: win.box.x,
      y: win.box.y - win.label.h,
      w: Math.max(win.box.w, win.label.w),
      h: win.box.h + win.label.h,
    };
    const spot = findSpot(want, placed, canvasW, canvasH);
    win.dx = spot.x - want.x;
    win.dy = spot.y - want.y;
    placed.push({ ...want, x: spot.x, y: spot.y });
  }
}

/**
 * The free position nearest the one asked for.
 *
 * Candidates are generated by pushing the box clear of each obstacle in turn
 * along one axis, then pushing those results clear again — a handful of
 * rounds is enough for the eight windows this view can draw, and the nearest
 * free candidate wins so a window that has to move barely moves.
 *
 * Each round multiplies the frontier by four per obstacle, so it is cut back
 * to the `SPOT_KEEP` nearest survivors. Without that, a plan with no room
 * left on it reaches the last round with a million candidates and takes the
 * whole tab down with it.
 */
function findSpot(want, placed, canvasW, canvasH) {
  const inside = (x, y) => ({
    x: Math.max(0, Math.min(x, canvasW - want.w)),
    y: Math.max(0, Math.min(y, canvasH - want.h)),
  });
  const hits = (spot) => placed.some((p) =>
    spot.x < p.x + p.w + WINDOW_GAP && p.x < spot.x + want.w + WINDOW_GAP
    && spot.y < p.y + p.h + WINDOW_GAP && p.y < spot.y + want.h + WINDOW_GAP);
  const gone = (spot) => Math.hypot(spot.x - want.x, spot.y - want.y);

  let best = null;
  const seen = new Set();
  let frontier = [inside(want.x, want.y)];
  for (let round = 0; round < 4 && !best; round += 1) {
    const next = [];
    const push = (spot) => {
      const key = `${Math.round(spot.x)},${Math.round(spot.y)}`;
      if (seen.has(key)) return;
      seen.add(key);
      next.push(spot);
    };
    for (const spot of frontier) {
      if (!hits(spot)) {
        if (!best || gone(spot) < best.gone) best = { ...spot, gone: gone(spot) };
        continue;
      }
      for (const p of placed) {
        push(inside(p.x - want.w - WINDOW_GAP, spot.y));
        push(inside(p.x + p.w + WINDOW_GAP, spot.y));
        push(inside(spot.x, p.y - want.h - WINDOW_GAP));
        push(inside(spot.x, p.y + p.h + WINDOW_GAP));
      }
    }
    next.sort((a, b) => gone(a) - gone(b));
    frontier = next.slice(0, SPOT_KEEP);
  }
  // Nowhere clear — the plan is smaller than the windows want. Overlapping
  // in the right place beats not being drawn.
  return best || inside(want.x, want.y);
}

/** Where a line from `from` to `to` first meets `rect`, or `to`. */
function entryPoint(from, to, rect) {
  const at = (t) => ({
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
  });
  const within = (t) => {
    const spot = at(t);
    return spot.x >= rect.x && spot.x <= rect.x + rect.w
      && spot.y >= rect.y && spot.y <= rect.y + rect.h;
  };
  if (!within(1)) return to;
  let out = 0;
  let hit = 1;
  for (let step = 0; step < 20; step += 1) {
    const mid = (out + hit) / 2;
    if (within(mid)) hit = mid;
    else out = mid;
  }
  return at(out);
}

function paintLabels(ctx, db, prints, map, scale) {
  ctx.font = `${Math.min(12, Math.max(9, scale - 2))}px "DejaVu Sans", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const [id, print] of prints) {
    const node = db.nodeById.get(id);
    if (!node) continue;
    const room = (print.x2 - print.x1 + 1) * scale;
    if (room < 26) continue;
    const text = fit(ctx, node.name, room - 4);
    if (!text) continue;
    const x = (print.cx - map.x1) * scale;
    const y = (print.cy - map.y1) * scale;
    ctx.strokeStyle = 'rgba(10, 9, 7, 0.85)';
    ctx.lineWidth = 3;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = state.selected === id ? '#fff6e2' : '#e8e0d0';
    ctx.fillText(text, x, y);
  }
}

function fit(ctx, text, room) {
  if (ctx.measureText(text).width <= room) return text;
  for (let n = text.length - 1; n > 2; n -= 1) {
    const cut = `${text.slice(0, n)}…`;
    if (ctx.measureText(cut).width <= room) return cut;
  }
  return null;
}

// ------------------------------------------------------------- the panels

function stat(value, label, title) {
  return h('div', { class: 'stat', title: title || null },
    h('div', { class: 'value' }, value),
    h('div', { class: 'label' }, label));
}

function headline(db, map, level, stats, reach, prints) {
  const piles = [...prints.keys()]
    .map((id) => db.nodeById.get(id))
    .filter((node) => node && node.node === 'stockpile');
  const loose = looseHere(db, level.z);

  const strip = h('div', { class: 'stat-strip' },
    stat(db.elevShort(level.z), db.elevCaption,
      `raw z index ${level.z}`),
    stat(String(prints.size), 'piles + shops',
      'stockpiles and workshops with tiles on this level'),
    stat(String(stats.walkable), 'walkable tiles',
      'floor, ramps, stairs and shallow water'),
    stat(String(stats.constructed), 'constructed',
      'floors, walls, stairs and ramps the fort built rather than carved'),
    stat(String(reach.areas), 'floor areas',
      `separate walkable areas on this level — ${reach.groups.length} of them`
      + ' hold a stockpile or a workshop'),
    stat(loose === null ? '—' : String(loose), 'loose items',
      'on the floor here, outside every pile'));

  const notes = [];
  if (reach.stranded.size) {
    const names = [...reach.stranded]
      .map((id) => db.nodeById.get(id))
      .filter(Boolean)
      .map((node) => node.name);
    notes.push(h('p', { class: 'warn-note' },
      `${plural(names.length, 'building')} on floor with no stair or ramp: `,
      names.slice(0, 6).join(', '),
      names.length > 6 ? `, and ${names.length - 6} more` : '',
      h('span', { class: 'muted' },
        ' — reachable from another level, or sealed in. This plan only walks'
        + ' one level, so it cannot tell you which.')));
  }
  if (map.droppedLevels) {
    notes.push(h('p', { class: 'muted' },
      `${plural(map.droppedLevels, 'level')} left out of the plan: the fort's`
      + ' buildings span more of the map than one snapshot should carry.'
      + ' The levels with the most built on them were kept.'));
  }
  return h('div', {}, strip, notes);
}

/** Loose items recorded on this level, or null on a pre-flow snapshot. */
function looseHere(db, z) {
  if (!db.hasFlow) return null;
  let total = 0;
  for (const row of asList(db.flow.loose.by_type)) {
    for (const level of asList(row.levels)) {
      if (level.z === z) total += level.count;
    }
  }
  return total;
}

function legend(db, map, level, stats) {
  const entries = [...map.legend.values()]
    .filter((cls) => TILE_COLOURS[cls.key] && stats.counts.get(cls.key));
  return h('section', { class: 'panel plan-legend' },
    h('h3', {}, 'Legend'),
    h('div', { class: 'swatches' },
      entries.map((cls) => h('span', { class: 'swatch' },
        h('i', { style: `background:${TILE_COLOURS[cls.key]}` }),
        cls.key.replace('_', ' '),
        h('em', {}, ` ${stats.counts.get(cls.key)}`))),
      h('span', { class: 'swatch' },
        h('i', { style: `background:${PILE_TINT}; border-color:${PILE_EDGE}` }),
        'stockpile'),
      h('span', { class: 'swatch' },
        h('i', { style: `background:${SHOP_TINT}; border-color:${SHOP_EDGE}` }),
        'workshop'),
      h('span', { class: 'swatch' },
        h('i', { style: `border-color:${FULL_EDGE}` }),
        'full, or on floor with no way off'),
      h('span', { class: 'swatch', title: 'Shown when you select a building that links off this level' },
        h('i', { style: `border-color:${ABOVE_EDGE}` }),
        'link partner above'),
      h('span', { class: 'swatch', title: 'Shown when you select a building that links off this level' },
        h('i', { style: `border-color:${BELOW_EDGE}` }),
        'link partner below')),
    h('p', { class: 'muted small' },
      'Undiscovered rock is left blank — DF hides it from you, so the plan'
      + ' does too. '
      + (stats.known
        ? `${pct(stats.known / (map.width * map.height))} of this level's box has been seen.`
        : 'Nothing on this level has been seen yet.')));
}

function drawSide(side, db, level, prints, reach) {
  clear(side);
  const node = state.selected && db.nodeById.get(state.selected);
  if (!node) {
    side.append(h('p', { class: 'empty' },
      'Click a stockpile or workshop to inspect it.'));
    return;
  }
  const print = prints.get(node.id);
  const { inbound, outbound } = db.linksOf(node.id);

  side.append(h('h3', {}, node.name),
    h('p', { class: 'muted' },
      node.node === 'stockpile'
        ? `Stockpile ${node.number}`
        : db.buildingCaption(node.kind, node.subtype),
      ` · ${db.elevLabel(node.z)}`));

  const rows = [];
  if (print) {
    rows.push(['Footprint', `${plural(print.tiles.length, 'tile')} in a `
      + `${print.x2 - print.x1 + 1}×${print.y2 - print.y1 + 1} box`]);
    rows.push(['At', `${print.x1}, ${print.y1} – ${print.x2}, ${print.y2}`]);
  }
  if (node.node === 'stockpile') {
    rows.push(['Filled', `${pct(fillRatio(node))} of ${plural(node.area, 'tile')}`
      + (isQuantum(node) ? ' — quantum pile, full by design' : '')]);
    rows.push(['Holding', plural(node.item_count || 0, 'item')]);
    rows.push(['Accepts', plural(asList(node.categories).length, 'category', 'categories')]);
    if (node.incoming_jobs) rows.push(['Incoming', plural(node.incoming_jobs, 'haul job')]);
  } else {
    rows.push(['Jobs', asList(node.jobs).length
      ? asList(node.jobs).join(', ')
      : 'none queued']);
    if (node.held_items) {
      rows.push(['Holding', `${plural(node.held_items, 'item')}`
        + (node.held_top_type
          ? `, mostly ${db.itemCaption(node.held_top_type)}`
          : '')]);
    }
  }
  if (reach.stranded.has(node.id)) {
    rows.push(['Floor', 'no stair or ramp on this walkable area']);
  }

  side.append(h('dl', { class: 'plan-facts' }, rows.map(([key, value]) =>
    [h('dt', {}, key), h('dd', {}, value)])));

  side.append(linkList(db, level, 'Takes from', inbound, (l) => l.from));
  side.append(linkList(db, level, 'Gives to', outbound, (l) => l.to));

  side.append(h('button', {
    class: 'link-btn',
    onclick: () => { focusStockpile(node.id); location.hash = 'stockpiles'; },
  }, 'Show on the cross-section'));
}

function linkList(db, level, title, links, pick) {
  if (!links.length) return h('div', {});
  const away = links.filter((link) => {
    const other = db.nodeById.get(pick(link));
    return other && other.z !== level.z;
  }).length;
  return h('div', { class: 'plan-links' },
    h('h4', {}, title),
    h('div', { class: 'chips' }, links.map((link) => {
      const other = db.nodeById.get(pick(link));
      if (!other) return null;
      const here = other.z === level.z;
      return h('button', {
        class: `chip ${other.node}`,
        title: here ? 'On this level' : 'Outlined on the plan — click to go there',
        onclick: () => {
          state.selected = other.id;
          state.z = other.z;
          rerender();
        },
      },
      here ? '' : (other.z > level.z ? '▲ ' : '▼ '),
      other.name, h('em', {}, ` ${db.elevLabel(other.z)}`));
    })),
    away ? h('p', { class: 'muted small' },
      `${plural(away, 'partner')} on another level, drawn on the plan as a`
      + ' window onto the floor it sits on.') : null);
}
