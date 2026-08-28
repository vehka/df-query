// Squad equipment analysis: what each soldier is wearing against what
// their own uniform asks for, and whether the fort can close the gap.
//
// Pure functions over the snapshot, like `flow.js` and `geometry.js` —
// nothing here touches the DOM, so the judgment calls can be checked
// without a browser.
//
// The standard being graded against is the player's, not this module's.
// A uniform spec carries an `entity_material_category`, and its values are
// specific: `Armor` is ARMOR_METAL — the player asked for metal — while
// `Leather` and `Cloth` name exactly what they say, and only `None` means
// "any material". Grading a leather-glove uniform against a hardcoded
// gauntlet demands kit the player never wanted. `ROLES` below is only the
// fallback for a squad with no uniform at all.
//
// Two things this module cannot know, and never claims to:
//
//   * Whether DF will actually issue a given item. A gap here means "this
//     soldier is not wearing it", not "DF refuses to give it to them".
//   * Whether a bar can be forged into a specific piece. Bar stock says
//     the metal exists, not that the smithy, fuel, and orders do.
//
// And one distinction it exists to draw: an earmarked piece is not a
// missing one. DF assigns kit the moment it exists and the soldier picks
// it up when they go on duty, so an off-duty squad reads as bare while a
// full set of iron waits in a stockpile. That is a hauling fact, not a
// forge order.

import { asList } from './util.js';

// Material classes ranked as armour. DF's own `strength.fracture[SHEAR]`
// orders metals exactly the way players do — adamantine, steel, iron,
// bronze, copper — but it is NOT comparable across classes: it is a
// tension figure for thread, so giant cave spider silk reads 1,200,000,
// above steel. Rank by class first, and only use the raw number to
// separate metals from each other.
export const MAT_CLASS_RANK = {
  metal: 4,
  bone: 3,
  shell: 3,
  leather: 2,
  wood: 1,
  cloth: 0,
  other: 0,
};

// `entity_material_category` read as a demand on the piece. This is the
// enum DF's own uniform screen writes; `Armor` is its ARMOR_METAL, which
// is why a uniform saying "Armor" is a request for metal.
export const CLASS_DEMAND = {
  Armor: 'metal',
  WeaponMelee: 'metal',
  WeaponRanged: 'metal',
  Ammo: 'metal',
  AmmoMetal: 'metal',
  Chain: 'metal',
  Pick: 'metal',
  Anvil: 'metal',
  Leather: 'leather',
  Bone: 'bone',
  Shell: 'shell',
  Wood: 'wood',
  Cloth: 'cloth',
  Silk: 'cloth',
  PlantFiber: 'cloth',
  Clothing: 'cloth',
};

// Armor User at or below this is a green recruit: full metal will slow
// them down until they train out of it. Worth saying, not worth changing
// the target kit over.
export const GREEN_ARMOR_SKILL = 1;

// Bolts per archer before the quiver counts as stocked. DF's own default
// uniform asks for 25.
export const AMMO_TARGET = 25;

// `armorlevel` 0 is clothing -- a leather dress and a mail shirt are both
// item type ARMOR, and this is what separates them. But armorlevel is
// about LAYERING, not protection: a steel cap and a helm are both real
// armour and the cap is armorlevel 0, same as a headscarf. So metal counts
// as armour whatever its level, and metal at level 0 is flagged as light.
export const ARMOR_LEVEL_MIN = 1;

export const SEVERITY = { high: 0, medium: 1, low: 2 };

// Slots DF issues a left and a right of.
export const PAIRED_SLOTS = new Set(['hands', 'feet']);

// What to call an unnamed spec. A uniform that just says "any HELM, metal"
// is asking for a helm; one that says "any HELM, leather" is asking for a
// cap or a hood, and calling that a helm overstates it.
const SLOT_LABEL = {
  head: 'headgear', body: 'body armour', hands: 'gloves', legs: 'legwear',
  feet: 'footwear', shield: 'shield', weapon: 'weapon', quiver: 'quiver',
};
const METAL_LABEL = {
  head: 'helm', body: 'mail shirt', hands: 'gauntlets', legs: 'greaves',
  feet: 'high boots', shield: 'shield', weapon: 'metal weapon', quiver: 'quiver',
};

// The fallback kit, for a squad with no uniform to read. Both roles want
// the same armour — a crossbow dwarf's list and a melee dwarf's differ
// only in the weapon and the quiver.
const ARMOUR_SLOTS = [
  { slot: 'head', label: 'helm', want: 1, demand: 'metal' },
  { slot: 'body', label: 'mail shirt', want: 1, demand: 'metal' },
  { slot: 'hands', label: 'gauntlets', want: 2, demand: 'metal' },
  { slot: 'legs', label: 'greaves', want: 1, demand: 'metal' },
  { slot: 'feet', label: 'high boots', want: 2, demand: 'metal' },
  { slot: 'shield', label: 'shield', want: 1, demand: 'metal' },
];

export const ROLES = {
  melee: {
    label: 'melee',
    slots: [...ARMOUR_SLOTS,
      { slot: 'weapon', label: 'metal weapon', want: 1, demand: 'metal' }],
    ammo: false,
  },
  ranged: {
    label: 'crossbow',
    slots: [
      ...ARMOUR_SLOTS,
      // The crossbow itself is not a metal requirement: DF's own bone and
      // wooden crossbows shoot exactly as well, and the material only
      // matters when it is swung as a club.
      { slot: 'weapon', label: 'crossbow', want: 1, demand: null, anyMaterial: true },
      { slot: 'quiver', label: 'quiver', want: 1, demand: null, anyMaterial: true },
    ],
    ammo: true,
  },
};

/** Skills that mark a soldier as a shooter rather than a swinger. */
const RANGED_SKILLS = new Set(['CROSSBOW', 'BOW', 'BLOWGUN']);

const RANGED_WEAPON = /crossbow|\bbow\b|blowgun/i;

/** Does this item count as armour at all, or is it just clothing? */
export function isArmour(item) {
  if (item.mat_class === 'metal') return true;
  return (item.armor_level || 0) >= ARMOR_LEVEL_MIN;
}

/** Metal, but the open-faced version: a cap rather than a helm. */
export function isLightArmour(item) {
  return item.mat_class === 'metal' && (item.armor_level || 0) < ARMOR_LEVEL_MIN;
}

export function classRank(item) {
  return MAT_CLASS_RANK[item.mat_class] ?? 0;
}

/**
 * Order two pieces by protective value: material class first, then DF's
 * shear figure within the class, then quality as the tie-break.
 */
export function betterOf(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (classRank(a) !== classRank(b)) return classRank(a) > classRank(b) ? a : b;
  if ((a.grade || 0) !== (b.grade || 0)) return (a.grade || 0) > (b.grade || 0) ? a : b;
  return (a.quality || 0) >= (b.quality || 0) ? a : b;
}

// Labels that take no article: "leather legwear", not "a leather legwear".
const MASS_NOUNS = new Set(['armour', 'legwear', 'footwear', 'headgear', 'gear']);

/** "a shield", "2 gauntlets", "leather legwear" — a piece, counted. */
export function quantify(label, want) {
  if (want > 1) return `${want} ${label}`;
  const last = label.split(' ').pop();
  if (/s$/.test(last) || MASS_NOUNS.has(last)) return label;
  return `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}`;
}

/** "a steel cap", for a sentence. */
export function describe(item) {
  if (!item) return 'nothing';
  const words = `${item.material || ''} ${item.subtype || ''}`.trim();
  return /^[aeiou]/i.test(words) ? `an ${words}` : `a ${words}`;
}

/** Which role's kit should this soldier be judged against? */
export function roleOf(position, unit) {
  for (const spec of asList(position.uniform)) {
    if (spec.type === 'WEAPON' && spec.subtype && RANGED_WEAPON.test(spec.subtype)) {
      return 'ranged';
    }
  }
  for (const item of asList(position.equipment)) {
    if (item.slot === 'weapon' && RANGED_WEAPON.test(item.subtype || '')) return 'ranged';
    if (item.slot === 'quiver') return 'ranged';
  }
  // Nothing issued and no uniform weapon: fall back to what they are good
  // at, which is how a player would pick the squad in the first place.
  let best = null;
  for (const skill of asList(unit && unit.skills)) {
    if (!RANGED_SKILLS.has(skill.key)) continue;
    if (!best || skill.rating > best.rating) best = skill;
  }
  return best && best.rating > 0 ? 'ranged' : 'melee';
}

/** The best metal the fort has demonstrated it can put on a soldier. */
export function bestMetal(input) {
  let best = null;
  const consider = (material, grade, armour) => {
    if (!material || !armour) return;
    if (!best || grade > best.grade) best = { material, grade };
  };
  for (const group of asList(input.armory && input.armory.groups)) {
    if (group.mat_class === 'metal' && isArmour(group)) {
      consider(group.material, group.grade || 0, group.armor_material);
    }
  }
  for (const bar of asList(input.armory && input.armory.bars)) {
    consider(bar.material, bar.grade || 0, bar.armor_material);
  }
  for (const squad of asList(input.squads)) {
    for (const position of asList(squad.positions)) {
      for (const item of asList(position.equipment)) {
        if (item.mat_class === 'metal' && isArmour(item)) {
          consider(item.material, item.grade || 0, item.armor_material);
        }
      }
    }
  }
  return best;
}

/** What material class, if any, this uniform spec insists on. */
export function demandOf(spec) {
  return CLASS_DEMAND[spec.material_class] ?? null;
}

function labelFor(spec, slot, want, demand) {
  const named = spec.subtype
    ? (want > 1 ? `${spec.subtype}s` : spec.subtype)
    : (demand === 'metal' ? METAL_LABEL[slot] : SLOT_LABEL[slot]) || slot;
  // "leather footwear" beats "footwear" when the uniform said leather and
  // the shopping list has to name the piece on its own line.
  if (!spec.subtype && demand && demand !== 'metal') return `${demand} ${named}`;
  return named;
}

/**
 * The target kit for one position: the player's uniform where there is
 * one, the role's default kit where there is not.
 *
 * One entry per uniform spec, so a body slot that layers leather armour
 * over a mail shirt reads as the two pieces DF is tracking.
 */
export function targetKit(position, role) {
  const specs = asList(position.uniform).filter((spec) => spec.slot);
  if (!specs.length) return (ROLES[role] || ROLES.melee).slots.map((s) => ({ ...s }));
  return specs.map((spec) => {
    const slot = spec.slot;
    const want = PAIRED_SLOTS.has(slot) ? 2 : 1;
    const demand = demandOf(spec);
    return {
      slot,
      want,
      demand,
      anyMaterial: demand === null,
      subtype: spec.subtype || null,
      label: labelFor(spec, slot, want, demand),
      armorLevel: spec.armor_level ?? null,
      spec,
    };
  });
}

/** Does this piece satisfy that line of the uniform? */
export function matchesSpec(item, want) {
  if (item.slot !== want.slot) return false;
  if (want.subtype && (item.subtype || '') !== want.subtype) return false;
  if (want.demand) return classRank(item) >= (MAT_CLASS_RANK[want.demand] ?? 0);
  // No material named and no subtype named: any piece of the right kind
  // will do — but a sock must not pass for body armour, so the piece still
  // has to be armour rather than clothing.
  if (want.subtype || want.slot === 'weapon' || want.slot === 'quiver') return true;
  return isArmour(item);
}

// Stricter specs claim their piece first, so the mail-shirt line takes the
// mail shirt and the "any armour" line beside it takes the leather.
function strictness(want) {
  return (want.subtype ? 2 : 0) + (want.demand ? 1 : 0);
}

/**
 * Grade one soldier's kit line by line against their uniform.
 *
 * Returns the per-line verdicts plus the counts the roll-ups need. Each
 * line is judged on the best piece matching it, so a steel boot beside a
 * sock reads as booted.
 *
 * The verdicts, worst first:
 *
 *   missing    nothing worn, nothing earmarked — this is a forge order
 *   wrong      wearing the wrong kind of piece for the line
 *   soft       wearing something softer than the uniform asks for
 *   partial    half a pair
 *   unclaimed  the piece exists and DF has earmarked it, uncollected
 *   light      metal, but the open-faced kind
 *   downgrade  metal, but not the best metal the fort makes
 */
export function assess(position, unit, role, best) {
  const spec = ROLES[role] || ROLES.melee;
  const kit = targetKit(position, role);
  const worn = asList(position.equipment).filter((item) => item.slot);
  const taken = new Set();
  const matched = kit.map(() => []);

  const order = kit.map((want, i) => i)
    .sort((a, b) => strictness(kit[b]) - strictness(kit[a]));
  for (const idx of order) {
    const want = kit[idx];
    const pool = worn
      .map((item, i) => ({ item, i }))
      .filter(({ item, i }) => !taken.has(i) && matchesSpec(item, want))
      .sort((a, b) => (betterOf(a.item, b.item) === a.item ? -1 : 1));
    for (const entry of pool.slice(0, want.want)) {
      taken.add(entry.i);
      matched[idx].push(entry.item);
    }
  }

  const slots = kit.map((want, idx) => {
    const held = matched[idx];
    const have = held.length;
    const item = held.reduce((a, b) => betterOf(a, b), null);
    // Earmarked but still in a stockpile. A piece the soldier is already
    // carrying shows up in `worn` above, so only the uncollected ones are
    // news here.
    const waiting = asList(want.spec && want.spec.assigned_items)
      .filter((piece) => !piece.carried);
    const promise = waiting.reduce((a, b) => betterOf(a, b), null);
    // Something is on that body part, just not something this line of the
    // uniform accepts.
    const substitute = worn
      .filter((piece, i) => !taken.has(i) && piece.slot === want.slot)
      .reduce((a, b) => betterOf(a, b), null);

    let verdict = 'ok';
    let note = null;
    if (have >= want.want) {
      if (want.slot === 'weapon' || want.slot === 'quiver') {
        verdict = 'ok';
      } else if (want.demand === 'metal' && isLightArmour(item)) {
        verdict = 'light';
        note = `${describe(item)} — metal, but the open-faced kind`;
      } else if (want.demand === 'metal' && best && (item.grade || 0) < best.grade) {
        // Only armour is graded against the fort's best metal. A weapon
        // just has to be metal: a bronze war hammer is a blunt weapon
        // doing its job, and DF's shear figure says nothing about it.
        verdict = 'downgrade';
        note = `${describe(item)}, and the fort has ${best.material}`;
      }
    } else if (have + waiting.length >= want.want) {
      verdict = 'unclaimed';
      note = `${describe(promise)} earmarked for them, not collected`;
    } else if (have > 0) {
      verdict = 'partial';
      note = `only ${have} of ${want.want}, ${describe(item)}`;
    } else if (substitute) {
      const wrongKind = want.subtype && (substitute.subtype || '') !== want.subtype;
      verdict = wrongKind ? 'wrong' : 'soft';
      note = `wearing ${describe(substitute)} where the uniform asks for ${want.label}`;
    } else {
      verdict = 'missing';
      note = `no ${want.label}, and none earmarked`;
      if (want.want > 1) note = `none of the ${want.want} ${want.label}, and none earmarked`;
    }
    return {
      ...want, item, have, waiting: waiting.length, promise, verdict, note,
    };
  });

  const gaps = slots.filter((s) => s.verdict !== 'ok');
  const waitingSlots = gaps.filter((s) => s.verdict === 'unclaimed').length;
  const armourSlots = slots.filter((s) => s.slot !== 'weapon' && s.slot !== 'quiver');
  // The three questions the roll-ups ask, kept apart on purpose: does the
  // uniform want metal here, is metal on the soldier, and is metal waiting
  // for them in a pile. A squad that reads bare because it is off duty is
  // a different problem from one with nothing to wear.
  const metalWanted = armourSlots.filter((s) => s.demand === 'metal');
  const metalWorn = metalWanted.filter((s) => s.item && s.item.mat_class === 'metal');
  const metalWaiting = metalWanted.filter((s) => s.promise && s.promise.mat_class === 'metal');
  return {
    role,
    spec,
    kit,
    slots,
    gaps,
    // Slots holding what the uniform asked for, whatever that was.
    covered: armourSlots.filter((s) => s.have >= s.want).length,
    armourSlots: armourSlots.length,
    metalDemand: metalWanted.length,
    metalArmour: metalWorn.length,
    metalWaiting: metalWaiting.length,
    waitingSlots: waitingSlots,
    // Most of the kit is made, earmarked, and still in a pile. That is one
    // errand, and it is what an off-duty squad looks like — reporting it
    // slot by slot sends the player to the forge for armour that exists.
    kitUncollected: waitingSlots >= 2 && waitingSlots >= gaps.length / 2,
    // Worn out kit is a slow leak: DF will not replace it on its own.
    tattered: asList(position.equipment).filter((i) => (i.wear || 0) > 0),
    ammo: position.ammo || 0,
  };
}

/** Armor User rating, 0 if the soldier has never worn any. */
export function armorSkill(unit) {
  for (const skill of asList(unit && unit.skills)) {
    if (skill.key === 'ARMOR') return skill.rating || 0;
  }
  return 0;
}

/** Does the squad have a uniform at all? Without one DF issues nothing. */
export function hasUniform(squad) {
  return asList(squad.positions).some((p) => asList(p.uniform).length > 0);
}

/**
 * Is this squad on duty this month?
 *
 * `cur_routine_idx` picks the routine actually in force; a month with no
 * orders in it is a month off, and an off-duty dwarf takes their uniform
 * back off. Returns null when the schedule cannot be read, which the
 * callers treat as "do not claim either way".
 */
export function onDuty(squad, month) {
  if (month === undefined || month === null) return null;
  const routines = asList(squad.schedule);
  if (!routines.length) return null;
  const idx = squad.cur_routine_idx || 0;
  const routine = routines.find((r) => r.index === idx) || routines[idx];
  if (!routine) return null;
  const entry = asList(routine.months).find((m) => m.month === month);
  if (!entry) return null;
  return asList(entry.orders).length > 0;
}

/**
 * Every filled position in the fort, with its assessment attached.
 * `input.unitById` resolves squad members to their skills.
 */
export function roster(input) {
  const best = bestMetal(input);
  const out = [];
  for (const squad of asList(input.squads)) {
    const uniformed = hasUniform(squad);
    const duty = onDuty(squad, input.month);
    for (const position of asList(squad.positions)) {
      if (position.unit_id === undefined || position.unit_id === null) continue;
      const unit = input.unitById(position.unit_id);
      const role = roleOf(position, unit);
      out.push({
        squad,
        position,
        unit,
        uniformed,
        onDuty: duty,
        name: (unit && unit.label) || position.name || `unit ${position.unit_id}`,
        armorSkill: armorSkill(unit),
        ...assess(position, unit, role, best),
      });
    }
  }
  return out;
}

/** Slot severity, worst first: nothing at all beats a soft substitute. */
const GAP_SEVERITY = {
  missing: 'high',
  wrong: 'high',
  partial: 'medium',
  soft: 'medium',
  unclaimed: 'low',
  light: 'low',
  downgrade: 'low',
};

// How a shared gap reads when it is stated once for the whole squad,
// where a per-soldier note ("wearing a pig tail trousers") would name one
// dwarf's kit for everyone's problem.
// The headline for a shared gap. One phrasing per verdict, because
// "8 of 8 short a mail shirt" is false of a squad that is wearing iron
// mail and could be wearing steel.
const VERDICT_TITLE = {
  missing: (n, m, piece) => `${n} of ${m} have no ${piece}`,
  wrong: (n, m, piece) => `${n} of ${m} carry the wrong piece for the ${piece} slot`,
  soft: (n, m, piece) => `${n} of ${m} have something soft where the ${piece} goes`,
  partial: (n, m, piece) => `${n} of ${m} have half a set of ${piece}`,
  light: (n, m, piece) => `${n} of ${m} wear open-faced metal for the ${piece}`,
  downgrade: (n, m, piece) => `${n} of ${m} could upgrade their ${piece}`,
};

const VERDICT_DETAIL = {
  missing: 'Nothing in that slot and nothing earmarked for it, so the fort does not have one '
    + 'to give them.',
  wrong: 'They are carrying the wrong kind of piece for that line of the uniform.',
  soft: 'What they have on is softer than the uniform asks for.',
  partial: 'Half a pair each — DF found one and not the other.',
  light: 'Metal, but the open-faced kind: a cap where the uniform reads as a helm.',
  downgrade: 'Metal, but not the best metal the fort makes.',
  unclaimed: 'Earmarked for them and still in a stockpile.',
};

// A gap DF cannot close from what exists: these are the ones that mean a
// trip to the forge.
const FORGE_VERDICTS = new Set(['missing', 'wrong', 'soft', 'partial']);

// Head and body are the slots that decide whether a hit is survivable.
const VITAL_SLOTS = new Set(['head', 'body']);

// Soldiers with no metal on before the squad is called unarmoured as a
// whole rather than one name at a time.
export const BARE_SQUAD_MIN = 3;

/**
 * The shopping list: every gap in the fort, folded into one line per
 * piece, with what the armory can cover it from.
 *
 * `need` counts only the gaps that mean a piece has to be found or made.
 * A slot DF has already earmarked is counted under `waiting` instead —
 * that piece exists, and ordering another one would be waste.
 *
 * No-uniform squads are left out — their soldiers would swamp the list
 * with demand for kit that will never be issued. They get their own
 * finding instead.
 */
export function shoppingList(soldiers, input) {
  const best = bestMetal(input);
  const rows = new Map();
  for (const soldier of soldiers) {
    if (!soldier.uniformed) continue;
    for (const gap of soldier.gaps) {
      // Keyed by label as well as slot: both roles want a `weapon`, but a
      // crossbow and a battle axe are not the same order at the forge.
      const key = `${gap.slot} ${gap.label}`;
      let row = rows.get(key);
      if (!row) {
        row = {
          slot: gap.slot,
          label: gap.label,
          demand: gap.demand,
          need: 0,
          urgent: 0,
          waiting: 0,
          soldiers: 0,
          vital: VITAL_SLOTS.has(gap.slot),
          reasons: new Map(),
        };
        rows.set(key, row);
      }
      // A missing pair needs two; a half-empty one needs the difference;
      // an upgrade replaces what is already there.
      const short = gap.verdict === 'missing' || gap.verdict === 'partial'
        ? gap.want - gap.have
        : gap.want;
      if (gap.verdict === 'unclaimed') {
        // The piece exists and has this soldier's name on it. Ordering
        // another one is waste, so it is counted, not demanded.
        row.waiting += gap.waiting;
      } else {
        row.need += short;
        // An upgrade is worth doing; a bare slot is worth doing first.
        if (gap.verdict !== 'downgrade' && gap.verdict !== 'light') row.urgent += short;
        row.soldiers += 1;
      }
      row.reasons.set(gap.verdict, (row.reasons.get(gap.verdict) || 0) + 1);
    }
  }

  const stock = stockBySlot(input);
  const list = [...rows.values()]
    .filter((row) => row.need > 0 || row.waiting > 0)
    .map((row) => {
      const available = stock.get(row.slot) || { metal: 0, other: 0, groups: [] };
      // A line that asks for leather can be filled from leather; only a
      // line that asks for metal has to count metal alone.
      const onHand = row.demand === 'metal'
        ? available.metal
        : available.metal + available.other;
      return {
        ...row,
        reasons: [...row.reasons.entries()].map(([verdict, count]) => ({ verdict, count })),
        onHand,
        onHandGroups: available.groups,
        shortfall: Math.max(0, row.need - onHand),
        urgentShortfall: Math.max(0, row.urgent - onHand),
      };
    });
  // Lines with something to make come first; the waiting-only lines are
  // context, not work, and belong under them.
  list.sort((a, b) => (Number(b.need > 0) - Number(a.need > 0))
    || (b.vital - a.vital) || (b.urgent - a.urgent)
    || (b.need - a.need) || (b.waiting - a.waiting));
  return { rows: list, best, bars: asList(input.armory && input.armory.bars) };
}

/** Free armour in the fort, indexed by the slot it fills. */
export function stockBySlot(input) {
  const out = new Map();
  for (const group of asList(input.armory && input.armory.groups)) {
    if (!group.slot) continue;
    const usable = group.slot === 'weapon' || group.slot === 'quiver' || isArmour(group);
    if (!usable) continue;
    let entry = out.get(group.slot);
    if (!entry) {
      entry = { metal: 0, other: 0, groups: [] };
      out.set(group.slot, entry);
    }
    // `claimed` items belong to a civilian or are already in a job; they
    // are in the fort but not free to hand to a soldier.
    const free = Math.max(0, (group.count || 0) - (group.claimed || 0));
    if (group.mat_class === 'metal') entry.metal += free;
    else entry.other += free;
    if (free > 0) entry.groups.push({ ...group, free });
  }
  for (const entry of out.values()) {
    entry.groups.sort((a, b) => classRank(b) - classRank(a) || (b.grade || 0) - (a.grade || 0));
  }
  return out;
}

// An empty quiver is a different problem from a half-full one: one is a
// soldier who cannot shoot, the other is a soldier who will run out.
function ammoSeverity(bolts) {
  if (bolts === 0) return 'high';
  return bolts < AMMO_TARGET / 2 ? 'medium' : 'low';
}

/** "9 iron mail shirts, 9 steel helms", for the waiting roll-up. */
function summarisePromises(soldiers) {
  const tally = new Map();
  for (const soldier of soldiers) {
    for (const gap of soldier.gaps) {
      if (gap.verdict !== 'unclaimed' || !gap.promise) continue;
      const key = `${gap.promise.material} ${gap.promise.subtype}`;
      tally.set(key, (tally.get(key) || 0) + gap.waiting);
    }
  }
  const parts = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([key, count]) => `${count} ${key}${count === 1 ? '' : 's'}`);
  return parts.length ? parts.join(', ') : 'the pieces';
}

/**
 * Findings, worst first. Squad-level problems come before soldier-level
 * ones, because a squad with no uniform makes every gap inside it moot,
 * and a squad that has simply not collected its kit is one errand rather
 * than nine shortages.
 */
export function diagnose(input) {
  const soldiers = roster(input);
  const best = bestMetal(input);
  const findings = [];
  const add = (f) => findings.push(f);

  // --- squad level ---
  for (const squad of asList(input.squads)) {
    const members = soldiers.filter((s) => s.squad === squad);
    if (!members.length) continue;
    const name = squad.display_name || squad.name || `squad ${squad.id}`;
    if (!hasUniform(squad)) {
      add({
        rule: 'no-uniform',
        severity: 'high',
        squadId: squad.id,
        title: `${name} has no uniform`,
        detail: `${members.length} soldier${members.length === 1 ? '' : 's'} assigned, but no uniform is `
          + 'configured, so DF will never issue them anything. Set one before the gear matters. '
          + 'These soldiers are left out of the shopping list.',
      });
      continue;
    }
    const duty = members[0].onDuty;
    // The kit exists and DF has earmarked it; nobody has picked it up.
    // That is an errand or a scheduling fact, not a shortage, and saying
    // it slot by slot sends the player to the forge for armour that is
    // already sitting in a stockpile.
    const waiting = members.filter((s) => s.kitUncollected);
    if (waiting.length >= BARE_SQUAD_MIN && waiting.length >= members.length / 2) {
      add({
        rule: 'kit-waiting',
        severity: duty === false ? 'low' : 'medium',
        squadId: squad.id,
        title: `${name}: ${waiting.length} of ${members.length} have not collected their kit`,
        detail: 'The pieces their uniform asks for exist and DF has earmarked them — '
          + `${summarisePromises(waiting)} — but they are still in a stockpile. `
          + (duty === false
            ? 'This squad has no orders this month, so DF will not have them pick anything up '
              + 'until they are back on duty. Nothing to forge.'
            : 'Nothing to forge for these: the kit is made. Check they can reach the pile and '
              + 'that the squad is actually on duty.'),
        names: waiting.map((s) => s.name),
        // Only their uncollected slots are spoken for. Anything the fort
        // genuinely does not have for them still gets reported below.
        rolledWaiting: new Set(waiting.map((s) => s.position.unit_id)),
      });
    }
    // A whole squad in leather is one fact about the squad, not one
    // finding per soldier. Only the ones with nothing earmarked either:
    // the rest are covered by the waiting roll-up above.
    const bare = members.filter((s) => s.metalDemand > 0 && s.metalArmour === 0
      && s.metalWaiting === 0 && asList(s.position.equipment).length);
    if (bare.length >= BARE_SQUAD_MIN && bare.length >= members.length / 2) {
      add({
        rule: 'squad-unarmoured',
        severity: 'high',
        squadId: squad.id,
        title: `${name}: ${bare.length} of ${members.length} wearing no metal armour`,
        detail: 'Their uniform asks for metal, and every armour slot is leather, cloth or bone '
          + 'with none earmarked to replace it. Treat this as one job, not as individual gaps.',
        names: bare.map((s) => s.name),
        rolled: new Set(bare.map((s) => s.position.unit_id)),
      });
    }
    // Bolts are the same story as armour: five archers at twenty rounds
    // apiece is one restock order, not five findings. Soldiers who have
    // not collected their quiver are left out — their bolts are part of
    // the kit-waiting finding above.
    const archers = members.filter((s) => s.spec.ammo && !s.kitUncollected);
    const dry = archers.filter((s) => s.ammo < AMMO_TARGET);
    if (dry.length >= BARE_SQUAD_MIN) {
      const low = Math.min(...dry.map((s) => s.ammo));
      const high = Math.max(...dry.map((s) => s.ammo));
      add({
        rule: 'ammo',
        severity: ammoSeverity(low),
        squadId: squad.id,
        title: `${name}: ${dry.length} of ${archers.length} archers short of bolts`,
        detail: `${low === high ? `${low} bolts` : `${low}–${high} bolts`} each, against the `
          + `${AMMO_TARGET} DF's own uniform asks for. Bolts are consumed in training, so a `
          + 'squad that drills needs a standing order, not a one-off batch.',
        names: dry.map((s) => s.name),
        rolledAmmo: new Set(dry.map((s) => s.position.unit_id)),
      });
    }
    // One real gap shared across the squad is also one fact: eight archers
    // with no shield and none in the fort is a single order, not eight
    // findings. Grouped by the piece and the verdict, so "no shield at
    // all" never merges with "shield, but copper".
    const shared = new Map();
    const fullyRolled = new Set(bare.map((s) => s.position.unit_id));
    for (const soldier of members) {
      if (fullyRolled.has(soldier.position.unit_id)) continue;
      for (const gap of soldier.gaps) {
        if (gap.verdict === 'unclaimed') continue;
        const key = `${gap.label}\u0000${gap.verdict}`;
        let row = shared.get(key);
        if (!row) {
          row = { gap, members: [] };
          shared.set(key, row);
        }
        row.members.push(soldier);
      }
    }
    for (const row of shared.values()) {
      if (row.members.length < BARE_SQUAD_MIN) continue;
      const { gap } = row;
      const headline = VERDICT_TITLE[gap.verdict]
        || ((n, m, piece) => `${n} of ${m} are short a ${piece}`);
      add({
        rule: 'squad-gap',
        severity: GAP_SEVERITY[gap.verdict] || 'medium',
        squadId: squad.id,
        title: `${name}: ${headline(row.members.length, members.length, gap.label)}`,
        detail: `${VERDICT_DETAIL[gap.verdict] || gap.note} `
          + `Their uniform asks each of them for ${quantify(gap.label, gap.want)}.`,
        names: row.members.map((s) => s.name),
        // Folded, not silenced: these soldiers keep their other findings.
        rolledGaps: new Map(row.members.map((s) => [s.position.unit_id, [gap.label, gap.verdict]])),
      });
    }
  }
  // Squad-level roll-ups take three shapes, and they suppress different
  // things below. `rolled` is the whole soldier; `rolledWaiting` is only
  // their uncollected kit; `rolledGaps` is one slot verdict each.
  const rolled = new Set();
  const rolledWaiting = new Set();
  const rolledGaps = new Map();
  const rolledAmmo = new Set();
  for (const finding of findings) {
    if (finding.rolled) for (const id of finding.rolled) rolled.add(id);
    if (finding.rolledWaiting) for (const id of finding.rolledWaiting) rolledWaiting.add(id);
    if (finding.rolledAmmo) for (const id of finding.rolledAmmo) rolledAmmo.add(id);
    if (finding.rolledGaps) {
      for (const [id, key] of finding.rolledGaps) {
        if (!rolledGaps.has(id)) rolledGaps.set(id, new Set());
        rolledGaps.get(id).add(key.join('\u0000'));
      }
    }
  }

  // --- soldier level ---
  for (const soldier of soldiers) {
    if (!soldier.uniformed || rolled.has(soldier.position.unit_id)) continue;
    const where = `${soldier.squad.display_name || soldier.squad.name}`;
    const folded = rolledGaps.get(soldier.position.unit_id) || new Set();
    const real = soldier.gaps.filter((g) => g.verdict !== 'unclaimed'
      && !folded.has(`${g.label}\u0000${g.verdict}`));
    if (soldier.metalDemand > 0 && soldier.metalArmour === 0 && soldier.metalWaiting === 0
        && asList(soldier.position.equipment).length) {
      add({
        rule: 'no-metal',
        severity: 'high',
        squadId: soldier.squad.id,
        unitId: soldier.position.unit_id,
        title: `${soldier.name} has no metal armour`,
        detail: `${where}, ${soldier.spec.label}. Their uniform asks for metal on `
          + `${soldier.metalDemand} slot${soldier.metalDemand === 1 ? '' : 's'} and none of it is `
          + 'on them, worn or earmarked.',
      });
      continue;
    }
    const vital = real.filter((g) => VITAL_SLOTS.has(g.slot)
      && g.verdict !== 'downgrade' && g.verdict !== 'light');
    if (vital.length) {
      add({
        rule: 'vital-gap',
        severity: 'high',
        squadId: soldier.squad.id,
        unitId: soldier.position.unit_id,
        title: `${soldier.name}: ${vital.map((g) => g.label).join(' and ')} unprotected`,
        detail: `${where}, ${soldier.spec.label}. ${vital.map((g) => `${g.label} — ${g.note}`).join('; ')}.`,
      });
    }
    const rest = real.filter((g) => !vital.includes(g));
    if (rest.length) {
      const worst = rest.some((g) => GAP_SEVERITY[g.verdict] === 'medium') ? 'medium' : 'low';
      add({
        rule: 'kit-gap',
        severity: worst,
        squadId: soldier.squad.id,
        unitId: soldier.position.unit_id,
        title: `${soldier.name}: ${rest.length} slot${rest.length === 1 ? '' : 's'} below the standard`,
        detail: `${where}, ${soldier.spec.label}. ${rest.map((g) => `${g.label} — ${g.note}`).join('; ')}.`,
      });
    }
    const uncollected = rolledWaiting.has(soldier.position.unit_id)
      ? []
      : soldier.gaps.filter((g) => g.verdict === 'unclaimed');
    if (uncollected.length) {
      add({
        rule: 'kit-waiting',
        severity: 'low',
        squadId: soldier.squad.id,
        unitId: soldier.position.unit_id,
        title: `${soldier.name}: ${uncollected.length} piece${uncollected.length === 1 ? '' : 's'} earmarked, not collected`,
        detail: `${where}, ${soldier.spec.label}. `
          + `${uncollected.map((g) => `${g.label} — ${g.note}`).join('; ')}. `
          + 'Nothing to forge; the pieces exist.'
          + (soldier.onDuty === false ? ' The squad is off duty this month.' : ''),
      });
    }
    // Bolts live in the quiver, and a soldier who has not collected their
    // quiver has not collected their bolts either. That is the uncollected
    // kit again, not a separate ammunition shortage.
    if (soldier.spec.ammo && soldier.ammo < AMMO_TARGET && !soldier.kitUncollected
        && !rolledAmmo.has(soldier.position.unit_id)) {
      add({
        rule: 'ammo',
        severity: ammoSeverity(soldier.ammo),
        squadId: soldier.squad.id,
        unitId: soldier.position.unit_id,
        title: soldier.ammo === 0
          ? `${soldier.name} has no bolts`
          : `${soldier.name} has ${soldier.ammo} bolts`,
        detail: `${where}, crossbow. A quiver holds ${AMMO_TARGET} in DF's own uniform; `
          + `this one has ${soldier.ammo}.`,
      });
    }
    if (soldier.tattered.length) {
      add({
        rule: 'worn',
        severity: 'low',
        squadId: soldier.squad.id,
        unitId: soldier.position.unit_id,
        title: `${soldier.name}: ${soldier.tattered.length} worn piece${soldier.tattered.length === 1 ? '' : 's'}`,
        detail: soldier.tattered
          .map((i) => `${i.material} ${i.subtype} (wear ${i.wear})`).join(', ')
          + '. DF does not replace worn armour on its own.',
      });
    }
    if (soldier.armorSkill <= GREEN_ARMOR_SKILL && soldier.metalArmour > 0) {
      add({
        rule: 'green',
        severity: 'low',
        squadId: soldier.squad.id,
        unitId: soldier.position.unit_id,
        title: `${soldier.name} is green in armour`,
        detail: `Armor User ${soldier.armorSkill}. Full metal is still the right target, but it `
          + 'will slow them until they train out of it — schedule the drill, not a lighter kit.',
      });
    }
  }

  // --- fort level ---
  const stock = stockBySlot(input);
  let spareMetal = 0;
  for (const entry of stock.values()) spareMetal += entry.metal;
  const forgeable = soldiers.some((s) => s.gaps.some((g) => FORGE_VERDICTS.has(g.verdict)));
  if (!spareMetal && forgeable) {
    add({
      rule: 'bare-armory',
      severity: 'high',
      title: 'No spare metal armour anywhere in the fort',
      detail: best
        ? `Every gap below has to be forged. The best armour metal on hand is ${best.material}.`
        : 'Every gap below has to be forged, and no armour metal is on hand either.',
    });
  }

  findings.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]);
  return findings;
}

/** Headline numbers for the stat strip. */
export function summarise(input) {
  const soldiers = roster(input);
  const graded = soldiers.filter((s) => s.uniformed);
  const slots = graded.reduce((n, s) => n + s.armourSlots, 0);
  const covered = graded.reduce((n, s) => n + s.covered, 0);
  const metal = graded.reduce((n, s) => n + s.metalArmour, 0);
  // Archers who have their kit. One who has not collected their quiver has
  // no bolts either, and counting them as dry quivers puts an ammunition
  // shortage on the strip where there is only an uncollected kit.
  const archers = graded.filter((s) => s.spec.ammo && !s.kitUncollected);
  const archersWaiting = graded.filter((s) => s.spec.ammo && s.kitUncollected).length;
  return {
    soldiers: soldiers.length,
    graded: graded.length,
    unbriefed: soldiers.length - graded.length,
    slots,
    covered,
    metal,
    coverage: slots ? covered / slots : 0,
    fullyKitted: graded.filter((s) => !s.gaps.length).length,
    waiting: graded.filter((s) => s.waitingSlots > 0).length,
    archers: archers.length,
    archersDry: archers.filter((s) => s.ammo < AMMO_TARGET).length,
    archersWaiting,
    best: bestMetal(input),
    spare: [...stockBySlot(input).values()].reduce((n, e) => n + e.metal, 0),
  };
}
