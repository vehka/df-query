// The strata diagram: a cross-section of the fort, one row per z level.
//
// Reading it:
//   · rows run top-down from the highest occupied level to the lowest;
//   · horizontal position is real map X, on one scale shared by every row,
//     so a pod sitting above another pod really is above it;
//   · nodes within a level are grouped into "pods" — everything inside one
//     pod is within the cluster radius of everything else, i.e. one place;
//   · the empty space between pods is annotated with the real walking gap,
//     and the empty space between rows is annotated with the climb;
//   · feed links are drawn as curves coloured by their hauling cost.
//
// Hand-rolled SVG, like graph.js, so the viewer stays dependency-free.

import { clusterByProximity, centroid, walk, costBand } from './geometry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const WIDTH = 1180;
const GUTTER = 66;        // left elevation axis
const PAD_RIGHT = 26;
const PAD_TOP = 40;       // room for the X ruler
const PAD_BOTTOM = 18;
const INNER = WIDTH - GUTTER - PAD_RIGHT;

const CHIP_H = 22;
const CHIP_GAP_X = 5;
const CHIP_GAP_Y = 4;
const CHIP_MIN_W = 46;
const CHIP_MAX_W = 132;
const POD_PAD = 7;
const POD_GAP = 22;       // minimum pixels kept between pods
const POD_MAX_COLS = 6;

const VOID_MIN = 44;      // a collapsed run of empty levels
const NUDGE_MAX = 24;     // how far map Y may push a pod off the row centre
const GAP_LABEL_MIN = 32; // don't label a gap too narrow to hold the number
const FOOT_H = 5;         // the map-footprint strip along the bottom of a row
const FOOT_BLOCK = FOOT_H + 7;

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) el.setAttribute(key, value);
  }
  return el;
}

function text(content, attrs) {
  const el = svgEl('text', attrs);
  el.textContent = content;
  return el;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** No text measurement without a layout pass, so estimate from the label. */
function chipWidth(node) {
  return clamp(26 + node.short.length * 6.3, CHIP_MIN_W, CHIP_MAX_W);
}

// ---------------------------------------------------------------- layout

/**
 * Place pods left-to-right at their map-X anchors, pushing them apart where
 * they would collide. Two passes so a pile-up on the left cannot shove the
 * right-hand pods off the edge.
 */
function resolveOverlaps(pods) {
  const left = GUTTER + 4;
  const right = WIDTH - PAD_RIGHT;
  pods.sort((a, b) => a.anchorX - b.anchorX);

  let cursor = left;
  for (const pod of pods) {
    pod.x = Math.max(pod.anchorX - pod.w / 2, cursor);
    cursor = pod.x + pod.w + POD_GAP;
  }
  // Overflowed the right edge: walk back, clamping from the other side.
  if (cursor - POD_GAP > right) {
    cursor = right;
    for (let i = pods.length - 1; i >= 0; i--) {
      const pod = pods[i];
      pod.x = Math.min(pod.x, cursor - pod.w);
      cursor = pod.x - POD_GAP;
    }
    // …which can push the leftmost pod past the gutter. Squeeze forward.
    cursor = left;
    for (const pod of pods) {
      pod.x = Math.max(pod.x, cursor);
      cursor = pod.x + pod.w + Math.min(POD_GAP, 8);
    }
  }
  return pods;
}

function shapePod(pod, cols) {
  pod.cols = clamp(cols, 1, POD_MAX_COLS);
  pod.rows = Math.ceil(pod.nodes.length / pod.cols);
  pod.w = pod.cols * pod.chipW + (pod.cols - 1) * CHIP_GAP_X + 2 * POD_PAD;
  pod.h = pod.rows * CHIP_H + (pod.rows - 1) * CHIP_GAP_Y + 2 * POD_PAD;
  return pod;
}

function layoutPod(nodes, px, yScale, yMid) {
  // Reading order matches the map: west to east, then north to south.
  const chips = [...nodes].sort((a, b) =>
    centroid(a).x - centroid(b).x || centroid(a).y - centroid(b).y);
  const cs = chips.map(centroid);

  return shapePod({
    nodes: chips,
    chipW: Math.max(...chips.map(chipWidth)),
    anchorX: px(cs.reduce((s, c) => s + c.x, 0) / cs.length),
    // Map Y becomes a small vertical nudge inside the row: enough to read
    // north-from-south, not enough to be mistaken for elevation.
    nudge: clamp((cs.reduce((s, c) => s + c.y, 0) / cs.length - yMid) * yScale,
      -NUDGE_MAX, NUDGE_MAX),
  }, Math.round(Math.sqrt(chips.length)));
}

/**
 * A crowded level can want more width than the diagram has. Squeeze the
 * widest pod into fewer columns (taller, narrower) until the row fits,
 * rather than letting chips run off the right edge.
 */
function fitBand(pods) {
  const available = WIDTH - PAD_RIGHT - GUTTER - 4;
  const used = () => pods.reduce((sum, p) => sum + p.w, 0) + (pods.length - 1) * POD_GAP;
  while (used() > available) {
    const widest = pods.filter((p) => p.cols > 1).sort((a, b) => b.w - a.w)[0];
    if (!widest) break;
    shapePod(widest, widest.cols - 1);
  }
  return pods;
}

export function layoutStrata(nodes, measured, opts) {
  const { clusterRadius, zPenalty, compress } = opts;

  const byZ = new Map();
  for (const node of nodes) {
    if (!byZ.has(node.z)) byZ.set(node.z, []);
    byZ.get(node.z).push(node);
  }
  const levels = [...byZ.keys()].sort((a, b) => b - a);

  const xMin = Math.min(...nodes.map((n) => n.x1));
  const xMax = Math.max(...nodes.map((n) => n.x2));
  const yMin = Math.min(...nodes.map((n) => n.y1));
  const yMax = Math.max(...nodes.map((n) => n.y2));

  const pxPerTile = clamp(INNER / Math.max(1, xMax - xMin), 6, 30);
  const xOff = GUTTER + Math.max(0, (INNER - (xMax - xMin) * pxPerTile) / 2);
  const px = (x) => xOff + (x - xMin) * pxPerTile;

  const yMid = (yMin + yMax) / 2;
  const yScale = Math.min(pxPerTile * 0.4, NUDGE_MAX / Math.max(1, (yMax - yMin) / 2));

  const bands = levels.map((z) => {
    const pods = resolveOverlaps(fitBand(
      clusterByProximity(byZ.get(z), clusterRadius)
        .map((group) => layoutPod(group, px, yScale, yMid))));

    // The row is as tall as the nudged pods make it, plus the footprint strip.
    const top = Math.min(...pods.map((p) => p.nudge - p.h / 2));
    const bottom = Math.max(...pods.map((p) => p.nudge + p.h / 2));
    return {
      z, pods, shift: -top, nodes: byZ.get(z),
      podsH: bottom - top,
      h: bottom - top + FOOT_BLOCK,
    };
  });

  // Vertical assembly. Uncompressed, the gap between two rows is the climb
  // between them drawn to the same scale as the horizontal ruler, so a link's
  // on-screen length tracks its cost. Compressed, it falls back to a log
  // squeeze — still ordered by depth, but a 40-level shaft stays on screen.
  const zStep = clamp(zPenalty * pxPerTile, 20, 64);
  const bandGap = clamp(zStep * 0.45, 10, 34);
  const voids = [];
  let y = PAD_TOP;
  bands.forEach((band, i) => {
    if (i > 0) {
      const missing = bands[i - 1].z - band.z - 1;
      if (missing <= 0) {
        y += bandGap;
      } else {
        const h = compress
          ? bandGap + VOID_MIN * 0.5 + Math.min(46, 16 * Math.log2(missing + 1))
          : bandGap + missing * zStep;
        voids.push({ top: y, h, levels: missing, from: bands[i - 1].z, to: band.z });
        y += h;
      }
    }
    band.top = y;
    y += band.h;
  });

  // Absolute chip boxes, and the anchor points links attach to.
  const anchors = new Map();
  for (const band of bands) {
    for (const pod of band.pods) {
      pod.y = band.top + band.shift + pod.nudge - pod.h / 2;
      pod.nodes.forEach((node, i) => {
        const col = i % pod.cols;
        const row = Math.floor(i / pod.cols);
        const box = {
          x: pod.x + POD_PAD + col * (pod.chipW + CHIP_GAP_X),
          y: pod.y + POD_PAD + row * (CHIP_H + CHIP_GAP_Y),
          w: pod.chipW, h: CHIP_H,
        };
        node.box = box;
        anchors.set(node.id, { x: box.x + box.w / 2, y: box.y + box.h / 2, node });
      });
    }
  }

  // Which links cross which void — the reason a void is worth drawing.
  for (const gap of voids) {
    const crossing = measured.filter((l) => {
      const hi = Math.max(l.a.z, l.b.z);
      const lo = Math.min(l.a.z, l.b.z);
      return hi >= gap.from && lo <= gap.to;
    });
    gap.crossings = crossing.length;
    gap.cheapest = crossing.length ? Math.min(...crossing.map((l) => l.cost)) : null;
  }

  return {
    bands, voids, anchors, px, pxPerTile, zStep, zPenalty,
    xMin, xMax, height: y + PAD_BOTTOM,
  };
}

// ---------------------------------------------------------------- render

function defs() {
  const el = svgEl('defs');

  const hatch = svgEl('pattern', {
    id: 'rock', width: 8, height: 8, patternUnits: 'userSpaceOnUse',
    patternTransform: 'rotate(38)',
  });
  hatch.append(svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 8, class: 'rock-line' }));
  el.append(hatch);

  for (const band of ['tight', 'fine', 'long', 'severe']) {
    const marker = svgEl('marker', {
      id: `strata-arrow-${band}`, viewBox: '0 0 10 10', refX: 9, refY: 5,
      markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse',
    });
    marker.append(svgEl('path', { d: 'M 0 1 L 9 5 L 0 9 z', class: `head ${band}` }));
    el.append(marker);
  }
  return el;
}

/** Faint vertical rules every 10 tiles: a ruler you can read across rows. */
function grid(model) {
  const layer = svgEl('g', { class: 'strata-grid' });
  const step = model.pxPerTile < 12 ? 20 : 10;
  const start = Math.ceil(model.xMin / step) * step;
  for (let x = start; x <= model.xMax; x += step) {
    const at = model.px(x);
    layer.append(svgEl('line', { x1: at, y1: PAD_TOP - 12, x2: at, y2: model.height }));
    layer.append(text(`x${x}`, { x: at, y: PAD_TOP - 18, 'text-anchor': 'middle', class: 'tick' }));
  }
  // Scale bar sits on its own line above the x ticks.
  const barPx = step * model.pxPerTile;
  const x1 = WIDTH - PAD_RIGHT;
  layer.append(svgEl('line', { x1: x1 - barPx, y1: 12, x2: x1, y2: 12, class: 'scale-bar' }));
  layer.append(svgEl('line', { x1: x1 - barPx, y1: 8, x2: x1 - barPx, y2: 16, class: 'scale-bar' }));
  layer.append(svgEl('line', { x1, y1: 8, x2: x1, y2: 16, class: 'scale-bar' }));
  layer.append(text(`${step} tiles`,
    { x: x1 - barPx - 8, y: 16, 'text-anchor': 'end', class: 'tick' }));
  return layer;
}

function gutter(model, counts, opts) {
  const layer = svgEl('g', { class: 'strata-gutter' });
  layer.append(svgEl('line', {
    x1: GUTTER - 10, y1: PAD_TOP - 6, x2: GUTTER - 10, y2: model.height - PAD_BOTTOM,
    class: 'axis',
  }));
  // The figures are bare, so the axis has to say what they are -- an
  // elevation against sea level once the snapshot carries the offset, the
  // raw block index when it does not.
  layer.append(text(opts.elevCaption,
    { x: GUTTER - 20, y: PAD_TOP - 18, 'text-anchor': 'end', class: 'tick' }));
  for (const band of model.bands) {
    const mid = band.top + band.podsH / 2;
    layer.append(svgEl('line', { x1: GUTTER - 14, y1: mid, x2: GUTTER - 6, y2: mid, class: 'axis' }));
    layer.append(text(opts.elevOf(band.z), { x: GUTTER - 20, y: mid + 1, 'text-anchor': 'end', class: 'z-label' }));
    const c = counts.get(band.z);
    layer.append(text(`${c.piles}▪ ${c.shops}◼`,
      { x: GUTTER - 20, y: mid + 13, 'text-anchor': 'end', class: 'z-count' }));
  }
  return layer;
}

function voidBands(model, opts, heaps = []) {
  const layer = svgEl('g', { class: 'strata-voids' });
  for (const gap of model.voids) {
    layer.append(svgEl('rect', {
      x: GUTTER - 2, y: gap.top + 3, width: WIDTH - GUTTER - PAD_RIGHT + 2,
      height: Math.max(0, gap.h - 6), rx: 4, class: 'void',
    }));
    const mid = gap.top + gap.h / 2;
    const parts = [
      `${gap.levels} level${gap.levels === 1 ? '' : 's'} of rock · ${opts.elevCaption} `
        + (gap.levels === 1
          ? opts.elevOf(gap.to + 1)
          : `${opts.elevOf(gap.to + 1)}–${opts.elevOf(gap.from - 1)}`),
      `+${gap.levels * model.zPenalty}t to climb`,
    ];
    if (gap.crossings) {
      parts.push(`${gap.crossings} haul${gap.crossings === 1 ? '' : 's'} cross`
        + `, cheapest ${Math.round(gap.cheapest)}t`);
    }
    // Goods stranded on a level with no stockpile have no row of their own,
    // so the band they fall inside is the only place they can be reported.
    const inside = heaps.filter((heap) => heap.z > gap.to && heap.z < gap.from);
    if (inside.length) {
      const stranded = inside.reduce((sum, heap) => sum + heap.count, 0);
      const levels = new Set(inside.map((heap) => heap.z));
      parts.push(`${stranded} loose in here, on `
        + `${levels.size} level${levels.size === 1 ? '' : 's'} with no pile`);
    }
    // Left-aligned: links crossing a void bunch up in the middle.
    layer.append(text(parts.join('  ·  '), {
      x: GUTTER + 10, y: mid + 4,
      class: `void-label${inside.length ? ' has-loose' : ''}`,
    }));
  }
  return layer;
}

/**
 * A slim plan strip along the bottom of each row: every node's true map-X
 * extent, on the same scale as the ruler. Pods can only be anchored at their
 * centroid, so a long pile looks displaced from a neighbour it actually
 * touches — the strip is where you see the footprints really overlap.
 */
function footprintLayer(model, selectedId, heaps = []) {
  const layer = svgEl('g', { class: 'strata-foot' });
  const heapsByZ = new Map();
  for (const heap of heaps) {
    if (!heapsByZ.has(heap.z)) heapsByZ.set(heap.z, []);
    heapsByZ.get(heap.z).push(heap);
  }

  for (const band of model.bands) {
    const y = band.top + band.podsH + 5;
    layer.append(svgEl('line', {
      x1: GUTTER + 2, y1: y + FOOT_H / 2, x2: WIDTH - PAD_RIGHT, y2: y + FOOT_H / 2,
      class: 'foot-axis',
    }));

    // Goods on the floor, drawn just above the strip at their real map-X
    // spread. They have no pod to belong to -- that is the point of them.
    for (const heap of heapsByZ.get(band.z) || []) {
      const hx = model.px(heap.x1);
      const rect = svgEl('rect', {
        x: hx, y: y - 5, width: Math.max(3, model.px(heap.x2) - hx), height: 3, rx: 1.5,
        class: 'heap',
      });
      const heapTitle = svgEl('title');
      heapTitle.textContent = `${heap.count} ${heap.label} loose · x${heap.x1}–${heap.x2}`;
      rect.append(heapTitle);
      layer.append(rect);
    }

    for (const node of band.nodes) {
      const x = model.px(node.x1);
      const classes = ['foot', node.node === 'stockpile' ? 'stockpile' : 'workshop'];
      if (node.id === selectedId) classes.push('selected');
      const rect = svgEl('rect', {
        x, y, width: Math.max(2, model.px(node.x2) - x), height: FOOT_H, rx: 1.5,
        class: classes.join(' '),
      });
      const title = svgEl('title');
      title.textContent = `${node.name} · x${node.x1}–${node.x2}, y${node.y1}–${node.y2}`;
      rect.append(title);
      layer.append(rect);
    }
  }
  return layer;
}

/** Annotate the empty space inside a row with the real walking gap. */
function podGaps(model) {
  const layer = svgEl('g', { class: 'strata-gaps' });
  for (const band of model.bands) {
    const pods = [...band.pods].sort((a, b) => a.x - b.x);
    for (let i = 1; i < pods.length; i++) {
      const left = pods[i - 1];
      const right = pods[i];
      const px0 = left.x + left.w;
      const px1 = right.x;
      if (px1 - px0 < GAP_LABEL_MIN) continue;
      let tiles = Infinity;
      for (const a of left.nodes) {
        for (const b of right.nodes) tiles = Math.min(tiles, walk(a, b));
      }
      const y = band.top + band.podsH / 2;
      layer.append(svgEl('line', { x1: px0 + 5, y1: y, x2: px1 - 5, y2: y, class: 'gap-rule' }));
      layer.append(text(`${Math.round(tiles)}t`, {
        x: (px0 + px1) / 2, y: y - 4, 'text-anchor': 'middle', class: 'gap-label',
      }));
    }
  }
  return layer;
}

function linkPath(a, b) {
  const dy = b.y - a.y;
  const dx = b.x - a.x;
  if (Math.abs(dy) < 4) {
    // Same row: arc over the top so the curve is not lost behind the pods.
    const lift = clamp(Math.abs(dx) * 0.28, 14, 46);
    return `M ${a.x} ${a.y} C ${a.x + dx * 0.25} ${a.y - lift}, ${a.x + dx * 0.75} ${b.y - lift}, ${b.x} ${b.y}`;
  }
  const bow = clamp(Math.abs(dy) * 0.45, 12, 90);
  return `M ${a.x} ${a.y} C ${a.x} ${a.y + Math.sign(dy) * bow}, ${b.x} ${b.y - Math.sign(dy) * bow}, ${b.x} ${b.y}`;
}

function linkLayer(model, measured, opts) {
  const layer = svgEl('g', { class: 'strata-links' });
  const { selectedId, minLinkCost } = opts;
  for (const link of measured) {
    const a = model.anchors.get(link.from);
    const b = model.anchors.get(link.to);
    if (!a || !b) continue;
    const touches = selectedId !== null && (link.from === selectedId || link.to === selectedId);
    const below = link.cost < minLinkCost;
    if (below && !touches) continue;
    const classes = ['link', link.band];
    if (selectedId !== null) classes.push(touches ? 'active' : 'faded');
    const path = svgEl('path', {
      d: linkPath(a, b),
      class: classes.join(' '),
      'marker-end': `url(#strata-arrow-${link.band})`,
    });
    const title = svgEl('title');
    title.textContent = `${link.a.name} → ${link.b.name}\n`
      + `${Math.round(link.plan)} tiles across, ${link.dz} z · ${Math.round(link.cost)} tiles of hauling`;
    path.append(title);
    layer.append(path);
    if (touches || (link.band === 'severe' && selectedId === null)) {
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      layer.append(text(`${Math.round(link.cost)}t`, {
        x: mid.x, y: mid.y - 3, 'text-anchor': 'middle', class: `link-label ${link.band}`,
      }));
    }
  }
  return layer;
}

function podLayer(model) {
  const layer = svgEl('g', { class: 'strata-pods' });
  for (const band of model.bands) {
    layer.append(svgEl('rect', {
      x: GUTTER - 2, y: band.top - 4, width: WIDTH - GUTTER - PAD_RIGHT + 2,
      height: band.h + 8, rx: 5, class: 'band',
    }));
    for (const pod of band.pods) {
      layer.append(svgEl('rect', {
        x: pod.x, y: pod.y, width: pod.w, height: pod.h, rx: 6, class: 'pod',
      }));
    }
  }
  return layer;
}

function chipLayer(model, opts) {
  const layer = svgEl('g', { class: 'strata-chips' });
  const { selectedId, onSelect } = opts;
  for (const band of model.bands) {
    for (const pod of band.pods) {
      for (const node of pod.nodes) {
        const { x, y, w, h } = node.box;
        const classes = ['chip-node', node.node === 'stockpile' ? 'stockpile' : 'workshop'];
        if (node.id === selectedId) classes.push('selected');
        if (!node.linked) classes.push('orphan');
        const group = svgEl('g', { class: classes.join(' '), transform: `translate(${x} ${y})` });
        group.append(svgEl('rect', { width: w, height: h, rx: 4, class: 'chip-bg' }));

        if (node.node === 'stockpile') {
          group.append(svgEl('circle', { cx: 11, cy: h / 2, r: 4.5, class: 'glyph' }));
          // Occupied tiles, not item count: a pile with bins holds far more
          // items than tiles, and it is the tiles that run out.
          const fill = node.used_tiles === undefined
            ? clamp((node.item_count || 0) / Math.max(1, node.area || 1), 0, 1)
            : clamp(node.used_tiles / Math.max(1, node.area || 1), 0, 1);
          if (fill > 0) {
            group.append(svgEl('rect', {
              x: 1, y: h - 3, width: (w - 2) * fill, height: 2, rx: 1,
              class: `fill-bar${fill >= 0.95 ? ' full' : ''}`,
            }));
          }
        } else {
          group.append(svgEl('rect', { x: 6.5, y: h / 2 - 4.5, width: 9, height: 9, rx: 1.5, class: 'glyph' }));
        }

        group.append(text(node.short, { x: 21, y: h / 2 + 3.5, class: 'chip-label' }));

        // A node the flow view has something to say about, marked in the
        // corner so the cross-section doubles as the map of the problems.
        if (node.alert) {
          group.append(svgEl('circle', {
            cx: w - 5, cy: 5, r: 3, class: `alert ${node.alert}`,
          }));
        }
        const title = svgEl('title');
        title.textContent = node.tooltip;
        group.append(title);
        if (onSelect) group.addEventListener('click', () => onSelect(node));
        layer.append(group);
      }
    }
  }
  return layer;
}

/**
 * Dashed rules from the selected node to the nearest things it is *not*
 * connected to — the "what else is within reach" question the link lines
 * cannot answer.
 */
function measureLayer(model, nearby, selectedId) {
  const layer = svgEl('g', { class: 'strata-measures' });
  const from = model.anchors.get(selectedId);
  if (!from) return layer;
  for (const { id, cost } of nearby) {
    const to = model.anchors.get(id);
    if (!to) continue;
    layer.append(svgEl('line', { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: 'measure' }));
    layer.append(text(`${Math.round(cost)}t`, {
      x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - 3,
      'text-anchor': 'middle', class: 'measure-label',
    }));
  }
  return layer;
}

/**
 * @param {Array} nodes  snapshot nodes with `short`, `tooltip`, `linked` added
 * @param {Array} measured  output of geometry.measureLinks
 */
export function renderStrata(nodes, measured, opts = {}) {
  const options = {
    clusterRadius: 10, zPenalty: 2, compress: true, rulers: true,
    selectedId: null, minLinkCost: 0, nearby: [], onSelect: null, heaps: [],
    elevOf: (z) => String(z), elevCaption: 'z',
    ...opts,
  };
  const model = layoutStrata(nodes, measured, options);

  const counts = new Map();
  for (const band of model.bands) {
    counts.set(band.z, {
      piles: band.nodes.filter((n) => n.node === 'stockpile').length,
      shops: band.nodes.filter((n) => n.node !== 'stockpile').length,
    });
  }

  const svg = svgEl('svg', {
    class: 'strata',
    viewBox: `0 0 ${WIDTH} ${model.height}`,
    preserveAspectRatio: 'xMidYMin meet',
    style: `aspect-ratio: ${WIDTH} / ${model.height}`,
  });
  svg.append(defs());
  if (options.rulers) svg.append(grid(model));
  svg.append(voidBands(model, options, options.heaps), podLayer(model),
    footprintLayer(model, options.selectedId, options.heaps), gutter(model, counts, options));
  if (options.rulers) svg.append(podGaps(model));
  svg.append(linkLayer(model, measured, options), chipLayer(model, options));
  if (options.selectedId !== null) {
    svg.append(measureLayer(model, options.nearby, options.selectedId));
  }
  return svg;
}
