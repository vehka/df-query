// Animals view: livestock grouped by the pasture they are assigned to.

import { h, clear, matches, formatBox, formatPos, plural } from '../util.js';

// Zone types that hold animals. Everything else is a pasture-adjacent zone we
// still want to name if an animal happens to be assigned to it.
const PEN_TYPES = new Set(['Pen', 'AnimalPit']);

const state = {
  search: '',
  grouping: 'pasture',
  hideUnassigned: false,
};

export function render(root, db) {
  clear(root);
  const body = h('div', { class: 'view-body' });
  root.append(toolbar(() => draw(body, db)), body);
  draw(body, db);
}

function toolbar(redraw) {
  return h('div', { class: 'toolbar' },
    h('div', { class: 'segmented' },
      ['pasture', 'species'].map((mode) => h('button', {
        class: state.grouping === mode ? 'active' : '',
        onclick: () => { state.grouping = mode; redraw(); },
      }, `by ${mode}`))),
    h('label', { class: 'field grow' }, h('span', {}, 'Filter'),
      h('input', {
        type: 'search',
        placeholder: 'Search animal, species, or pasture…',
        value: state.search,
        oninput: (e) => { state.search = e.target.value; redraw(); },
      })),
    h('label', { class: 'field check' },
      h('input', {
        type: 'checkbox',
        checked: state.hideUnassigned,
        onchange: (e) => { state.hideUnassigned = e.target.checked; redraw(); },
      }),
      h('span', {}, 'Hide unpastured')));
}

function visibleAnimals(db) {
  return db.animals.filter((a) => {
    if (state.hideUnassigned && !a.zone_id) return false;
    if (!state.search) return true;
    const zone = a.zone_id ? db.zoneById.get(a.zone_id) : null;
    return matches(a.name, state.search)
      || matches(a.race, state.search)
      || matches(zone && zone.name, state.search);
  });
}

function draw(body, db) {
  clear(body);
  const animals = visibleAnimals(db);
  const grazers = animals.filter((a) => a.grazer).length;
  const unpastured = animals.filter((a) => !a.zone_id).length;

  body.append(h('p', { class: 'summary' },
    `${plural(animals.length, 'animal')} · ${grazers} grazers · ${unpastured} unpastured`));

  body.append(state.grouping === 'pasture' ? byPasture(db, animals) : bySpecies(animals));
}

function byPasture(db, animals) {
  const groups = new Map();
  for (const animal of animals) {
    const key = animal.zone_id ?? 'none';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(animal);
  }

  // Every pasture, including empty ones — an empty pasture is usually the
  // thing you are trying to find.
  for (const zone of db.zones) {
    if (PEN_TYPES.has(zone.type) && !groups.has(zone.id) && !state.search) {
      groups.set(zone.id, []);
    }
  }

  const cards = [...groups.entries()]
    .map(([key, members]) => {
      const zone = key === 'none' ? null : db.zoneById.get(key);
      return { key, zone, members, name: zone ? (zone.name || `Zone ${zone.number}`) : 'Not in a pasture' };
    })
    .sort((a, b) => (a.key === 'none' ? 1 : b.key === 'none' ? -1 : 0)
      || b.members.length - a.members.length
      || a.name.localeCompare(b.name));

  return h('div', { class: 'card-grid wide' }, cards.map(({ zone, members, name }) => {
    const grazers = members.filter((m) => m.grazer).length;
    return h('section', { class: 'card' },
      h('h3', {}, name,
        zone && !zone.active ? h('span', { class: 'badge warn' }, 'inactive') : null),
      zone
        ? h('p', { class: 'muted mono' }, formatBox(zone, db), ` · ${zone.area} tiles`,
          grazers ? ` · ${(zone.area / grazers).toFixed(1)} tiles/grazer` : '')
        : h('p', { class: 'muted' }, 'Roaming free — no pen or pasture assignment.'),
      members.length ? h('p', {}, speciesChips(members)) : null,
      members.length
        ? h('table', { class: 'grid compact' },
          h('thead', {}, h('tr', {},
            ['Animal', 'Sex', 'Age', 'Traits', 'Where'].map((l) => h('th', {}, l)))),
          h('tbody', {}, members
            .sort((a, b) => a.race.localeCompare(b.race) || a.name.localeCompare(b.name))
            .map((a) => h('tr', {},
              h('td', {}, a.nickname || a.name),
              h('td', {}, a.sex === 'male' ? '♂' : a.sex === 'female' ? '♀' : '—'),
              h('td', {}, `${Math.floor(a.age)}${a.adult ? '' : ' (young)'}`),
              h('td', {}, traits(a)),
              h('td', { class: 'muted mono' }, formatPos(a.pos, db))))))
        : h('p', { class: 'empty' }, 'No animals assigned.'));
  }));
}

function speciesChips(members) {
  const counts = new Map();
  for (const animal of members) counts.set(animal.race, (counts.get(animal.race) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([race, count]) => h('span', { class: 'chip' }, `${race} ${count}`));
}

function bySpecies(animals) {
  const groups = new Map();
  for (const animal of animals) {
    if (!groups.has(animal.race)) groups.set(animal.race, []);
    groups.get(animal.race).push(animal);
  }
  const rows = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  return h('table', { class: 'grid' },
    h('thead', {}, h('tr', {},
      ['Species', 'Total', 'Male', 'Female', 'Young', 'Grazers', 'Unpastured', 'Slaughter']
        .map((l) => h('th', {}, l)))),
    h('tbody', {}, rows.map(([race, members]) => h('tr', {},
      h('td', {}, race),
      h('td', {}, members.length),
      h('td', {}, members.filter((m) => m.sex === 'male').length),
      h('td', {}, members.filter((m) => m.sex === 'female').length),
      h('td', {}, members.filter((m) => !m.adult).length),
      h('td', {}, members.filter((m) => m.grazer).length),
      h('td', {}, members.filter((m) => !m.zone_id).length),
      h('td', {}, members.filter((m) => m.marked_for_slaughter).length)))));
}

function traits(animal) {
  const flags = [
    animal.grazer && 'grazer',
    animal.milkable && 'milkable',
    animal.egg_layer && 'egg layer',
    animal.war && 'war',
    animal.hunting && 'hunting',
    animal.gelded && 'gelded',
    animal.marked_for_slaughter && 'slaughter',
    animal.marked_for_gelding && 'to geld',
  ].filter(Boolean);
  return flags.map((f) => h('span', {
    class: `chip ${f === 'slaughter' ? 'warn' : ''}`,
  }, f));
}
