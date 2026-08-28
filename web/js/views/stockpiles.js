// Stockpiles view: a table, a z-level cross-section, and a flow graph over
// the same pile/workshop network.

import { h, clear, matches, formatBox, plural, asList } from '../util.js';
import { renderGraph } from '../graph.js';
import { renderStrata } from '../strata.js';
import {
  measureLinks, summarise, haulCost, walk, straight, nearestNeighbour,
  costBand, COST_BANDS,
} from '../geometry.js';
import { diagnose } from '../flow.js';

const state = {
  mode: 'strata',
  search: '',
  zFilter: '',
  linkedOnly: true,      // graph mode only
  selectedId: null,
  // strata controls
  nodeType: 'all',
  connections: 'all',
  minLinkCost: 0,
  zPenalty: 2,
  clusterRadius: 10,
  compress: true,
  rulers: true,
  pressure: true,
};

/** Loose heaps worth drawing on a footprint strip. */
const HEAP_FLOOR = 3;

const NODE_TYPES = [
  { value: 'all', label: 'everything' },
  { value: 'stockpiles', label: 'stockpiles' },
  { value: 'workshops', label: 'workshops' },
  { value: 'Workshop', label: '· workshops only' },
  { value: 'Furnace', label: '· furnaces' },
  { value: 'FarmPlot', label: '· farm plots' },
  { value: 'TradeDepot', label: '· trade depot' },
];

const CONNECTIONS = [
  { value: 'all', label: 'all nodes' },
  { value: 'linked', label: 'linked only' },
  { value: 'orphans', label: 'unlinked only' },
];

/**
 * Aim the view at one node, for a cross-view jump from Flow. The caller
 * changes the hash afterwards; the app re-renders from this state.
 */
export function focus(id) {
  state.mode = 'strata';
  state.selectedId = id;
  state.search = '';
  state.zFilter = '';
  state.nodeType = 'all';
  state.connections = 'all';
}

export function render(root, db) {
  clear(root);
  const toolbarHost = h('div', { class: 'toolbar-stack' });
  const body = h('div', { class: 'view-body' });
  root.append(toolbarHost, body);

  const redraw = () => draw(body, db);
  // Only a mode switch changes the toolbar's shape; everything else redraws
  // the body alone, so a slider keeps focus while it is being dragged.
  const rebuild = () => {
    clear(toolbarHost);
    toolbarHost.append(mainToolbar(db, redraw, rebuild));
    if (state.mode === 'strata') toolbarHost.append(strataToolbar(redraw));
    redraw();
  };
  rebuild();
}

// ------------------------------------------------------------------ toolbar

function mainToolbar(db, redraw, rebuild) {
  const zLevels = [...new Set(db.nodes.map((n) => n.z))].sort((a, b) => b - a);
  return h('div', { class: 'toolbar' },
    h('div', { class: 'segmented' },
      ['table', 'strata', 'graph'].map((mode) => h('button', {
        class: state.mode === mode ? 'active' : '',
        onclick: () => { state.mode = mode; rebuild(); },
      }, mode))),
    h('label', { class: 'field grow' }, h('span', {}, 'Filter'),
      h('input', {
        type: 'search',
        placeholder: 'Search stockpile, workshop, or item type…',
        value: state.search,
        oninput: (e) => { state.search = e.target.value; redraw(); },
      })),
    h('label', { class: 'field' }, h('span', {}, db.elevOffset === null ? 'Z level' : 'Elevation'),
      h('select', { onchange: (e) => { state.zFilter = e.target.value; redraw(); } },
        h('option', { value: '' }, 'all'),
        zLevels.map((z) => h('option', { value: z, selected: String(state.zFilter) === String(z) },
          db.elevShort(z))))),
    state.mode !== 'table'
      ? h('label', { class: 'field' }, h('span', {}, 'Show'),
        h('select', { onchange: (e) => { state.nodeType = e.target.value; redraw(); } },
          NODE_TYPES.map((t) => h('option', { value: t.value, selected: state.nodeType === t.value },
            t.label))))
      : null,
    state.mode === 'strata'
      ? h('label', { class: 'field' }, h('span', {}, 'Connections'),
        h('select', { onchange: (e) => { state.connections = e.target.value; redraw(); } },
          CONNECTIONS.map((c) => h('option', { value: c.value, selected: state.connections === c.value },
            c.label))))
      : null,
    state.mode === 'graph'
      ? h('label', { class: 'field check' },
        h('input', {
          type: 'checkbox',
          checked: state.linkedOnly,
          onchange: (e) => { state.linkedOnly = e.target.checked; redraw(); },
        }),
        h('span', {}, 'Linked only'))
      : null);
}

function slider(label, key, { min, max, step, format }, redraw) {
  // The readout is patched in place rather than rebuilt, so dragging the
  // thumb does not tear the input out from under the pointer.
  const readout = h('b', {}, format(state[key]));
  return h('label', { class: 'field slider' },
    h('span', {}, label, readout),
    h('input', {
      type: 'range', min, max, step, value: state[key],
      oninput: (e) => {
        state[key] = Number(e.target.value);
        readout.textContent = format(state[key]);
        redraw();
      },
    }));
}

function strataToolbar(redraw) {
  return h('div', { class: 'toolbar sub' },
    slider('Stair cost ', 'zPenalty', {
      min: 0, max: 6, step: 0.5, format: (v) => `${v}t / z level`,
    }, redraw),
    slider('Group radius ', 'clusterRadius', {
      min: 2, max: 30, step: 1, format: (v) => `${v} tiles`,
    }, redraw),
    slider('Hide hauls under ', 'minLinkCost', {
      min: 0, max: 60, step: 1, format: (v) => (v ? `${v} tiles` : 'nothing'),
    }, redraw),
    h('label', { class: 'field check' },
      h('input', {
        type: 'checkbox', checked: state.compress,
        onchange: (e) => { state.compress = e.target.checked; redraw(); },
      }),
      h('span', {}, 'Compress empty levels')),
    h('label', { class: 'field check' },
      h('input', {
        type: 'checkbox', checked: state.rulers,
        onchange: (e) => { state.rulers = e.target.checked; redraw(); },
      }),
      h('span', {}, 'Rulers')),
    h('label', { class: 'field check' },
      h('input', {
        type: 'checkbox', checked: state.pressure,
        onchange: (e) => { state.pressure = e.target.checked; redraw(); },
      }),
      h('span', {}, 'Flow problems')));
}

// ------------------------------------------------------------------ filters

/** Short enough to fit in a chip; the full name lives in the tooltip. */
function shortLabel(node) {
  let label = node.name || `#${node.id}`;
  if (node.node === 'stockpile') {
    label = label.replace(/\bStockpiles?\s+/i, '').trim() || label;
  } else {
    label = label.replace(/'s (Workshop|Shop)$/i, '')
      .replace(/\s+Workshop$/i, '')
      .replace(/\s+Plot$/i, '')
      .trim() || label;
  }
  return label.length > 16 ? `${label.slice(0, 15)}…` : label;
}

function typeOk(node) {
  switch (state.nodeType) {
    case 'all': return true;
    case 'stockpiles': return node.node === 'stockpile';
    case 'workshops': return node.node !== 'stockpile';
    default: return node.kind === state.nodeType;
  }
}

function searchOk(node) {
  if (!state.search) return true;
  return matches(node.name, state.search)
    || matches(node.subtype, state.search)
    || matches(node.kind, state.search)
    || asList(node.categories).some((c) => matches(c, state.search))
    || Object.keys(node.items_by_type || {}).some((t) => matches(t, state.search));
}

function isLinked(db, node) {
  const { inbound, outbound } = db.linksOf(node.id);
  return inbound.length + outbound.length > 0;
}

function visibleNodes(db, { applyConnections = true } = {}) {
  return db.nodes.filter((node) => {
    if (state.zFilter !== '' && String(node.z) !== String(state.zFilter)) return false;
    if (!typeOk(node)) return false;
    if (!searchOk(node)) return false;
    if (applyConnections && state.connections !== 'all') {
      const linked = isLinked(db, node);
      if (state.connections === 'linked' && !linked) return false;
      if (state.connections === 'orphans' && linked) return false;
    }
    return true;
  });
}

function visibleStockpiles(db) {
  return db.stockpiles.filter((sp) => {
    if (state.zFilter !== '' && String(sp.z) !== String(state.zFilter)) return false;
    if (!state.search) return true;
    return matches(sp.name, state.search)
      || asList(sp.categories).some((c) => matches(c, state.search))
      || Object.keys(sp.items_by_type || {}).some((t) => matches(t, state.search));
  });
}

// ------------------------------------------------------------------ draw

function draw(body, db) {
  clear(body);
  const redrawBody = () => draw(body, db);
  if (state.mode === 'graph') return void body.append(graphPanel(db));
  if (state.mode === 'strata') return void body.append(strataPanel(db, redrawBody));

  const piles = visibleStockpiles(db);
  body.append(h('p', { class: 'summary' },
    `${plural(piles.length, 'stockpile')} · `,
    `${plural(db.workshops.length, 'workshop')} · `,
    `${plural(db.links.length, 'link')}`));

  const redraw = () => draw(body, db);
  body.append(stockpileTable(db, piles, redraw));

  if (state.selectedId !== null) {
    const node = db.nodeById.get(state.selectedId);
    if (node) body.append(nodeDetail(db, node, redraw));
  }
}

// ------------------------------------------------------------------ strata

function strataPanel(db, redraw) {
  const wrapper = h('div', { class: 'strata-wrapper' });

  const nodes = visibleNodes(db).map((node) => ({
    ...node,
    short: shortLabel(node),
    linked: isLinked(db, node),
    tooltip: [
      node.name,
      formatBox(node, db),
      node.node === 'stockpile'
        ? `${node.area} tiles · ${node.item_count} items`
        : `${node.kind}${node.subtype ? ` · ${node.subtype}` : ''}`,
    ].join('\n'),
  }));

  if (!nodes.length) {
    wrapper.append(h('p', { class: 'empty' },
      'Nothing matches those filters. Widen the search or set Show back to everything.'));
    return wrapper;
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const measured = measureLinks(
    db.links.filter((l) => nodeById.has(l.from) && nodeById.has(l.to)),
    nodeById, state.zPenalty);
  const stats = summarise(measured, state.zPenalty);

  // What the selected pile could reach but does not: the three closest
  // neighbours it has no feed link with.
  const linkedToSelection = new Set(measured
    .filter((l) => l.from === state.selectedId || l.to === state.selectedId)
    .flatMap((l) => [l.from, l.to]));
  const selected = state.selectedId !== null ? nodeById.get(state.selectedId) : null;
  const nearby = selected
    ? nodes
      .filter((n) => n.id !== selected.id && !linkedToSelection.has(n.id))
      .map((n) => ({ id: n.id, cost: haulCost(selected, n, state.zPenalty) }))
      .sort((a, b) => a.cost - b.cost)
      .slice(0, 3)
    : [];

  // The flow layer: mark every node a finding names, and put the loose
  // heaps on the footprint strips at their real map position.
  const { alerts, heaps } = state.pressure && db.hasFlow
    ? flowOverlay(db)
    : { alerts: new Map(), heaps: [] };
  for (const node of nodes) node.alert = alerts.get(node.id) || null;

  wrapper.append(statStrip(db, nodes, measured, stats, redraw));
  wrapper.append(h('div', { class: 'strata-scroll' },
    renderStrata(nodes, measured, {
      clusterRadius: state.clusterRadius,
      zPenalty: state.zPenalty,
      compress: state.compress,
      rulers: state.rulers,
      minLinkCost: state.minLinkCost,
      selectedId: state.selectedId,
      elevOf: (z) => db.elevShort(z),
      elevCaption: db.elevCaption,
      heaps,
      nearby,
      onSelect: (node) => {
        state.selectedId = state.selectedId === node.id ? null : node.id;
        redraw();
      },
    })));
  wrapper.append(strataLegend());

  if (selected) {
    const full = db.nodeById.get(selected.id);
    if (full) wrapper.append(nodeDetail(db, full, redraw, { nodes }));
  }
  return wrapper;
}

function tiles(n) {
  return `${Math.round(n)}t`;
}

/**
 * Findings, reduced to what the cross-section can draw: a severity per node,
 * and the loose heaps as map-X spans per level.
 */
function flowOverlay(db) {
  const alerts = new Map();
  for (const item of diagnose(db.flowInput(state.zPenalty))) {
    for (const id of item.nodes) {
      // Worst severity wins; a pile can appear in several findings.
      if (item.severity === 'high' || !alerts.has(id)) alerts.set(id, item.severity);
    }
  }

  const heaps = [];
  for (const heap of asList(db.flow.loose.by_type)) {
    for (const level of asList(heap.levels)) {
      if (level.count < HEAP_FLOOR) continue;
      heaps.push({ ...level, label: db.itemCaption(heap.type) });
    }
  }
  return { alerts, heaps };
}

function statStrip(db, nodes, measured, stats, redraw) {
  const orphans = nodes.filter((n) => n.node === 'stockpile' && !n.linked).length;
  const strip = h('div', { class: 'stat-strip' },
    stat(plural(nodes.length, 'node'), `${nodes.filter((n) => n.node === 'stockpile').length} piles`),
    stat(tiles(stats.median), 'median haul', 'the typical trip between linked places'),
    stat(tiles(stats.p90), '90th pct', 'nine in ten hauls are shorter than this'),
    stat(tiles(stats.total), 'total network', `${plural(stats.count, 'link')} end to end`),
    stat(`${Math.round(stats.verticalShare * 100)}%`, 'is stairs',
      'share of the total cost that is pure vertical travel'),
    stat(String(orphans), 'unlinked piles', 'stockpiles with no feed link either way'));

  strip.append(h('div', { class: 'stat histogram' },
    h('div', { class: 'bars' }, stats.histogram.map((band) => band.count
      ? h('div', {
        class: `bar ${band.key}`,
        style: `flex: ${band.count}`,
        title: `${plural(band.count, 'link')} ${band.label} (${
          band.max === Infinity ? 'over 40' : `up to ${band.max}`} tiles)`,
      }, band.count > 1 ? String(band.count) : '')
      : null)),
    h('div', { class: 'label' }, 'haul cost mix')));

  if (stats.worst.length) {
    strip.append(h('div', { class: 'stat worst' },
      h('div', { class: 'label' }, 'longest hauls'),
      h('ol', { class: 'worst-list' }, stats.worst.map((link) => h('li', {
        class: link.band,
        onclick: () => { state.selectedId = link.from; redraw(); },
      },
        h('span', { class: 'worst-name' }, `${link.a.short || link.a.name} → ${link.b.short || link.b.name}`),
        h('span', { class: 'worst-cost' }, tiles(link.cost),
          link.dz ? h('em', {}, ` ${link.dz}z`) : null))))));
  }
  return strip;
}

function stat(value, label, title) {
  return h('div', { class: 'stat', title: title || null },
    h('div', { class: 'value' }, value),
    h('div', { class: 'label' }, label));
}

function strataLegend() {
  return h('p', { class: 'summary strata-legend' },
    h('span', { class: 'key stockpile' }), ' stockpile ',
    h('span', { class: 'key workshop' }), ' workshop ',
    h('span', { class: 'sep' }, '·'),
    COST_BANDS.map((band) => h('span', { class: 'cost-key' },
      h('span', { class: `key cost ${band.key}` }),
      ` ${band.label} ${band.max === Infinity ? '40t+' : `≤${band.max}t`}`)),
    h('span', { class: 'sep' }, '·'),
    ' A pod holds everything within the group radius of everything else, and'
    + ' the number between two pods is the real walk across the gap. The thin'
    + ' strip under each row is the true map-X footprint of what sits on it.',
    state.pressure
      ? [
        h('span', { class: 'sep' }, '·'),
        h('span', { class: 'key alert' }), ' a finding names this one; ',
        h('span', { class: 'key full' }), ' the bar under a pile is its'
        + ' occupied tiles, turning orange when it runs out of floor; ',
        h('span', { class: 'key heap' }), ' goods loose on the floor, drawn'
        + ' over the footprint strip where they actually lie.',
      ]
      : null);
}

// ------------------------------------------------------------------ table

function stockpileTable(db, piles, redraw) {
  const sorted = [...piles].sort((a, b) => b.z - a.z || a.name.localeCompare(b.name));
  return h('table', { class: 'grid' },
    h('thead', {}, h('tr', {},
      ['Stockpile', 'Location', 'Tiles', 'Accepts', 'Items', 'In', 'Out', 'Reach']
        .map((label) => h('th', {}, label)))),
    h('tbody', {}, sorted.map((sp) => {
      const { inbound, outbound } = db.linksOf(sp.id);
      const partners = [...inbound.map((l) => l.from), ...outbound.map((l) => l.to)]
        .map((id) => db.nodeById.get(id)).filter(Boolean);
      const reach = partners.length
        ? partners.reduce((sum, p) => sum + haulCost(sp, p, state.zPenalty), 0) / partners.length
        : null;
      return h('tr', {
        class: state.selectedId === sp.id ? 'selected' : '',
        onclick: () => { state.selectedId = state.selectedId === sp.id ? null : sp.id; redraw(); },
      },
        h('td', {}, sp.name),
        h('td', { class: 'muted mono' }, formatBox(sp, db)),
        h('td', {}, sp.area),
        h('td', {}, acceptChips(db, sp)),
        h('td', {}, sp.item_count),
        h('td', { class: inbound.length ? '' : 'muted' }, inbound.length),
        h('td', { class: outbound.length ? '' : 'muted' }, outbound.length),
        reach === null
          ? h('td', { class: 'muted' }, '—')
          : h('td', { class: `cost ${costBand(reach).key}` }, tiles(reach)));
    })));
}

/** Collapse the "accepts one of everything" piles to a single chip. */
function acceptChips(db, sp) {
  const categories = asList(sp.categories);
  if (categories.length >= db.stockpileCategoryCount) {
    return h('span', { class: 'chip' }, 'everything');
  }
  return categories.map((c) => h('span', { class: 'chip' }, c));
}

// ------------------------------------------------------------------ detail

function nodeDetail(db, node, redraw, ctx = {}) {
  const { inbound, outbound } = db.linksOf(node.id);
  const nameOf = (id) => db.nodeById.get(id)?.name || `#${id}`;
  const items = Object.entries(node.items_by_type || {}).sort((a, b) => b[1] - a[1]);
  const pool = ctx.nodes || db.nodes;
  const nearest = nearestNeighbour(node, pool, state.zPenalty);

  const linkRow = (id) => {
    const other = db.nodeById.get(id);
    if (!other) return h('li', {}, nameOf(id));
    const cost = haulCost(node, other, state.zPenalty);
    return h('li', { class: 'link-row' },
      h('span', {}, other.name),
      h('span', { class: `cost ${costBand(cost).key}` },
        tiles(cost),
        h('em', { class: 'muted' },
          ` ${Math.round(walk(node, other))} across`,
          other.z !== node.z ? ` · ${Math.abs(other.z - node.z)}z` : '')));
  };

  return h('aside', { class: 'detail' },
    h('header', {},
      h('h3', {}, node.name),
      h('button', { class: 'ghost', onclick: () => { state.selectedId = null; redraw(); } }, '✕')),
    h('p', { class: 'muted mono' }, formatBox(node, db), ` · ${node.area ?? '?'} tiles`),
    nearest
      ? h('p', { class: 'small' },
        h('strong', {}, 'Nearest neighbour: '), nearest.node.name,
        h('span', { class: `cost ${costBand(nearest.cost).key}` }, ` ${tiles(nearest.cost)}`),
        h('span', { class: 'muted' },
          ` (${Math.round(straight(node, nearest.node))} tiles straight line)`))
      : null,
    node.categories ? h('p', {}, h('strong', {}, 'Accepts: '),
      asList(node.categories).join(', ') || 'nothing') : null,
    asList(node.flags).length ? h('p', { class: 'muted' }, asList(node.flags).join(', ')) : null,
    h('div', { class: 'two-col' },
      h('div', {}, h('h4', {}, `Takes from (${inbound.length})`),
        h('ul', { class: 'link-list' }, inbound.length
          ? inbound.map((l) => linkRow(l.from))
          : h('li', { class: 'muted' }, 'nothing'))),
      h('div', {}, h('h4', {}, `Gives to (${outbound.length})`),
        h('ul', { class: 'link-list' }, outbound.length
          ? outbound.map((l) => linkRow(l.to))
          : h('li', { class: 'muted' }, 'nothing')))),
    items.length
      ? h('div', {}, h('h4', {}, `Contents (${node.item_count})`),
        h('p', {}, items.map(([type, count]) =>
          h('span', { class: 'chip' }, `${type.toLowerCase()} ${count}`))))
      : null);
}

// ------------------------------------------------------------------ graph

function graphPanel(db) {
  const linkedIds = new Set(db.links.flatMap((l) => [l.from, l.to]));
  const candidates = visibleNodes(db, { applyConnections: false })
    .filter((node) => !state.linkedOnly || linkedIds.has(node.id));

  const nodes = candidates.map((n) => ({
    id: n.id, label: n.name, kind: n.node === 'stockpile' ? 'stockpile' : 'workshop',
  }));
  const visible = new Set(nodes.map((n) => n.id));
  const edges = db.links.filter((l) => visible.has(l.from) && visible.has(l.to));

  const wrapper = h('div', { class: 'graph-wrapper' });
  wrapper.append(h('p', { class: 'summary' },
    `${plural(nodes.length, 'node')} · ${plural(edges.length, 'edge')}`,
    h('span', { class: 'legend' },
      h('span', { class: 'key stockpile' }), ' stockpile ',
      h('span', { class: 'key workshop' }), ' workshop')));

  if (!nodes.length) {
    wrapper.append(h('p', { class: 'empty' },
      'Nothing to draw. Turn off "linked only" to see unlinked piles and workshops.'));
    return wrapper;
  }

  const detail = h('div', {});
  wrapper.append(renderGraph(nodes, edges, {
    onSelect: (node) => {
      clear(detail);
      const full = db.nodeById.get(node.id);
      if (full) detail.append(nodeDetail(db, full, () => clear(detail)));
    },
  }), detail);
  return wrapper;
}
