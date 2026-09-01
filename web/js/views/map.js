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
};

// Set on every render, so a chip deep in the side panel can move the plan
// to another level without knowing where the view was mounted.
let rerender = () => {};
// One live observer at a time: `draw` runs on every toggle, and an
// observer per redraw would keep every stale canvas alive.
let watching = null;

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

  const step = (delta) => {
    const at = map.levels.findIndex((level) => level.z === state.z);
    const next = map.levels[at + delta];
    if (next) {
      state.z = next.z;
      rerender();
    }
  };

  toolbar.append(
    h('label', { class: 'field' }, h('span', {}, `Level (${db.elevCaption})`),
      h('div', { class: 'level-pick' },
        h('button', {
          title: 'Up one level',
          disabled: map.levels[0].z === state.z,
          onclick: () => step(-1),
        }, '▲'),
        h('select', {
          onchange: (e) => { state.z = Number(e.target.value); rerender(); },
        }, map.levels.map((level) => h('option', {
          value: level.z,
          selected: level.z === state.z,
          title: `${plural(level.buildings, 'building')} in all, beds and doors included`,
        }, `${db.elevShort(level.z)} · ${level.nodes ? `${level.nodes} piles + shops` : 'nothing stored'}`))),
        h('button', {
          title: 'Down one level',
          disabled: map.levels[map.levels.length - 1].z === state.z,
          onclick: () => step(1),
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
      h('span', {}, 'Links')),
    h('label', { class: 'field check' },
      h('input', {
        type: 'checkbox',
        checked: state.labels,
        onchange: (e) => { state.labels = e.target.checked; redraw(); },
      }),
      h('span', {}, 'Labels')),
  );

  redraw();
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
    paintPlan(canvas, db, map, level, below, prints, reach, scale);
  };
  paint();
  if (watching) watching.disconnect();
  watching = new ResizeObserver(() => { if (!state.tile) paint(); });
  watching.observe(scroller);

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

/** Pixels per tile: whatever the panel can give, or the pinned size. */
function tileSize(scroller, map) {
  if (state.tile) return state.tile;
  const room = Math.max(240, scroller.clientWidth - 2);
  return Math.max(2, Math.min(14, Math.floor(room / map.width)));
}

// -------------------------------------------------------------- the canvas

function paintPlan(canvas, db, map, level, below, prints, reach, scale) {
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
}

/** Colour per tile *code*, resolved once against the snapshot's legend. */
function palette(map) {
  const out = [];
  for (const [code, cls] of map.legend) out[code] = TILE_COLOURS[cls.key] || null;
  return out;
}

function paintTerrain(ctx, map, level, scale, alpha) {
  ctx.globalAlpha = alpha;
  const { width } = map;
  const colours = palette(map);
  // One pass per colour: a dozen fillStyle changes for ten thousand tiles
  // rather than ten thousand, which is the difference between a smooth
  // level change and a visible stutter.
  for (let code = 0; code < colours.length; code += 1) {
    if (!colours[code]) continue;
    ctx.fillStyle = colours[code];
    for (let at = 0; at < level.terrain.length; at += 1) {
      if (level.terrain[at] !== code) continue;
      const cx = at % width;
      ctx.fillRect(cx * scale, ((at - cx) / width) * scale, scale, scale);
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
  const { width, height } = map;
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

    ctx.beginPath();
    for (const at of print.tiles) {
      const cx = at % width;
      const cy = (at - cx) / width;
      const px = cx * scale;
      const py = cy * scale;
      // Only the edges that face a tile this building does not own.
      if (cy === 0 || level.owner[at - width] !== id) {
        ctx.moveTo(px, py); ctx.lineTo(px + scale, py);
      }
      if (cy === height - 1 || level.owner[at + width] !== id) {
        ctx.moveTo(px, py + scale); ctx.lineTo(px + scale, py + scale);
      }
      if (cx === 0 || level.owner[at - 1] !== id) {
        ctx.moveTo(px, py); ctx.lineTo(px, py + scale);
      }
      if (cx === width - 1 || level.owner[at + 1] !== id) {
        ctx.moveTo(px + scale, py); ctx.lineTo(px + scale, py + scale);
      }
    }
    ctx.stroke();
    ctx.lineWidth = Math.max(1, scale >= 8 ? 1.5 : 1);
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
        'full, or on floor with no way off')),
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
  return h('div', { class: 'plan-links' },
    h('h4', {}, title),
    h('div', { class: 'chips' }, links.map((link) => {
      const other = db.nodeById.get(pick(link));
      if (!other) return null;
      const here = other.z === level.z;
      return h('button', {
        class: `chip ${other.node}`,
        title: here ? 'On this level' : 'Jump to its level',
        onclick: () => {
          state.selected = other.id;
          state.z = other.z;
          rerender();
        },
      }, other.name, h('em', {}, ` ${db.elevLabel(other.z)}`));
    })));
}
