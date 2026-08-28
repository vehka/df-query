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
    this.visitors = asList(snapshot.visitors);
    this.idleHistory = snapshot.idle_history || {};

    // Absent from snapshots taken before the flow dumper landed; the views
    // check `hasFlow` rather than guessing from empty lists.
    this.flow = snapshot.flow || null;
    this.armory = snapshot.armory || null;
    this.instruments = snapshot.instruments || null;
    this.hasArmory = Boolean(this.armory && Array.isArray(this.armory.groups));
    this.hasFlow = Boolean(this.flow && this.flow.loose);
    this.hasVisitors = Array.isArray(snapshot.visitors);
    this.hasInstruments = Boolean(this.instruments
      && Array.isArray(this.instruments.types));

    // DF shows elevations, not raw z indices: z175 is "Elevation 46" on the
    // game's own z-axis widget. Snapshots taken before the dumper learned
    // the offset have no way back to that number, so they keep saying z175.
    this.elevOffset = typeof this.meta.elev_offset === 'number'
      ? this.meta.elev_offset
      : null;
    this.elevCaption = this.elevOffset === null ? 'z' : 'elev';

    const enums = snapshot.enums || {};
    this.labors = new Map(asList(enums.unit_labor).map((l) => [l.key, l]));
    this.skills = new Map(asList(enums.job_skill).map((s) => [s.key, s]));
    this.ratings = asList(enums.skill_rating);
    this.itemTypes = new Map(asList(enums.item_type).map((i) => [i.key, i]));
    this.qualities = new Map(asList(enums.item_quality).map((q) => [q.id, q]));
    // Two enums, because DF reads a building's subtype against a different
    // one per class — the same trap the workshop dumper has to dodge.
    this.buildingCaptions = new Map([
      ...asList(enums.workshop_type).map((w) => [`Workshop:${w.key}`, w.caption]),
      ...asList(enums.furnace_type).map((f) => [`Furnace:${f.key}`, f.caption]),
    ]);

    this.#categoriseSkills();
    this.#index();
    this.#annotateUnits();
    this.#orderCategories();
    this.#rankFort();
    this.#rankSkills();
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

    // DF hangs a profession off most skills (`job_skill.profession`), which
    // is what lets "a Maceman is judged on Combat" be read out of the
    // snapshot rather than typed into a view. Visiting professions —
    // scholar, mercenary, monster slayer — carry no skill, and the
    // visitors module names those itself.
    this.professionCategory = new Map();
    for (const skill of this.skills.values()) {
      const profession = skill.profession;
      if (!profession || profession === 'NONE') continue;
      if (!this.professionCategory.has(profession)) {
        this.professionCategory.set(profession, skill.category);
      }
    }
  }

  /**
   * The fort's own ceiling in each skill category — the best rating any
   * citizen has. A visitor who beats it is the only kind whose arrival
   * moves what the fort can do, rather than just how fast.
   */
  #rankFort() {
    this.fortBest = new Map();
    for (const unit of this.units) {
      for (const [category, entry] of unit.best) {
        const current = this.fortBest.get(category);
        if (!current || entry.rating > current.rating) {
          this.fortBest.set(category, { rating: entry.rating, name: unit.label });
        }
      }
    }
  }

  /**
   * The best citizen at each individual skill. `fortBest` answers the same
   * question per *category*, which is the right grain for judging a
   * visitor; a recipe asks about one skill exactly — who would actually
   * take this job, and how good are they.
   */
  #rankSkills() {
    this.bestBySkill = new Map();
    for (const unit of this.units) {
      for (const entry of unit.skills) {
        if (!entry.rating || entry.rating <= 0) continue;
        const current = this.bestBySkill.get(entry.key);
        if (!current || entry.rating > current.rating) {
          this.bestBySkill.set(entry.key, {
            rating: entry.rating,
            name: unit.label,
            id: unit.id,
          });
        }
      }
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
    this.nodes = [...this.nodeById.values()];
    // Adjacency, so a view never has to scan every link per row.
    this.inboundById = new Map();
    this.outboundById = new Map();
    for (const link of this.links) {
      if (!this.outboundById.has(link.from)) this.outboundById.set(link.from, []);
      if (!this.inboundById.has(link.to)) this.inboundById.set(link.to, []);
      this.outboundById.get(link.from).push(link);
      this.inboundById.get(link.to).push(link);
    }
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

  /** Feed links touching a node, split by direction. */
  linksOf(id) {
    return {
      inbound: this.inboundById.get(id) || [],
      outbound: this.outboundById.get(id) || [],
    };
  }

  /** DF's own caption for an item quality — "Masterful", not 5. */
  qualityCaption(level) {
    const entry = this.qualities.get(level);
    return entry ? entry.caption : null;
  }

  /** DF's own word for an item type — "stones", not BOULDER. */
  itemCaption(key) {
    const entry = this.itemTypes.get(key);
    return (entry && entry.caption) || String(key || '').toLowerCase();
  }

  /** Everything `armory.js` needs, assembled once. */
  armoryInput() {
    return {
      squads: this.squads,
      armory: this.armory,
      // The schedule months are 0-based; `meta.month` counts from 1. The
      // current month decides whether a squad is on duty, which is the
      // difference between "has not collected its kit" and "will not".
      month: this.meta && this.meta.month ? this.meta.month - 1 : null,
      unitById: (id) => this.unitById.get(id),
    };
  }

  /** Everything `visitors.js` needs, assembled once. */
  visitorInput() {
    return {
      visitors: this.visitors,
      categoryOf: (key) => {
        const skill = this.skills.get(key);
        return skill ? skill.category : null;
      },
      categoryOfProfession: (key) => this.professionCategory.get(key) || null,
      captionOf: (key) => {
        const skill = this.skills.get(key);
        return (skill && (skill.caption_noun || skill.caption)) || String(key || '').toLowerCase();
      },
      // The bar a guest has to clear to be the best in the fort at
      // something. -1 for a category no citizen has, so anyone clears it.
      fortBest: (category) => {
        const entry = category && this.fortBest.get(category);
        return entry ? entry.rating : -1;
      },
      fortHolder: (category) => {
        const entry = category && this.fortBest.get(category);
        return entry ? entry.name : null;
      },
      ratingName: (rating) => this.ratingName(rating),
    };
  }

  /** Everything `instruments.js` needs, assembled once. */
  instrumentInput() {
    return {
      types: asList(this.instruments && this.instruments.types),
      foreign: asList(this.instruments && this.instruments.foreign),
      workshops: this.workshops,
      // Who in the fort would take this job. Null when nobody has the
      // skill at all, which is not the same as nobody being able to do
      // it — DF gates work on the labour, not the rating.
      skillHolder: (key) => this.bestBySkill.get(key) || null,
    };
  }

  /** DF's own name for a workshop — "Craftsdwarf's Workshop", not the key. */
  buildingCaption(kind, subtype) {
    return this.buildingCaptions.get(`${kind}:${subtype}`) || subtype || kind || '';
  }

  /** Everything `flow.js` needs, assembled once. */
  flowInput(zPenalty) {
    return {
      stockpiles: this.stockpiles,
      workshops: this.workshops,
      loose: this.flow ? this.flow.loose : null,
      hauling: asList(this.flow && this.flow.hauling),
      storeJobs: this.flow ? this.flow.store_jobs : null,
      inboundOf: (id) => this.inboundById.get(id) || [],
      captionOf: (key) => this.itemCaption(key),
      elevOf: (z) => this.elevLabel(z),
      zPenalty,
    };
  }

  /** The number DF prints for a raw z index, or null for old snapshots. */
  elevation(z) {
    return this.elevOffset === null ? null : z + this.elevOffset;
  }

  /** Bare figure, for axes and chips whose caption already says which. */
  elevShort(z) {
    const e = this.elevation(z);
    return String(e === null ? z : e);
  }

  /** Standalone label, for prose and coordinate readouts. */
  elevLabel(z) {
    const e = this.elevation(z);
    return e === null ? `z${z}` : `elev ${e}`;
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
