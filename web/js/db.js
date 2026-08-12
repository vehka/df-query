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

// Display order for the category cards; anything unlisted is appended.
export const CATEGORY_ORDER = [
  'Combat', 'Woodworking', 'Stoneworking', 'Metalsmithing', 'Jewelry',
  'Crafts', 'Farming', 'Fishing', 'Hunting', 'Healthcare', 'Engineering',
  'Arts', 'Social', 'Personal', 'Hauling', 'Other',
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
  }

  #categoriseSkills() {
    this.categories = new Map();
    for (const skill of this.skills.values()) {
      const labor = skill.labor && skill.labor !== 'NONE' ? this.labors.get(skill.labor) : null;
      const fromLabor = labor && labor.category && labor.category !== 'None' ? labor.category : null;
      skill.category = fromLabor || CLASS_CATEGORY[skill.class] || 'Other';
      if (!this.categories.has(skill.category)) this.categories.set(skill.category, []);
      this.categories.get(skill.category).push(skill);
    }
    this.categoryNames = [...this.categories.keys()].sort((a, b) => {
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
    }
  }

  ratingName(rating) {
    const entry = this.ratings[rating];
    return entry ? entry.caption : `level ${rating}`;
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
