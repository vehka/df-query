// Squads view: roster, barracks, and the 12-month training schedule.

import { h, clear, asList, plural } from '../util.js';

const MONTH_INITIALS = ['G', 'S', 'F', 'H', 'M', 'Ga', 'L', 'Sa', 'T', 'Mo', 'O', 'Ob'];

const state = { showAllRoutines: false };

export function render(root, db) {
  clear(root);
  const body = h('div', { class: 'view-body' });
  root.append(toolbar(() => draw(body, db)), body);
  draw(body, db);
}

function toolbar(redraw) {
  return h('div', { class: 'toolbar' },
    h('label', { class: 'field check' },
      h('input', {
        type: 'checkbox',
        checked: state.showAllRoutines,
        onchange: (e) => { state.showAllRoutines = e.target.checked; redraw(); },
      }),
      h('span', {}, 'Show all routines')));
}

function draw(body, db) {
  clear(body);
  if (!db.squads.length) {
    body.append(h('p', { class: 'empty' }, 'This fortress has no squads.'));
    return;
  }
  const filled = db.squads.reduce((total, sq) =>
    total + asList(sq.positions).filter((p) => p.unit_id).length, 0);
  body.append(h('p', { class: 'summary' },
    `${plural(db.squads.length, 'squad')} · ${plural(filled, 'soldier')}`));
  body.append(h('div', { class: 'card-grid wide' }, db.squads.map((sq) => squadCard(db, sq))));
}

function squadCard(db, squad) {
  const positions = asList(squad.positions);
  const members = positions.filter((p) => p.unit_id);
  const routines = asList(squad.schedule);
  const shown = state.showAllRoutines
    ? routines
    : routines.filter((r) => r.index === squad.cur_routine_idx);

  return h('section', { class: 'card' },
    h('h3', {}, squad.display_name || squad.name,
      h('span', { class: 'muted' }, ` #${squad.id}`)),
    h('p', { class: 'muted' },
      `${members.length}/${positions.length} positions filled`,
      squad.alias && squad.alias !== squad.name ? ` · named "${squad.name}"` : ''),

    h('h4', {}, 'Roster'),
    members.length
      ? h('table', { class: 'grid compact' },
        h('thead', {}, h('tr', {},
          ['#', 'Soldier', 'Combat skills', 'Doing now'].map((l) => h('th', {}, l)))),
        h('tbody', {}, members.map((pos) => {
          const unit = db.unitById.get(pos.unit_id);
          return h('tr', {},
            h('td', { class: 'muted' }, pos.index),
            h('td', { title: unit ? unit.name : '' },
              unit ? unit.label : pos.name || `hf ${pos.occupant_hf}`),
            h('td', {}, unit ? combatChips(db, unit) : h('span', { class: 'muted' }, '—')),
            h('td', { class: 'muted' }, unit && unit.job ? unit.job.name : 'no job'));
        })))
      : h('p', { class: 'empty' }, 'No soldiers assigned.'),

    h('h4', {}, 'Barracks'),
    asList(squad.rooms).length
      ? h('ul', {}, asList(squad.rooms).map((room) => h('li', {},
        room.name, h('span', { class: 'muted' }, ` — ${asList(room.modes).join(', ') || 'no use set'}`))))
      : h('p', { class: 'muted' }, 'None assigned.'),

    h('h4', {}, 'Schedule'),
    shown.map((routine) => scheduleGrid(routine, routine.index === squad.cur_routine_idx)));
}

function combatChips(db, unit) {
  const combat = unit.skills
    .map((s) => ({ ...s, def: db.skills.get(s.key) }))
    .filter((s) => s.def && s.def.category === 'Combat' && s.rating > 0)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 3);
  if (!combat.length) return h('span', { class: 'muted' }, 'untrained');
  return combat.map((s) => h('span', {
    class: `chip lvl-${Math.min(s.rating, 15)}`,
  }, `${s.def.caption} ${s.rating}`));
}

function scheduleGrid(routine, isCurrent) {
  return h('div', { class: `schedule ${isCurrent ? 'current' : 'inactive'}` },
    h('div', { class: 'schedule-label' },
      `routine ${routine.index}`,
      isCurrent ? h('span', { class: 'badge' }, 'active') : null),
    h('div', { class: 'months' }, asList(routine.months).map((month) => {
      const orders = asList(month.orders);
      const training = orders.find((o) => o.type === 'TRAIN');
      const title = orders.length
        ? orders.map((o) => `${o.type} (min ${o.min_count})`).join('; ')
        : 'off duty';
      return h('span', {
        class: `month ${orders.length ? 'on' : 'off'}`,
        title: `${month.name} — ${title}`,
      }, MONTH_INITIALS[month.month],
        orders.length
          ? h('em', {}, String(training ? training.min_count : orders[0].min_count))
          : null);
    })));
}
