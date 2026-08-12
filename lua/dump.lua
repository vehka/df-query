-- df-query snapshot dumper
--
-- Runs inside a live DFHack instance and writes a JSON snapshot of the
-- fortress to a path given by the caller. Read-only: it never touches game
-- state.
--
-- Invoked from outside as:
--   dfhack-run lua "dofile([[/path/to/lua/dump.lua]])([[/path/to/out.json]])"
--
-- The long-bracket strings keep the shell out of the quoting business.

local TICKS_PER_DAY = 1200
local TICKS_PER_MONTH = 28 * TICKS_PER_DAY
local TICKS_PER_SEASON = 3 * TICKS_PER_MONTH

local SEASONS = {'spring', 'summer', 'autumn', 'winter'}
local MONTHS = {
    'Granite', 'Slate', 'Felsite', 'Hematite', 'Malachite', 'Galena',
    'Limestone', 'Sandstone', 'Timber', 'Moonstone', 'Opal', 'Obsidian',
}

--------------------------------------------------------------------------
-- JSON encoding
--
-- Hand-rolled rather than json.lua's, so that empty arrays stay arrays
-- (json.lua cannot tell `{}` from `[]`) and so DF's CP437 strings are
-- converted exactly once, here at the boundary.
--------------------------------------------------------------------------

local ARRAY_MT = {}

--- Mark a table as a JSON array (so an empty one still encodes as `[]`).
local function A(t)
    return setmetatable(t or {}, ARRAY_MT)
end

local ESCAPES = {
    ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f',
    ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t',
}

local function escape_char(c)
    return ESCAPES[c] or string.format('\\u%04x', c:byte())
end

local function encode_string(s, out)
    -- `%c` covers the control characters JSON must escape; UTF-8 continuation
    -- bytes are all >= 0x80 and pass through untouched.
    out[#out + 1] = '"' .. s:gsub('[%c"\\]', escape_char) .. '"'
end

local function encode_number(v, out)
    if v ~= v or v == math.huge or v == -math.huge then
        out[#out + 1] = 'null'
    elseif v == math.floor(v) and math.abs(v) < 2 ^ 53 then
        out[#out + 1] = string.format('%d', v)
    else
        out[#out + 1] = string.format('%.4f', v)
    end
end

local encode

local function encode_table(v, out)
    if getmetatable(v) == ARRAY_MT then
        out[#out + 1] = '['
        for i = 1, #v do
            if i > 1 then out[#out + 1] = ',' end
            encode(v[i], out)
        end
        out[#out + 1] = ']'
    else
        out[#out + 1] = '{'
        local first = true
        for k, val in pairs(v) do
            if not first then out[#out + 1] = ',' end
            first = false
            encode_string(tostring(k), out)
            out[#out + 1] = ':'
            encode(val, out)
        end
        out[#out + 1] = '}'
    end
end

encode = function(v, out)
    local t = type(v)
    if v == nil then
        out[#out + 1] = 'null'
    elseif t == 'boolean' then
        out[#out + 1] = v and 'true' or 'false'
    elseif t == 'number' then
        encode_number(v, out)
    elseif t == 'string' then
        encode_string(v, out)
    elseif t == 'table' then
        encode_table(v, out)
    else
        encode_string(tostring(v), out)
    end
    return out
end

--------------------------------------------------------------------------
-- Small helpers
--------------------------------------------------------------------------

--- CP437 -> UTF-8. Every DF-sourced string goes through this.
local function u(s)
    if s == nil then return '' end
    local ok, converted = pcall(dfhack.df2utf, tostring(s))
    return ok and converted or tostring(s)
end

--- Run `fn`, returning `fallback` if it raises. DF structs shift between
--- versions; a missing field should cost one value, not the whole snapshot.
local function try(fn, fallback)
    local ok, result = pcall(fn)
    if ok then return result end
    return fallback
end

local function name_of(name_struct, in_english)
    return try(function()
        return u(dfhack.translation.translateName(name_struct, in_english ~= false))
    end, '')
end

--- Collect a bitfield's set flags as a list of names.
local function set_flags(bitfield)
    local out = A{}
    if not bitfield then return out end
    pcall(function()
        for key, value in pairs(bitfield) do
            if value == true then out[#out + 1] = key end
        end
    end)
    return out
end

local function enum_name(enum, value)
    if value == nil then return nil end
    local name = try(function() return enum[value] end)
    if type(name) == 'string' then return name end
    return tostring(value)
end

local function season_of(ticks)
    return SEASONS[ticks // TICKS_PER_SEASON + 1] or 'spring'
end

--------------------------------------------------------------------------
-- Enum tables
--
-- Shipped with the snapshot so the web UI never has to hardcode DF's
-- skill/labor taxonomy — it reads whatever this build of DF actually has.
--------------------------------------------------------------------------

local function dump_enums()
    local skills = A{}
    for i = 0, df.job_skill._last_item do
        local key = df.job_skill[i]
        if key then
            local attrs = df.job_skill.attrs[i]
            skills[#skills + 1] = {
                id = i,
                key = key,
                caption = u(attrs.caption),
                caption_noun = u(attrs.caption_noun),
                labor = enum_name(df.unit_labor, attrs.labor),
                profession = enum_name(df.profession, attrs.profession),
                class = enum_name(df.job_skill_class, attrs.type),
            }
        end
    end

    local labors = A{}
    for i = 0, df.unit_labor._last_item do
        local key = df.unit_labor[i]
        if key then
            local attrs = df.unit_labor.attrs[i]
            labors[#labors + 1] = {
                id = i,
                key = key,
                caption = u(attrs.caption),
                category = enum_name(df.unit_labor_category, attrs.category),
            }
        end
    end

    local ratings = A{}
    for i = 0, df.skill_rating._last_item do
        if df.skill_rating[i] then
            ratings[#ratings + 1] = {
                rating = i,
                caption = u(df.skill_rating.attrs[i].caption),
                xp_threshold = df.skill_rating.attrs[i].xp_threshold,
            }
        end
    end

    return {job_skill = skills, unit_labor = labors, skill_rating = ratings}
end

--------------------------------------------------------------------------
-- Migration waves
--
-- Ported from hack/scripts/list-waves.lua, at season granularity: group
-- CHANGE_HF_STATE/settler events (plus residency agreements, i.e.
-- petitioners) by the season they landed in.
--------------------------------------------------------------------------

local function is_pet_caste(hf)
    return dfhack.units.casteFlagSet(hf.race, hf.caste, df.caste_raw_flags.PET)
        or dfhack.units.casteFlagSet(hf.race, hf.caste, df.caste_raw_flags.PET_EXOTIC)
end

local function build_wave_map()
    local plotinfo = df.global.plotinfo
    local waves = {}

    local function record(hfid, ev, petitioned)
        local hf = df.historical_figure.find(hfid)
        if not hf or is_pet_caste(hf) then return end
        if not waves[hfid] then
            waves[hfid] = {year = ev.year, seconds = ev.seconds, petitioned = false}
        end
        if petitioned then waves[hfid].petitioned = true end
    end

    local function record_agreement(ev)
        local agreement = df.agreement.find(ev.agreement_id)
        if not agreement then return end
        local residency = false
        for _, details in ipairs(agreement.details) do
            if details.type == df.agreement_details_type.Residency
                and details.data.Residency.site == plotinfo.site_id then
                residency = true
                break
            end
        end
        if not residency then return end
        if #agreement.parties ~= 2 or #agreement.parties[1].entity_ids ~= 1 then return end
        if agreement.parties[1].entity_ids[0] ~= plotinfo.group_id then return end
        for _, hfid in ipairs(agreement.parties[0].histfig_ids) do
            record(hfid, ev, true)
        end
    end

    for _, ev in ipairs(df.global.world.history.events) do
        local evtype = ev:getType()
        if evtype == df.history_event_type.CHANGE_HF_STATE then
            if ev.site == plotinfo.site_id and ev.state == df.whereabouts_type.settler then
                record(ev.hfid, ev, false)
            end
        elseif evtype == df.history_event_type.AGREEMENT_FORMED then
            pcall(record_agreement, ev)
        end
    end

    -- Key each histfig by unit id, and pre-render the wave label.
    local by_unit = {}
    for hfid, data in pairs(waves) do
        local hf = df.historical_figure.find(hfid)
        if hf and hf.unit_id and hf.unit_id >= 0 then
            local season = season_of(data.seconds)
            by_unit[hf.unit_id] = {
                key = data.year * 4 + data.seconds // TICKS_PER_SEASON,
                year = data.year,
                season = season,
                label = ('%s %d'):format(season, data.year),
                petitioned = data.petitioned,
            }
        end
    end
    return by_unit
end

--------------------------------------------------------------------------
-- Units
--------------------------------------------------------------------------

local function job_name(job)
    if not job then return nil end
    local name = try(function() return dfhack.job.getName(job) end)
    if name then return u(name) end
    return try(function()
        return u(df.job_type.attrs[job.job_type].caption)
    end, enum_name(df.job_type, job.job_type))
end

local function unit_skills(unit)
    local out = A{}
    local soul = unit.status.current_soul
    if not soul then return out end
    for _, sk in ipairs(soul.skills) do
        local key = df.job_skill[sk.id]
        if key then
            out[#out + 1] = {
                key = key,
                rating = sk.rating,
                experience = sk.experience,
                rusty = sk.rusty,
                natural = sk.natural_skill_lvl,
            }
        end
    end
    return out
end

local function unit_labors(unit)
    local out = A{}
    for i = 0, df.unit_labor._last_item do
        local key = df.unit_labor[i]
        if key and unit.status.labors[i] then out[#out + 1] = key end
    end
    return out
end

local function noble_positions(unit)
    local out = A{}
    local positions = try(function() return dfhack.units.getNoblePositions(unit) end)
    if not positions then return out end
    for _, np in ipairs(positions) do
        local caption = np.position.name[0]
        if caption == '' then caption = np.position.code end
        out[#out + 1] = u(caption)
    end
    return out
end

local function dump_units(waves, work_detail_lookup)
    local out = A{}
    local citizens = try(function() return dfhack.units.getCitizens(false, true) end, {})
    for _, unit in ipairs(citizens) do
        local job = unit.job.current_job
        local soul = unit.status.current_soul
        local record = {
            id = unit.id,
            name = u(dfhack.units.getReadableName(unit)),
            nickname = u(unit.name.nickname),
            profession = u(try(function() return dfhack.units.getProfessionName(unit) end, '')),
            race = u(try(function() return dfhack.units.getRaceReadableName(unit) end, '')),
            sex = unit.sex == 1 and 'male' or (unit.sex == 0 and 'female' or 'other'),
            age = try(function() return dfhack.units.getAge(unit) end, 0),
            is_child = try(function() return dfhack.units.isChild(unit) end, false),
            is_baby = try(function() return dfhack.units.isBaby(unit) end, false),
            is_visitor = try(function() return dfhack.units.isVisiting(unit) end, false),
            stress = soul and soul.personality.stress or 0,
            stress_category = try(function() return dfhack.units.getStressCategory(unit) end, 3),
            pos = {x = unit.pos.x, y = unit.pos.y, z = unit.pos.z},
            job = job and {
                type = enum_name(df.job_type, job.job_type),
                name = job_name(job),
            } or nil,
            -- Two complementary idleness signals: no assigned job right now,
            -- and DF itself considering the unit available to pick one up.
            idle = job == nil,
            seeking_job = try(function() return dfhack.units.isJobAvailable(unit, true) end, false),
            on_break = try(function()
                return dfhack.units.getMiscTrait(unit, df.misc_trait_type.OnBreak) ~= nil
            end, false),
            labors = unit_labors(unit),
            work_details = work_detail_lookup[unit.id] or A{},
            skills = unit_skills(unit),
            nobles = noble_positions(unit),
            squad_id = unit.military.squad_id >= 0 and unit.military.squad_id or nil,
            squad_position = unit.military.squad_position >= 0 and unit.military.squad_position or nil,
            wave = waves[unit.id],
        }
        out[#out + 1] = record
    end
    return out
end

--------------------------------------------------------------------------
-- Work details
--------------------------------------------------------------------------

local function dump_work_details()
    local out = A{}
    local lookup = {}
    local details = try(function() return df.global.plotinfo.labor_info.work_details end, {})
    for i, wd in ipairs(details) do
        local labors = A{}
        for labor = 0, df.unit_labor._last_item do
            local key = df.unit_labor[labor]
            if key and try(function() return wd.allowed_labors[labor] end, false) then
                labors[#labors + 1] = key
            end
        end
        local assigned = A{}
        for _, uid in ipairs(wd.assigned_units) do
            assigned[#assigned + 1] = uid
            lookup[uid] = lookup[uid] or A{}
            lookup[uid][#lookup[uid] + 1] = u(wd.name)
        end
        out[#out + 1] = {
            index = i,
            name = u(wd.name),
            mode = enum_name(df.work_detail_mode, try(function() return wd.flags.mode end, 0)),
            icon = enum_name(df.work_detail_icon_type, wd.icon),
            labors = labors,
            assigned_units = assigned,
        }
    end
    return out, lookup
end

--------------------------------------------------------------------------
-- Stockpiles, workshops, and the links between them
--------------------------------------------------------------------------

local function building_name(bld, fallback)
    local name = try(function() return u(dfhack.buildings.getName(bld)) end)
    if name and name ~= '' then return name end
    return fallback
end

local function stockpile_contents(sp)
    local by_type, total = {}, 0
    local items = try(function() return dfhack.buildings.getStockpileContents(sp) end, {})
    for _, item in ipairs(items) do
        local key = enum_name(df.item_type, item:getType()) or 'UNKNOWN'
        by_type[key] = (by_type[key] or 0) + 1
        total = total + 1
    end
    return by_type, total
end

local function dump_stockpiles()
    local out = A{}
    for _, sp in ipairs(df.global.world.buildings.other.STOCKPILE) do
        local by_type, total = stockpile_contents(sp)
        local width = sp.x2 - sp.x1 + 1
        local height = sp.y2 - sp.y1 + 1
        out[#out + 1] = {
            id = sp.id,
            number = sp.stockpile_number,
            name = building_name(sp, ('Stockpile %d'):format(sp.stockpile_number)),
            custom_name = u(sp.name),
            x1 = sp.x1, y1 = sp.y1, x2 = sp.x2, y2 = sp.y2, z = sp.z,
            area = width * height,
            categories = set_flags(sp.settings.flags),
            flags = set_flags(sp.stockpile_flag),
            item_count = total,
            items_by_type = by_type,
        }
    end
    return out
end

-- Building types worth showing as production nodes in the flow graph.
local GRAPH_BUILDING_TYPES = {
    Workshop = true, Furnace = true, TradeDepot = true, FarmPlot = true,
}

local function dump_workshops()
    local out = A{}
    for _, bld in ipairs(df.global.world.buildings.all) do
        local btype = enum_name(df.building_type, bld:getType())
        if GRAPH_BUILDING_TYPES[btype] then
            local jobs = A{}
            for _, job in ipairs(bld.jobs) do
                jobs[#jobs + 1] = job_name(job)
            end
            local workers = A{}
            for _, uid in ipairs(try(function() return bld.profile.permitted_workers end, {})) do
                workers[#workers + 1] = uid
            end
            out[#out + 1] = {
                id = bld.id,
                kind = btype,
                -- `bld.type` is a different enum per building class.
                subtype = enum_name(
                    btype == 'Furnace' and df.furnace_type or df.workshop_type,
                    try(function() return bld.type end)),
                name = building_name(bld, btype),
                custom_name = u(bld.name),
                x1 = bld.x1, y1 = bld.y1, x2 = bld.x2, y2 = bld.y2, z = bld.z,
                jobs = jobs,
                permitted_workers = workers,
            }
        end
    end
    return out
end

--- Both stockpiles and workshops record their links, and DF keeps the two
--- sides in sync, so we normalise everything to material-flow direction
--- (source -> destination) and drop duplicates.
local function dump_links()
    local seen, out = {}, A{}

    local function add(from_id, to_id)
        if not from_id or not to_id then return end
        local key = from_id .. '>' .. to_id
        if seen[key] then return end
        seen[key] = true
        out[#out + 1] = {from = from_id, to = to_id}
    end

    local function walk(links, self_id)
        if not links then return end
        for _, other in ipairs(links.give_to_pile) do add(self_id, other.id) end
        for _, other in ipairs(links.give_to_workshop) do add(self_id, other.id) end
        for _, other in ipairs(links.take_from_pile) do add(other.id, self_id) end
        for _, other in ipairs(links.take_from_workshop) do add(other.id, self_id) end
    end

    for _, sp in ipairs(df.global.world.buildings.other.STOCKPILE) do
        pcall(walk, sp.links, sp.id)
    end
    for _, bld in ipairs(df.global.world.buildings.all) do
        if GRAPH_BUILDING_TYPES[enum_name(df.building_type, bld:getType())] then
            pcall(function() walk(bld.profile.links, bld.id) end)
        end
    end
    return out
end

--------------------------------------------------------------------------
-- Zones and animals
--------------------------------------------------------------------------

local function dump_zones()
    local out = A{}
    local zone_of_unit = {}
    for _, zone in ipairs(df.global.world.buildings.other.ACTIVITY_ZONE) do
        local assigned = A{}
        for _, uid in ipairs(zone.assigned_units) do
            assigned[#assigned + 1] = uid
            zone_of_unit[uid] = zone.id
        end
        local width = zone.x2 - zone.x1 + 1
        local height = zone.y2 - zone.y1 + 1
        out[#out + 1] = {
            id = zone.id,
            number = zone.zone_num,
            name = u(zone.name),
            type = enum_name(df.civzone_type, zone.type),
            active = try(function() return zone.spec_sub_flag.active end, false),
            x1 = zone.x1, y1 = zone.y1, x2 = zone.x2, y2 = zone.y2, z = zone.z,
            area = width * height,
            assigned_units = assigned,
        }
    end
    return out, zone_of_unit
end

local function dump_animals(zone_of_unit)
    local out = A{}
    local civ_id = df.global.plotinfo.civ_id
    for _, unit in ipairs(df.global.world.units.active) do
        local is_ours = unit.civ_id == civ_id
            and try(function() return dfhack.units.isAnimal(unit) end, false)
            and try(function() return dfhack.units.isAlive(unit) end, false)
        if is_ours then
            out[#out + 1] = {
                id = unit.id,
                name = u(dfhack.units.getReadableName(unit)),
                nickname = u(unit.name.nickname),
                race = u(try(function() return dfhack.units.getRaceReadableName(unit) end, '')),
                sex = unit.sex == 1 and 'male' or (unit.sex == 0 and 'female' or 'other'),
                age = try(function() return dfhack.units.getAge(unit) end, 0),
                pos = {x = unit.pos.x, y = unit.pos.y, z = unit.pos.z},
                zone_id = zone_of_unit[unit.id],
                tame = try(function() return dfhack.units.isTame(unit) end, false),
                domesticated = try(function() return dfhack.units.isDomesticated(unit) end, false),
                grazer = try(function() return dfhack.units.isGrazer(unit) end, false),
                milkable = try(function() return dfhack.units.isMilkable(unit) end, false),
                egg_layer = try(function() return dfhack.units.isEggLayer(unit) end, false),
                war = try(function() return dfhack.units.isWar(unit) end, false),
                hunting = try(function() return dfhack.units.isHunter(unit) end, false),
                adult = try(function() return dfhack.units.isAdult(unit) end, false),
                gelded = try(function() return dfhack.units.isGelded(unit) end, false),
                geldable = try(function() return dfhack.units.isGeldable(unit) end, false),
                marked_for_slaughter = try(function() return dfhack.units.isMarkedForSlaughter(unit) end, false),
                marked_for_gelding = try(function() return dfhack.units.isMarkedForGelding(unit) end, false),
                training_level = enum_name(df.animal_training_level,
                    try(function() return unit.training_level end)),
            }
        end
    end
    return out
end

--------------------------------------------------------------------------
-- Squads
--------------------------------------------------------------------------

local function squad_schedule(sq)
    local routines = A{}
    for ri, routine in ipairs(sq.schedule.routine) do
        local months = A{}
        for m = 0, 11 do
            local entry = routine.month[m]
            local orders = A{}
            for _, order in ipairs(entry.orders) do
                orders[#orders + 1] = {
                    type = enum_name(df.squad_order_type, try(function() return order:getType() end)),
                    min_count = try(function() return order.min_count end, 0),
                }
            end
            months[#months + 1] = {
                month = m,
                name = MONTHS[m + 1],
                uniform_mode = try(function() return entry.uniform_mode end, 0),
                orders = orders,
            }
        end
        routines[#routines + 1] = {index = ri, months = months}
    end
    return routines
end

local function dump_squads()
    local out = A{}
    local entity = df.historical_entity.find(df.global.plotinfo.group_id)
    if not entity then return out end

    for _, sid in ipairs(entity.squads) do
        local sq = df.squad.find(sid)
        if sq then
            local positions = A{}
            for pi, pos in ipairs(sq.positions) do
                local entry = {index = pi, occupant_hf = pos.occupant}
                if pos.occupant >= 0 then
                    local hf = df.historical_figure.find(pos.occupant)
                    local unit = hf and hf.unit_id >= 0 and df.unit.find(hf.unit_id) or nil
                    if unit then
                        entry.unit_id = unit.id
                        entry.name = u(dfhack.units.getReadableName(unit))
                    elseif hf then
                        entry.name = u(dfhack.units.getReadableName(hf))
                    end
                end
                positions[#positions + 1] = entry
            end

            local rooms = A{}
            for _, room in ipairs(sq.rooms) do
                local bld = df.building.find(room.building_id)
                rooms[#rooms + 1] = {
                    building_id = room.building_id,
                    name = bld and building_name(bld, ('building %d'):format(room.building_id))
                        or ('building %d'):format(room.building_id),
                    modes = set_flags(room.mode),
                }
            end

            local alias = u(sq.alias)
            out[#out + 1] = {
                id = sq.id,
                name = name_of(sq.name),
                alias = alias,
                display_name = alias ~= '' and alias or name_of(sq.name),
                cur_routine_idx = sq.cur_routine_idx,
                uniform_priority = sq.uniform_priority,
                positions = positions,
                rooms = rooms,
                schedule = squad_schedule(sq),
            }
        end
    end
    return out
end

--------------------------------------------------------------------------
-- Entry point
--------------------------------------------------------------------------

local function build_snapshot()
    local plotinfo = df.global.plotinfo
    local tick = df.global.cur_year_tick

    local work_details, work_detail_lookup = dump_work_details()
    local zones, zone_of_unit = dump_zones()

    local site = df.world_site.find(plotinfo.site_id)
    local civ = df.historical_entity.find(plotinfo.civ_id)
    local group = df.historical_entity.find(plotinfo.group_id)

    return {
        meta = {
            format = 1,
            generated_at = os.time(),
            dfhack_version = try(function() return dfhack.getDFHackVersion() end, 'unknown'),
            df_version = try(function() return dfhack.getDFVersion() end, 'unknown'),
            fort_name = site and name_of(site.name) or '',
            civ_name = civ and name_of(civ.name) or '',
            group_name = group and name_of(group.name) or '',
            site_id = plotinfo.site_id,
            group_id = plotinfo.group_id,
            year = df.global.cur_year,
            year_tick = tick,
            month = tick // TICKS_PER_MONTH + 1,
            month_name = MONTHS[tick // TICKS_PER_MONTH + 1],
            day = (tick % TICKS_PER_MONTH) // TICKS_PER_DAY + 1,
            season = season_of(tick),
        },
        enums = dump_enums(),
        units = dump_units(build_wave_map(), work_detail_lookup),
        work_details = work_details,
        stockpiles = dump_stockpiles(),
        workshops = dump_workshops(),
        links = dump_links(),
        zones = zones,
        animals = dump_animals(zone_of_unit),
        squads = dump_squads(),
    }
end

return function(out_path)
    if not out_path or out_path == '' then
        qerror('df-query: no output path given')
    end
    if df.global.gamemode ~= df.game_mode.DWARF then
        qerror('df-query: not in fortress mode (gamemode=' ..
            tostring(df.game_mode[df.global.gamemode]) .. ')')
    end

    local snapshot = build_snapshot()
    local text = table.concat(encode(snapshot, {}))

    local file = io.open(out_path, 'w')
    if not file then
        qerror('df-query: cannot write to ' .. out_path)
    end
    file:write(text)
    file:close()

    print(('df-query: wrote %d bytes (%d units, %d animals, %d stockpiles, %d squads)')
        :format(#text, #snapshot.units, #snapshot.animals,
                #snapshot.stockpiles, #snapshot.squads))
end
