// Skills view: per-category highlights plus a filterable roster.

import { h, clear, matches, pct, plural } from '../util.js';

const HIGHLIGHT_COUNT = 6;

const state = {
  mode: 'highlights',
  search: '',
  category: '',
  wave: '',
  workDetail: '',
  squad: '',
  idleOnly: false,
  selectedUnitId: null,
};

export function render(root, db) {
  clear(root);
  const body = h('div', { class: 'view-body' });
  root.append(toolbar(db, () => draw(body, db)), body);
  draw(body, db);
}

function toolbar(db, redraw) {
  const search = h('input', {
    type: 'search',
    placeholder: 'Search dwarf, skill, or profession…',
    value: state.search,
    oninput: (e) => { state.search = e.target.value; redraw(); },
  });

  const select = (label, options, key) => h('label', { class: 'field' },
    h('span', {}, label),
    h('select', {
      onchange: (e) => { state[key] = e.target.value; redraw(); },
    }, h('option', { value: '' }, 'all'),
      options.map((o) => h('option', { value: o, selected: state[key] === o }, o))));

  return h('div', { class: 'toolbar' },
    h('div', { class: 'segmented' },
      ['highlights', 'roster'].map((mode) => h('button', {
        class: state.mode === mode ? 'active' : '',
        onclick: () => { state.mode = mode; redraw(); },
      }, mode))),
    h('label', { class: 'field grow' }, h('span', {}, 'Filter'), search),
    select('Category', db.categoryNames, 'category'),
    select('Wave', db.waves, 'wave'),
    select('Work detail', db.workDetails.map((w) => w.name), 'workDetail'),
    select('Squad', db.squads.map((s) => s.display_name), 'squad'),
    h('label', { class: 'field check' },
      h('input', {
        type: 'checkbox',
        checked: state.idleOnly,
        onchange: (e) => { state.idleOnly = e.target.checked; redraw(); },
      }),
      h('span', {}, 'Idle only')));
}

function filterUnits(db) {
  return db.units.filter((unit) => {
    if (state.wave && (!unit.wave || unit.wave.label !== state.wave)) return false;
    if (state.workDetail && !unit.work_details.includes(state.workDetail)) return false;
    if (state.squad && (!unit.squad || unit.squad.display_name !== state.squad)) return false;
    if (state.idleOnly && !unit.idle) return false;
    if (state.category && !unit.best.has(state.category)) return false;
    if (!state.search) return true;
    return matches(unit.name, state.search)
      || matches(unit.profession, state.search)
      || unit.skills.some((s) => {
        const def = db.skills.get(s.key);
        return def && s.rating > 0 && matches(def.caption, state.search);
      });
  });
}

function draw(body, db) {
  clear(body);
  const units = filterUnits(db);
  body.append(h('p', { class: 'summary' },
    `${plural(units.length, 'dwarf', 'dwarves')} of ${db.units.length}`,
    state.idleOnly ? ' · idle right now' : ''));

  const redraw = () => draw(body, db);
  const select = (unit) => {
    state.selectedUnitId = state.selectedUnitId === unit.id ? null : unit.id;
    redraw();
  };

  if (state.mode === 'highlights') body.append(highlights(db, units, select));
  else body.append(roster(db, units, select));

  if (state.selectedUnitId !== null) {
    const unit = db.unitById.get(state.selectedUnitId);
    if (unit) body.append(unitDetail(db, unit, redraw));
  }
}

function highlights(db, units, select) {
  const categories = state.category ? [state.category] : db.categoryNames;
  const cards = categories.map((category) => {
    const ranked = units
      .filter((u) => u.best.has(category))
      .sort((a, b) => b.best.get(category).rating - a.best.get(category).rating
        || a.name.localeCompare(b.name))
      .slice(0, HIGHLIGHT_COUNT);
    if (!ranked.length) return null;
    return h('section', { class: 'card' },
      h('h3', {}, category, h('span', { class: 'muted' },
        ` ${units.filter((u) => u.best.has(category)).length}`)),
      h('ol', { class: 'ranked' }, ranked.map((unit) => {
        const best = unit.best.get(category);
        return h('li', { onclick: () => select(unit) },
          h('span', { class: 'rank-name' }, unit.name),
          h('span', { class: `rank-skill lvl-${Math.min(best.rating, 15)}` },
            `${best.def.caption} · ${db.ratingName(best.rating)}`));
      })));
  }).filter(Boolean);

  return h('div', { class: 'card-grid' }, cards.length ? cards
    : h('p', { class: 'empty' }, 'No dwarves match these filters.'));
}

function roster(db, units, select) {
  const sorted = [...units].sort((a, b) => {
    if (state.category) {
      const ra = a.best.get(state.category)?.rating ?? -1;
      const rb = b.best.get(state.category)?.rating ?? -1;
      if (ra !== rb) return rb - ra;
    }
    return a.name.localeCompare(b.name);
  });

  return h('table', { class: 'grid' },
    h('thead', {}, h('tr', {},
      ['Dwarf', 'Profession', 'Age', 'Wave', 'Squad', 'Work details',
        'Top skills', 'Idle', 'Stress'].map((label) => h('th', {}, label)))),
    h('tbody', {}, sorted.map((unit) => h('tr', {
      class: state.selectedUnitId === unit.id ? 'selected' : '',
      onclick: () => select(unit),
    },
      h('td', {}, unit.name, unit.nobles.length
        ? h('span', { class: 'badge' }, unit.nobles[0]) : null),
      h('td', {}, unit.profession),
      h('td', {}, Math.floor(unit.age)),
      h('td', { class: 'muted' }, unit.wave ? unit.wave.label : 'founder/born'),
      h('td', {}, unit.squad ? unit.squad.display_name : '—'),
      h('td', { class: 'muted' }, unit.work_details.join(', ') || '—'),
      h('td', {}, unit.topSkills.map((s) => h('span', {
        class: `chip lvl-${Math.min(s.rating, 15)}`,
      }, `${s.def.caption} ${s.rating}`))),
      h('td', { class: unit.idle ? 'idle-now' : '' },
        idleLabel(unit)),
      h('td', {}, h('span', { class: `stress s${unit.stress_category}` },
        String(unit.stress_category)))))));
}

function idleLabel(unit) {
  if (unit.idleSamples > 1) return `${pct(unit.idleRate)} (${unit.idleSamples})`;
  return unit.idle ? 'idle' : 'working';
}

function unitDetail(db, unit, redraw) {
  const grouped = db.skillsByCategory(unit);
  const order = db.categoryNames.filter((c) => grouped.has(c));

  return h('aside', { class: 'detail' },
    h('header', {},
      h('h3', {}, unit.name),
      h('button', { class: 'ghost', onclick: () => { state.selectedUnitId = null; redraw(); } }, '✕')),
    h('p', { class: 'muted' },
      `${unit.profession} · ${Math.floor(unit.age)} years · ${unit.sex}`,
      unit.nobles.length ? ` · ${unit.nobles.join(', ')}` : '',
      unit.squad ? ` · ${unit.squad.display_name}` : ''),
    h('p', {},
      h('strong', {}, 'Now: '),
      unit.job ? unit.job.name : h('em', {}, 'no job'),
      unit.on_break ? ' (on break)' : '',
      unit.idleSamples > 1
        ? h('span', { class: 'muted' }, ` — idle in ${pct(unit.idleRate)} of ${unit.idleSamples} refreshes`)
        : null),
    h('p', {}, h('strong', {}, 'Work details: '),
      unit.work_details.join(', ') || h('em', {}, 'none')),
    h('div', { class: 'skill-columns' }, order.map((category) => h('div', {},
      h('h4', {}, category),
      h('ul', { class: 'skill-list' }, grouped.get(category).map((s) => h('li', {},
        h('span', {}, s.def.caption),
        h('span', { class: `lvl lvl-${Math.min(s.rating, 15)}` },
          `${db.ratingName(s.rating)} (${s.rating})`),
        s.rusty > 0 ? h('span', { class: 'rusty' }, 'rusty') : null)))))),
    h('details', {}, h('summary', {}, `Labors (${unit.labors.length})`),
      h('p', { class: 'muted small' },
        unit.labors.map((key) => db.labors.get(key)?.caption || key).join(', ') || 'none')));
}
