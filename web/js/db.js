// Turns a raw snapshot into the indexed shape the views want.

import { asList } from './util.js';

// DF groups skills two different ways: labour skills carry a `unit_labor`
// whose `category` is the grouping the Labors screen uses, and everything
// else (combat, social, arts, ...) only has a `job_skill_class`. Prefer the
// labour category, fall back to the class.
const CLASS_CATEGORY = {
  MilitaryWeapon: 'Combat',
  MilitaryUnarmed: 'Combat',
  MilitaryAttack: 'Combat',
  MilitaryDefense: 'Combat',
  MilitaryMisc: 'Combat',
  Social: 'Social',
  Cultural: 'Arts',
  Medical: 'Healthcare',
  Personal: 'Personal',
  Normal: 'Other',
};

// A handful of skills are class `Normal` with no labour attached, so neither
// signal places them. DF has no third grouping to read — the game's own UI
// hardcodes these too — so they are named here rather than dumped into
// "Other". Everything else is still derived from the snapshot's enum tables.
const SKILL_CATEGORY_OVERRIDES = {
  MINING: 'Mining',
  MILITARY_TACTICS: 'Combat',
  // Performing arts, alongside the Cultural (written) ones.
  DANCE: 'Arts',
  MAKE_MUSIC: 'Arts',
  SING_MUSIC: 'Arts',
  PLAY_KEYBOARD_INSTRUMENT: 'Arts',
  PLAY_STRINGED_INSTRUMENT: 'Arts',
  PLAY_WIND_INSTRUMENT: 'Arts',
  PLAY_PERCUSSION_INSTRUMENT: 'Arts',
  // The noble/bookkeeping skills.
  APPRAISAL: 'Administration',
  ORGANIZATION: 'Administration',
  RECORD_KEEPING: 'Administration',
  // Library research.
  CRITICAL_THINKING: 'Scholarship',
  LOGIC: 'Scholarship',
  MATHEMATICS: 'Scholarship',
  ASTRONOMY: 'Scholarship',
  CHEMISTRY: 'Scholarship',
  GEOGRAPHY: 'Scholarship',
  OPTICS_ENGINEER: 'Scholarship',
  FLUID_ENGINEER: 'Scholarship',
};

// Display order for the category cards; anything unlisted is appended.
export const CATEGORY_ORDER = [
  'Combat', 'Mining', 'Woodworking', 'Stoneworking', 'Metalsmithing',
  'Jewelry', 'Crafts', 'Farming', 'Fishing', 'Hunting', 'Healthcare',
  'Engineering', 'Arts', 'Scholarship', 'Administration', 'Social',
  'Personal', 'Hauling', 'Other',
];

export class Db {
  constructor(snapshot) {
    this.raw = snapshot;
    this.meta = snapshot.meta || {};

    this.units = asList(snapshot.units);
    this.animals = asList(snapshot.animals);
    this.stockpiles = asList(snapshot.stockpiles);
    this.workshops = asList(snapshot.workshops);
    this.links = asList(snapshot.links);
    this.zones = asList(snapshot.zones);
    this.squads = asList(snapshot.squads);
    this.workDetails = asList(snapshot.work_details);
    this.idleHistory = snapshot.idle_history || {};

    const enums = snapshot.enums || {};
    this.labors = new Map(asList(enums.unit_labor).map((l) => [l.key, l]));
    this.skills = new Map(asList(enums.job_skill).map((s) => [s.key, s]));
    this.ratings = asList(enums.skill_rating);

    this.#categoriseSkills();
    this.#index();
    this.#annotateUnits();
    this.#orderCategories();
  }

  #categoriseSkills() {
    this.categories = new Map();
    for (const skill of this.skills.values()) {
      const labor = skill.labor && skill.labor !== 'NONE' ? this.labors.get(skill.labor) : null;
      const fromLabor = labor && labor.category && labor.category !== 'None' ? labor.category : null;
      skill.category = SKILL_CATEGORY_OVERRIDES[skill.key]
        || fromLabor
        || CLASS_CATEGORY[skill.class]
        || 'Other';
      if (!this.categories.has(skill.category)) this.categories.set(skill.category, []);
      this.categories.get(skill.category).push(skill);
    }
  }

  /** Order categories for display, dropping any nobody in this fort has. */
  #orderCategories() {
    const present = new Set();
    for (const unit of this.units) {
      for (const category of unit.best.keys()) present.add(category);
    }
    this.categoryNames = [...present].sort((a, b) => {
      const ai = CATEGORY_ORDER.indexOf(a);
      const bi = CATEGORY_ORDER.indexOf(b);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.localeCompare(b);
    });
  }

  #index() {
    this.unitById = new Map(this.units.map((u) => [u.id, u]));
    this.zoneById = new Map(this.zones.map((z) => [z.id, z]));
    this.squadById = new Map(this.squads.map((s) => [s.id, s]));
    this.nodeById = new Map([
      ...this.stockpiles.map((s) => [s.id, { ...s, node: 'stockpile' }]),
      ...this.workshops.map((w) => [w.id, { ...w, node: 'workshop' }]),
    ]);
    // DF's stockpile category set, taken from whichever pile accepts the
    // most — used to collapse "accepts everything" piles in the table.
    this.stockpileCategoryCount = Math.max(
      1, ...this.stockpiles.map((s) => asList(s.categories).length));
    this.waves = [...new Set(this.units.map((u) => u.wave && u.wave.label).filter(Boolean))]
      .sort((a, b) => {
        const ua = this.units.find((u) => u.wave && u.wave.label === a);
        const ub = this.units.find((u) => u.wave && u.wave.label === b);
        return ua.wave.key - ub.wave.key;
      });
  }

  #annotateUnits() {
    for (const unit of this.units) {
      unit.skills = asList(unit.skills);
      unit.labors = asList(unit.labors);
      unit.work_details = asList(unit.work_details);
      unit.nobles = asList(unit.nobles);

      // Best skill per category, used by both the highlights and the roster.
      unit.best = new Map();
      for (const entry of unit.skills) {
        const def = this.skills.get(entry.key);
        if (!def || entry.rating <= 0) continue;
        const current = unit.best.get(def.category);
        if (!current || entry.rating > current.rating) {
          unit.best.set(def.category, { ...entry, def });
        }
      }
      unit.topSkills = unit.skills
        .filter((s) => s.rating > 0 && this.skills.has(s.key))
        .sort((a, b) => b.rating - a.rating)
        .slice(0, 3)
        .map((s) => ({ ...s, def: this.skills.get(s.key) }));

      const samples = this.idleHistory[String(unit.id)] || [];
      unit.idleSamples = samples.length;
      unit.idleRate = samples.length
        ? samples.reduce((a, b) => a + b, 0) / samples.length
        : (unit.idle ? 1 : 0);

      unit.squad = unit.squad_id !== undefined && unit.squad_id !== null
        ? this.squadById.get(unit.squad_id)
        : null;

      // Compact label for cards and rosters, where the full readable name
      // (nickname + profession) would be truncated to uselessness.
      unit.label = unit.nickname || unit.short_name || unit.name;
    }
  }

  ratingName(rating) {
    const entry = this.ratings[rating];
    if (entry) return entry.caption;
    // DF's enum stops at Legendary+5, but skills keep climbing past it.
    return rating > 15 ? `Legendary+${rating - 15}` : `level ${rating}`;
  }

  /** Skill entries for a unit, grouped into the display categories. */
  skillsByCategory(unit) {
    const grouped = new Map();
    for (const entry of unit.skills) {
      const def = this.skills.get(entry.key);
      if (!def || entry.rating <= 0) continue;
      if (!grouped.has(def.category)) grouped.set(def.category, []);
      grouped.get(def.category).push({ ...entry, def });
    }
    for (const list of grouped.values()) list.sort((a, b) => b.rating - a.rating);
    return grouped;
  }
}
