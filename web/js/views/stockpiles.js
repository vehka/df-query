// Stockpiles view: the pile/workshop table plus a flow graph of their links.

import { h, clear, matches, formatBox, plural, asList } from '../util.js';
import { renderGraph } from '../graph.js';

const state = {
  mode: 'table',
  search: '',
  zFilter: '',
  linkedOnly: true,
  selectedId: null,
};

export function render(root, db) {
  clear(root);
  const body = h('div', { class: 'view-body' });
  root.append(toolbar(db, () => draw(body, db)), body);
  draw(body, db);
}

function toolbar(db, redraw) {
  const zLevels = [...new Set(db.stockpiles.map((s) => s.z))].sort((a, b) => b - a);
  return h('div', { class: 'toolbar' },
    h('div', { class: 'segmented' },
      ['table', 'graph'].map((mode) => h('button', {
        class: state.mode === mode ? 'active' : '',
        onclick: () => { state.mode = mode; redraw(); },
      }, mode))),
    h('label', { class: 'field grow' }, h('span', {}, 'Filter'),
      h('input', {
        type: 'search',
        placeholder: 'Search stockpile, workshop, or item type…',
        value: state.search,
        oninput: (e) => { state.search = e.target.value; redraw(); },
      })),
    h('label', { class: 'field' }, h('span', {}, 'Z level'),
      h('select', { onchange: (e) => { state.zFilter = e.target.value; redraw(); } },
        h('option', { value: '' }, 'all'),
        zLevels.map((z) => h('option', { value: z, selected: String(state.zFilter) === String(z) },
          `z${z}`)))),
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

function visibleStockpiles(db) {
  return db.stockpiles.filter((sp) => {
    if (state.zFilter !== '' && String(sp.z) !== String(state.zFilter)) return false;
    if (!state.search) return true;
    return matches(sp.name, state.search)
      || asList(sp.categories).some((c) => matches(c, state.search))
      || Object.keys(sp.items_by_type || {}).some((t) => matches(t, state.search));
  });
}

function draw(body, db) {
  clear(body);
  if (state.mode === 'graph') {
    body.append(graphPanel(db));
    return;
  }

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

function linkCounts(db, id) {
  const inbound = db.links.filter((l) => l.to === id);
  const outbound = db.links.filter((l) => l.from === id);
  return { inbound, outbound };
}

function stockpileTable(db, piles, redraw) {
  const sorted = [...piles].sort((a, b) => b.z - a.z || a.name.localeCompare(b.name));
  return h('table', { class: 'grid' },
    h('thead', {}, h('tr', {},
      ['Stockpile', 'Location', 'Tiles', 'Accepts', 'Items', 'In', 'Out']
        .map((label) => h('th', {}, label)))),
    h('tbody', {}, sorted.map((sp) => {
      const { inbound, outbound } = linkCounts(db, sp.id);
      return h('tr', {
        class: state.selectedId === sp.id ? 'selected' : '',
        onclick: () => { state.selectedId = state.selectedId === sp.id ? null : sp.id; redraw(); },
      },
        h('td', {}, sp.name),
        h('td', { class: 'muted mono' }, formatBox(sp)),
        h('td', {}, sp.area),
        h('td', {}, acceptChips(db, sp)),
        h('td', {}, sp.item_count),
        h('td', { class: inbound.length ? '' : 'muted' }, inbound.length),
        h('td', { class: outbound.length ? '' : 'muted' }, outbound.length));
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

function nodeDetail(db, node, redraw) {
  const { inbound, outbound } = linkCounts(db, node.id);
  const nameOf = (id) => db.nodeById.get(id)?.name || `#${id}`;
  const items = Object.entries(node.items_by_type || {}).sort((a, b) => b[1] - a[1]);

  return h('aside', { class: 'detail' },
    h('header', {},
      h('h3', {}, node.name),
      h('button', { class: 'ghost', onclick: () => { state.selectedId = null; redraw(); } }, '✕')),
    h('p', { class: 'muted mono' }, formatBox(node), ` · ${node.area ?? '?'} tiles`),
    node.categories ? h('p', {}, h('strong', {}, 'Accepts: '),
      asList(node.categories).join(', ') || 'nothing') : null,
    asList(node.flags).length ? h('p', { class: 'muted' }, asList(node.flags).join(', ')) : null,
    h('div', { class: 'two-col' },
      h('div', {}, h('h4', {}, `Takes from (${inbound.length})`),
        h('ul', {}, inbound.length
          ? inbound.map((l) => h('li', {}, nameOf(l.from)))
          : h('li', { class: 'muted' }, 'nothing'))),
      h('div', {}, h('h4', {}, `Gives to (${outbound.length})`),
        h('ul', {}, outbound.length
          ? outbound.map((l) => h('li', {}, nameOf(l.to)))
          : h('li', { class: 'muted' }, 'nothing')))),
    items.length
      ? h('div', {}, h('h4', {}, `Contents (${node.item_count})`),
        h('p', {}, items.map(([type, count]) =>
          h('span', { class: 'chip' }, `${type.toLowerCase()} ${count}`))))
      : null);
}

function graphPanel(db) {
  const linkedIds = new Set(db.links.flatMap((l) => [l.from, l.to]));
  const include = (node) => {
    if (state.zFilter !== '' && String(node.z) !== String(state.zFilter)) return false;
    if (state.linkedOnly && !linkedIds.has(node.id)) return false;
    if (state.search) return matches(node.name, state.search);
    return true;
  };

  const nodes = [
    ...db.stockpiles.filter(include).map((s) => ({ id: s.id, label: s.name, kind: 'stockpile' })),
    ...db.workshops.filter(include).map((w) => ({ id: w.id, label: w.name, kind: 'workshop' })),
  ];
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
