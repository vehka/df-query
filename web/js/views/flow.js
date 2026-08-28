// Flow view: triage for goods that are not moving.
//
// The stockpile views answer "how far apart is everything". This one answers
// "what is stuck, and why" — findings first, then the raw material they were
// drawn from, so a claim can always be checked against the numbers under it.

import { h, clear, plural, pct, asList, matches } from '../util.js';
import { diagnose, summariseFlow, isFull } from '../flow.js';
import { focus as focusStockpile } from './stockpiles.js';

const state = {
  severity: 'all',
  search: '',
  showLoose: true,
};

const SEVERITIES = [
  { value: 'all', label: 'everything' },
  { value: 'high', label: 'urgent only' },
  { value: 'medium', label: 'urgent + notable' },
];

const KEEP = {
  all: () => true,
  high: (f) => f.severity === 'high',
  medium: (f) => f.severity !== 'low',
};

export function render(root, db) {
  clear(root);
  if (!db.hasFlow) {
    root.append(h('p', { class: 'empty' },
      'This snapshot predates the flow dumper. Hit Refresh to collect the '
      + 'loose-goods and hauling data.'));
    return;
  }

  const toolbar = h('div', { class: 'toolbar' });
  const body = h('div', { class: 'view-body' });
  root.append(toolbar, body);

  const redraw = () => draw(body, db);
  toolbar.append(
    h('div', { class: 'segmented' }, SEVERITIES.map((option) => h('button', {
      class: state.severity === option.value ? 'active' : '',
      onclick: () => { state.severity = option.value; redraw(); },
    }, option.label))),
    h('label', { class: 'field grow' }, h('span', {}, 'Filter'),
      h('input', {
        type: 'search',
        placeholder: 'Search findings, piles, or item types…',
        value: state.search,
        oninput: (e) => { state.search = e.target.value; redraw(); },
      })),
    h('label', { class: 'field check' },
      h('input', {
        type: 'checkbox',
        checked: state.showLoose,
        onchange: (e) => { state.showLoose = e.target.checked; redraw(); },
      }),
      h('span', {}, 'Loose goods table')),
  );
  redraw();
}

function draw(body, db) {
  clear(body);
  const input = db.flowInput();
  const stats = summariseFlow(input);
  const findings = diagnose(input);

  // Findings lead: the point of the view is triage, and the queue and the
  // loose table are the evidence you check a finding against.
  body.append(headline(stats, db));
  body.append(findingList(findings, db));
  body.append(haulingLanes(asList(db.flow.hauling)));
  if (state.showLoose) body.append(looseTable(db));
}

// ----------------------------------------------------------------- headline

function stat(value, label, title) {
  return h('div', { class: 'stat', title: title || null },
    h('div', { class: 'value' }, value),
    h('div', { class: 'label' }, label));
}

function headline(stats, db) {
  const loose = db.flow.loose;
  return h('div', { class: 'stat-strip' },
    stat(String(stats.loose), 'loose items',
      'on the floor, outside every stockpile'),
    stat(String(stats.loose - stats.claimed), 'unclaimed',
      'nobody is on their way to fetch these'),
    stat(pct(stats.fill), 'pile space used',
      `${stats.used} of ${stats.tiles} stockpile tiles hold something`),
    stat(String(stats.full), 'full piles',
      'every tile occupied — they cannot take more without containers'),
    stat(String(stats.queued), 'storage jobs',
      `${stats.unclaimed} with nobody assigned`),
    stat(String(loose.forbidden), 'forbidden',
      'loose and excluded from hauling by the player'));
}

// -------------------------------------------------------------- haul queues

/**
 * DF's own counters. `Any` is the fort-wide total rather than a lane of its
 * own, so it becomes the scale the lanes are drawn against.
 */
function haulingLanes(lanes) {
  const rows = lanes.filter((lane) => lane.key !== 'Any');
  if (!rows.length) return h('div', {});
  const peak = Math.max(1, ...rows.map((lane) => lane.jobs));

  return h('section', { class: 'panel lanes' },
    h('h3', {}, 'Hauling queue',
      h('span', { class: 'muted' }, ' · what DF has queued, per class')),
    h('div', { class: 'lane-grid' },
      h('div', { class: 'lane head' },
        h('span', {}, ''), h('span', {}, ''),
        h('span', { class: 'lane-jobs' }, 'jobs'),
        h('span', { class: 'lane-haulers' }, 'haulers')),
      rows.map((lane) => h('div', {
        class: 'lane'
          + (lane.jobs === 0 ? ' idle' : '')
          + (lane.jobs > 0 && lane.haulers === 0 ? ' starved' : ''),
        title: `${plural(lane.jobs, 'job')} · ${plural(lane.haulers, 'dwarf', 'dwarves')} enabled for ${lane.key} hauling`,
      },
        h('span', { class: 'lane-name' }, lane.key),
        h('span', { class: 'lane-bar' },
          h('span', { class: 'fill', style: `width: ${(lane.jobs / peak) * 100}%` })),
        h('span', { class: 'lane-jobs' }, String(lane.jobs)),
        h('span', { class: 'lane-haulers' }, String(lane.haulers))))));
}

// --------------------------------------------------------------- findings

function findingList(findings, db) {
  const kept = findings
    .filter(KEEP[state.severity])
    .filter((f) => matches(`${f.title} ${f.detail}`, state.search));

  const section = h('section', { class: 'panel findings' },
    h('h3', {}, plural(kept.length, 'finding'),
      findings.length !== kept.length
        ? h('span', { class: 'muted' }, ` · ${findings.length} before filtering`)
        : null));

  if (!kept.length) {
    section.append(h('p', { class: 'empty' }, findings.length
      ? 'Nothing matches that filter.'
      : 'Nothing is obviously stuck. Goods are reaching their piles.'));
    return section;
  }

  for (const item of kept) section.append(findingCard(item, db));
  return section;
}

function findingCard(item, db) {
  const nodes = item.nodes
    .map((id) => db.nodeById.get(id))
    .filter(Boolean)
    .slice(0, 12);

  return h('article', { class: `finding ${item.severity}` },
    h('div', { class: 'finding-head' },
      h('span', { class: `sev ${item.severity}` }, item.severity),
      h('h4', {}, item.title)),
    h('p', { class: 'finding-detail' }, item.detail),
    nodes.length
      ? h('div', { class: 'chips' }, nodes.map((node) => h('button', {
        class: `chip ${node.node}`,
        title: 'Show on the stockpile cross-section',
        onclick: () => {
          focusStockpile(node.id);
          location.hash = 'stockpiles';
        },
      }, node.name, h('em', {}, ` ${db.elevLabel(node.z)}`))))
      : null);
}

// ------------------------------------------------------------ loose goods

function looseTable(db) {
  const rows = asList(db.flow.loose.by_type)
    .filter((row) => matches(`${row.type} ${db.itemCaption(row.type)}`, state.search));

  const section = h('section', { class: 'panel' },
    h('h3', {}, 'Loose goods',
      h('span', { class: 'muted' },
        ' · on the floor, outside every pile — an outlined pile is full')));

  if (!rows.length) {
    section.append(h('p', { class: 'empty' }, 'Nothing loose matches that filter.'));
    return section;
  }

  section.append(h('table', { class: 'grid' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Item'),
      h('th', { class: 'num' }, 'Loose'),
      h('th', { class: 'num' }, 'Claimed'),
      h('th', { class: 'num' }, 'Forbidden'),
      h('th', {}, 'Where'),
      h('th', {}, 'Held by'))),
    h('tbody', {}, rows.map((row) => {
      const holders = db.stockpiles.filter((p) => (p.items_by_type || {})[row.type] > 0);
      return h('tr', {},
        h('td', {},
          h('strong', {}, db.itemCaption(row.type)),
          h('span', { class: 'muted' }, ` ${row.type}`)),
        h('td', { class: 'num' }, String(row.count)),
        h('td', { class: 'num muted' }, String(row.claimed || 0)),
        h('td', { class: `num ${row.forbidden ? 'warn' : 'muted'}` },
          String(row.forbidden || 0)),
        h('td', { class: 'levels' }, asList(row.levels).slice(0, 5).map((level) =>
          h('span', {
            class: 'zchip',
            title: `x${level.x1}–${level.x2}, y${level.y1}–${level.y2}`,
          }, db.elevLabel(level.z), h('em', {}, ` ${level.count}`)))),
        h('td', { class: 'holders' }, holders.length
          ? holders.slice(0, 4).map((pile) => h('span', {
            class: `zchip${isFull(pile) ? ' full' : ''}`,
            title: `${pile.used_tiles}/${pile.area} tiles used`,
          }, pile.name))
          : h('span', { class: 'muted' }, 'nothing holds these')));
    }))));
  return section;
}
