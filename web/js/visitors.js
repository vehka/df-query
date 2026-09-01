// What a residency petition is actually asking you to take in.
//
// DF puts the decision to the player as a popup with a name and a stated
// purpose on it, and once it is dismissed there is no screen that will
// show you the applicant again. Two questions go unanswered there: can
// this bard actually play, and is this bard a bard.
//
// Both have real answers in the snapshot. Skill ratings settle the first.
// The second is settled by a cover identity, an intrigue plot with a
// target, a CRIMINAL tie to some government, or a reputation as a
// murderer — DF tracks all of them, and none of them reach the popup.
//
// Pure, like `geometry.js`, `flow.js` and `armory.js`: `diagnose(input)`
// returns findings worst-first and `roster(input)` the evidence behind
// them, both checkable with `node` against a snapshot.

import { asList, plural } from './util.js';

// ------------------------------------------------------------ thresholds

/** Novice or worse. The rating a player means by "no novice poets". */
export const WEAK_RATING = 1;
/** Proficient: past the point where a performer is worth a bed. */
export const GOOD_RATING = 5;
/** Expert and up — worth taking for the skill alone. */
export const STRONG_RATING = 8;
/**
 * How far a personality value has to swing before it is worth mentioning.
 * DF's scale runs -50..50 and its own captions change wording around here.
 */
export const VALUE_EXTREME = 25;
/** Below this many low-severity concerns of a kind, list them one by one. */
export const ROLLUP_MIN = 3;

// -------------------------------------------------------------- taxonomy

/**
 * What each visiting profession is judged on.
 *
 * Most of this is *derived*: DF attaches a profession to a skill
 * (`job_skill.profession`), so a Maceman is judged on MACE and a Poet on
 * POETRY without anything being typed here — `input.categoryOfProfession`
 * reads it from the snapshot's enum tables. The professions DF leaves
 * unattached are the visiting ones, which is exactly the set that matters
 * here, so they are named below the same way `SKILL_CATEGORY_OVERRIDES`
 * names the skills DF's two groupings miss.
 */
export const PROFESSION_CATEGORY = {
  SCHOLAR: 'Scholarship',
  SAGE: 'Scholarship',
  PHILOSOPHER: 'Scholarship',
  MATHEMATICIAN: 'Scholarship',
  HISTORIAN: 'Scholarship',
  ASTRONOMER: 'Scholarship',
  NATURALIST: 'Scholarship',
  CHEMIST: 'Scholarship',
  GEOGRAPHER: 'Scholarship',
  SCRIBE: 'Scholarship',
  MERCENARY: 'Combat',
  MONSTER_SLAYER: 'Combat',
  BEAST_HUNTER: 'Combat',
  SCOUT: 'Combat',
  RECRUIT: 'Combat',
  DOCTOR: 'Healthcare',
  DIAGNOSER: 'Healthcare',
  BONE_SETTER: 'Healthcare',
  SUTURER: 'Healthcare',
  PERFORMER: 'Arts',
  TAVERN_KEEPER: 'Social',
};

/**
 * The fort's own record of what a guest was taken on to do, which beats
 * their profession when the two disagree. `occupation_type` has no skills
 * hanging off it in the raws, so there is nothing to derive from.
 */
export const OCCUPATION_CATEGORY = {
  PERFORMER: 'Arts',
  SCHOLAR: 'Scholarship',
  SCRIBE: 'Scholarship',
  MERCENARY: 'Combat',
  MONSTER_SLAYER: 'Combat',
  DOCTOR: 'Healthcare',
  DIAGNOSTICIAN: 'Healthcare',
  SURGEON: 'Healthcare',
  BONE_DOCTOR: 'Healthcare',
  TAVERN_KEEPER: 'Social',
};

/**
 * `identity_type` values that mean the face is not the person. DF's own
 * names: SCOUT_COVER, IMPROMPTU_SITE_ID, VILLAIN, GOD_PRETENDER. The one
 * left out is `HidingCurse`, which is a vampire hiding what they are
 * rather than an agent hiding who they are — the curse rule reports that.
 */
export const COVER_IDENTITIES = new Set([
  'FalseIdentity', 'InfiltrationIdentity', 'Identity', 'Impersonating',
]);

/**
 * `reputation_type` values worth a warning, with how bad. DF files these
 * per entity and marks none of them as good or bad, so the split is a
 * judgement — but it is the same one DF's own prose makes when it calls
 * someone a murderer.
 */
export const ALARMING_REPUTATIONS = {
  Murderer: 'high',
  Psycho: 'high',
  Monster: 'high',
  Killer: 'high',
  Thief: 'high',
  Brigand: 'high',
  Bully: 'medium',
  Brawler: 'medium',
  Quarreler: 'low',
  Flatterer: 'low',
};

/** Professions that are their own confession. */
export const CRIMINAL_PROFESSIONS = new Set([
  'THIEF', 'MASTER_THIEF', 'SNATCHER', 'CRIMINAL',
]);

/** Entity ties DF records for people a government wants, or fears. */
const CRIMINAL_LINKS = new Set(['CRIMINAL', 'PRISONER', 'SLAVE']);

/**
 * Plots that name a target. The rest — growing a funding network, growing
 * an asset network — are the machinery of being a villain rather than a
 * move against anyone in particular, so they carry no target and land as
 * one lower-severity "is running plots" line.
 */
const POINTED_PLOTS = new Set([
  'Acquire_Artifact', 'Infiltrate_Society', 'Counterintelligence',
  'Assassinate_Actor', 'Kidnap_Actor', 'Sabotage_Actor', 'Frame_Actor',
  'Corruptly_Punish_Actor', 'Direct_War_To_Actor', 'Corrupt_Actors_Government',
  'Undead_World_Conquest',
]);

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

// ---------------------------------------------------------------- naming

/**
 * DF's enum keys come in three shapes — SCREAMING_SNAKE, Snake_Case and
 * CamelCase — and none of these enums carry a caption, so the words have
 * to be recovered from the key itself rather than read from the snapshot.
 */
export function words(key) {
  if (!key) return '';
  return String(key)
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

// ------------------------------------------------------------- the guest

function bestIn(visitor, category, input) {
  let best = null;
  for (const entry of asList(visitor.skills)) {
    if (entry.rating <= 0) continue;
    if (input.categoryOf(entry.key) !== category) continue;
    if (!best || entry.rating > best.rating) best = entry;
  }
  return best && { ...best, caption: input.captionOf(best.key) };
}

/**
 * What they are here to do. The fort's own occupation record first, then
 * the profession DF gives them, then whatever they are actually best at
 * — a traveller with no stated trade is still worth grading on something.
 */
function roleOf(visitor, input) {
  const occupation = visitor.occupation && visitor.occupation.type;
  const fromOccupation = occupation && OCCUPATION_CATEGORY[occupation];
  if (fromOccupation) {
    return {
      key: occupation,
      label: words(occupation),
      category: fromOccupation,
      stated: true,
      where: visitor.occupation.location || null,
    };
  }

  const profession = visitor.profession_key;
  const category = profession
    && (input.categoryOfProfession(profession) || PROFESSION_CATEGORY[profession]);
  if (category) {
    return {
      key: profession,
      label: visitor.profession || words(profession),
      category,
      stated: true,
      where: null,
    };
  }

  // No stated trade. Grade them on their own best category so the row
  // still says something, and mark it as ours rather than theirs.
  const top = topSkills(visitor, input)[0];
  return {
    key: profession || 'STANDARD',
    label: visitor.profession || 'traveller',
    category: top ? input.categoryOf(top.key) : null,
    stated: false,
    where: null,
  };
}

function topSkills(visitor, input, limit = 4) {
  return asList(visitor.skills)
    .filter((s) => s.rating > 0)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, limit)
    .map((s) => ({
      ...s,
      caption: input.captionOf(s.key),
      category: input.categoryOf(s.key),
      // Whether taking them in would move the fort's ceiling, which is
      // the difference between a useful hire and a spare pair of hands.
      beatsFort: s.rating > input.fortBest(input.categoryOf(s.key)),
    }));
}

/**
 * The usefulness verdict, graded against the role they claim. A novice
 * poet is a novice poet whatever else they are good at, so the headline
 * follows the role and the standouts carry the rest.
 */
function worthOf(role, craft, standouts) {
  const beats = standouts.filter((s) => s.beatsFort);
  if (!craft) {
    return {
      key: 'none',
      label: role.stated ? 'cannot' : 'nothing',
      note: role.stated
        ? `no ${role.category ? String(role.category).toLowerCase() : 'relevant'} skill at all`
        : 'no skill worth the name in anything',
    };
  }
  // A high rating only earns the top grade when it is in a trade they
  // came here to practise. A traveller who claims nothing is graded on
  // whatever they happen to be best at, and "legendary Climber" is not a
  // reason to house anyone — so an unstated role can only reach the top
  // by actually beating the fort's ceiling at something.
  if (beats.length || (role.stated && craft.rating >= STRONG_RATING)) {
    return {
      key: 'star',
      label: 'excellent',
      note: beats.length
        ? `would be the fort's best at ${beats[0].caption}`
        : `${craft.caption} is the trade they claim, and they are very good at it`,
    };
  }
  if (!role.stated) {
    return {
      key: craft.rating >= GOOD_RATING ? 'solid' : 'green',
      label: craft.rating >= GOOD_RATING ? 'good' : 'passable',
      note: `they claim no trade; ${craft.caption} is what they are best at`,
    };
  }
  if (craft.rating >= GOOD_RATING) {
    return { key: 'solid', label: 'good', note: `${craft.caption}, well past workmanlike` };
  }
  if (craft.rating > WEAK_RATING) {
    return { key: 'green', label: 'passable', note: `${craft.caption}, still learning` };
  }
  return {
    key: 'novice',
    label: 'novice',
    note: `${craft.caption} at ${craft.rating === 0 ? 'dabbling' : 'novice'} — a beginner`,
  };
}

// ------------------------------------------------------------- the risks

/**
 * `spoiler` marks a concern DF deliberately keeps from the player. The
 * line is drawn at the unit's own info screen: race, profession, skills,
 * age, entity membership and the uninvited flag are all on it, so saying
 * them out loud spoils nothing. A cover identity, an intrigue plot, a
 * hidden curse and a foreign government's criminal file are not — DF
 * means those to be guesswork, and a player who wants them to stay that
 * way should be able to use this view anyway.
 *
 * With spoilers off they are dropped whole: no count, no badge, no
 * "something is off about this one". A suppressed count is still a
 * spoiler, and the checkbox already says what it would show.
 */
function concern(kind, severity, title, detail, spoiler = false) {
  return { kind, severity, title, detail, spoiler };
}

/**
 * Everything DF knows against them, worst first. Each line names the
 * structure it came from, because every one of these is a fact in the
 * save rather than an inference from how someone looks.
 */
function concernsOf(visitor, role, craft, input) {
  const out = [];
  const who = visitor.name;

  // The cover story. `unit.name` is the real figure underneath, which is
  // why the dumper ships both.
  const identity = visitor.identity;
  // `entity`, `groups` and `reputations` all hang off the *real* figure,
  // and DF shows the player the identity's civilisation instead. So for a
  // masked guest every tie below is hidden knowledge, even though the
  // same tie on an honest guest is right there on their own screen.
  const masked = Boolean(identity && COVER_IDENTITIES.has(identity.type));
  if (identity && COVER_IDENTITIES.has(identity.type)) {
    const claims = [
      identity.profession ? `a ${words(identity.profession)}` : null,
      identity.entity ? `of ${identity.entity.name}${identity.entity.ours ? ' — your own civilisation' : ''}` : null,
    ].filter(Boolean).join(' ');
    out.push(concern('cover', 'high',
      `${who} is not who they say`,
      `DF has them under a ${words(identity.type)}: really ${visitor.real_name || 'someone else'}`
      + `${visitor.entity ? ` of ${visitor.entity.name}` : ''}, presenting as ${who}`
      + `${claims ? `, ${claims}` : ''}.`, true));
  }

  // Their own intrigue perspective: the plots they are running.
  const plots = asList(visitor.intrigue && visitor.intrigue.plots);
  const pointed = plots.filter((p) => POINTED_PLOTS.has(p.type));
  const aimedHere = pointed.filter((p) => p.target && p.target.ours);
  if (aimedHere.length) {
    out.push(concern('plot-here', 'high',
      `${who} is plotting against this fort`,
      aimedHere.map((plot) => `${words(plot.type)} → ${plot.target.name}`
        + (plot.target.kind === 'artifact' ? ' (an artifact held here)' : '')
        + (plot.on_hold ? ', on hold' : '')).join('; ') + '.', true));
  }
  const elsewhere = pointed.filter((p) => !(p.target && p.target.ours));
  if (elsewhere.length) {
    out.push(concern('plotter', 'medium',
      `${who} runs plots of their own`,
      `${elsewhere.length} plot${elsewhere.length === 1 ? '' : 's'} with a named target, none of them here yet: `
      + `${elsewhere.map((p) => words(p.type) + (p.target ? ` (${p.target.name})` : '')).join(', ')}.`, true));
  } else if (!aimedHere.length && plots.length) {
    out.push(concern('plotter', 'medium',
      `${who} is building a network`,
      `${plots.length} plot${plots.length === 1 ? '' : 's'} on file — `
      + `${plots.map((p) => words(p.type)).join(', ')} — none aimed at anyone in particular yet.`, true));
  }
  const master = visitor.intrigue && visitor.intrigue.master;
  if (master) {
    out.push(concern('handler', 'medium',
      `${who} takes orders from ${master}`,
      'DF files them as obeying a master in someone else\'s intrigue network.', true));
  }

  // Governments that want them. Several governments wanting the same
  // person is one fact about the person, not one per government.
  const wanted = asList(visitor.groups).filter((g) => CRIMINAL_LINKS.has(g.link));
  if (wanted.length) {
    out.push(concern('criminal', 'high',
      `${who} is wanted by ${plural(wanted.length, 'government')}`,
      wanted.map((g) => `${g.name} has them on file as ${words(g.link)}`).join('; ') + '.',
      // A foreign government's file on someone is not something the fort
      // has been told; your own civilisation's is.
      masked || !wanted.some((g) => g.ours)));
  }
  const enemies = asList(visitor.groups).filter((g) => g.link === 'ENEMY' && g.ours);
  if (enemies.length) {
    out.push(concern('enemy', 'high',
      `${who} counts this fort among their enemies`,
      `DF records an ENEMY tie to ${enemies.map((g) => g.name).join(' and ')}.`, masked));
  }
  if (visitor.entity && visitor.entity.type === 'Outcast') {
    out.push(concern('outcast', 'medium',
      `${who} belongs to an outcast band`,
      `${visitor.entity.name} is an Outcast group — DF's word for bandits and exiles.`, masked));
  }

  // What entities have written down about them.
  for (const record of asList(visitor.reputations)) {
    for (const entry of asList(record.types)) {
      const severity = ALARMING_REPUTATIONS[entry.key];
      if (!severity) continue;
      out.push(concern('wanted', record.ours && severity === 'medium' ? 'high' : severity,
        `${who} is known as a ${words(entry.key)}`,
        `${record.entity || 'A government'} rates it ${entry.level}/100`
        + `${record.ours ? ' — and that is your own civilisation' : ''}.`,
        masked || !record.ours));
    }
    if (record.unsolved_murders > 0) {
      out.push(concern('wanted', 'high',
        `${who} trails unsolved murders`,
        `${record.unsolved_murders} unsolved in ${record.entity || 'their homeland'}.`,
        masked || !record.ours));
    }
    if (record.exiled) {
      out.push(concern('wanted', 'medium',
        `${who} was exiled`,
        `${record.entity || 'Their government'} threw them out.`,
        masked || !record.ours));
    }
  }

  if (CRIMINAL_PROFESSIONS.has(visitor.profession_key)) {
    out.push(concern('trade', 'high',
      `${who} is a ${words(visitor.profession_key)} by profession`,
      'DF\'s own profession for them, not a guess from their kit.'));
  }

  // What they are, rather than who. A hidden curse is hidden by design —
  // DF means a vampire in the tavern to be a murder mystery — so both
  // curse lines are spoilers.
  const curse = visitor.curse || {};
  if (curse.hiding || curse.undead || curse.bloodsucker) {
    out.push(concern('cursed', 'high',
      `${who} is hiding a curse`,
      curse.bloodsucker
        ? 'A bloodsucker under an assumed life — a vampire, in the fort, at night.'
        : 'DF has them concealing an undead curse.',
      true));
  }
  if (curse.night_creature || curse.opposed_to_life || curse.crazed) {
    out.push(concern('cursed', 'high',
      `${who} is a night creature`,
      [curse.night_creature ? 'night creature' : null,
        curse.opposed_to_life ? 'opposed to life' : null,
        curse.crazed ? 'crazed' : null].filter(Boolean).join(', ') + '.',
      true));
  }

  // `isInvader` is three flags in a trenchcoat and only one of them is an
  // attack. `invader_origin` means they arrived with an invasion at some
  // point, which stays true for a goblin long after the siege that
  // brought them — saying "is flagged as an invader" for that reads as a
  // live threat and is simply wrong.
  const threat = visitor.threat || {};
  if (threat.active_invader) {
    out.push(concern('invader', 'high',
      `${who} is attacking`,
      'DF has them flagged as an active invader, guest flag or not.'));
  } else if (threat.invader) {
    out.push(concern('invader', 'medium',
      `${who} came here with an invasion`,
      `DF still has ${[threat.invader_origin ? 'invader_origin' : null,
        threat.marauder ? 'marauder' : null].filter(Boolean).join(' and ')} set on them. `
      + 'That is where they came from, not what they are doing now — a goblin who arrived '
      + 'with a siege keeps it for good.'));
  } else if (threat.great_danger || threat.danger) {
    out.push(concern('beast', threat.great_danger ? 'high' : 'medium',
      `${who} is dangerous`,
      `${visitor.race} — DFHack's own ${threat.great_danger ? 'great danger' : 'danger'} check`
      + `${visitor.uninvited ? ', and nobody invited them' : ''}.`));
  } else if (visitor.uninvited) {
    out.push(concern('beast', 'medium',
      `${who} came uninvited`,
      'DF flags them visitor_uninvited — they let themselves in.'));
  }

  // Here for something specific. A journey is world data, not anything
  // the fort has been told, so it is a spoiler even though a quester will
  // eventually ask around out loud.
  const quest = visitor.artifact_quest;
  if (quest) {
    out.push(concern('quest', quest.ours ? 'high' : 'medium',
      `${who} is hunting an artifact`,
      `On a journey for ${quest.name}${quest.ours ? ', which is in this fort' : ''}.`,
      true));
  } else if (visitor.journey === 'GATHER_INFORMATION') {
    out.push(concern('quest', 'medium',
      `${who} is here to gather information`,
      'DF\'s own journey type for them, not a reading of their behaviour.',
      true));
  }

  // The wiki's oldest tell: an elf calling himself a bard, carrying a
  // sword and unable to play a note. This is a soft signal on its own —
  // plenty of honest guests are simply bad at their trade — so it is
  // only raised when they claim a trade and have nothing in it.
  //
  // A cover identity carries a profession of its own, and that is the
  // trade the *story* claims rather than the one DF prints next to their
  // name, so both are checked.
  const claims = [
    role.stated ? { label: role.label, category: role.category } : null,
    identity && identity.profession
      ? {
        label: words(identity.profession),
        category: input.categoryOfProfession(identity.profession)
          || PROFESSION_CATEGORY[identity.profession],
      }
      : null,
  ].filter((claim) => claim && claim.category);

  const seen = new Set();
  for (const claim of claims) {
    if (seen.has(claim.category)) continue;
    seen.add(claim.category);
    if (bestIn(visitor, claim.category, input)) continue;
    if (!asList(visitor.skills).some((s) => s.rating > 0)) continue;
    const top = topSkills(visitor, input, 1)[0];
    out.push(concern('mismatch', 'medium',
      `${who} claims a trade they have no skill in`,
      `Presents as ${claim.label}, which is graded on ${String(claim.category).toLowerCase()}, `
      + `and has none at all. Their best skill is ${top.caption} ${top.rating}.`));
  }

  // Personality, which is where brawls come from.
  for (const value of asList(visitor.values)) {
    if (value.key === 'LAW' && value.strength <= -VALUE_EXTREME) {
      out.push(concern('temper', 'low',
        `${who} has no use for the law`,
        `Value LAW at ${value.strength} on DF's -50..50 scale.`));
    }
    if (value.key === 'TRUTH' && value.strength <= -VALUE_EXTREME) {
      out.push(concern('temper', 'low',
        `${who} thinks lying is fine`,
        `Value TRUTH at ${value.strength} on DF's -50..50 scale.`));
    }
  }

  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

// ------------------------------------------------------------ the roster

/**
 * Whether a guest is actually standing in the tavern. `world.units.active`
 * means "on the map": in Shieldclosed 349 of its 765 entries are corpses,
 * and a caged beast keeps the visitor flag it arrived with. Neither is
 * asking to stay, and neither should be graded as if it were.
 */
export function presence(visitor) {
  const state = visitor.state || {};
  if (state.dead || state.ghost) return 'dead';
  if (state.caged || state.chained) return 'caged';
  if (state.tame) return 'tame';
  return 'present';
}

/** One guest, fully judged. */
export function assess(visitor, input) {
  const role = roleOf(visitor, input);
  const craft = role.category ? bestIn(visitor, role.category, input) : null;
  const standouts = topSkills(visitor, input);
  // With spoilers off the hidden concerns are dropped before anything
  // downstream sees them, so the risk column, the counts and the findings
  // are all consistently blind rather than blind in the list and knowing
  // in the summary.
  const concerns = concernsOf(visitor, role, craft, input)
    .filter((c) => input.spoilers || !c.spoiler);
  const worst = concerns[0] ? concerns[0].severity : null;
  const masked = Boolean(input.spoilers && visitor.real_name);

  return {
    visitor,
    id: visitor.id,
    name: visitor.name,
    presence: presence(visitor),
    role,
    craft,
    standouts,
    concerns,
    masked,
    worth: worthOf(role, craft, standouts),
    risk: worst === 'high' ? 'danger' : (worst ? 'watch' : 'clear'),
    // A petition waiting on an answer is the row the player came for.
    pending: Boolean(visitor.petition && visitor.petition.pending),
  };
}

const RISK_RANK = { danger: 0, watch: 1, clear: 2 };
const WORTH_RANK = { star: 0, solid: 1, green: 2, novice: 3, none: 4 };

export function roster(input) {
  return asList(input.visitors)
    .filter((visitor) => presence(visitor) === 'present')
    .map((visitor) => assess(visitor, input))
    // Pending petitions first — they are the ones on a clock. Then the
    // dangerous, then the useful, so the list reads as a decision queue.
    .sort((a, b) => (b.pending - a.pending)
      || (RISK_RANK[a.risk] - RISK_RANK[b.risk])
      || (WORTH_RANK[a.worth.key] - WORTH_RANK[b.worth.key])
      || String(a.name).localeCompare(String(b.name)));
}

// ------------------------------------------------------ group petitions

/**
 * Petitions filed by a group rather than a person.
 *
 * A performance troupe asks for residency **as an entity**: DF puts the
 * troupe on the agreement's applicant party and leaves the histfig list
 * empty, so there is no guest to hang the petition off and a reader that
 * only walks guests drops it entirely. It is also genuinely not a fact
 * about any one member — DF is asking about the whole troupe at once, and
 * most of them are not on the map yet to be asked about.
 *
 * The join is done here rather than in the dumper because "is this member
 * actually in the fort" is `presence()`'s question, and that answer lives
 * in exactly one place. `here` is the members standing in the tavern,
 * `elsewhere` the count still travelling — the usual split is lopsided
 * (Shieldclosed's troupe had one of fifteen here when it petitioned), and
 * saying so is the point: accepting takes in the fourteen you cannot see.
 */
export function groupPetitions(input) {
  const present = new Map();
  for (const person of roster(input)) {
    if (person.visitor.hf_id != null) present.set(person.visitor.hf_id, person);
  }

  return asList(input.petitions).map((petition) => {
    const members = asList(petition.members);
    const here = members
      .map((m) => present.get(m.hf_id))
      .filter(Boolean);
    return {
      petition,
      entity: petition.entity || null,
      name: (petition.entity && petition.entity.name) || 'an unnamed group',
      kind: petition.kind,
      year: petition.year,
      pending: Boolean(petition.pending),
      members,
      here,
      elsewhere: members.length - here.length,
    };
  }).sort((a, b) => (b.pending - a.pending)
    || (b.year - a.year)
    || String(a.name).localeCompare(String(b.name)));
}

// ----------------------------------------------------------- the verdict

/**
 * Findings worst-first. The serious concerns stay per-guest, because each
 * one is a separate decision; the low-severity ones fold into a single
 * line once enough guests share them, the way the equipment findings do —
 * eight guests who dislike the law is one note about the tavern, not
 * eight findings.
 */
export function diagnose(input) {
  const people = roster(input);
  const findings = [];
  const rolled = new Map();

  for (const person of people) {
    for (const item of person.concerns) {
      if (item.severity === 'low') {
        if (!rolled.has(item.kind)) rolled.set(item.kind, []);
        rolled.get(item.kind).push({ person, item });
        continue;
      }
      findings.push({
        severity: item.severity,
        kind: item.kind,
        title: item.title,
        detail: item.detail,
        id: person.id,
        names: [person.name],
      });
    }
  }

  for (const [kind, entries] of rolled) {
    if (entries.length < ROLLUP_MIN) {
      for (const { person, item } of entries) {
        findings.push({
          severity: item.severity,
          kind,
          title: item.title,
          detail: item.detail,
          id: person.id,
          names: [person.name],
        });
      }
      continue;
    }
    findings.push({
      severity: 'low',
      kind,
      title: `${entries.length} guests with a temper worth watching`,
      detail: 'Values DF records well outside the normal range — the raw material '
        + 'of a tavern brawl, not a plot.',
      names: [...new Set(entries.map((e) => e.person.name))],
    });
  }

  // A petition on the clock outranks everything: it is the one thing here
  // that stops being actionable if the player looks away.
  const waiting = people.filter((p) => p.pending);
  if (waiting.length) {
    findings.unshift({
      severity: 'high',
      kind: 'pending',
      title: `${waiting.length} petition${waiting.length === 1 ? '' : 's'} waiting on you`,
      detail: waiting.map((p) => `${p.name} (${p.visitor.petition.kind}, ${p.worth.label})`).join('; ') + '.',
      names: waiting.map((p) => p.name),
    });
  }

  // Group petitions are separate findings rather than folded into the
  // count above, because the decision is a different one: it is a single
  // yes or no covering people the fort cannot see, so the numbers the
  // player needs are the membership and how much of it is still on the
  // road, not a per-guest verdict.
  for (const group of groupPetitions(input).filter((g) => g.pending)) {
    findings.unshift({
      severity: 'high',
      kind: 'pending-group',
      title: `${group.name} asks for ${group.kind} as a group`,
      detail: `${plural(group.members.length, 'member')}, `
        + (group.here.length
          ? `${group.here.length} in the fort (${group.here.map((p) => p.name).join(', ')})`
          : 'none of them in the fort yet')
        + (group.elsewhere
          ? `; ${group.elsewhere} still travelling. Accepting takes in all of them.`
          : '.'),
      names: group.here.map((p) => p.name),
    });
  }

  return findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

export function summarise(input) {
  const people = roster(input);
  const groups = groupPetitions(input);
  const visitors = people.filter((p) => p.visitor.status === 'visitor');
  const residents = people.filter((p) => p.visitor.status === 'resident');
  // What the presence filter took out, so the view can say so rather than
  // quietly showing a smaller number than the fort has bodies for.
  const absent = asList(input.visitors)
    .map(presence)
    .filter((p) => p !== 'present')
    .reduce((counts, p) => ({ ...counts, [p]: (counts[p] || 0) + 1 }), {});
  return {
    total: people.length,
    visitors: visitors.length,
    residents: residents.length,
    absent,
    // Individual and group petitions are both waiting on the same answer,
    // so the headline counts them together; `pendingGroups` is the part of
    // that number no row in the list below accounts for.
    pending: people.filter((p) => p.pending).length
      + groups.filter((g) => g.pending).length,
    pendingGroups: groups.filter((g) => g.pending).length,
    groupPetitions: groups.length,
    dangerous: people.filter((p) => p.risk === 'danger').length,
    watch: people.filter((p) => p.risk === 'watch').length,
    impostors: people.filter((p) => p.concerns.some((c) => c.kind === 'cover')).length,
    worthKeeping: people.filter((p) => p.worth.key === 'star' || p.worth.key === 'solid').length,
    novices: people.filter((p) => p.worth.key === 'novice' || p.worth.key === 'none').length,
    // What taking the good ones in would actually add to the fort.
    upgrades: people.filter((p) => p.standouts.some((s) => s.beatsFort)).length,
  };
}
