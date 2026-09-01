// Containers view: the census DF's stocks screen will not give you.
//
// The stocks screen counts barrels. It does not say how many of them are
// empty, which is the only figure that decides whether the brewery keeps
// running — and the one place in game that number surfaces at all is a
// work-order condition, one container kind at a time. So the table leads
// with "free", and everything else is there to explain that column.

import { h, clear, plural, asList, matches } from '../util.js';
import {
  census, summarise, diagnose, contentsOf, byMatClass, pluralName, words,
  ROLES,
} from '../containers.js';
import { focus as focusStockpile } from './stockpiles.js';

const state = {
  role: 'all',
  search: '',
  severity: 'all',
};

const SEVERITY_FILTERS = [
  { value: 'all', label: 'all' },
  { value: 'high', label: 'high only' },
  { value: 'act', label: 'high + medium' },
];

const KEEP_SEVERITY = {
  all: () => true,
  high: (f) => f.severity === 'high',
  act: (f) => f.severity !== 'low',
};

// The columns, in the order they answer a player's questions: how many are
// there, how many can I use, what are the rest doing, where are they.
const COLUMNS = [
  { key: 'total', label: 'Total', title: 'every one in the fort' },
  { key: 'free', label: 'Free', title: 'empty, reachable, and not already claimed by a job' },
  { key: 'holding', label: 'In use', title: 'currently holding something' },
  { key: 'assigned', label: 'Assigned', title: 'claimed by a stockpile as one of its container slots' },
  { key: 'built', label: 'Built in', title: 'installed as furniture or part of a machine' },
  { key: 'carried', label: 'Carried', title: 'in a dwarf\'s inventory' },
  { key: 'nested', label: 'Nested', title: 'sitting inside another container' },
];

export function render(root, db) {
  clear(root);
  if (!db.hasContainers) {
    root.append(h('p', { class: 'empty' },
      'This snapshot predates the container dumper. Hit Refresh to count '
      + 'what the fort has and what state it is in.'));
    return;
  }

  const toolbar = h('div', { class: 'toolbar' });
  const body = h('div', { class: 'view-body' });
  root.append(toolbar, body);

  const redraw = () => draw(body, db);
  toolbar.append(
    h('div', { class: 'segmented' },
      [{ key: 'all', label: 'everything' }, ...ROLES].map((role) => h('button', {
        class: state.role === role.key ? 'active' : '',
        onclick: () => { state.role = role.key; redraw(); },
      }, role.label || 'everything'))),
    h('label', { class: 'field grow' }, h('span', {}, 'Filter'),
      h('input', {
        type: 'search',
        placeholder: 'barrel, jug, wooden…',
        value: state.search,
        oninput: (e) => { state.search = e.target.value; redraw(); },
      })),
    h('div', { class: 'segmented' }, SEVERITY_FILTERS.map((option) => h('button', {
      class: state.severity === option.value ? 'active' : '',
      onclick: () => { state.severity = option.value; redraw(); },
    }, option.label))),
  );

  draw(body, db);
}

function draw(body, db) {
  clear(body);
  const input = db.containerInput();
  const stats = summarise(input);
  const { sections } = census(input);

  body.append(headline(stats));
  body.append(findingList(diagnose(input), db));

  const kept = sections
    .filter((s) => state.role === 'all' || s.key === state.role)
    .map((section) => ({
      ...section,
      kinds: section.kinds.filter((k) => matches(
        `${k.name} ${k.item_type} ${asList(k.uses).join(' ')} `
        + `${asList(k.materials).map((m) => `${m.material} ${m.mat_class}`).join(' ')}`,
        state.search,
      )),
    }))
    .filter((section) => section.kinds.length);

  if (!kept.length) {
    body.append(h('p', { class: 'empty' }, 'No kind of container matches that.'));
    return;
  }
  for (const section of kept) body.append(kindTable(section, db));
  body.append(routePanel(input.routes, db));
}

// ----------------------------------------------------------------- headline

function stat(value, label, title) {
  return h('div', { class: 'stat', title: title || null },
    h('div', { class: 'value' }, value),
    h('div', { class: 'label' }, label));
}

function headline(stats) {
  return h('div', { class: 'stat-strip' },
    stat(String(stats.total), 'containers',
      `${stats.kinds} different kinds, counting tools DF states a use for`),
    stat(String(stats.storage), 'storage',
      'bins, barrels, bags, buckets, boxes, pots and jugs'),
    stat(String(stats.storageFree), 'free',
      'empty, reachable, and not already claimed by a job — the number '
      + 'that decides whether a job can start'),
    stat(String(stats.goodsStored), 'goods inside',
      `held across ${plural(stats.holding, 'container')}`),
    stat(String(stats.assigned), 'pile-assigned',
      'claimed by a stockpile as one of its container slots'),
    stat(String(stats.routes - stats.routesIdle) + '/' + String(stats.routes),
      'routes crewed', 'minecart routes with a cart actually assigned'));
}

// ---------------------------------------------------------------- findings

function findingList(findings, db) {
  const kept = findings
    .filter(KEEP_SEVERITY[state.severity])
    .filter((f) => matches(`${f.title} ${f.detail}`, state.search));

  const section = h('section', { class: 'panel findings' },
    h('h3', {}, plural(kept.length, 'finding'),
      findings.length !== kept.length
        ? h('span', { class: 'muted' }, ` · ${findings.length} before filtering`)
        : null));

  if (!kept.length) {
    section.append(h('p', { class: 'empty' }, findings.length
      ? 'Nothing matches that filter.'
      : 'Nothing is short. Every kind has spares and every route has a cart.'));
    return section;
  }

  for (const item of kept) {
    section.append(h('article', { class: `finding ${item.severity}` },
      h('div', { class: 'finding-head' },
        h('span', { class: `sev ${item.severity}` }, item.severity),
        h('h4', {}, item.title)),
      h('p', { class: 'finding-detail' }, item.detail),
      asList(item.piles).length
        ? h('div', { class: 'chips' }, asList(item.piles).map((id) => {
          const pile = db.nodeById.get(id);
          if (!pile) return null;
          return h('button', {
            class: 'chip stockpile',
            title: 'Show on the stockpile cross-section',
            onclick: () => { focusStockpile(id); location.hash = 'stockpiles'; },
          }, pile.name, h('em', {}, ` ${db.elevLabel(pile.z)}`));
        }))
        : null));
  }
  return section;
}

// ------------------------------------------------------------- the census

/** Where the free ones of a kind are, as pile chips. */
function pileChips(kind, db) {
  const piles = asList(kind.piles).filter((p) => p.empty > 0);
  if (!piles.length) return h('span', { class: 'muted' }, '—');
  return h('span', { class: 'chips tight' }, piles.slice(0, 5).map((entry) => {
    const pile = db.nodeById.get(entry.id);
    return h('button', {
      class: 'chip stockpile',
      title: `${entry.empty} empty of ${entry.total} here`,
      onclick: () => { focusStockpile(entry.id); location.hash = 'stockpiles'; },
    }, pile ? pile.name : `pile ${entry.id}`, h('em', {}, ` ${entry.empty}`));
  }));
}

function kindTable(section, db) {
  const panel = h('section', { class: 'panel' },
    h('h3', {}, section.label, h('span', { class: 'muted' }, ` · ${section.blurb}`)));

  panel.append(h('table', { class: 'grid' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Kind'),
      COLUMNS.map((c) => h('th', { class: 'num', title: c.title }, c.label)),
      h('th', {}, 'Made of'),
      h('th', {}, 'Holding'),
      h('th', {}, 'Empty ones sit in'))),
    h('tbody', {}, section.kinds.map((kind) => kindRow(kind, db)))));
  return panel;
}

function kindRow(kind, db) {
  const holds = contentsOf(kind, (t) => db.itemCaption(t));
  const classes = byMatClass(kind);
  const dry = kind.free === 0 && kind.role === 'storage';

  return h('tr', { class: dry ? 'warn-row' : '' },
    h('td', {},
      h('strong', {}, pluralName(kind.name)),
      // For a tool, DF's own statement of what it is for; for a plain item
      // type there is no such field, so the raw enum key stands in — the
      // same muted-key idiom the Flow view uses.
      h('div', { class: 'small muted' }, asList(kind.uses).length
        ? asList(kind.uses).map(words).join(', ')
        : String(kind.item_type || ''))),
    COLUMNS.map((c) => {
      const value = kind[c.key] || 0;
      const emphasis = c.key === 'free'
        ? (value === 0 ? 'num warn' : 'num strong')
        : (value === 0 ? 'num muted' : 'num');
      return h('td', { class: emphasis }, String(value));
    }),
    h('td', {}, classes.length
      ? h('span', { class: 'chips tight' }, classes.slice(0, 4).map((c) => h('span', {
        class: `tag mat-${c.mat_class}`,
        title: `${c.empty} of these are empty`,
      }, c.mat_class, h('em', {}, ` ${c.count}`))))
      : h('span', { class: 'muted' }, '—')),
    h('td', {}, holds.length
      ? h('span', { class: 'chips tight' }, holds.slice(0, 4).map((entry) => h('span', {
        class: 'tag',
        title: `${entry.count} ${pluralName(kind.name)} whose top item is ${entry.caption}`,
      }, entry.caption, h('em', {}, ` ${entry.count}`))))
      : h('span', { class: 'muted' }, 'nothing')),
    h('td', {}, pileChips(kind, db)));
}

// ----------------------------------------------------------------- routes

/**
 * Minecart routes, and whether each has a cart.
 *
 * A route with no vehicle is configured, listed and completely inert. DF
 * reports nothing about it, and the only way to notice in game is to open
 * every route in turn — which is why this panel shows even when nothing is
 * wrong with it.
 */
function routePanel(routes, db) {
  const panel = h('section', { class: 'panel' },
    h('h3', {}, 'Minecart routes',
      h('span', { class: 'muted' }, ' · a route with no cart never runs')));

  if (!routes.length) {
    panel.append(h('p', { class: 'empty' }, 'No hauling routes are set up.'));
    return panel;
  }

  panel.append(h('table', { class: 'grid' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Route'),
      h('th', { class: 'num' }, 'Stops'),
      h('th', { class: 'num' }, 'Carts'),
      h('th', {}, 'State'))),
    h('tbody', {}, routes.map((route) => {
      const carts = asList(route.carts).filter((c) => !c.missing);
      const lost = asList(route.carts).length - carts.length;
      return h('tr', { class: carts.length ? '' : 'warn-row' },
        h('td', {}, h('strong', {}, route.name || `Route ${route.id}`)),
        h('td', { class: 'num' }, String(route.stops || 0)),
        h('td', { class: carts.length ? 'num' : 'num warn' }, String(carts.length)),
        h('td', {}, carts.length
          ? h('span', { class: 'muted' },
            lost ? `running, ${plural(lost, 'cart')} missing` : 'running')
          : h('span', { class: 'warn-text' }, 'no cart assigned — inert')));
    }))));
  return panel;
}
