// Equipment view: where the military's armour is thin, and what it would
// take to fix it.
//
// Three panels, in the order you act on them. The findings say what is
// wrong. The forge order folds every gap in the fort into one list per
// piece, against the metal actually on hand. The roster is the evidence —
// one row per soldier, one cell per slot, so any claim above can be
// checked against the kit it came from.

import { h, clear, plural, pct, asList, matches } from '../util.js';
import {
  diagnose, summarise, roster, shoppingList,
  GREEN_ARMOR_SKILL, AMMO_TARGET,
} from '../armory.js';

const state = {
  severity: 'all',
  search: '',
  squad: 'all',
  showRoster: true,
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

// What each slot verdict means, in one word for the roster cell and one
// phrase for its tooltip. The order is the display order too: the worst
// verdict in a slot is the one the roster cell shows.
const VERDICT = {
  missing: { short: 'none', why: 'nothing here, and nothing earmarked for it' },
  wrong: { short: 'wrong', why: 'the wrong kind of piece for this line of the uniform' },
  soft: { short: 'soft', why: 'softer than the uniform asks for' },
  partial: { short: 'half', why: 'a pair, half issued' },
  unclaimed: { short: 'waiting', why: 'earmarked for them, still in a stockpile' },
  light: { short: 'light', why: 'metal, but the open-faced kind' },
  downgrade: { short: 'soft metal', why: 'metal, but not the best the fort has' },
  ok: { short: 'ok', why: 'what the uniform asks for' },
};

const VERDICT_ORDER = Object.keys(VERDICT);

export function render(root, db) {
  clear(root);
  if (!db.hasArmory) {
    root.append(h('p', { class: 'empty' },
      'This snapshot predates the equipment dumper. Hit Refresh to collect '
      + 'soldier inventories and the fort’s spare gear.'));
    return;
  }
  if (!db.squads.length) {
    root.append(h('p', { class: 'empty' }, 'This fort has no squads.'));
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
    h('label', { class: 'field' }, h('span', {}, 'Squad'),
      h('select', {
        onchange: (e) => { state.squad = e.target.value; redraw(); },
      },
        h('option', { value: 'all', selected: state.squad === 'all' }, 'all squads'),
        db.squads.map((squad) => h('option', {
          value: String(squad.id),
          selected: state.squad === String(squad.id),
        }, squad.display_name || squad.name)))),
    h('label', { class: 'field grow' }, h('span', {}, 'Filter'),
      h('input', {
        type: 'search',
        placeholder: 'Search soldiers, squads, or materials…',
        value: state.search,
        oninput: (e) => { state.search = e.target.value; redraw(); },
      })),
    h('label', { class: 'field check' },
      h('input', {
        type: 'checkbox',
        checked: state.showRoster,
        onchange: (e) => { state.showRoster = e.target.checked; redraw(); },
      }),
      h('span', {}, 'Soldier roster')),
  );
  redraw();
}

function inSquad(squadId) {
  return state.squad === 'all' || String(squadId) === state.squad;
}

function draw(body, db) {
  clear(body);
  const input = db.armoryInput();
  const stats = summarise(input);
  const soldiers = roster(input).filter((s) => inSquad(s.squad.id));

  body.append(headline(stats, db));
  body.append(findingList(diagnose(input), db));
  body.append(forgeOrder(shoppingList(soldiers, input), soldiers, db));
  if (state.showRoster) body.append(rosterTable(soldiers, db));
}

// ----------------------------------------------------------------- headline

function stat(value, label, title) {
  return h('div', { class: 'stat', title: title || null },
    h('div', { class: 'value' }, value),
    h('div', { class: 'label' }, label));
}

function headline(stats, db) {
  return h('div', { class: 'stat-strip' },
    stat(String(stats.soldiers), 'soldiers',
      `${stats.graded} in squads with a uniform set`),
    stat(pct(stats.coverage), 'slots to standard',
      `${stats.covered} of ${stats.slots} armour slots hold what the squad's own uniform asks `
      + 'for — metal where it says metal, leather where it says leather'),
    stat(String(stats.fullyKitted), 'fully kitted',
      'every line of their uniform met, in the best metal the fort makes'),
    stat(String(stats.waiting), 'kit waiting',
      'soldiers with pieces earmarked for them still sitting in a stockpile — made, '
      + 'not collected'),
    stat(stats.best ? stats.best.material : '—', 'best metal',
      'the strongest armour metal the fort has, worn or in stock'),
    stat(String(stats.spare), 'spare pieces',
      'free metal armour anywhere in the fort, unclaimed'),
    stat(`${stats.archersDry}/${stats.archers}`, 'quivers short',
      `archers carrying fewer than ${AMMO_TARGET} bolts`
      + (stats.archersWaiting
        ? `; ${stats.archersWaiting} more have not collected their quiver yet`
        : '')));
}

// --------------------------------------------------------------- findings

function findingList(findings, db) {
  const kept = findings
    .filter(KEEP[state.severity])
    .filter((f) => inSquad(f.squadId === undefined ? state.squad : f.squadId))
    .filter((f) => matches(`${f.title} ${f.detail} ${(f.names || []).join(' ')}`, state.search));

  const section = h('section', { class: 'panel findings' },
    h('h3', {}, plural(kept.length, 'finding'),
      findings.length !== kept.length
        ? h('span', { class: 'muted' }, ` · ${findings.length} before filtering`)
        : null));

  if (!kept.length) {
    section.append(h('p', { class: 'empty' }, findings.length
      ? 'Nothing matches that filter.'
      : 'Every soldier is in the best metal the fort makes.'));
    return section;
  }

  for (const item of kept) {
    section.append(h('article', { class: `finding ${item.severity}` },
      h('div', { class: 'finding-head' },
        h('span', { class: `sev ${item.severity}` }, item.severity),
        h('h4', {}, item.title)),
      h('p', { class: 'finding-detail' }, item.detail),
      item.names && item.names.length
        ? h('div', { class: 'chips' },
          item.names.slice(0, 12).map((name) => h('span', { class: 'chip' }, name)),
          item.names.length > 12
            ? h('span', { class: 'muted' }, ` +${item.names.length - 12} more`)
            : null)
        : null));
  }
  return section;
}

// ------------------------------------------------------------ forge order

/**
 * The concatenated shopping list. `need` is every gap including upgrades;
 * `urgent` drops the "metal, but softer than the fort's best" rows, which
 * are worth doing and worth doing second.
 */
function forgeOrder(list, soldiers, db) {
  const section = h('section', { class: 'panel' },
    h('h3', {}, 'Forge order',
      h('span', { class: 'muted' },
        ' · every gap in the fort, folded into one line per piece. A piece already '
        + 'earmarked for a soldier is counted as waiting, not as work.')));

  if (!list.rows.length) {
    // "Nothing to make" and "nobody here is being graded" look identical
    // in an empty table, and only one of them is good news.
    const gradable = soldiers.some((s) => s.uniformed);
    section.append(h('p', { class: 'empty' }, !soldiers.length
      ? 'No soldiers here.'
      : (gradable
        ? 'Nothing to make. Every graded soldier has a full kit.'
        : 'Nobody here is graded — set a uniform first, and these soldiers '
          + 'will start showing up in the list.')));
    return section;
  }

  section.append(h('table', { class: 'grid forge' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Piece'),
      h('th', { class: 'num', title: 'pieces the fort has to find or make' }, 'Need'),
      h('th', { class: 'num', title: 'of those, the bare slots rather than the upgrades' },
        'Urgent'),
      h('th', {
        class: 'num',
        title: 'already made and earmarked for a soldier who has not collected it — not work',
      }, 'Waiting'),
      h('th', { class: 'num', title: 'free in the fort, unclaimed' }, 'In stock'),
      h('th', { class: 'num', title: 'need, less what is in stock' }, 'To make'),
      h('th', {}, 'Why'))),
    h('tbody', {}, list.rows.map((row) => h('tr', {
      class: `${row.vital ? 'vital' : ''}${row.need ? '' : ' waiting-only'}`,
    },
      h('td', {},
        h('strong', {}, row.label),
        row.vital ? h('span', { class: 'tag' }, 'vital') : null),
      h('td', { class: `num ${row.need ? '' : 'muted'}` }, String(row.need)),
      h('td', { class: `num ${row.urgent ? 'warn' : 'muted'}` }, String(row.urgent)),
      h('td', { class: `num ${row.waiting ? '' : 'muted'}` }, String(row.waiting)),
      h('td', { class: `num ${row.onHand ? '' : 'muted'}` }, String(row.onHand)),
      h('td', { class: `num ${row.shortfall ? 'strong' : 'muted'}` }, String(row.shortfall)),
      h('td', { class: 'reasons' }, row.reasons
        .sort((a, b) => b.count - a.count)
        .map(({ verdict, count }) => h('span', {
          class: `zchip ${verdict}`,
          title: (VERDICT[verdict] || {}).why,
        }, (VERDICT[verdict] || { short: verdict }).short, h('em', {}, ` ${count}`)))))))));

  section.append(barStock(list, db));
  return section;
}

function barStock(list, db) {
  const bars = list.bars.filter((bar) => bar.armor_material && bar.count > 0);
  const note = h('p', { class: 'note' });
  if (!bars.length) {
    note.append('No armour-grade metal bars in stock — every line above needs '
      + 'smelting before it needs a smith.');
    return note;
  }
  note.append('Bars on hand: ');
  note.append(h('span', { class: 'chips inline' }, bars.map((bar) => h('span', {
    class: `zchip${list.best && bar.material === list.best.material ? ' best' : ''}`,
    title: bar.material === (list.best && list.best.material)
      ? 'the best armour metal the fort has'
      : 'usable for armour, softer than the best on hand',
  }, bar.material, h('em', {}, ` ${bar.count}`)))));
  note.append(' · one bar is roughly one piece, so this is the ceiling on '
    + 'what can be made before more is smelted.');
  return note;
}

// ------------------------------------------------------------- the roster

function rosterTable(soldiers, db) {
  const kept = soldiers.filter((s) => matches(
    `${s.name} ${s.squad.display_name || s.squad.name} ${s.spec.label} `
    + asList(s.position.equipment).map((i) => `${i.material} ${i.subtype}`).join(' '),
    state.search));

  const section = h('section', { class: 'panel' },
    h('h3', {}, 'Soldiers',
      h('span', { class: 'muted' },
        ' · one cell per slot, showing the best piece in it')));

  if (!kept.length) {
    section.append(h('p', { class: 'empty' }, 'No soldier matches that filter.'));
    return section;
  }

  // One column per body part, whatever each squad's uniform names there.
  // A uniform can put two lines on one slot — leather armour over a mail
  // shirt is the common one — so a cell shows the worse of the two.
  const columns = ['head', 'body', 'hands', 'legs', 'feet', 'shield', 'weapon'];
  const heads = ['head', 'body', 'hands', 'legs', 'feet', 'shield', 'weapon'];

  section.append(h('div', { class: 'scroll' }, h('table', { class: 'grid kit' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Soldier'),
      h('th', {}, 'Squad'),
      h('th', {}, 'Role'),
      h('th', { class: 'num' }, 'Armor'),
      heads.map((label) => h('th', {}, label)),
      h('th', { class: 'num' }, 'Bolts'))),
    h('tbody', {}, kept.map((soldier) => {
      const bySlot = new Map();
      for (const entry of soldier.slots) {
        const seen = bySlot.get(entry.slot);
        if (!seen || VERDICT_ORDER.indexOf(entry.verdict) < VERDICT_ORDER.indexOf(seen.verdict)) {
          bySlot.set(entry.slot, entry);
        }
      }
      const green = soldier.armorSkill <= GREEN_ARMOR_SKILL;
      return h('tr', { class: soldier.uniformed ? '' : 'unbriefed' },
        h('td', {}, h('strong', {}, soldier.name)),
        h('td', { class: 'muted' }, soldier.squad.display_name || soldier.squad.name),
        h('td', {}, h('span', { class: `tag ${soldier.role}` }, soldier.spec.label)),
        h('td', {
          class: `num ${green ? 'warn' : ''}`,
          title: green
            ? `Armor User ${soldier.armorSkill} — metal will slow them until they train up`
            : `Armor User ${soldier.armorSkill}`,
        }, String(soldier.armorSkill)),
        columns.map((slot) => slotCell(bySlot.get(slot), soldier)),
        h('td', {
          class: `num ${soldier.spec.ammo && soldier.ammo < AMMO_TARGET ? 'warn' : 'muted'}`,
        }, soldier.spec.ammo ? String(soldier.ammo) : '—'));
    })))));
  return section;
}

function slotCell(entry, soldier) {
  // A slot the uniform says nothing about is not a gap — an archer whose
  // uniform names no gloves is dressed as ordered.
  if (!entry) return h('td', { class: 'kit-cell muted', title: 'not in their uniform' }, '—');
  const verdict = VERDICT[entry.verdict] || { short: entry.verdict, why: '' };
  const item = entry.item || entry.promise;
  const asked = `the uniform asks for ${entry.label}`;
  const title = item
    ? `${item.material} ${item.subtype}`
      + (item.quality ? ` (quality ${item.quality})` : '')
      + (item.wear ? `, worn ${item.wear}` : '')
      + ` — ${asked}; ${verdict.why}`
    : `${asked} — ${verdict.why}`;
  return h('td', { class: `kit-cell ${entry.verdict}`, title },
    // An earmarked piece is shown as the material it will be, in brackets:
    // it is the answer to "what will they have", not "what are they in".
    item
      ? h('span', { class: 'mat' }, entry.item ? item.material : `(${item.material})`)
      : h('span', { class: 'mat none' }, verdict.short),
    entry.want > 1
      ? h('em', {}, ` ${entry.have}/${entry.want}`)
      : null);
}
