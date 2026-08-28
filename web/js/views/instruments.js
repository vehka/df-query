// Instruments view: the recipe card DF never shows you.
//
// Building an instrument means knowing what its pieces are, what each one
// is made of, which workshop makes it and who should be at the bench —
// four facts DF keeps in four different screens, none of which is the
// build menu. This view puts them on one card and marks how far the fort
// already is.

import { h, clear, plural, asList, matches } from '../util.js';
import { roster, summarise } from '../instruments.js';
import { focus as focusStockpile } from './stockpiles.js';

const state = {
  status: 'all',
  search: '',
  showForeign: false,
};

const FILTERS = [
  { value: 'all', label: 'everything' },
  { value: 'ready', label: 'can start now' },
  { value: 'started', label: 'half-built' },
  { value: 'blocked', label: 'blocked' },
];

const KEEP = {
  all: () => true,
  ready: (t) => t.status === 'ready' || t.status === 'built',
  started: (t) => t.status === 'started',
  blocked: (t) => t.status === 'blocked',
};

// What each verdict means on a step row, in the words a player would use.
const VERDICT_LABEL = {
  done: 'made',
  ready: 'ready to queue',
  waiting: 'needs the pieces',
  'no-material': 'short of materials',
  'no-workshop': 'no workshop for it',
  'no-recipe': 'your civilisation has no recipe for this piece',
};

const STATUS_LABEL = {
  ready: 'ready',
  started: 'half-built',
  blocked: 'blocked',
  built: 'in the fort',
};

export function render(root, db) {
  clear(root);
  if (!db.hasInstruments) {
    root.append(h('p', { class: 'empty' },
      'This snapshot predates the instrument dumper. Hit Refresh to collect '
      + 'the recipes your civilisation knows.'));
    return;
  }

  const toolbar = h('div', { class: 'toolbar' });
  const body = h('div', { class: 'view-body' });
  root.append(toolbar, body);

  const redraw = () => draw(body, db);
  toolbar.append(
    h('div', { class: 'segmented' }, FILTERS.map((option) => h('button', {
      class: state.status === option.value ? 'active' : '',
      onclick: () => { state.status = option.value; redraw(); },
    }, option.label))),
    h('label', { class: 'field grow' }, h('span', {}, 'Filter'),
      h('input', {
        type: 'search',
        placeholder: 'Search instruments, pieces, materials, or workshops…',
        value: state.search,
        oninput: (e) => { state.search = e.target.value; redraw(); },
      })),
    h('label', { class: 'field check' },
      h('input', {
        type: 'checkbox',
        checked: state.showForeign,
        onchange: (e) => { state.showForeign = e.target.checked; redraw(); },
      }),
      h('span', {}, 'Kinds we cannot make')),
  );
  redraw();
}

function draw(body, db) {
  clear(body);
  const input = db.instrumentInput();
  const stats = summarise(input);
  const all = roster(input);

  body.append(headline(stats));
  if (stats.missingSites.length) body.append(missingPanel(stats.missingSites));

  const kept = all.filter(KEEP[state.status]).filter(searchable);
  const section = h('section', { class: 'panel' },
    h('h3', {}, plural(kept.length, 'instrument'),
      kept.length !== all.length
        ? h('span', { class: 'muted' }, ` · ${all.length} your civilisation knows`)
        : null));

  if (!all.length) {
    // Instruments are generated per world and handed out per civilisation:
    // every dwarf, human, goblin, elf and kobold civ gets some, but a civ
    // can have none, and then there is nothing wrong here to report.
    section.append(h('p', { class: 'empty' },
      'Your civilisation knows no instruments. Worldgen hands these out per '
      + 'civilisation, so this is a fact about your world, not a missing '
      + 'snapshot.'));
  } else if (!kept.length) {
    section.append(h('p', { class: 'empty' }, 'Nothing matches that filter.'));
  } else {
    section.append(h('div', { class: 'card-grid recipes' },
      kept.sort(byInterest).map((type) => card(type, db))));
  }
  body.append(section);

  if (state.showForeign) body.append(foreignPanel(asList(input.foreign)));
}

/** Half-built first, then blocked, then the rest — work in progress leads. */
const ORDER = { started: 0, blocked: 1, ready: 2, built: 3 };

function byInterest(a, b) {
  return (ORDER[a.status] - ORDER[b.status])
    || (b.piecesDone - a.piecesDone)
    || a.name.localeCompare(b.name);
}

function searchable(type) {
  if (!state.search) return true;
  const haystack = [
    type.name, type.skill_caption,
    ...type.steps.map((s) => [
      s.label,
      s.site.label,
      ...asList(s.reaction && s.reaction.reagents).map((r) => `${r.description} ${r.code}`),
    ].join(' ')),
  ].join(' ');
  return matches(haystack, state.search);
}

// ----------------------------------------------------------------- headline

function stat(value, label, title) {
  return h('div', { class: 'stat', title: title || null },
    h('div', { class: 'value' }, value),
    h('div', { class: 'label' }, label));
}

function headline(stats) {
  return h('div', { class: 'stat-strip' },
    stat(String(stats.types), 'kinds we can make',
      'the instruments your civilisation has the recipes for'),
    stat(String(stats.ready), 'ready to start',
      'every workshop and material for the first step is on hand'),
    stat(String(stats.started), 'half-built',
      'some pieces are already made and sitting in the fort'),
    stat(String(stats.blocked), 'blocked',
      'a step is short of a workshop or a material'),
    stat(String(stats.inStock), 'in the fort',
      'finished instruments of kinds we can make'),
    stat(String(stats.foreign), 'from elsewhere',
      `${plural(stats.foreignKinds, 'kind')} we own but cannot build`));
}

function missingPanel(sites) {
  return h('section', { class: 'panel findings' },
    h('h3', {}, 'Workshops the fort does not have'),
    sites.map((site) => h('article', { class: 'finding medium' },
      h('div', { class: 'finding-head' },
        h('span', { class: 'sev medium' }, 'build'),
        h('h4', {}, site.label)),
      h('p', { class: 'finding-detail' },
        `Needed by ${plural(site.unlocks.length, 'recipe')}: ${site.unlocks.join(', ')}.`))));
}

// --------------------------------------------------------------------- card

function card(type, db) {
  const parts = type.piecesTotal
    ? `${type.piecesTotal} pieces`
    : 'made in one job';
  const progress = type.piecesTotal
    ? `${type.piecesDone} of ${type.piecesTotal} made`
    : null;

  return h('article', { class: `card instrument ${type.status}` },
    h('h3', {},
      type.name,
      h('span', { class: `badge ${type.status === 'blocked' ? 'warn' : ''}` },
        STATUS_LABEL[type.status] || type.status)),
    h('p', { class: 'summary' },
      parts,
      ' · ',
      // The music skill is what the instrument is *for*: a fort with no
      // stringed players gains nothing from building a lyre.
      h('span', { title: 'played with this skill' }, type.skill_caption || 'unplayable'),
      ` · worth ${type.value}☼`,
      type.placed_as_building
        ? h('span', { class: 'warn-text', title: 'built on a tile and played where it stands, never carried' },
          ' · furniture')
        : null,
      progress ? h('span', { class: 'muted' }, ` · ${progress}`) : null,
      type.in_stock
        ? h('span', { class: 'muted' }, ` · ${type.in_stock} in the fort`)
        : null),
    stepTable(type, db),
    type.description
      ? h('details', { class: 'flavour' },
        h('summary', {}, 'What it sounds like'),
        h('p', {}, type.description))
      : null);
}

function stepTable(type, db) {
  // Three columns, not four: who should be at the bench rides under the
  // step name rather than in a column of its own, because a fourth column
  // pushes the ingredient list — the thing you came to read — off the card.
  return h('table', { class: 'grid compact steps' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Step'),
      h('th', {}, 'Workshop'),
      h('th', {}, 'Ingredients'))),
    h('tbody', {}, type.steps.map((step) => stepRow(step, db))));
}

function stepRow(step, db) {
  const isAssembly = Boolean(step.waiting);
  return h('tr', { class: `step ${step.verdict}`, title: VERDICT_LABEL[step.verdict] || '' },
    h('td', {},
      h('span', { class: 'step-name' }, step.label),
      isAssembly && step.waiting.length
        ? h('div', { class: 'muted small' },
          `waiting on ${step.waiting.map((w) => w.piece.name).join(', ')}`)
        : null,
      h('div', { class: 'hand small' }, handCell(step, db))),
    h('td', {}, siteCell(step, db)),
    h('td', {}, ingredientCell(step, db)));
}

function siteCell(step, db) {
  const site = step.site;
  if (!site.options.length) return h('span', { class: 'muted' }, '—');
  // Alternatives are joined with "or" because either satisfies the step —
  // DF offers a magma twin for every heated job.
  return h('span', { class: 'sites' }, site.options.map((option, i) => [
    i ? h('span', { class: 'muted' }, ' or ') : null,
    option.have
      ? h('button', {
        class: 'chip workshop',
        title: `${plural(option.have, 'in the fort')} · show on the cross-section`,
        onclick: () => {
          focusStockpile(option.buildings[0].id);
          location.hash = 'stockpiles';
        },
      }, option.name, h('em', {}, ` ×${option.have}`))
      : h('span', {
        class: 'chip warn',
        title: 'the fort has none of these',
      }, option.name),
  ]));
}

function ingredientCell(step, db) {
  const reagents = asList(step.reaction && step.reaction.reagents);
  if (!reagents.length) return h('span', { class: 'muted' }, '—');

  return h('div', { class: 'ingredients' },
    reagents.map((r) => {
      const have = typeof r.stock_units === 'number' ? r.stock_units : null;
      const need = r.units || 1;
      const shortfall = have !== null && !r.preserve && have < need;
      return h('div', {
        class: `ingredient${shortfall ? ' short' : ''}`,
        // The raw figure is worth keeping reachable: DF counts a bar as
        // 150 and a thread as 15000, and a player who has seen those
        // numbers in the game should be able to match them up.
        title: `DF asks for ${r.quantity}${r.unit_dimension ? ` (${r.unit_dimension} to the unit)` : ''}`,
      },
        h('span', { class: 'qty' }, `${need}×`),
        h('span', { class: 'what' }, r.description || r.code),
        r.preserve
          ? h('span', { class: 'muted', title: 'handed back when the job finishes' }, ' not used up')
          : h('span', { class: have === null ? 'muted' : 'have' },
            have === null ? ' —' : ` have ${have}`));
    }),
    step.reaction && step.reaction.fuel
      ? h('div', { class: 'ingredient fuel', title: 'a heated job: it burns a bar of fuel unless the workshop is magma-powered' },
        h('span', { class: 'qty' }, '1×'),
        h('span', { class: 'what' }, 'fuel'),
        h('span', { class: 'muted' }, ' unless magma'))
      : null);
}

function handCell(step, db) {
  if (!step.reaction || !step.reaction.skill) return h('span', { class: 'muted' }, '—');
  // DF's caption for LEATHERWORK is "Leatherworkering"; the noun form is
  // the one that reads like a job, so it is what names the trade here.
  const noun = db.skills.get(step.reaction.skill);
  const trade = (noun && (noun.caption_noun || noun.caption)) || step.reaction.skill;
  if (!step.skill) {
    // DF gates work on the labour, not the rating, so this is a warning
    // about the quality of the result, never a reason the job cannot run.
    return h('span', {
      class: 'warn-text',
      title: `Nobody in the fort has any ${trade} skill. The job will still run — the result will be poor.`,
    }, `no ${trade} in the fort`);
  }
  return h('span', { title: `best ${trade} in the fort` },
    h('span', { class: 'muted' }, `${trade}: `),
    h('span', { class: `lvl-${Math.min(15, step.skill.rating)}` }, step.skill.name),
    h('span', { class: 'muted' }, ` · ${db.ratingName(step.skill.rating)}`));
}

// ------------------------------------------------------------------ foreign

function foreignPanel(foreign) {
  const section = h('section', { class: 'panel' },
    h('h3', {}, 'Instruments we cannot make',
      h('span', { class: 'muted' },
        ' · traded in, or carried by a guest — no recipe reached this civilisation')));
  if (!foreign.length) {
    section.append(h('p', { class: 'empty' },
      'Every instrument in the fort is one you know how to build.'));
    return section;
  }
  section.append(h('div', { class: 'chips inline' },
    foreign.map((f) => h('span', { class: 'chip' }, f.name, h('em', {}, ` ×${f.count}`)))));
  return section;
}
