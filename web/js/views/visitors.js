// Visitors view: who is asking to stay, what they are worth, and what
// they are hiding.
//
// Three panels in the order you act on them. The headline says how many
// petitions are on the clock. The concerns say what is wrong with the
// people in the tavern, worst first. The roster is the evidence — one row
// per guest, and clicking one opens the dossier the petition popup never
// showed you: the cover story, the plots, the ties, and every skill they
// have with DF's own word for how good it is.

import { h, clear, plural, matches, asList } from '../util.js';
import {
  diagnose, summarise, roster, groupPetitions, words,
  WEAK_RATING, GOOD_RATING, STRONG_RATING,
} from '../visitors.js';

const state = {
  who: 'all',
  search: '',
  risk: 'all',
  // Off by default. Everything behind this switch is something DF means
  // the player to work out for themselves — who is wearing a false face,
  // who is a vampire, who is running a plot. Turning it on cannot be
  // undone in the player's head, so it has to be their choice.
  spoilers: false,
  selectedId: null,
};

const WHO = [
  { value: 'all', label: 'everyone' },
  { value: 'pending', label: 'petitions waiting' },
  { value: 'visitor', label: 'visitors' },
  { value: 'resident', label: 'residents' },
];

const RISK = [
  { value: 'all', label: 'any' },
  { value: 'danger', label: 'dangerous' },
  { value: 'watch', label: 'worth watching' },
];

// One word for the roster cell, one phrase for its tooltip.
const WORTH = {
  star: {
    label: 'excellent',
    why: `rating ${STRONG_RATING} or better at their trade, or the best in the fort at something`,
  },
  solid: { label: 'good', why: `rating ${GOOD_RATING}+ — well past workmanlike` },
  green: { label: 'passable', why: 'has the skill, still learning it' },
  novice: { label: 'novice', why: `rating ${WEAK_RATING} or below at their own trade` },
  none: { label: 'nothing', why: 'no skill in the trade they claim' },
};

const RISK_LABEL = {
  danger: { label: 'danger', why: 'DF records something serious against them' },
  watch: { label: 'watch', why: 'something on file, short of serious' },
  clear: { label: 'clear', why: 'nothing on file against them' },
};

export function render(root, db) {
  clear(root);
  if (!db.hasVisitors) {
    root.append(h('p', { class: 'empty' },
      'This snapshot predates the visitors dumper. Hit Refresh to collect '
      + 'the tavern’s guests, their skills, and what DF has on file about them.'));
    return;
  }
  if (!db.visitors.length) {
    root.append(h('p', { class: 'empty' },
      'Nobody is visiting. Guests arrive once the fort has a tavern, a temple '
      + 'or a library the outside world has heard of.'));
    return;
  }

  const toolbar = h('div', { class: 'toolbar' });
  const body = h('div', { class: 'view-body' });
  root.append(toolbar, body);

  const redraw = () => draw(body, db);
  toolbar.append(
    h('div', { class: 'segmented' }, WHO.map((option) => h('button', {
      class: state.who === option.value ? 'active' : '',
      onclick: () => { state.who = option.value; redraw(); },
    }, option.label))),
    h('label', { class: 'field' }, h('span', {}, 'Risk'),
      h('select', { onchange: (e) => { state.risk = e.target.value; redraw(); } },
        RISK.map((option) => h('option', {
          value: option.value,
          selected: state.risk === option.value,
        }, option.label)))),
    h('label', { class: 'field grow' }, h('span', {}, 'Filter'),
      h('input', {
        type: 'search',
        placeholder: 'Search guests, races, skills, or civilisations…',
        value: state.search,
        oninput: (e) => { state.search = e.target.value; redraw(); },
      })),
    h('label', {
      class: 'field check',
      title: 'Off, this view only says what DF itself would show you on a guest\'s '
        + 'own screen. On, it also reads what the game hides: cover identities, '
        + 'intrigue plots, concealed curses, and foreign criminal records.',
    },
      h('input', {
        type: 'checkbox',
        checked: state.spoilers,
        onchange: (e) => { state.spoilers = e.target.checked; redraw(); },
      }),
      h('span', {}, 'Show spoilers')),
  );
  redraw();
}

function keep(person, groupOf) {
  const group = groupOf.get(person.visitor.hf_id) || null;
  // "Petitions waiting" means everyone the pending answer covers, which
  // includes a troupe member with nothing on their own record: the player
  // is about to decide about them too.
  if (state.who === 'pending' && !person.pending && !(group && group.pending)) return false;
  if (state.who === 'visitor' && person.visitor.status !== 'visitor') return false;
  if (state.who === 'resident' && person.visitor.status !== 'resident') return false;
  if (state.risk !== 'all' && person.risk !== state.risk) return false;
  if (!state.search) return true;
  const v = person.visitor;
  return matches(v.name, state.search)
    || matches(v.real_name, state.search)
    || matches(v.race, state.search)
    || matches(v.profession, state.search)
    || matches(v.entity && v.entity.name, state.search)
    || matches(group && group.name, state.search)
    || person.standouts.some((s) => matches(s.caption, state.search));
}

function draw(body, db) {
  clear(body);
  const input = { ...db.visitorInput(), spoilers: state.spoilers };
  const people = roster(input);
  // A group petition covers people who have no petition of their own, so
  // the roster needs to be able to look one up by member to explain why a
  // guest is standing here as a resident with nothing on their own record.
  const groups = groupPetitions(input);
  const groupOf = new Map();
  for (const group of groups) {
    for (const member of group.members) {
      if (!groupOf.has(member.hf_id)) groupOf.set(member.hf_id, group);
    }
  }
  const kept = people.filter((p) => keep(p, groupOf));

  const stats = summarise(input);
  body.append(headline(stats));
  body.append(concerns(diagnose(input), db));
  if (groups.length) body.append(groupPanel(groups, db, () => draw(body, db)));
  body.append(rosterTable(kept, people.length, stats.absent, groupOf, db, () => draw(body, db)));

  if (state.selectedId !== null) {
    const person = people.find((p) => p.id === state.selectedId);
    if (person) body.append(dossier(person, db, input, () => draw(body, db)));
  }
}

// ----------------------------------------------------------------- headline

function stat(value, label, title, className = '') {
  return h('div', { class: `stat ${className}`, title: title || null },
    h('div', { class: 'value' }, value),
    h('div', { class: 'label' }, label));
}

function headline(stats) {
  return h('div', { class: 'stat-strip' },
    stat(String(stats.pending), 'petitions waiting',
      'residency or citizenship agreements DF has not had an answer to yet'),
    stat(String(stats.visitors), 'visitors',
      'guests standing in the fort right now, invited or otherwise'),
    stat(String(stats.residents), 'residents',
      'already accepted — the pool citizenship petitions come from'),
    // A count of impostors is itself the spoiler, so the tile is not
    // merely blanked when spoilers are off: it is not there at all.
    state.spoilers
      ? stat(String(stats.impostors), 'false faces',
        'guests DF has under a cover identity: the name on the petition is not theirs')
      : null,
    stat(String(stats.dangerous), 'dangerous',
      state.spoilers
        ? 'at least one serious thing on file — a plot, a curse, a criminal record'
        : 'at least one serious thing on file. Spoilers are off, so this counts only '
          + 'what DF would show you itself'),
    stat(String(stats.worthKeeping), 'worth keeping',
      'good or better at the trade they claim'),
    stat(String(stats.upgrades), 'would raise the ceiling',
      'better than any citizen at something — the only guests whose arrival '
      + 'changes what the fort can do rather than how fast'));
}

// ---------------------------------------------------------------- concerns

function concerns(findings, db) {
  const section = h('section', { class: 'panel findings' },
    h('h3', {}, plural(findings.length, 'concern'),
      h('span', { class: 'muted' },
        ' · every one of these is a fact in the save, not a reading of how someone looks')));

  if (!findings.length) {
    section.append(h('p', { class: 'empty' },
      'Nothing on file against anyone in the tavern.'));
    return section;
  }

  for (const item of findings) {
    section.append(h('article', { class: `finding ${item.severity}` },
      h('div', { class: 'finding-head' },
        h('span', { class: `sev ${item.severity}` }, item.severity),
        h('h4', {}, item.title)),
      h('p', { class: 'finding-detail' }, item.detail),
      item.names && item.names.length > 1
        ? h('div', { class: 'chips' },
          item.names.slice(0, 12).map((name) => h('span', { class: 'chip' }, name)),
          item.names.length > 12
            ? h('span', { class: 'muted' }, ` +${item.names.length - 12} more`)
            : null)
        : null));
  }
  return section;
}

// -------------------------------------------------------- group petitions

/**
 * Petitions filed by a group. These get their own panel because they are
 * not a row in the roster and never can be: DF names the *entity* on the
 * agreement and leaves the applicant's histfig list empty, so there is no
 * guest to attach the decision to, and most of the membership is not in
 * the fort to be listed anyway.
 *
 * The split between who is here and who is still travelling is the whole
 * substance of the decision — accepting a troupe takes in the members the
 * player cannot inspect, so the count of those is stated rather than left
 * to be inferred from a short list of names.
 */
function groupPanel(groups, db, redraw) {
  const section = h('section', { class: 'panel' },
    h('h3', {}, plural(groups.length, 'group petition'),
      h('span', { class: 'muted' },
        ' · filed by the group itself, so they belong to no single guest below')));

  for (const group of groups) {
    const card = h('article', { class: `finding ${group.pending ? 'high' : 'info'}` },
      h('div', { class: 'finding-head' },
        group.pending
          ? h('span', { class: 'sev high' }, 'waiting')
          : h('span', { class: 'muted' }, `yr ${group.year}`),
        h('h4', {}, group.name,
          group.entity && group.entity.type
            ? h('span', { class: 'muted' }, ` · ${words(group.entity.type)}`)
            : null)),
      h('p', { class: 'finding-detail' },
        group.pending
          ? `Asking for ${group.kind}. `
          : `${group.kind.charAt(0).toUpperCase()}${group.kind.slice(1)} agreed in year ${group.year}. `,
        `${plural(group.members.length, 'member')}, `,
        group.here.length
          ? `${group.here.length} in the fort`
          : 'none of them in the fort yet',
        group.elsewhere
          ? ` · ${group.elsewhere} still travelling, and ${group.pending ? 'accepting' : 'the agreement'} covers them too.`
          : '.'));

    if (group.here.length) {
      card.append(h('div', { class: 'chips' }, group.here.map((person) => h('span', {
        class: 'chip',
        title: `${person.role.label} · click to open the dossier`,
        onclick: () => {
          state.selectedId = state.selectedId === person.id ? null : person.id;
          redraw();
        },
      }, person.name))));
    }
    section.append(card);
  }
  return section;
}

// ------------------------------------------------------------------ roster

/**
 * `absent` is what the presence filter removed. It is spelled out rather
 * than dropped silently: DF's "active" unit list is full of corpses, and
 * a reader who counts bodies in the tavern and gets a different number
 * deserves to know which way the difference goes.
 */
function absentNote(absent) {
  const parts = [
    absent.dead ? plural(absent.dead, 'dead guest') : null,
    absent.caged ? `${absent.caged} caged or chained` : null,
    absent.tame ? `${absent.tame} tame` : null,
  ].filter(Boolean);
  if (!parts.length) return null;
  return h('span', { class: 'muted' },
    ` · ${parts.join(', ')} not listed — DF keeps them in the same list as the living`);
}

function rosterTable(people, total, absent, groupOf, db, redraw) {
  const section = h('section', { class: 'panel' },
    h('h3', {}, 'Guests',
      h('span', { class: 'muted' },
        people.length === total
          ? ' · click a row for the dossier the petition popup does not show'
          : ` · ${people.length} of ${total}`),
      absentNote(absent)));

  if (!people.length) {
    section.append(h('p', { class: 'empty' }, 'Nobody matches that filter.'));
    return section;
  }

  section.append(h('div', { class: 'scroll' }, h('table', { class: 'grid guests' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Guest'),
      h('th', {}, 'Standing'),
      h('th', {}, 'Race'),
      h('th', { class: 'num' }, 'Age'),
      h('th', {}, 'Here as'),
      h('th', {}, 'At their trade'),
      h('th', {}, 'Worth'),
      h('th', {}, 'Risk'),
      h('th', {}, 'Best skills'))),
    h('tbody', {}, people.map((person) => row(person, groupOf, db, redraw))))));
  return section;
}

function row(person, groupOf, db, redraw) {
  const v = person.visitor;
  const worth = WORTH[person.worth.key];
  const risk = RISK_LABEL[person.risk];

  const group = groupOf.get(v.hf_id) || null;

  return h('tr', {
    class: `${state.selectedId === person.id ? 'selected' : ''}`
      + `${person.pending || (group && group.pending) ? ' pending' : ''}`,
    onclick: () => {
      state.selectedId = state.selectedId === person.id ? null : person.id;
      redraw();
    },
  },
    h('td', {},
      h('strong', {}, v.name),
      // The cover story belongs next to the name: it is the one fact that
      // makes every other cell on the row a claim rather than a reading.
      // `masked` is already false when spoilers are off, so the badge is
      // simply absent rather than present-but-vague.
      person.masked ? h('span', { class: 'badge warn', title: `really ${v.real_name}` }, 'alias') : null),
    h('td', {}, standing(v, group)),
    h('td', { class: 'muted' }, v.race),
    h('td', { class: 'num muted' }, String(v.age)),
    h('td', {},
      h('span', { class: person.role.stated ? '' : 'muted' }, person.role.label),
      person.role.where ? h('span', { class: 'muted' }, ` · ${person.role.where}`) : null),
    h('td', {}, person.craft
      ? h('span', { class: `chip lvl-${Math.min(person.craft.rating, 15)}` },
        `${person.craft.caption} · ${db.ratingName(person.craft.rating)}`)
      : h('span', { class: 'muted' }, '—')),
    h('td', {}, h('span', {
      class: `worth ${person.worth.key}`,
      title: `${worth.why} — ${person.worth.note}`,
    }, worth.label)),
    h('td', {}, h('span', {
      class: `risk ${person.risk}`,
      title: person.concerns.length
        ? person.concerns.map((c) => c.title).join('; ')
        : risk.why,
    }, risk.label,
      person.concerns.length ? h('em', {}, ` ${person.concerns.length}`) : null)),
    h('td', {}, person.standouts.map((s) => h('span', {
      class: `chip lvl-${Math.min(s.rating, 15)}${s.beatsFort ? ' best' : ''}`,
      title: s.beatsFort
        ? `better than any citizen — the fort's best is ${db.ratingName(Math.max(0, s.rating - 1))} or below`
        : `${s.category || 'other'} · ${db.ratingName(s.rating)}`,
    }, `${s.caption} ${s.rating}`))));
}

/**
 * `group` is the group petition this guest is covered by, if any. Without
 * it a troupe member reads as a bare "resident" with no year and no reason
 * — their own `petition` is empty, because the agreement names the troupe
 * rather than them.
 */
function standing(v, group) {
  if (v.petition && v.petition.pending) {
    return h('span', { class: 'badge' }, `${v.petition.kind} pending`);
  }
  if (group && group.pending) {
    return h('span', { class: 'badge', title: `${group.name} petitioned as a group` },
      `${group.kind} pending · group`);
  }
  if (v.status === 'resident') {
    const via = v.petition
      ? `accepted in year ${v.petition.year}`
      : (group ? `through ${group.name}, agreed in year ${group.year}` : null);
    return h('span', { class: 'muted', title: via },
      `resident${v.petition ? ` · yr ${v.petition.year}` : (group ? ` · with ${group.name}` : '')}`);
  }
  return h('span', { class: v.uninvited ? 'warn-text' : 'muted' },
    v.uninvited ? 'uninvited' : 'visitor');
}

// ----------------------------------------------------------------- dossier

function dossier(person, db, input, redraw) {
  const v = person.visitor;
  const grouped = new Map();
  for (const entry of asList(v.skills)) {
    if (entry.rating <= 0) continue;
    const category = input.categoryOf(entry.key) || 'Other';
    if (!grouped.has(category)) grouped.set(category, []);
    grouped.get(category).push(entry);
  }
  for (const list of grouped.values()) list.sort((a, b) => b.rating - a.rating);
  const order = db.categoryNames.filter((c) => grouped.has(c))
    .concat([...grouped.keys()].filter((c) => !db.categoryNames.includes(c)));

  return h('aside', { class: 'detail' },
    h('header', {},
      h('h3', {}, v.name),
      h('button', {
        class: 'ghost',
        onclick: () => { state.selectedId = null; redraw(); },
      }, '✕')),
    h('p', { class: 'muted' },
      `${v.profession} · ${v.race} · ${v.age} years · ${v.sex}`,
      v.years_here !== null && v.years_here !== undefined
        ? ` · at this site since year ${v.arrived_year}`
        : ''),

    person.masked ? identityBlock(v) : null,
    allegianceBlock(v, state.spoilers),
    verdictBlock(person, db, input),
    concernBlock(person),

    h('div', { class: 'skill-columns' }, order.map((category) => h('div', {},
      h('h4', {}, category),
      h('ul', { class: 'skill-list' }, grouped.get(category).map((s) => h('li', {},
        h('span', {}, input.captionOf(s.key)),
        h('span', { class: `lvl lvl-${Math.min(s.rating, 15)}` },
          `${db.ratingName(s.rating)} (${s.rating})`),
        s.rusty > 0 ? h('span', { class: 'rusty' }, 'rusty') : null)))))),

    valuesBlock(v));
}

function identityBlock(v) {
  const id = v.identity;
  if (!id) return null;
  return h('div', { class: 'dossier-flag' },
    h('h4', {}, 'Cover identity'),
    h('p', {},
      h('strong', {}, v.name), ' is DF\'s ', words(id.type), ' for ',
      h('strong', {}, v.real_name || 'an unnamed figure'),
      v.entity ? `, of ${v.entity.name}` : '',
      '. They present as ',
      id.race || v.race,
      id.profession ? ` and a ${words(id.profession)}` : '',
      id.entity ? ` of ${id.entity.name}` : '',
      id.entity && id.entity.ours ? ' — your own civilisation.' : '.'));
}

/**
 * Entity ties are on DF's own screen, so an honest guest's show either
 * way. Plots, the handler and the artifact quest are world data the game
 * hides, and so are the ties of a guest wearing a false face — those
 * belong to the figure underneath, and DF shows the player the cover's
 * civilisation instead.
 *
 * A masked guest's ties are dropped without a word. Saying "hidden here"
 * would announce the mask, which is the one thing this switch exists to
 * keep quiet.
 */
function allegianceBlock(v, spoilers) {
  const hidden = !spoilers && Boolean(v.identity);
  const groups = hidden ? [] : asList(v.groups).filter((g) => g.link !== 'FORMER_MEMBER');
  const plots = spoilers ? asList(v.intrigue && v.intrigue.plots) : [];
  const quest = spoilers ? v.artifact_quest : null;
  const master = spoilers && v.intrigue && v.intrigue.master;
  if (!groups.length && !plots.length && !quest) return null;

  return h('div', {},
    h('h4', {}, 'Ties and business'),
    quest
      ? h('p', {}, 'On a journey for ', h('strong', {}, quest.name),
        quest.ours ? ' — which is in this fort.' : '.')
      : null,
    plots.length
      ? h('p', { class: 'chips inline' }, plots.map((p) => h('span', {
        class: `zchip${p.target && p.target.ours ? ' full' : ''}`,
        title: p.on_hold ? 'on hold' : 'active',
      }, words(p.type), p.target ? h('em', {}, ` → ${p.target.name}`) : null)))
      : null,
    master
      ? h('p', { class: 'muted' }, `Answers to ${master}.`)
      : null,
    groups.length
      ? h('p', { class: 'chips inline' }, groups.map((g) => h('span', {
        class: `zchip${g.link === 'CRIMINAL' || g.link === 'ENEMY' ? ' full' : ''}`,
        title: `${words(g.link)} · ${g.type}`,
      }, g.name, h('em', {}, ` ${words(g.link)}`))))
      : null);
}

function verdictBlock(person, db, input) {
  const holder = input.fortHolder(person.role.category);
  const bar = input.fortBest(person.role.category);
  return h('div', {},
    h('h4', {}, 'Worth taking in'),
    h('p', {}, h('span', { class: `worth ${person.worth.key}` }, WORTH[person.worth.key].label),
      ' — ', person.worth.note, '.'),
    person.role.category
      ? h('p', { class: 'muted' },
        `The fort's best at ${String(person.role.category).toLowerCase()} is `
        + `${holder ? `${holder} at ${db.ratingName(bar)}` : 'nobody'}`
        + `${person.craft && person.craft.rating > bar ? ' — this guest beats that.' : '.'}`)
      : null);
}

function concernBlock(person) {
  if (!person.concerns.length) {
    return h('p', { class: 'muted' }, 'Nothing on file against them.');
  }
  return h('div', {},
    h('h4', {}, plural(person.concerns.length, 'concern')),
    h('ul', { class: 'concern-list' }, person.concerns.map((c) => h('li', {},
      h('span', { class: `sev ${c.severity}` }, c.severity), ' ',
      h('strong', {}, c.title), ' — ', c.detail))));
}

function valuesBlock(v) {
  const values = asList(v.values)
    .sort((a, b) => Math.abs(b.strength) - Math.abs(a.strength));
  if (!values.length) return null;
  return h('details', {}, h('summary', {}, `Values (${values.length})`),
    h('p', { class: 'chips inline' }, values.map((value) => h('span', {
      class: `zchip${value.strength <= -25 ? ' full' : ''}`,
      title: 'DF stores only the values that swing away from their culture’s norm, on a −50..50 scale',
    }, words(value.key), h('em', {}, ` ${value.strength > 0 ? '+' : ''}${value.strength}`)))));
}
