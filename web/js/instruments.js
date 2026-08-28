// Instrument manufacturing: what a recipe needs, and how far the fort is.
//
// Everything judged here comes out of DF's own generated reactions, which
// the dumper ships whole — the building, the skill, the reagents and the
// fuel are the game's answer, not this module's. What is left to decide is
// only the fort-facing half: whether the fort has the building, whether it
// has the materials, and which step it is stuck on.
//
// Pure, like `geometry.js`, `flow.js`, `armory.js` and `visitors.js`:
// `roster(input)` grades every buildable instrument and `summarise(input)`
// gives the headline numbers, both checkable with `node` against a
// snapshot.

import { asList } from './util.js';

// A step's verdict, worst first. The order is the judgement: a step with
// nowhere to run is a harder stop than one short of clay, because the
// player can usually buy clay and cannot buy a kiln. `waiting` is the
// assembly's own case — nothing is wrong with it, it simply cannot run
// until the pieces exist.
export const VERDICTS = [
  'no-recipe', 'no-workshop', 'no-material', 'waiting', 'ready', 'done',
];

// Below this the fort can still run the job — DF gates work on the labour,
// not the skill — but the result will be poor, and for an instrument the
// quality *is* the point.
export const GREEN_SKILL = 1;

/** Sort key for a verdict; unknown verdicts sort last. */
function rank(verdict) {
  const i = VERDICTS.indexOf(verdict);
  return i < 0 ? VERDICTS.length : i;
}

/**
 * A reagent the fort cannot currently satisfy. `stock_units` is absent for
 * a reagent with no item type of its own — the bag a glassmaker's sand
 * arrives in — and an absent figure is not a shortfall, it is a reagent
 * this module has no business grading.
 */
function short(reagent) {
  if (reagent.preserve) return false;
  if (typeof reagent.stock_units !== 'number') return false;
  return reagent.stock_units < (reagent.units || 1);
}

/**
 * Where a reaction may be run, as one requirement rather than a list. DF
 * offers alternatives for the heated jobs — either glass furnace, either
 * kiln — and either one satisfies the step, so they are held together and
 * counted together. Reporting them separately would make one recipe look
 * like two missing workshops.
 */
function siteFor(reaction) {
  const options = asList(reaction && reaction.buildings);
  return {
    options,
    label: options.map((o) => o.name).join(' or ') || 'no workshop named',
    key: options.map((o) => `${o.kind}:${o.subtype}`).join('|'),
  };
}

/** Fill in how many of each alternative the fort actually has. */
function held(site, workshops) {
  const options = site.options.map((option) => {
    const buildings = workshops.filter((w) => w.kind === option.kind
      && w.subtype === option.subtype);
    return { ...option, have: buildings.length, buildings };
  });
  return {
    ...site,
    options,
    have: options.reduce((sum, o) => sum + o.have, 0),
  };
}

/**
 * Grade one reaction against the fort. `made` is how many of the thing it
 * produces already exist — for a piece that is the count DF's own item
 * match found against the assembly's reagent, which is the only honest
 * source: a piece is a tool like any other, and nothing in the snapshot
 * marks one as belonging to a half-built instrument.
 */
function gradeStep(reaction, input, { made, needed, label, piece }) {
  const site = held(siteFor(reaction), input.workshops);
  const missing = asList(reaction && reaction.reagents).filter(short);
  const skill = reaction && reaction.skill ? input.skillHolder(reaction.skill) : null;

  let verdict = 'ready';
  // No reaction at all means the permitted list has no recipe for this
  // piece. Saying "no workshop" instead would be a wrong claim about a
  // fort that may well have every workshop it needs.
  if (!reaction) verdict = 'no-recipe';
  else if (made >= needed) verdict = 'done';
  else if (!site.have) verdict = 'no-workshop';
  else if (missing.length) verdict = 'no-material';

  return {
    label,
    piece: piece || null,
    reaction: reaction || null,
    site,
    // Named separately from the verdict because a step can be short of
    // both a workshop and its clay, and the player wants to hear about
    // both, not about whichever this module checked first.
    missing,
    made,
    needed,
    verdict,
    skill,
    // DF will run the job regardless, so an unskilled fort is a warning
    // about quality, never a reason to call the step blocked.
    unskilled: Boolean(reaction && reaction.skill && (!skill || skill.rating < GREEN_SKILL)),
  };
}

/** The assembly reagent standing for `piece`, matched by tool identity. */
function slotFor(assembly, piece) {
  return asList(assembly && assembly.reagents).find((r) => r.item_type === 'TOOL'
    && r.item_subtype === piece.tool_index) || null;
}

/**
 * Every instrument the fort's civilisation knows how to build, with each
 * step graded. A one-piece instrument has a single step and no assembly;
 * a multi-piece one has a step per piece plus the assembly that consumes
 * them.
 */
export function roster(input) {
  return asList(input.types).map((type) => {
    const pieces = asList(type.pieces);
    const recipe = type.reaction || null;
    const partSteps = [];

    for (const piece of pieces) {
      const slot = slotFor(recipe, piece);
      partSteps.push(gradeStep(piece.reaction, input, {
        made: slot && typeof slot.stock_units === 'number' ? slot.stock_units : 0,
        needed: (slot && slot.units) || 1,
        label: (piece.reaction && piece.reaction.name)
          || `make ${type.name} ${piece.name}`,
        piece,
      }));
    }

    // With no pieces DF makes the whole instrument in one job, and the
    // instrument's reaction is that job rather than an assembly. It is
    // graded on materials alone: owning one already is not a reason to
    // call the job finished, because a fort can always make another.
    const single = pieces.length ? null : gradeStep(recipe, input, {
      made: 0,
      needed: 1,
      label: (recipe && recipe.name) || `make ${type.name}`,
    });

    const assembly = pieces.length ? assemble(recipe, input, type, partSteps) : null;
    const steps = single ? [single] : [...partSteps, assembly];
    const blocked = steps.filter((s) => s.verdict === 'no-workshop'
      || s.verdict === 'no-material' || s.verdict === 'no-recipe');
    const done = partSteps.filter((s) => s.verdict === 'done').length;

    return {
      ...type,
      steps,
      partSteps,
      assembly,
      piecesDone: done,
      piecesTotal: partSteps.length,
      blocked,
      // What the player actually wants off a list: can I start this now,
      // is it half-built, or is something in the way.
      status: statusOf(type, blocked, done, partSteps.length),
      // Every workshop the whole recipe touches, deduplicated — the
      // shortest honest answer to "which workshops do I need".
      sites: allSites(steps),
      // Worst step first, so a card can lead with the thing in the way.
      worst: steps.slice().sort((a, b) => rank(a.verdict) - rank(b.verdict))[0] || null,
    };
  });
}

/**
 * The assembly step. It consumes pieces rather than raw materials, so it
 * is graded against them: `waiting` while any piece is still to be made,
 * which is a state of the recipe rather than a fault in the fort.
 */
function assemble(recipe, input, type, partSteps) {
  const outstanding = partSteps.filter((s) => s.verdict !== 'done');
  const step = gradeStep(recipe, input, {
    made: partSteps.length - outstanding.length,
    needed: partSteps.length,
    label: (recipe && recipe.name) || `assemble ${type.name}`,
  });
  step.waiting = outstanding;
  // `gradeStep` would call a full set "done"; for an assembly a full set
  // is the one case where it is ready to run.
  if (outstanding.length) step.verdict = step.site.have ? 'waiting' : 'no-workshop';
  else step.verdict = step.site.have ? 'ready' : 'no-workshop';
  return step;
}

function statusOf(type, blocked, done, total) {
  if (blocked.length) return 'blocked';
  if (total && done > 0 && done < total) return 'started';
  if (type.in_stock > 0) return 'built';
  return 'ready';
}

/** The distinct workshops a recipe needs, each with how many the fort has. */
function allSites(steps) {
  const seen = new Map();
  for (const step of steps) {
    if (!step.site.key) continue;
    if (!seen.has(step.site.key)) seen.set(step.site.key, { ...step.site, steps: 0 });
    seen.get(step.site.key).steps += 1;
  }
  return [...seen.values()].sort((a, b) => b.steps - a.steps);
}

/** Headline figures for the view's stat strip. */
export function summarise(input) {
  const all = roster(input);
  return {
    types: all.length,
    // Nothing in the way and nothing part-made yet. `built` counts here
    // too: already owning one is no reason a fort cannot start another,
    // and the view's "can start now" filter has to agree with this figure.
    ready: all.filter((t) => t.status === 'ready' || t.status === 'built').length,
    started: all.filter((t) => t.status === 'started').length,
    blocked: all.filter((t) => t.status === 'blocked').length,
    inStock: all.reduce((sum, t) => sum + (t.in_stock || 0), 0),
    foreign: asList(input.foreign).reduce((sum, f) => sum + (f.count || 0), 0),
    foreignKinds: asList(input.foreign).length,
    // The workshops the fort is missing, most-unlocked first — the one
    // list that turns "blocked" into something to go and do.
    missingSites: missingSites(all),
  };
}

function missingSites(all) {
  const tally = new Map();
  for (const type of all) {
    for (const site of type.sites) {
      if (site.have > 0) continue;
      if (!tally.has(site.key)) tally.set(site.key, { ...site, unlocks: [] });
      tally.get(site.key).unlocks.push(type.name);
    }
  }
  return [...tally.values()].sort((a, b) => b.unlocks.length - a.unlocks.length);
}
