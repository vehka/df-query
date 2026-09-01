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

    -- Item captions, so the flow view can say "stones" rather than BOULDER
    -- without keeping its own copy of DF's item list.
    local items = A{}
    for i = 0, df.item_type._last_item do
        local key = df.item_type[i]
        if key then
            items[#items + 1] = {
                id = i,
                key = key,
                caption = u(try(function() return df.item_type.attrs[i].caption end, '')),
            }
        end
    end

    -- Quality captions, so the equipment view can print DF's own stars
    -- rather than inventing its own word for a masterwork.
    local qualities = A{}
    for i = 0, df.item_quality._last_item do
        local key = df.item_quality[i]
        if key then
            qualities[#qualities + 1] = {
                id = i,
                key = key,
                caption = u(try(function() return df.item_quality.attrs[i].caption end, key)),
            }
        end
    end

    -- Building captions, so a recipe can say "Craftsdwarf's Workshop"
    -- rather than `Craftsdwarfs`. Two enums, because DF reads a building's
    -- subtype against a different one per class.
    local function building_captions(enum)
        local out = A{}
        for i = 0, enum._last_item do
            local key = enum[i]
            if key then
                out[#out + 1] = {
                    id = i,
                    key = key,
                    caption = u(try(function() return enum.attrs[i].name end, key)),
                }
            end
        end
        return out
    end

    return {
        job_skill = skills,
        unit_labor = labors,
        skill_rating = ratings,
        item_type = items,
        item_quality = qualities,
        workshop_type = building_captions(df.workshop_type),
        furnace_type = building_captions(df.furnace_type),
    }
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
            -- What DF's own unit list shows: "Zas Kironol", no nickname or
            -- profession tacked on. The full readable name stays in `name`.
            short_name = try(function()
                return u(dfhack.translation.translateName(
                    dfhack.units.getVisibleName(unit), false))
            end, ''),
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

--- Prefer whatever the player typed in over DF's generated "Stockpile #3".
local function building_name(bld, fallback)
    local custom = try(function() return u(bld.name) end, '')
    if custom and custom ~= '' then return custom end
    local name = try(function() return u(dfhack.buildings.getName(bld)) end)
    if name and name ~= '' then return name end
    return fallback
end

--- Pack a map tile into one integer key. Map edges are well under 65536.
local function tile_key(x, y)
    return x * 65536 + y
end

--- Every stockpile tile, mapped to the pile that owns it, plus each pile's
--- true tile count.
---
--- A pile is painted, not rectangular, so its bounding box overstates it --
--- the box is what `area` used to report. Walking the box once per pile
--- costs a few thousand `containsTile` calls; the alternative, asking each
--- of tens of thousands of items which pile it is in, is the expensive
--- direction.
local function stockpile_tile_map()
    local map, tiles = {}, {}
    for _, sp in ipairs(df.global.world.buildings.other.STOCKPILE) do
        local plane = map[sp.z]
        if not plane then
            plane = {}
            map[sp.z] = plane
        end
        local count = 0
        for x = sp.x1, sp.x2 do
            for y = sp.y1, sp.y2 do
                -- Falling back to `true` keeps a pile rectangular rather than
                -- empty if the extents ever move.
                if try(function() return dfhack.buildings.containsTile(sp, x, y) end, true) then
                    plane[tile_key(x, y)] = sp.id
                    count = count + 1
                end
            end
        end
        tiles[sp.id] = count
    end
    return map, tiles
end

local function stockpile_contents(sp)
    local by_type, total = {}, 0
    local occupied, used_tiles = {}, 0
    local items = try(function() return dfhack.buildings.getStockpileContents(sp) end, {})
    for _, item in ipairs(items) do
        local key = enum_name(df.item_type, item:getType()) or 'UNKNOWN'
        by_type[key] = (by_type[key] or 0) + 1
        total = total + 1
        -- Only the top layer sits on a tile: a barrel's contents are
        -- `in_inventory` and share the barrel's square, which is exactly the
        -- occupancy DF itself cares about when deciding a pile is full.
        if try(function() return item.flags.on_ground end, false) then
            local k = tile_key(item.pos.x, item.pos.y)
            if not occupied[k] then
                occupied[k] = true
                used_tiles = used_tiles + 1
            end
        end
    end
    return by_type, total, used_tiles
end

--- Every tool definition's `tool_use` list, keyed by def index.
---
--- `itemdef_toolst.tool_use` is DF's own statement of what a tool is *for*:
--- LIQUID_CONTAINER for a jug, FOOD_STORAGE for a pot, TRACK_CART for a
--- minecart, HEAVY_OBJECT_HAULING for a wheelbarrow. Reading it is what
--- keeps a material-to-kind table out of this file -- the alternative is
--- matching on the def's name, which is translated and which a mod moves.
local tool_use_cache
local function tool_uses(subtype)
    if not tool_use_cache then
        tool_use_cache = {}
        for i, def in ipairs(try(function()
            return df.global.world.raws.itemdefs.tools
        end, {})) do
            local uses = A{}
            for _, use in ipairs(try(function() return def.tool_use end, {})) do
                uses[#uses + 1] = enum_name(df.tool_uses, use)
            end
            tool_use_cache[i] = uses
        end
    end
    return tool_use_cache[subtype or -1] or A{}
end

local function has_tool_use(subtype, use)
    for _, key in ipairs(tool_uses(subtype)) do
        if key == use then return true end
    end
    return false
end

--- Containers the pile asks for against containers it actually has. A food
--- pile set to 20 barrels with 2 on site stores almost nothing, and nothing
--- else in the snapshot would show it.
---
--- `container_type` cannot answer this on its own. A wheelbarrow is a TOOL,
--- and there is no `item_type.WHEELBARROW` to compare against -- so the
--- kind has to come from the item's own tool definition, which means
--- resolving each id in `container_item_id` rather than reading the types
--- vector beside it.
local function stockpile_containers(sp)
    local storage = try(function() return sp.storage end)
    if not storage then return nil end
    local bins, barrels, carts = 0, 0, 0
    for _, id in ipairs(try(function() return storage.container_item_id end, {})) do
        local item = df.item.find(id)
        local kind = item and enum_name(df.item_type, try(function()
            return item:getType()
        end))
        if kind == 'BIN' then
            bins = bins + 1
        elseif kind == 'BARREL' or kind == 'BUCKET' then
            barrels = barrels + 1
        elseif kind == 'TOOL' then
            local subtype = try(function() return item:getSubtype() end)
            -- DF pools bins, barrels and wheelbarrows into one container
            -- list but counts them against separate wanted-slots. A pot is
            -- a TOOL too, and it stores food, so it answers the barrel slot.
            if has_tool_use(subtype, 'HEAVY_OBJECT_HAULING') then
                carts = carts + 1
            elseif has_tool_use(subtype, 'FOOD_STORAGE')
                or has_tool_use(subtype, 'LIQUID_CONTAINER') then
                barrels = barrels + 1
            end
        end
    end
    return {
        barrels_wanted = try(function() return storage.max_barrels end, 0),
        barrels_held = barrels,
        bins_wanted = try(function() return storage.max_bins end, 0),
        bins_held = bins,
        wheelbarrows_wanted = try(function() return storage.max_wheelbarrows end, 0),
        wheelbarrows_held = carts,
    }
end

local function dump_stockpiles(tiles, incoming)
    local out = A{}
    for _, sp in ipairs(df.global.world.buildings.other.STOCKPILE) do
        local by_type, total, used = stockpile_contents(sp)
        local width = sp.x2 - sp.x1 + 1
        local height = sp.y2 - sp.y1 + 1
        out[#out + 1] = {
            id = sp.id,
            number = sp.stockpile_number,
            name = building_name(sp, ('Stockpile %d'):format(sp.stockpile_number)),
            custom_name = u(sp.name),
            x1 = sp.x1, y1 = sp.y1, x2 = sp.x2, y2 = sp.y2, z = sp.z,
            area = tiles[sp.id] or (width * height),
            box_area = width * height,
            used_tiles = used,
            categories = set_flags(sp.settings.flags),
            flags = set_flags(sp.stockpile_flag),
            containers = stockpile_containers(sp),
            incoming_jobs = incoming[sp.id] or 0,
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
            -- `PERM` items are the workshop's own construction materials.
            -- Anything else parked here is input waiting or output nobody has
            -- hauled away -- the latter is what stalls a workshop. Which it
            -- is shows in the mix: a butcher holding a thousand body parts is
            -- a refuse problem, not a finished-goods one, so record the
            -- dominant type rather than just the total.
            local held, held_by_type = 0, {}
            for _, entry in ipairs(try(function() return bld.contained_items end, {})) do
                if try(function() return entry.use_mode end) ~= df.building_item_role_type.PERM then
                    held = held + 1
                    local key = enum_name(df.item_type,
                        try(function() return entry.item:getType() end)) or 'UNKNOWN'
                    held_by_type[key] = (held_by_type[key] or 0) + 1
                end
            end
            local top_type, top_count = nil, 0
            for key, count in pairs(held_by_type) do
                if count > top_count then top_type, top_count = key, count end
            end
            out[#out + 1] = {
                id = bld.id,
                kind = btype,
                held_items = held,
                held_top_type = top_type,
                held_top_count = top_count,
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
-- Goods flow
--
-- Why is a thing lying on the floor instead of in a pile? DF exposes no
-- "would pile X accept item Y" predicate -- answering that properly means
-- reimplementing the stockpile settings screen against every item subtype
-- and material -- so this section reports observable facts and leaves the
-- inference to the viewer: what is loose and where, how much of it a dwarf
-- is already on their way to fetch, and what DF's own hauling queue holds.
--------------------------------------------------------------------------

--- Is this item loose cargo? The excluded flags all mean the item is
--- somewhere on purpose: built into a construction or a building, inside a
--- container or a creature, encased in ice, or a visitor's property.
local function is_loose(flags)
    return flags.on_ground
        and not (flags.removed or flags.garbage_collect or flags.in_building
            or flags.in_inventory or flags.construction or flags.spider_web
            or flags.encased or flags.hostile or flags.trader)
end

-- A type spread over more levels than this is scattered everywhere; the
-- tail adds noise, not information.
local LOOSE_LEVEL_CAP = 24

--- Items on the floor outside every stockpile, grouped by type and level.
local function dump_loose(tile_map)
    local by_type = {}
    local totals = {items = 0, claimed = 0, forbidden = 0, rotten = 0, dump = 0}

    for _, item in ipairs(df.global.world.items.all) do
        local flags = item.flags
        if is_loose(flags) then
            -- `item.pos` only tracks the last position the item was on the
            -- ground -- which is where it is, given the filter above. Reading
            -- the field beats a getPosition() call per item across a world
            -- list tens of thousands of entries long.
            local pos = item.pos
            local plane = tile_map[pos.z]
            if not (plane and plane[tile_key(pos.x, pos.y)]) then
                local key = enum_name(df.item_type, item:getType()) or 'UNKNOWN'
                local entry = by_type[key]
                if not entry then
                    entry = {
                        type = key, count = 0, claimed = 0,
                        forbidden = 0, rotten = 0, dump = 0, levels = {},
                    }
                    by_type[key] = entry
                end
                local level = entry.levels[pos.z]
                if not level then
                    level = {z = pos.z, count = 0,
                             x1 = pos.x, x2 = pos.x, y1 = pos.y, y2 = pos.y}
                    entry.levels[pos.z] = level
                end
                level.count = level.count + 1
                if pos.x < level.x1 then level.x1 = pos.x end
                if pos.x > level.x2 then level.x2 = pos.x end
                if pos.y < level.y1 then level.y1 = pos.y end
                if pos.y > level.y2 then level.y2 = pos.y end

                entry.count = entry.count + 1
                totals.items = totals.items + 1
                -- `in_job` means someone is already coming for it. Counting
                -- it separately is the difference between a backlog being
                -- worked and a backlog nobody has picked up.
                if flags.in_job then
                    entry.claimed = entry.claimed + 1
                    totals.claimed = totals.claimed + 1
                end
                if flags.forbid then
                    entry.forbidden = entry.forbidden + 1
                    totals.forbidden = totals.forbidden + 1
                end
                if flags.rotten then
                    entry.rotten = entry.rotten + 1
                    totals.rotten = totals.rotten + 1
                end
                if flags.dump then
                    entry.dump = entry.dump + 1
                    totals.dump = totals.dump + 1
                end
            end
        end
    end

    local types = A{}
    for _, entry in pairs(by_type) do
        local levels = A{}
        for _, level in pairs(entry.levels) do levels[#levels + 1] = level end
        table.sort(levels, function(a, b) return a.count > b.count end)
        while #levels > LOOSE_LEVEL_CAP do table.remove(levels) end
        entry.levels = levels
        types[#types + 1] = entry
    end
    table.sort(types, function(a, b) return a.count > b.count end)

    return {
        total = totals.items,
        claimed = totals.claimed,
        forbidden = totals.forbidden,
        rotten = totals.rotten,
        marked_dump = totals.dump,
        by_type = types,
    }
end

-- df-structures marks `hauler_type` "not an actual enum" and its `name`
-- attributes are shifted against the `original-name` ones at indices 3 and 4,
-- where it reads Item/Bin instead of Burial/Item. The original names line up
-- with DF's own hauling labors, and a live fort agrees: lane 4 carries the
-- bulk of the queue, which is Item Hauling, not bins. Ten entries, checked
-- against Shieldclosed -- correcting them here beats shipping wrong labels.
local HAULER_LABELS = {
    [0] = 'Any', 'Stone', 'Wood', 'Burial', 'Item',
    'Body', 'Food', 'Refuse', 'Furniture', 'Animals',
}

--- DF's own hauling counters: pending storage jobs and assigned haulers per
--- hauling class, the same pair its Labors screen shows.
local function dump_hauling()
    local out = A{}
    local storage = try(function() return df.global.world.stockpile end)
    if not storage then return out end
    for index = 0, 9 do
        local jobs = try(function() return storage.num_jobs[index] end)
        local haulers = try(function() return storage.num_haulers[index] end)
        if jobs == nil and haulers == nil then break end
        out[#out + 1] = {
            index = index,
            key = HAULER_LABELS[index] or tostring(index),
            -- Kept so a future df-structures fix is visible without a redump.
            raw_key = enum_name(df.hauler_type, index) or tostring(index),
            jobs = jobs or 0,
            haulers = haulers or 0,
        }
    end
    return out
end

--- Pending "put this away" jobs, counted per destination building. The job
--- kinds are matched on their enum name rather than a hardcoded list, so a
--- new Store* job in a later DF version is picked up for free.
local function dump_store_jobs()
    local per_building, total, unclaimed = {}, 0, 0
    local link = try(function() return df.global.world.jobs.list.next end)
    while link do
        local job = try(function() return link.item end)
        if job then
            local kind = enum_name(df.job_type, try(function() return job.job_type end)) or ''
            if kind:sub(1, 5) == 'Store' then
                total = total + 1
                if not try(function() return dfhack.job.getWorker(job) end) then
                    unclaimed = unclaimed + 1
                end
                local id = try(function()
                    return dfhack.job.getGeneralRef(
                        job, df.general_ref_type.BUILDING_DESTINATION).building_id
                end)
                if id then per_building[id] = (per_building[id] or 0) + 1 end
            end
        end
        link = try(function() return link.next end)
    end
    return per_building, total, unclaimed
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
-- Equipment
--
-- Everything the squad-equipment analyser needs: what each soldier is
-- actually wearing, what DF's uniform asks for, and what spare gear the
-- fort has lying about to fix the gaps with.
--------------------------------------------------------------------------

-- Item types that can be part of a military kit. Ammo is handled through
-- the quiver rather than listed as a slot.
local EQUIPMENT_TYPES = {
    ARMOR = 'body', HELM = 'head', GLOVES = 'hands', SHOES = 'feet',
    PANTS = 'legs', SHIELD = 'shield', WEAPON = 'weapon', QUIVER = 'quiver',
}

-- Slots that come in pairs. DF issues a left and a right, and a soldier
-- with one gauntlet has a gap that a naive per-slot count would miss.
local PAIRED_SLOTS = {hands = true, feet = true}

-- Where the subtype definitions live in the raws, per item type. A uniform
-- spec names its piece by subtype id against these lists; -1 means "any of
-- this kind", which is how DF stores "any helm" rather than an error.
local ITEMDEF_LISTS = {
    ARMOR = 'armor', HELM = 'helms', GLOVES = 'gloves', SHOES = 'shoes',
    PANTS = 'pants', SHIELD = 'shields', WEAPON = 'weapons', AMMO = 'ammo',
    TOOL = 'tools',
}

local function subtype_def(kind, id)
    local list = ITEMDEF_LISTS[kind or '']
    if not list or not id or id < 0 then return nil end
    return try(function() return df.global.world.raws.itemdefs[list][id] end)
end

--- How good is this material, as armour?
---
--- Rather than shipping a table of metal names, this reads DF's own
--- `strength.fracture[SHEAR]` off the material. Sorting by it reproduces
--- the received wisdom exactly -- adamantine, steel, iron, bronze, copper,
--- bone, leather -- and it gets divine metals and mods right for free.
--- Pig iron lands below copper and is not flagged ITEMS_ARMOR, which is
--- why nobody makes armour out of it.
local function material_grade(item)
    local mi = try(function() return dfhack.matinfo.decode(item) end)
    local mat = mi and mi.material
    if not mat then return nil end
    local flags = mat.flags
    local class = 'other'
    if flags.IS_METAL then class = 'metal'
    elseif flags.BONE then class = 'bone'
    elseif flags.SHELL then class = 'shell'
    elseif flags.LEATHER then class = 'leather'
    elseif flags.WOOD then class = 'wood'
    elseif flags.SILK or flags.YARN or flags.THREAD_PLANT then class = 'cloth'
    -- Nothing is made of stone armour, so this branch is invisible to the
    -- equipment view -- but a stone pot stores food exactly as a wooden
    -- barrel does, and telling the two apart is the whole point of the
    -- container view's material column.
    elseif flags.IS_STONE then class = 'stone'
    end
    return {
        material = u(try(function() return mi:toString() end, '')),
        mat_class = class,
        -- Resistance to a cutting blow, DF's own number. The single figure
        -- that orders armour materials the way players rank them.
        grade = try(function() return mat.strength.fracture[df.strain_type.SHEAR] end, 0),
        armor_material = try(function() return flags.ITEMS_ARMOR end, false),
    }
end

--- One wearable item, flattened for the snapshot.
local function equipment_item(item, mode)
    local subtype = try(function() return item.subtype end)
    local record = {
        id = try(function() return item.id end),
        type = enum_name(df.item_type, try(function() return item:getType() end)),
        subtype = u(try(function() return subtype.name end, '')),
        -- 0 is clothing, 1+ is armour. The one field that separates a
        -- leather dress from a mail shirt without parsing names.
        armor_level = try(function() return subtype.armorlevel end),
        quality = try(function() return item:getQuality() end, 0),
        wear = try(function() return item.wear end, 0),
        mode = enum_name(df.inv_item_role_type, mode),
    }
    record.slot = EQUIPMENT_TYPES[record.type or '']
    local grade = material_grade(item)
    if grade then
        record.material = grade.material
        record.mat_class = grade.mat_class
        record.grade = grade.grade
        record.armor_material = grade.armor_material
    end
    return record
end

--- What a soldier is carrying, plus the bolts in their quiver.
local function unit_equipment(unit)
    local items, ammo = A{}, 0
    for _, entry in ipairs(try(function() return unit.inventory end, {})) do
        local item = try(function() return entry.item end)
        if item then
            local kind = enum_name(df.item_type, try(function() return item:getType() end))
            if EQUIPMENT_TYPES[kind or ''] then
                items[#items + 1] = equipment_item(item, entry.mode)
            end
            -- Bolts live inside the quiver, not directly on the unit, so a
            -- scan of `inventory` alone reports every archer as out of ammo.
            if kind == 'QUIVER' then
                for _, held in ipairs(try(function()
                    return dfhack.items.getContainedItems(item)
                end, {})) do
                    if enum_name(df.item_type, try(function() return held:getType() end)) == 'AMMO' then
                        ammo = ammo + try(function() return held.stack_size end, 1)
                    end
                end
            end
        end
    end
    return items, ammo
end

--- The uniform DF has been told to issue: one entry per slot it names.
---
--- Three things make this the standard worth grading against, rather than
--- a hardcoded ideal kit:
---
---   * `material_class` is DF's own `entity_material_category`, and its
---     values are specific: `Armor` is ARMOR_METAL -- the player asked for
---     metal -- while `Leather` and `Cloth` name exactly what they say.
---     Only `None` means "any material".
---   * `item_subtype` indexes the raws, so a spec resolves to "mail shirt"
---     or "high boot" by name; -1 is "any piece of this kind".
---   * `assigned` is what DF has earmarked, which runs well ahead of what
---     the soldier has picked up -- an off-duty squad has a full set of
---     assignments and wears civilian clothes. Dumping the earmarked items
---     themselves is what lets the UI tell "nothing exists" apart from
---     "exists, not collected yet".
local function position_uniform(pos, unit)
    local out = A{}
    local equipment = try(function() return pos.equipment end)
    if not equipment then return out, 0 end
    local assigned = 0
    for ci, specs in ipairs(equipment.uniform) do
        local category = enum_name(df.uniform_category, ci)
        for _, spec in ipairs(specs) do
            local kind = enum_name(df.item_type, try(function() return spec.item_type end))
            local subtype_id = try(function() return spec.item_subtype end, -1)
            local def = subtype_def(kind, subtype_id)
            local count = #try(function() return spec.assigned end, {})
            assigned = assigned + count
            -- The earmarked items, with the one fact the uniform itself
            -- cannot say: whether the soldier is actually carrying it.
            local items = A{}
            for _, item_id in ipairs(try(function() return spec.assigned end, {})) do
                local item = try(function() return df.item.find(item_id) end)
                if item then
                    local record = equipment_item(item, nil)
                    record.mode = nil
                    record.carried = unit ~= nil and try(function()
                        return dfhack.items.getHolderUnit(item) == unit
                    end, false)
                    items[#items + 1] = record
                end
            end
            local entry = {
                category = category,
                slot = EQUIPMENT_TYPES[kind or ''],
                type = kind,
                subtype = def and u(try(function() return def.name end, '')) or nil,
                -- The layering level of the *wanted* piece: 2 for a mail
                -- shirt, 1 for leather armour, 0 for a cap. Says which of
                -- two body specs is the armour and which is the layer.
                armor_level = def and try(function() return def.armorlevel end) or nil,
                material_class = enum_name(df.entity_material_category,
                    try(function() return spec.material_class end)),
                assigned = count,
                assigned_items = items,
            }
            -- A spec can also name one exact material ("steel breastplate").
            local mattype = try(function() return spec.mattype end, -1)
            if mattype and mattype >= 0 then
                entry.material = u(try(function()
                    return dfhack.matinfo.decode(mattype, spec.matindex):toString()
                end, ''))
            end
            out[#out + 1] = entry
        end
    end
    return out, assigned
end

--- Metal bars on hand, by metal. The direct answer to "can I forge the
--- replacements?" -- a gap the fort has the steel for reads very
--- differently from one it does not.
local function dump_metal_bars()
    local tally, order = {}, A{}
    for _, item in ipairs(try(function()
        return df.global.world.items.other.BAR
    end, {})) do
        local flags = item.flags
        if not try(function()
            return flags.forbid or flags.trader or flags.encased or flags.removed
        end, false) then
            local grade = material_grade(item)
            if grade and grade.mat_class == 'metal' then
                local row = tally[grade.material]
                if not row then
                    row = {
                        material = grade.material,
                        grade = grade.grade,
                        armor_material = grade.armor_material,
                        count = 0,
                    }
                    tally[grade.material] = row
                    order[#order + 1] = row
                end
                row.count = row.count + try(function() return item.stack_size end, 1)
            end
        end
    end
    table.sort(order, function(a, b) return (a.grade or 0) > (b.grade or 0) end)
    return order
end

--- Spare gear: equipment nobody is wearing, grouped by what it is and what
--- it is made of, with the pile it is sitting in.
---
--- `in_inventory` covers both worn kit and a hauler mid-carry; everything
--- else in the exclusion list means the item is somewhere on purpose or is
--- not really available (a construction, a trader's goods, an artifact
--- nobody will melt down for a recruit).
local function dump_armory(tile_map)
    local groups, order = {}, A{}
    local total, free = 0, 0
    for _, item in ipairs(try(function()
        return df.global.world.items.other.IN_PLAY
    end, {})) do
        local kind = enum_name(df.item_type, try(function() return item:getType() end))
        if EQUIPMENT_TYPES[kind or ''] then
            total = total + 1
            local flags = item.flags
            local held = try(function()
                return flags.in_inventory or flags.construction or flags.artifact
                    or flags.trader or flags.forbid or flags.dump or flags.encased
                    or flags.removed or flags.garbage_collect
            end, false)
            if not held then
                free = free + 1
                local record = equipment_item(item, nil)
                record.mode = nil
                local key = table.concat({
                    record.type or '?', record.subtype or '?', record.material or '?',
                }, '\1')
                local group = groups[key]
                if not group then
                    group = {
                        type = record.type, subtype = record.subtype,
                        slot = record.slot, armor_level = record.armor_level,
                        material = record.material, mat_class = record.mat_class,
                        grade = record.grade, armor_material = record.armor_material,
                        count = 0, best_quality = 0, worn = 0,
                        claimed = 0, stockpiles = A{},
                    }
                    groups[key] = group
                    order[#order + 1] = group
                end
                group.count = group.count + 1
                if (record.quality or 0) > group.best_quality then
                    group.best_quality = record.quality
                end
                if (record.wear or 0) > 0 then group.worn = group.worn + 1 end
                -- Owned by a civilian or already spoken for by a job: still
                -- in the fort, but not free to hand to a soldier.
                if try(function() return flags.owned or flags.in_job end, false) then
                    group.claimed = group.claimed + 1
                end
                -- Which pile is it in? Reuses the stockpile tile map the
                -- flow dumper already built.
                if try(function() return flags.on_ground end, false) then
                    local plane = tile_map[item.pos.z]
                    local sp = plane and plane[tile_key(item.pos.x, item.pos.y)]
                    if sp then
                        local seen = false
                        for _, id in ipairs(group.stockpiles) do
                            if id == sp then seen = true break end
                        end
                        if not seen then group.stockpiles[#group.stockpiles + 1] = sp end
                    end
                end
            end
        end
    end
    table.sort(order, function(a, b)
        if a.count ~= b.count then return a.count > b.count end
        return (a.grade or 0) > (b.grade or 0)
    end)
    return {total = total, free = free, groups = order, bars = dump_metal_bars()}
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
            -- `entry.orders` holds squad_schedule_order wrappers; the actual
            -- squad_order (and thus its type) hangs off `.order`.
            for _, scheduled in ipairs(entry.orders) do
                orders[#orders + 1] = {
                    type = enum_name(df.squad_order_type,
                        try(function() return scheduled.order:getType() end)),
                    min_count = try(function() return scheduled.min_count end, 0),
                }
            end
            months[#months + 1] = {
                month = m,
                name = MONTHS[m + 1],
                label = u(try(function() return entry.name end, '')),
                sleep_mode = enum_name(df.squad_sleep_option_type,
                    try(function() return entry.sleep_mode end)),
                uniform_mode = enum_name(df.squad_civilian_uniform_type,
                    try(function() return entry.uniform_mode end)),
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
                -- The occupant is resolved first: the uniform dump needs it
                -- to tell an earmarked item the soldier is carrying from one
                -- still sitting in a stockpile.
                local hf, unit
                if pos.occupant >= 0 then
                    hf = df.historical_figure.find(pos.occupant)
                    unit = hf and hf.unit_id >= 0 and df.unit.find(hf.unit_id) or nil
                end
                local uniform, assigned = position_uniform(pos, unit)
                entry.uniform = uniform
                entry.assigned_items = assigned
                if unit then
                    entry.unit_id = unit.id
                    entry.name = u(dfhack.units.getReadableName(unit))
                    local carried, ammo = unit_equipment(unit)
                    entry.equipment = carried
                    entry.ammo = ammo
                elseif hf then
                    entry.name = u(dfhack.units.getReadableName(hf))
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
-- Visitors and residents
--
-- Who is in the fort but not of it: tavern guests, scholars, mercenaries,
-- monster slayers, and the long-term residents who arrived the same way.
-- DF puts a residency petition to the player as a popup carrying a name
-- and a stated purpose and nothing else, and once it is dismissed there
-- is no screen that will show the applicant's skills or history again.
-- Everything the decision actually turns on is collected here: what they
-- can do, who they belong to, and whether they are who they say.
--
-- The dangerous half is not a guess. A cover identity, an intrigue plot
-- with a target, a CRIMINAL link to a government, a reputation as a
-- murderer -- DF tracks all of them, and none of them are on the popup.
--------------------------------------------------------------------------

--- Which of `intrigue_plotst.parameter`'s three meanings applies. The
--- df-structures comment reads "2:artifact_id, 5-11:actor_id, 12/15:
--- entity_id"; anything else carries no target at all.
local function plot_target_kind(plot_type)
    if plot_type == df.intrigue_plot_type.Acquire_Artifact then return 'artifact' end
    if plot_type == df.intrigue_plot_type.Counterintelligence
        or plot_type == df.intrigue_plot_type.Infiltrate_Society then
        return 'entity'
    end
    if plot_type >= df.intrigue_plot_type.Assassinate_Actor
        and plot_type <= df.intrigue_plot_type.Corrupt_Actors_Government then
        return 'actor'
    end
    return nil
end

local function entity_brief(id)
    if id == nil or id < 0 then return nil end
    local entity = df.historical_entity.find(id)
    if not entity then return nil end
    local plotinfo = df.global.plotinfo
    return {
        id = id,
        name = name_of(entity.name),
        type = enum_name(df.historical_entity_type, entity.type),
        -- Our own civilisation and this fort's government, so a rule can
        -- say "targets *you*" rather than naming an entity the player has
        -- to look up.
        ours = id == plotinfo.civ_id or id == plotinfo.group_id,
    }
end

--- The cover story, when there is one. `unit.name` stays the real figure;
--- everything DF shows the player -- name, race, profession, civilisation
--- -- comes from here instead.
local function visitor_identity(unit)
    local identity = try(function() return dfhack.units.getIdentity(unit) end)
    if not identity then return nil end
    return {
        type = enum_name(df.identity_type, identity.type),
        -- Person names stay in the form DF's unit list uses ("Dakost
        -- Rakustes"), so the cover name and the real one read alike.
        -- Entity and artifact names are translated, as DF shows them.
        name = name_of(identity.name, false),
        race = u(try(function() return df.creature_raw.find(identity.race).name[0] end, '')),
        profession = enum_name(df.profession, identity.profession),
        entity = entity_brief(identity.entity_id),
    }
end

--- Plots the figure is running, and the handlers running them. Read from
--- the figure's own intrigue perspective, so "has a master" means DF has
--- them taking orders, not that anyone in the fort suspects it.
local function visitor_intrigue(hf)
    local perspective = try(function() return hf.info.relationships.intrigues end)
    if not perspective then return nil end

    local actors = {}
    for _, actor in ipairs(try(function() return perspective.intrigue end, {})) do
        actors[actor.id] = actor
    end

    local function actor_name(actor)
        if not actor then return nil end
        local id = actor.hf_1 >= 0 and actor.hf_1 or actor.hf_2
        local figure = id >= 0 and df.historical_figure.find(id) or nil
        return figure and name_of(figure.name, false) or nil
    end

    local plots = A{}
    for _, plot in ipairs(try(function() return perspective.plots end, {})) do
        local kind = plot_target_kind(plot.plot_type)
        local target
        if kind == 'entity' then
            target = entity_brief(plot.parameter)
            if target then target.kind = 'entity' end
        elseif kind == 'artifact' then
            local record = df.artifact_record.find(plot.parameter)
            if record then
                target = {
                    kind = 'artifact',
                    id = plot.parameter,
                    name = name_of(record.name),
                    -- Whether the thing they are after is in this fort.
                    ours = try(function()
                        return record.site == df.global.plotinfo.site_id
                    end, false),
                }
            end
        elseif kind == 'actor' then
            local name = actor_name(actors[plot.parameter])
            if name then target = {kind = 'figure', id = plot.parameter, name = name} end
        end
        plots[#plots + 1] = {
            type = enum_name(df.intrigue_plot_type, plot.plot_type),
            on_hold = try(function() return plot.flags.on_hold end, false),
            target = target,
        }
    end

    local roles = A{}
    local master
    for _, actor in ipairs(try(function() return perspective.intrigue end, {})) do
        local role = enum_name(df.plot_role_type, actor.role)
        if role and role ~= 'None' then
            roles[#roles + 1] = {role = role, name = actor_name(actor)}
            if role == 'Master' then master = actor_name(actor) end
        end
    end

    return {plots = plots, roles = roles, master = master}
end

--- What entities have on file about them. DF keeps this per entity, so a
--- murderer known to their homeland is not necessarily known to us --
--- `ours` is the difference between a warning the fort could act on and
--- one the player only gets to see through DFHack.
local function visitor_reputations(hf)
    local out = A{}
    for _, profile in ipairs(try(function() return hf.info.reputation.wanted end, {})) do
        local types = A{}
        for i, kind in ipairs(try(function() return profile.reputation.types end, {})) do
            local name = enum_name(df.reputation_type, kind)
            if name and name ~= 'NONE' then
                types[#types + 1] = {
                    key = name,
                    level = try(function() return profile.reputation.levels[i] end, 0),
                }
            end
        end
        local murders = try(function() return profile.reputation.unsolved_murders end, 0)
        local exiled = try(function() return profile.flags.exiled end, false)
        if #types > 0 or murders > 0 or exiled then
            local entity = entity_brief(profile.entity_id)
            out[#out + 1] = {
                entity = entity and entity.name or '',
                entity_id = profile.entity_id,
                ours = entity and entity.ours or false,
                exiled = exiled,
                unsolved_murders = murders,
                types = types,
            }
        end
    end
    return out
end

--- Entity ties, which is where DF files "wanted by that government" and
--- "counts that government among their enemies" alongside plain
--- membership. Only the links that say something are kept.
local function visitor_groups(hf)
    local out = A{}
    for _, link in ipairs(try(function() return hf.entity_links end, {})) do
        local kind = enum_name(df.histfig_entity_link_type,
            try(function() return link:getType() end))
        local entity = entity_brief(link.entity_id)
        if kind and entity then
            entity.link = kind
            out[#out + 1] = entity
        end
    end
    return out
end

local function visitor_values(unit)
    local out = A{}
    local soul = unit.status.current_soul
    if not soul then return out end
    for _, value in ipairs(try(function() return soul.personality.values end, {})) do
        local key = enum_name(df.value_type, value.type)
        if key then out[#out + 1] = {key = key, strength = value.strength} end
    end
    return out
end

--- The membership of a petitioning group, as figures rather than units.
--- Most of a troupe is off the map -- Shieldclosed's has 15 members and
--- one of them in the tavern -- so `unit_id` is what it is on the
--- historical figure and may name a unit that is not loaded. Deciding who
--- is actually here is the web side's job, joining on `hf_id` against the
--- guests it already filtered; the dumper stays a dumb reader.
local function petition_members(entity)
    local out = A{}
    for _, hfid in ipairs(try(function() return entity.histfig_ids end, {})) do
        local hf = df.historical_figure.find(hfid)
        if hf then
            local unit_id = try(function() return hf.unit_id end, -1)
            out[#out + 1] = {
                hf_id = hfid,
                -- People render in their own language, entities in
                -- translation -- see `name_of`'s two callers below.
                name = name_of(hf.name, false),
                unit_id = unit_id >= 0 and unit_id or nil,
            }
        end
    end
    return out
end

--- Residency and citizenship agreements at this site, split by who filed
--- them. `plotinfo.petitions` holds the unapproved ones, which is the
--- closest thing DF has to "waiting on the player's answer"; the accepted
--- ones are what turned a visitor into a resident and carry the year.
---
--- The applicant party comes in two shapes and only one of them names
--- people. An individual petitions with `histfig_ids` populated. A
--- **performance troupe petitions as an entity** -- `histfig_ids` empty,
--- `entity_ids` holding the troupe -- so a reader that only walks
--- `histfig_ids` silently drops the whole petition rather than
--- mis-attributing it. Those come back separately, in `groups`, because a
--- group petition is not a fact about any one guest: DF is asking about
--- all fifteen members at once and most of them are not on the map to
--- attach anything to.
---
--- Returns `{units = hfid -> petition, groups = A{group petitions}}`.
local function petition_map()
    local plotinfo = df.global.plotinfo
    local unapproved = {}
    for _, id in ipairs(try(function() return plotinfo.petitions end, {})) do
        unapproved[id] = true
    end

    local out = {}
    local groups = A{}
    for _, agreement in ipairs(try(function() return df.global.world.agreements.all end, {})) do
        for _, details in ipairs(agreement.details) do
            local kind, data
            if details.type == df.agreement_details_type.Residency then
                kind, data = 'residency', details.data.Residency
            elseif details.type == df.agreement_details_type.Citizenship then
                kind, data = 'citizenship', details.data.Citizenship
            end
            if kind and data and data.site == plotinfo.site_id then
                local pending = unapproved[agreement.id]
                    or try(function() return agreement.flags.petition_not_accepted end, false)
                for _, party in ipairs(agreement.parties) do
                    if party.id == data.applicant then
                        for _, hfid in ipairs(party.histfig_ids) do
                            local prev = out[hfid]
                            -- A pending petition outranks a settled one, and
                            -- a later one outranks an earlier: citizenship
                            -- follows residency for the same figure.
                            if not prev or pending or details.year >= prev.year then
                                out[hfid] = {
                                    kind = kind,
                                    year = details.year,
                                    pending = pending and true or false,
                                    agreement_id = agreement.id,
                                }
                            end
                        end
                        if #party.histfig_ids == 0 then
                            for _, eid in ipairs(party.entity_ids) do
                                local entity = df.historical_entity.find(eid)
                                if entity then
                                    groups[#groups + 1] = {
                                        kind = kind,
                                        year = details.year,
                                        pending = pending and true or false,
                                        agreement_id = agreement.id,
                                        entity = entity_brief(eid),
                                        members = petition_members(entity),
                                    }
                                end
                            end
                        end
                    end
                end
            end
        end
    end
    return {units = out, groups = groups}
end

--- hfid -> the post they hold here, if any. This is the fort's own record
--- of what a visitor was taken on to do, which is a firmer answer to
--- "what are they for" than their profession.
local function occupation_map()
    local out = {}
    -- Abstract buildings -- temples, libraries, taverns -- are numbered
    -- within their site rather than globally, so there is no `find`.
    local locations = {}
    local site = df.world_site.find(df.global.plotinfo.site_id)
    for _, building in ipairs(try(function() return site.buildings end, {})) do
        locations[building.id] = name_of(try(function() return building.name end))
    end

    for _, occupation in ipairs(try(function() return df.global.world.occupations.all end, {})) do
        if occupation.histfig_id >= 0 and occupation.site_id == df.global.plotinfo.site_id then
            out[occupation.histfig_id] = {
                type = enum_name(df.occupation_type, occupation.type),
                location = locations[occupation.location_id],
            }
        end
    end
    return out
end

--- Returns the guest roster and, separately, the petitions filed by a
--- group rather than by a person -- see `petition_map` for why those
--- cannot be attached to a guest.
local function dump_visitors()
    local out = A{}
    local petitions = petition_map()
    local occupations = occupation_map()
    local year = df.global.cur_year

    for _, unit in ipairs(try(function() return df.global.world.units.active end, {})) do
        local visiting = try(function() return dfhack.units.isVisitor(unit) end, false)
        local resident = try(function() return dfhack.units.isResident(unit, true) end, false)
        -- A soul is what separates a guest from a merchant's wagon, and
        -- DF gives pack animals the visitor flag too.
        local person = unit.status.current_soul ~= nil
            and not try(function() return dfhack.units.isAnimal(unit) end, false)

        if (visiting or resident) and person then
            local hf = unit.hist_figure_id >= 0
                and df.historical_figure.find(unit.hist_figure_id) or nil
            local identity = visitor_identity(unit)
            local arrived = hf and try(function() return hf.info.whereabouts.year end) or nil
            local journey = hf and try(function()
                return hf.info.reputation.journey_profile
            end) or nil

            local quest
            if journey and journey.artifact_id and journey.artifact_id >= 0 then
                local record = df.artifact_record.find(journey.artifact_id)
                if record then
                    quest = {
                        id = journey.artifact_id,
                        name = name_of(record.name),
                        ours = try(function()
                            return record.site == df.global.plotinfo.site_id
                        end, false),
                    }
                end
            end

            out[#out + 1] = {
                id = unit.id,
                hf_id = hf and hf.id or nil,
                -- The name DF shows, which is the cover name when there is
                -- one. `real_name` is the figure underneath.
                name = try(function()
                    return u(dfhack.translation.translateName(
                        dfhack.units.getVisibleName(unit), false))
                end, ''),
                full_name = u(try(function() return dfhack.units.getReadableName(unit) end, '')),
                real_name = identity and name_of(unit.name, false) or nil,
                nickname = u(unit.name.nickname),
                profession = u(try(function() return dfhack.units.getProfessionName(unit) end, '')),
                -- The enum behind that caption. The caption is DF's
                -- localised prose ("Rat Man Dancer"); this is the stable
                -- key a rule can branch on, and it is also where THIEF,
                -- SNATCHER and CRIMINAL show up undisguised.
                profession_key = enum_name(df.profession, unit.profession),
                race = u(try(function() return dfhack.units.getRaceReadableName(unit) end, '')),
                sex = unit.sex == 1 and 'male' or (unit.sex == 0 and 'female' or 'other'),
                age = try(function() return math.floor(dfhack.units.getAge(unit)) end, 0),
                status = resident and 'resident' or 'visitor',
                -- DF's word for a guest nobody invited: night creatures and
                -- megabeasts that wandered into the tavern arrive this way.
                uninvited = try(function() return unit.flags2.visitor_uninvited end, false),
                pos = {x = unit.pos.x, y = unit.pos.y, z = unit.pos.z},
                arrived_year = arrived,
                years_here = arrived and arrived >= 0 and (year - arrived) or nil,
                entity = hf and entity_brief(hf.civ_id) or nil,
                groups = hf and visitor_groups(hf) or A{},
                occupation = hf and occupations[hf.id] or nil,
                petition = hf and petitions.units[hf.id] or nil,
                skills = unit_skills(unit),
                values = visitor_values(unit),
                identity = identity,
                intrigue = hf and visitor_intrigue(hf) or nil,
                reputations = hf and visitor_reputations(hf) or A{},
                artifact_quest = quest,
                journey = journey and enum_name(df.journey_type, journey.type) or nil,
                -- DFHack's own predicates, which are the checks the game
                -- uses rather than a guess from the creature raws.
                curse = {
                    hiding = try(function() return dfhack.units.isHidingCurse(unit) end, false),
                    undead = try(function() return dfhack.units.isUndead(unit, true) end, false),
                    night_creature = try(function() return dfhack.units.isNightCreature(unit) end, false),
                    bloodsucker = try(function() return dfhack.units.isBloodsucker(unit) end, false),
                    opposed_to_life = try(function() return dfhack.units.isOpposedToLife(unit) end, false),
                    crazed = try(function() return dfhack.units.isCrazed(unit) end, false),
                },
                threat = {
                    danger = try(function() return dfhack.units.isDanger(unit) end, false),
                    great_danger = try(function() return dfhack.units.isGreatDanger(unit) end, false),
                    invader = try(function() return dfhack.units.isInvader(unit) end, false),
                    -- `isInvader` is the OR of three flags that mean very
                    -- different things, so they ship separately: only
                    -- `active_invader` is an attack in progress, while
                    -- `invader_origin` is "arrived with a siege", which
                    -- stays set on a goblin long after the siege ended.
                    active_invader = try(function() return unit.flags1.active_invader end, false),
                    invader_origin = try(function() return unit.flags1.invader_origin end, false),
                    marauder = try(function() return unit.flags1.marauder end, false),
                },
                -- `world.units.active` means "on the map", not "alive":
                -- 349 of Shieldclosed's 765 entries are corpses, and a
                -- caged beast keeps its visitor flag. Neither is asking
                -- to stay, so the state ships and the UI filters on it.
                state = {
                    dead = try(function() return dfhack.units.isKilled(unit) end, false)
                        or not try(function() return dfhack.units.isActive(unit) end, true),
                    ghost = try(function() return dfhack.units.isGhost(unit) end, false),
                    caged = try(function() return unit.flags1.caged end, false),
                    chained = try(function() return unit.flags1.chained end, false),
                    tame = try(function() return unit.flags1.tame end, false),
                },
            }
        end
    end
    return out, petitions.groups
end

--------------------------------------------------------------------------
-- Instruments
--
-- Instruments are the one manufactured good DF describes to itself in
-- full. For every instrument a civilisation knows, worldgen writes real
-- reactions -- "make sharsid keyboard", "assemble sharsid" -- and each
-- one names its building, its skill, its reagents and whether it burns
-- fuel. `entity.resources.reaction_idx` then lists exactly the ones this
-- fort is allowed to run. So nothing here is transcribed from the wiki:
-- the recipe is read out of the game, and a mod's instruments come
-- through on the same path as the vanilla ones.
--------------------------------------------------------------------------

--- DF stores bars, thread, cloth and powders as a dimension rather than a
--- count -- a whole metal bar is 150, a whole thread 15000 -- so a reagent
--- asking for 300 wants two bars, not three hundred. Nothing in the raws
--- states the full-unit figure, so it is read off the fort's own stock
--- (the largest dimension any item of that type carries is a whole one;
--- partly-used ones sit below it) and only falls back to these constants
--- for a type the fort holds none of.
local DIMENSION_UNIT = {
    BAR = 150, POWDER_MISC = 150, LIQUID_MISC = 150, DRINK = 150,
    THREAD = 15000, CLOTH = 10000,
}

local function item_vector(type_key)
    if not type_key then return nil end
    return try(function() return df.global.world.items.other[type_key] end)
end

--- The dimension of a whole one of `type_key`, or nil for item types that
--- are simply counted.
local function unit_dimension(type_key, cache)
    if cache.dimension[type_key] ~= nil then
        return cache.dimension[type_key] or nil
    end
    local best = nil
    for _, item in ipairs(item_vector(type_key) or {}) do
        local dim = try(function() return item.dimension end)
        if type(dim) == 'number' and (best == nil or dim > best) then best = dim end
    end
    if best == nil then best = DIMENSION_UNIT[type_key] end
    cache.dimension[type_key] = best or false
    return best
end

--- How much of `reagent` the fort holds, using DF's own item-match
--- predicate rather than a guess from the item type: "clay" is a boulder
--- with a fired-material product, and only 93 of Shieldclosed's 730
--- boulders are one.
local function reagent_stock(reagent, reaction_index, type_key, cache)
    -- A reagent can name a material without naming an item type -- "shell",
    -- "bone" -- and there is no one vector holding those, so the scan falls
    -- back to everything in play. It costs a full item walk, which is why
    -- the answer is cached against the reagent's own terms: a civilisation's
    -- instruments ask for the same sand bag over and over.
    local vector = item_vector(type_key)
        or try(function() return df.global.world.items.other.IN_PLAY end)
    if not vector then return nil, nil end

    local key = table.concat({
        type_key or '*',
        tostring(try(function() return reagent.item_subtype end)),
        tostring(try(function() return reagent.mat_type end)),
        tostring(try(function() return reagent.mat_index end)),
        try(function() return reagent.reaction_class end) or '',
        try(function() return reagent.has_material_reaction_product end) or '',
        tostring(try(function() return reagent.flags1.whole end)),
        tostring(try(function() return reagent.flags2.whole end)),
        tostring(try(function() return reagent.flags3.whole end)),
    }, '\1')
    local hit = cache.stock[key]
    if hit then return hit[1], hit[2] end

    local items, dimension = 0, 0
    for _, item in ipairs(vector) do
        if try(function() return reagent:matchesRoot(item, reaction_index) end, false) then
            items = items + 1
            dimension = dimension + (try(function() return item.dimension end) or 0)
        end
    end
    local unit = type_key and unit_dimension(type_key, cache) or nil
    local units = items
    if unit and unit > 0 and dimension > 0 then units = dimension // unit end
    cache.stock[key] = {items, units}
    return items, units
end

--- Where a reaction may be run. DF lists alternatives -- a glass piece
--- takes either furnace -- and `building.subtype` is read against a
--- different enum per building class, the same trap `dump_workshops` hits.
local function reaction_buildings(r)
    local out = A{}
    for i, btype in ipairs(try(function() return r.building.type end, {})) do
        local kind = enum_name(df.building_type, btype)
        local subtype = try(function() return r.building.subtype[i] end)
        local enum = (kind == 'Furnace' and df.furnace_type)
            or (kind == 'Workshop' and df.workshop_type)
            or nil
        out[#out + 1] = {
            kind = kind,
            subtype = enum and enum_name(enum, subtype) or nil,
            name = u(try(function() return enum.attrs[subtype].name end,
                kind or 'workshop')),
        }
    end
    return out
end

local function reaction_product(r)
    for _, product in ipairs(try(function() return r.products end, {})) do
        -- A reaction's products can include improvements, which carry no
        -- item of their own; only the item products name what is made.
        if try(function() return df.reaction_product_itemst:is_instance(product) end, false) then
            return {
                item_type = enum_name(df.item_type,
                    try(function() return product.item_type end)),
                item_subtype = try(function() return product.item_subtype end),
                count = try(function() return product.count end, 1),
            }
        end
    end
    return nil
end

local function dump_reaction(r, index, describe, cache)
    local reagents = A{}
    for _, reagent in ipairs(try(function() return r.reagents end, {})) do
        local type_key = enum_name(df.item_type,
            try(function() return reagent.item_type end))
        -- A reagent with no item type is a container the reaction only
        -- borrows -- the bag a glassmaker's sand arrives in. There is no
        -- one vector to count those in, so they ship without a stock
        -- figure rather than with a wrong one.
        if type_key == 'NONE' then type_key = nil end
        local quantity = try(function() return reagent.quantity end, 1)
        local stock, stock_units = reagent_stock(reagent, index, type_key, cache)
        local unit = type_key and unit_dimension(type_key, cache) or nil
        local description = nil
        if describe then
            description = u(try(function()
                reagent:getDescription(describe, index)
                return describe.value
            end))
        end
        reagents[#reagents + 1] = {
            code = u(try(function() return reagent.code end, '')),
            -- DF's own phrasing for the requirement ("Clay boulders",
            -- "Sand powder"), which beats anything assembled from the
            -- item type and the reagent token.
            description = description ~= '' and description or nil,
            item_type = type_key,
            -- Which tool an assembly step is asking for, so a piece can be
            -- matched to its slot by identity rather than by its name.
            item_subtype = try(function()
                local subtype = reagent.item_subtype
                if subtype and subtype >= 0 then return subtype end
            end),
            quantity = quantity,
            unit_dimension = unit or nil,
            units = unit and unit > 0 and math.ceil(quantity / unit) or quantity,
            stock = stock,
            stock_units = stock_units,
            -- PRESERVE_REAGENT is the sand bag: needed to run the job,
            -- handed back afterwards. Saying it is consumed would put a
            -- bag on every shopping list forever.
            preserve = try(function() return reagent.flags.PRESERVE_REAGENT end, false),
            in_container = try(function() return reagent.flags.IN_CONTAINER end, false),
        }
    end

    local skill = enum_name(df.job_skill, try(function() return r.skill end))
    return {
        code = u(try(function() return r.code end, '')),
        name = u(try(function() return r.name end, '')),
        category = u(try(function() return r.category end, '')),
        skill = skill,
        skill_caption = u(try(function()
            return df.job_skill.attrs[r.skill].caption
        end, '')),
        fuel = try(function() return r.flags.FUEL end, false),
        buildings = reaction_buildings(r),
        reagents = reagents,
        product = reaction_product(r),
    }
end

local function dump_instruments(civ)
    if not civ then return nil end

    local reactions = try(function()
        return df.global.world.raws.reactions.reactions
    end, {})

    -- The fort's permitted list, indexed by what each reaction makes: an
    -- instrument for the assembly (or, for a one-piece instrument, the
    -- whole job), a tool for each piece.
    local by_instrument, by_tool = {}, {}
    local cache = {dimension = {}, stock = {}}
    local describe = try(function() return df.new('string') end)
    for _, index in ipairs(try(function() return civ.resources.reaction_idx end, {})) do
        local r = reactions[index]
        local category = r and u(try(function() return r.category end, '')) or ''
        if r and (category == 'INSTRUMENT' or category == 'INSTRUMENT_PIECE') then
            local entry = dump_reaction(r, index, describe, cache)
            local product = entry.product
            if product and product.item_type == 'INSTRUMENT' then
                by_instrument[product.item_subtype] = entry
            elseif product and product.item_type == 'TOOL' then
                by_tool[product.item_subtype] = entry
            end
        end
    end

    -- Finished instruments already in the fort, by subtype. Counted for
    -- every subtype, not just the makeable ones: a fort's tavern fills up
    -- with traded instruments it could never build itself.
    local held = {}
    for _, item in ipairs(try(function()
        return df.global.world.items.other.INSTRUMENT
    end, {})) do
        local subtype = try(function() return item:getSubtype() end)
        if subtype then held[subtype] = (held[subtype] or 0) + 1 end
    end

    local out, makeable = A{}, {}
    for _, subtype in ipairs(try(function()
        return civ.resources.instrument_type
    end, {})) do
        local def = df.itemdef_instrumentst.find(subtype)
        if def then
            makeable[subtype] = true
            local pieces = A{}
            for _, piece in ipairs(try(function() return def.pieces end, {})) do
                local tool_index = try(function() return piece.index end)
                pieces[#pieces + 1] = {
                    token = u(try(function() return piece.type end, '')),
                    name = u(try(function() return piece.name end, '')),
                    name_plural = u(try(function() return piece.name_plural end, '')),
                    tool_index = tool_index,
                    -- Which piece decides the finished instrument's
                    -- material, and so the skill the assembly is graded on.
                    dominant = u(try(function() return piece.type end, ''))
                        == u(try(function() return def.dominant_instrument_piece end, '')),
                    reaction = tool_index ~= nil and by_tool[tool_index] or nil,
                }
            end
            out[#out + 1] = {
                id = subtype,
                name = u(try(function() return def.name end, '')),
                name_plural = u(try(function() return def.name_plural end, '')),
                description = u(try(function() return def.description end, '')),
                value = try(function() return def.value end, 0),
                size = try(function() return def.size end, 0),
                -- The music skill, which is what the instrument is *for*:
                -- a fort with no stringed players gains nothing from a lyre.
                skill = enum_name(df.job_skill, try(function() return def.music_skill end)),
                skill_caption = u(try(function()
                    return df.job_skill.attrs[def.music_skill].caption
                end, '')),
                -- A placed instrument is furniture: it is built on a tile
                -- and played where it stands, never carried to a tavern.
                placed_as_building = try(function()
                    return def.flags.PLACED_AS_BUILDING
                end, false),
                in_stock = held[subtype] or 0,
                pieces = pieces,
                reaction = by_instrument[subtype],
            }
        end
    end

    -- Instruments the fort owns but cannot build. Worth naming rather than
    -- silently dropping: they are most of what a tavern accumulates, and
    -- their absence from the buildable list is otherwise mystifying.
    local foreign = A{}
    for subtype, count in pairs(held) do
        if not makeable[subtype] then
            local def = df.itemdef_instrumentst.find(subtype)
            foreign[#foreign + 1] = {
                id = subtype,
                name = def and u(try(function() return def.name end, '')) or '?',
                count = count,
            }
        end
    end
    table.sort(foreign, function(a, b)
        if a.count ~= b.count then return a.count > b.count end
        return a.name < b.name
    end)

    if describe then pcall(function() describe:delete() end) end
    return {types = out, foreign = foreign}
end

--------------------------------------------------------------------------
-- Containers
--------------------------------------------------------------------------

--- Item types that exist to hold something else.
---
--- `df.item` has no `isContainer` predicate and `item_type` carries no flag
--- for it, so this is a list -- the same compromise `EQUIPMENT_TYPES` makes
--- a few hundred lines up. It stops at whole item types on purpose: the
--- *tools* that store or haul things are derived from `tool_use` instead,
--- which is why no jug, pot, minecart or wheelbarrow is named here.
local CONTAINER_TYPES = {
    BIN = true, BARREL = true, BAG = true, BUCKET = true, BOX = true,
    FLASK = true, BACKPACK = true, QUIVER = true, CAGE = true,
    ANIMALTRAP = true, COFFIN = true, CABINET = true, ARMORSTAND = true,
    WEAPONRACK = true,
}

-- Past this the tail is noise: a kind spread over forty piles is simply
-- everywhere, and naming them all says nothing the total did not.
local CONTAINER_PILE_CAP = 12
local CONTAINER_BUILDING_CAP = 8

--- Sorted, capped list of a map's values.
local function top_values(map, cap, rank)
    local list = A{}
    for _, value in pairs(map) do list[#list + 1] = value end
    table.sort(list, rank)
    while #list > cap do list[#list] = nil end
    return list
end

--- One census row per kind of container, and where every one of them sits.
---
--- DF's stocks screen counts containers but never their state, so "how many
--- empty barrels have I got?" is only answerable in game by opening the
--- work-order conditions screen and reading a threshold off it. That number
--- is what this section exists to produce.
---
--- Emptiness has to be *measured*. `item.flags.container` is set on every
--- barrel ever made -- it means "this is a container", not "this one has
--- something in it" -- so the only honest test is asking for the contents.
local function dump_containers(tile_map)
    -- Which pile has claimed each container as one of its storage slots.
    -- `container_item_id` is exact, so these need no position lookup, and
    -- it is the only place a wheelbarrow's assignment is visible at all.
    local assigned_to = {}
    for _, sp in ipairs(try(function()
        return df.global.world.buildings.other.STOCKPILE
    end, {})) do
        for _, id in ipairs(try(function()
            return sp.storage.container_item_id
        end, {})) do
            assigned_to[id] = sp.id
        end
    end

    local kinds, order = {}, A{}

    local function row_for(key, name, uses, type_key, subtype)
        local row = kinds[key]
        if not row then
            row = {
                key = key, name = name, item_type = type_key,
                subtype = subtype, uses = uses,
                total = 0, empty = 0, free = 0, holding = 0, contents = 0,
                in_job = 0, forbidden = 0, marked_dump = 0, artifact = 0,
                assigned = 0,
                built = 0, carried = 0, nested = 0, stored = 0, loose = 0,
                holds = {}, materials = {}, piles = {}, buildings = {},
            }
            kinds[key] = row
            order[#order + 1] = row
        end
        return row
    end

    local function scan(item)
        local type_key = enum_name(df.item_type, try(function()
            return item:getType()
        end))
        if not type_key then return end

        local key, name, uses, subtype = type_key, nil, A{}, nil
        if type_key == 'TOOL' then
            subtype = try(function() return item:getSubtype() end)
            uses = tool_uses(subtype)
            -- A tool DF states no use for is not storage and not hauling
            -- gear -- it is an instrument piece, which the Instruments view
            -- owns, or a toy. Dropping it here is what keeps a sharsid
            -- bellows out of the barrel census.
            if #uses == 0 then return end
            local def = subtype_def('TOOL', subtype)
            name = def and u(try(function() return def.name end, '')) or ''
            if name == '' then name = 'tool' end
            key = 'TOOL:' .. name
        elseif CONTAINER_TYPES[type_key] then
            -- `item_type.attrs[].caption` is DF's own word for the kind, and
            -- it already ships in `enums.item_type`.
            name = u(try(function()
                return df.item_type.attrs[item:getType()].caption
            end, ''))
            if name == '' then name = type_key:lower() end
        else
            return
        end

        local row = row_for(key, name, uses, type_key, subtype)
        local flags = item.flags
        row.total = row.total + 1

        local held = try(function()
            return dfhack.items.getContainedItems(item)
        end, {})
        local empty = #held == 0
        if empty then
            row.empty = row.empty + 1
        else
            row.holding = row.holding + 1
            row.contents = row.contents + #held
            -- One vote per container, cast by whatever is on top. Summing
            -- the contents instead would report 400 drinks and hide that
            -- they sit in 23 barrels -- and it is the barrels, not the
            -- drinks, that stop the brewery.
            local top = enum_name(df.item_type, try(function()
                return held[1]:getType()
            end)) or 'UNKNOWN'
            row.holds[top] = (row.holds[top] or 0) + 1
        end

        if try(function() return flags.in_job end, false) then
            row.in_job = row.in_job + 1
        end
        if try(function() return flags.forbid end, false) then
            row.forbidden = row.forbidden + 1
        end
        if try(function() return flags.dump end, false) then
            row.marked_dump = row.marked_dump + 1
        end
        if try(function() return flags.artifact end, false) then
            row.artifact = row.artifact + 1
        end
        if assigned_to[item.id] then row.assigned = row.assigned + 1 end

        -- Where it is, one bucket per container. `in_building` outranks
        -- everything else: a coffer installed in a bedroom is furniture,
        -- not stock, however empty it happens to be.
        local where
        if try(function() return flags.in_building end, false) then
            where = 'built'
            local bld = try(function()
                return dfhack.items.getHolderBuilding(item)
            end)
            local id = bld and try(function() return bld.id end)
            if id then
                local entry = row.buildings[id]
                if not entry then
                    entry = {
                        id = id,
                        name = building_name(bld, 'building'),
                        -- Which kind of building swallowed it. A bucket
                        -- built into a well and a coffer built as its own
                        -- bedroom furniture are both `in_building` and both
                        -- `use_mode == PERM`; only the building's type tells
                        -- the machine from the item installed as itself.
                        kind = enum_name(df.building_type, try(function()
                            return bld:getType()
                        end)),
                        count = 0,
                    }
                    row.buildings[id] = entry
                end
                entry.count = entry.count + 1
            end
        elseif try(function() return flags.in_inventory end, false) then
            -- `in_inventory` covers two different situations: a dwarf
            -- carrying a bag, and a bag sitting inside a barrel. Only the
            -- holder tells them apart.
            where = try(function()
                return dfhack.items.getHolderUnit(item) ~= nil
            end, false) and 'carried' or 'nested'
        else
            local pos = try(function() return item.pos end)
            local plane = pos and tile_map[pos.z]
            local sp = plane and plane[tile_key(pos.x, pos.y)]
            if sp then
                where = 'stored'
                local entry = row.piles[sp]
                if not entry then
                    entry = {id = sp, total = 0, empty = 0}
                    row.piles[sp] = entry
                end
                entry.total = entry.total + 1
                if empty then entry.empty = entry.empty + 1 end
            else
                where = 'loose'
            end
        end
        row[where] = row[where] + 1

        -- Free means "a job could take this one right now", which is a
        -- narrower thing than empty. It has to be decided per item and not
        -- by arithmetic on the totals: `empty` and `nested` count different
        -- sets of containers, so subtracting one from the other can go
        -- negative and reports a fort full of spare bags as having none.
        if empty
            and (where == 'stored' or where == 'loose')
            and not try(function() return flags.forbid end, false)
            and not try(function() return flags.in_job end, false)
        then
            row.free = row.free + 1
        end

        local grade = material_grade(item)
        if grade then
            local mkey = grade.material or '?'
            local mat = row.materials[mkey]
            if not mat then
                mat = {material = grade.material, mat_class = grade.mat_class,
                       count = 0, empty = 0}
                row.materials[mkey] = mat
            end
            mat.count = mat.count + 1
            if empty then mat.empty = mat.empty + 1 end
        end
    end

    for type_key in pairs(CONTAINER_TYPES) do
        for _, item in ipairs(try(function()
            return df.global.world.items.other[type_key]
        end, {})) do
            scan(item)
        end
    end
    for _, item in ipairs(try(function()
        return df.global.world.items.other.TOOL
    end, {})) do
        scan(item)
    end

    local by_count = function(a, b) return a.count > b.count end
    for _, row in ipairs(order) do
        row.materials = top_values(row.materials, 1e9, by_count)
        row.piles = top_values(row.piles, CONTAINER_PILE_CAP, function(a, b)
            if a.empty ~= b.empty then return a.empty > b.empty end
            return a.total > b.total
        end)
        row.buildings = top_values(row.buildings, CONTAINER_BUILDING_CAP,
            by_count)
    end
    table.sort(order, function(a, b)
        if a.total ~= b.total then return a.total > b.total end
        return a.name < b.name
    end)
    return order
end

--- Minecart hauling routes, and whether each one actually has a cart.
---
--- A route with no vehicle assigned is configured, listed, and completely
--- inert -- DF says nothing about it, and the only way to notice in game is
--- to open each route and look. That is worth a line of its own.
local function dump_routes()
    local out = A{}
    for _, route in ipairs(try(function()
        return df.global.plotinfo.hauling.routes
    end, {})) do
        local carts = A{}
        for _, vid in ipairs(try(function() return route.vehicle_ids end, {})) do
            local vehicle = df.vehicle.find(vid)
            local item_id = vehicle and try(function() return vehicle.item_id end)
            carts[#carts + 1] = {
                vehicle_id = vid,
                item_id = item_id,
                -- A vehicle whose minecart is gone leaves the route just as
                -- stopped as one that never had a cart.
                missing = item_id == nil or df.item.find(item_id) == nil,
            }
        end
        out[#out + 1] = {
            id = try(function() return route.id end),
            name = u(try(function() return route.name end, '')),
            stops = #try(function() return route.stops end, A{}),
            carts = carts,
        }
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

    -- Built once and shared: the stockpile dump needs the tile counts, the
    -- loose-item scan needs the tile ownership, and walking the piles twice
    -- for the same answer would be silly.
    local tile_map, tiles = stockpile_tile_map()
    local incoming, store_total, store_unclaimed = dump_store_jobs()

    local site = df.world_site.find(plotinfo.site_id)
    local civ = df.historical_entity.find(plotinfo.civ_id)
    local group = df.historical_entity.find(plotinfo.group_id)
    local visitors, petitions = dump_visitors()

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
            -- What DF's own z-axis widget reads out. The game shows an
            -- elevation against sea level, never the raw block index, so
            -- the UI needs the offset to speak the player's language.
            elev_offset = try(function() return df.global.world.map.region_z - 100 end),
        },
        enums = dump_enums(),
        units = dump_units(build_wave_map(), work_detail_lookup),
        work_details = work_details,
        stockpiles = dump_stockpiles(tiles, incoming),
        workshops = dump_workshops(),
        links = dump_links(),
        flow = {
            loose = dump_loose(tile_map),
            hauling = dump_hauling(),
            store_jobs = {total = store_total, unclaimed = store_unclaimed},
        },
        zones = zones,
        animals = dump_animals(zone_of_unit),
        squads = dump_squads(),
        armory = dump_armory(tile_map),
        visitors = visitors,
        -- Petitions filed by a group rather than a person. They have no
        -- guest to hang off, so they ship alongside the roster.
        petitions = petitions,
        instruments = dump_instruments(civ),
        containers = {
            kinds = dump_containers(tile_map),
            routes = dump_routes(),
        },
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

    print(('df-query: wrote %d bytes (%d units, %d animals, %d stockpiles, %d squads, %d guests)')
        :format(#text, #snapshot.units, #snapshot.animals,
                #snapshot.stockpiles, #snapshot.squads, #snapshot.visitors))
end
