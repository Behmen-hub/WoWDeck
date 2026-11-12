-- ============================================================================
-- WoWDeckBridge.lua (WoWDeckBridge Forever)
-- Author: Behmen
-- Bidirectional Optical Telemetry (234x1 Pixel Strip @ TOPLEFT 0,0) &
-- Dynamic Zero-Collision Runtime Keybinding Allocator (174-Key Pool)
-- Secret-Free Combat Cooldown Tracking for WoW: Forever (Interface 16001)
-- ============================================================================

local MAX_SLOTS = 116
local TOTAL_PIXELS = 234 -- 2 Sync Header pixels + 116 * 2 Slot pixels (indices 0..233)
local UPDATE_INTERVAL = 0.05 -- 20 Hz (50ms) smooth sub-second telemetry
local GCD_THRESHOLD = 1.5

local band = bit.band
local bor = bit.bor
local lshift = bit.lshift
local rshift = bit.rshift
local floor = math.floor
local ceil = math.ceil
local min = math.min
local max = math.max
local tonumber = tonumber
local type = type
local pcall = pcall
local GetTime = GetTime
local InCombatLockdown = InCombatLockdown
local issecretvalue = issecretvalue

-- ============================================================================
-- 1. SECRET-SAFE VALUE HELPERS (MIDNIGHT 12.0 / 16001 ENGINE PROTECTION)
-- ============================================================================

local function SafeNumber(v)
    if v == nil then return 0 end
    if issecretvalue and issecretvalue(v) then return 0 end
    if type(v) ~= "number" then return 0 end
    return v
end

local function SafeBoolean(v, defaultVal)
    if v == nil then return defaultVal end
    if issecretvalue and issecretvalue(v) then return defaultVal end
    if type(v) == "boolean" then return v end
    if type(v) == "number" then return v ~= 0 end
    return defaultVal
end

local function ClampByte(val)
    local n = SafeNumber(val)
    if n <= 0 then return 0 end
    if n >= 255 then return 255 end
    return floor(n)
end

-- ============================================================================
-- 2. ACTION BAR MAPPING (116 STREAM DECK SLOTS)
-- ============================================================================

local ACTION_BAR_BASE_SLOTS = {
    [1] = { baseSlot = 1,   blizzPrefix = "ActionButton" },              -- Index 1..12   -> Slots 1..12
    [2] = { baseSlot = 61,  blizzPrefix = "MultiBarBottomLeftButton" },  -- Index 13..24  -> Slots 61..72
    [3] = { baseSlot = 49,  blizzPrefix = "MultiBarBottomRightButton" }, -- Index 25..36  -> Slots 49..60
    [4] = { baseSlot = 25,  blizzPrefix = "MultiBarRightButton" },       -- Index 37..48  -> Slots 25..36
    [5] = { baseSlot = 37,  blizzPrefix = "MultiBarLeftButton" },        -- Index 49..60  -> Slots 37..48
    [6] = { baseSlot = 145, blizzPrefix = "MultiBar5Button" },           -- Index 61..72  -> Slots 145..156
    [7] = { baseSlot = 157, blizzPrefix = "MultiBar6Button" },           -- Index 73..84  -> Slots 157..168
    [8] = { baseSlot = 169, blizzPrefix = "MultiBar7Button" },           -- Index 85..96  -> Slots 169..180
}

local SD_INDEX_TO_WOW_SLOT = {}
local SD_INDEX_TO_BLIZZ_BTN_NAME = {}

for barIdx = 1, 8 do
    local info = ACTION_BAR_BASE_SLOTS[barIdx]
    for btnIdx = 1, 12 do
        local sdIndex = (barIdx - 1) * 12 + btnIdx
        SD_INDEX_TO_WOW_SLOT[sdIndex] = info.baseSlot + (btnIdx - 1)
        SD_INDEX_TO_BLIZZ_BTN_NAME[sdIndex] = info.blizzPrefix .. btnIdx
    end
end

local function GetEffectiveWoWSlot(sdIndex)
    if sdIndex >= 1 and sdIndex <= 12 then
        local page = GetActionBarPage and SafeNumber(GetActionBarPage()) or 1
        local bonus = GetBonusBarOffset and SafeNumber(GetBonusBarOffset()) or 0
        if page < 1 then page = 1 end
        if page == 1 and bonus > 0 then
            return (bonus + 5) * 12 + sdIndex
        elseif page > 1 then
            return (page - 1) * 12 + sdIndex
        end
        return sdIndex
    end
    return SD_INDEX_TO_WOW_SLOT[sdIndex]
end

-- ============================================================================
-- 3. PURE LUA CACHES FOR SECRET-FREE COMBAT TELEMETRY & COOLDOWNS
-- ============================================================================

local PET_TOKEN_FILE_DATA_IDS = {
    ["PET_ACTION_ATTACK"] = 132152,
    ["PET_ACTION_ATTACK_TEXTURE"] = 132152,
    ["PET_ACTION_FOLLOW"] = 132328,
    ["PET_ACTION_FOLLOW_TEXTURE"] = 132328,
    ["PET_ACTION_WAIT"] = 136106,
    ["PET_ACTION_WAIT_TEXTURE"] = 136106,
    ["PET_ACTION_STAY"] = 136106,
    ["PET_ACTION_STAY_TEXTURE"] = 136106,
    ["PET_ACTION_MOVE_TO"] = 457329,
    ["PET_ACTION_MOVE_TO_TEXTURE"] = 457329,
    ["PET_ACTION_MOVETO"] = 457329,
    ["PET_MODE_AGGRESSIVE"] = 132270,
    ["PET_MODE_AGGRESSIVE_TEXTURE"] = 132270,
    ["PET_MODE_DEFENSIVE"] = 132110,
    ["PET_MODE_DEFENSIVE_TEXTURE"] = 132110,
    ["PET_MODE_DEFENSIVEASSIST"] = 132110,
    ["PET_MODE_DEFENSIVEASSIST_TEXTURE"] = 132110,
    ["PET_MODE_PASSIVE"] = 132311,
    ["PET_MODE_PASSIVE_TEXTURE"] = 132311,
    ["PET_MODE_ASSIST"] = 524348,
    ["PET_MODE_ASSIST_TEXTURE"] = 524348,

    ["INTERFACE\\ICONS\\ABILITY_GHOULFRENZY"] = 132152,
    ["INTERFACE\\ICONS\\ABILITY_TRACKING"] = 132328,
    ["INTERFACE\\ICONS\\SPELL_NATURE_TIMESTOP"] = 136106,
    ["INTERFACE\\ICONS\\ABILITY_HUNTER_PET_GOTO"] = 457329,
    ["INTERFACE\\ICONS\\ABILITY_RACIAL_BLOODRAGE"] = 132270,
    ["INTERFACE\\ICONS\\ABILITY_PHYSICAL_TAUNT"] = 132270,
    ["INTERFACE\\ICONS\\ABILITY_DEFEND"] = 132110,
    ["INTERFACE\\ICONS\\SPELL_MAGIC_POLYMORPHCHICKEN"] = 132311,
    ["INTERFACE\\ICONS\\ABILITY_SEAL"] = 132311,
    ["INTERFACE\\ICONS\\ABILITY_HUNTER_PET_ASSIST"] = 524348,
}

local resolvedTextureCache = {}

-- Per-StreamDeck-Slot (1..116) state tables
local slotHasAction = {}
local slotFileDataID = {}
local slotSpellID = {}
local slotStacks = {}
local activeCooldownEnd = {}
local activeCooldownDuration = {}

-- Per-WoW-ActionSlot (1..180) state tables (supports stance/stealth paging on Bar 1 in combat)
local wowSlotHasAction = {}
local wowSlotFileDataID = {}
local wowSlotSpellID = {}
local wowSlotStacks = {}
local wowSlotCooldownEnd = {}
local wowSlotCooldownDuration = {}

-- SpellID -> Base Cooldown in seconds
local spellBaseCooldown = {}

for s = 1, MAX_SLOTS do
    slotHasAction[s] = false
    slotFileDataID[s] = 0
    slotSpellID[s] = 0
    slotStacks[s] = 0
    activeCooldownEnd[s] = 0
    activeCooldownDuration[s] = 0
end

for w = 1, 180 do
    wowSlotHasAction[w] = false
    wowSlotFileDataID[w] = 0
    wowSlotSpellID[w] = 0
    wowSlotStacks[w] = 0
    wowSlotCooldownEnd[w] = 0
    wowSlotCooldownDuration[w] = 0
end

-- ============================================================================
-- 4. TELEMETRY FRAME & OUT-OF-COMBAT ICON / SPELL / COOLDOWN SCANNER
-- ============================================================================

local telemetryFrame = CreateFrame("Frame", "WoWDeckTelemetryFrame", UIParent)
telemetryFrame:SetFrameStrata("TOOLTIP")
telemetryFrame:SetFrameLevel(9999)
telemetryFrame:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 0, 0)

local helperTex = telemetryFrame:CreateTexture(nil, "BACKGROUND")
helperTex:SetSize(1, 1)
helperTex:SetAlpha(0)

-- Strictly out-of-combat icon resolver
local function ResolveTextureToFileDataID(texOrToken, tokenName, spellID, blizzButton)
    if InCombatLockdown() then
        return 0
    end

    local numDirect = SafeNumber(texOrToken)
    if numDirect > 0 then
        return numDirect
    end

    if type(texOrToken) == "string" and resolvedTextureCache[texOrToken] then
        return resolvedTextureCache[texOrToken]
    end

    if type(tokenName) == "string" and tokenName ~= "" then
        local byName = PET_TOKEN_FILE_DATA_IDS[tokenName] or PET_TOKEN_FILE_DATA_IDS[string.upper(tokenName)]
        if byName then
            return byName
        end
    end

    local originalKey = type(texOrToken) == "string" and texOrToken or nil

    if type(texOrToken) == "string" and texOrToken ~= "" then
        local direct = PET_TOKEN_FILE_DATA_IDS[texOrToken]
            or PET_TOKEN_FILE_DATA_IDS[string.upper(string.gsub(texOrToken, "/", "\\"))]
        if direct then
            resolvedTextureCache[originalKey] = direct
            return direct
        end

        local globalVal = _G[texOrToken]
        local globalNum = SafeNumber(globalVal)
        if globalNum > 0 then
            resolvedTextureCache[originalKey] = globalNum
            return globalNum
        elseif type(globalVal) == "string" and globalVal ~= "" then
            local fromGlobal = PET_TOKEN_FILE_DATA_IDS[globalVal]
                or PET_TOKEN_FILE_DATA_IDS[string.upper(string.gsub(globalVal, "/", "\\"))]
            if fromGlobal then
                resolvedTextureCache[originalKey] = fromGlobal
                return fromGlobal
            end
            texOrToken = globalVal
        end
    end

    local safeSpellID = SafeNumber(spellID)
    if safeSpellID > 0 then
        if GetSpellTexture then
            local st = SafeNumber(GetSpellTexture(safeSpellID))
            if st > 0 then
                if originalKey then resolvedTextureCache[originalKey] = st end
                return st
            end
        end
        if C_Spell and C_Spell.GetSpellTexture then
            local st = SafeNumber(C_Spell.GetSpellTexture(safeSpellID))
            if st > 0 then
                if originalKey then resolvedTextureCache[originalKey] = st end
                return st
            end
        end
    end

    if blizzButton then
        local btnIcon = blizzButton.icon or (blizzButton.GetName and _G[blizzButton:GetName() .. "Icon"])
        if btnIcon then
            if btnIcon.GetTextureFileID then
                local fid = SafeNumber(btnIcon:GetTextureFileID())
                if fid > 0 then
                    if originalKey then resolvedTextureCache[originalKey] = fid end
                    return fid
                end
            end
            if btnIcon.GetTexture then
                local raw = SafeNumber(btnIcon:GetTexture())
                if raw > 0 then
                    if originalKey then resolvedTextureCache[originalKey] = raw end
                    return raw
                end
            end
        end
    end

    if type(texOrToken) == "string" and texOrToken ~= "" then
        helperTex:SetTexture(texOrToken)
        if helperTex.GetTextureFileID then
            local fid = SafeNumber(helperTex:GetTextureFileID())
            if fid > 0 then
                if originalKey then resolvedTextureCache[originalKey] = fid end
                return fid
            end
        end
        local numTex = SafeNumber(helperTex:GetTexture())
        if numTex > 0 then
            if originalKey then resolvedTextureCache[originalKey] = numTex end
            return numTex
        end
    end

    return 0
end

local function CacheBaseCooldownForSpell(spellID)
    local sID = SafeNumber(spellID)
    if sID <= 0 or InCombatLockdown() then
        return
    end
    if GetSpellBaseCooldown then
        local ok, baseMs = pcall(GetSpellBaseCooldown, sID)
        if ok then
            local sec = SafeNumber(baseMs) / 1000
            if sec > GCD_THRESHOLD then
                spellBaseCooldown[sID] = sec
                return
            end
        end
    end
    if C_Spell and C_Spell.GetSpellBaseCooldown then
        local ok, baseMs = pcall(C_Spell.GetSpellBaseCooldown, sID)
        if ok then
            local sec = SafeNumber(baseMs) / 1000
            if sec > GCD_THRESHOLD then
                spellBaseCooldown[sID] = sec
                return
            end
        end
    end
end

local function ResolveActionSlotSpellIDOutOfCombat(wowSlot)
    if InCombatLockdown() or not GetActionInfo then
        return 0
    end
    local ok, actionType, id = pcall(GetActionInfo, wowSlot)
    if not ok or not actionType then
        return 0
    end
    if actionType == "spell" then
        return SafeNumber(id)
    elseif actionType == "macro" and GetMacroSpell then
        local okM, macroSpellId = pcall(GetMacroSpell, id)
        if okM then
            return SafeNumber(macroSpellId)
        end
    end
    return 0
end

local function ReadCooldownOutOfCombat(wowSlot)
    if InCombatLockdown() then
        return 0, 0, 1
    end
    if GetActionCooldown then
        local ok, s, d, e = pcall(GetActionCooldown, wowSlot)
        if ok then
            if type(s) == "table" then
                return SafeNumber(s.startTime), SafeNumber(s.duration), SafeBoolean(s.isEnabled, true) and 1 or 0
            end
            return SafeNumber(s), SafeNumber(d), SafeBoolean(e, true) and 1 or 0
        end
    end
    if C_ActionBar and C_ActionBar.GetActionCooldown then
        local ok, cdInfo, d, e = pcall(C_ActionBar.GetActionCooldown, wowSlot)
        if ok then
            if type(cdInfo) == "table" then
                return SafeNumber(cdInfo.startTime), SafeNumber(cdInfo.duration), SafeBoolean(cdInfo.isEnabled, true) and 1 or 0
            end
            return SafeNumber(cdInfo), SafeNumber(d), SafeBoolean(e, true) and 1 or 0
        end
    end
    return 0, 0, 1
end

local function ReadUsableAndRange(wowSlot)
    local isUsable = true
    local notEnoughMana = false
    if IsUsableAction then
        local ok, u, m = pcall(IsUsableAction, wowSlot)
        if ok then
            if type(u) == "table" then
                isUsable = SafeBoolean(u.isUsable, true)
                notEnoughMana = SafeBoolean(u.notEnoughMana, false)
            else
                isUsable = SafeBoolean(u, true)
                notEnoughMana = SafeBoolean(m, false)
            end
        end
    elseif C_ActionBar and C_ActionBar.IsUsableAction then
        local ok, u, m = pcall(C_ActionBar.IsUsableAction, wowSlot)
        if ok then
            if type(u) == "table" then
                isUsable = SafeBoolean(u.isUsable, true)
                notEnoughMana = SafeBoolean(u.notEnoughMana, false)
            else
                isUsable = SafeBoolean(u, true)
                notEnoughMana = SafeBoolean(m, false)
            end
        end
    end

    local outOfRange = false
    if IsActionInRange then
        local ok, r = pcall(IsActionInRange, wowSlot)
        if ok and r ~= nil and not (issecretvalue and issecretvalue(r)) then
            outOfRange = (r == false or r == 0)
        end
    elseif C_ActionBar and C_ActionBar.IsActionInRange then
        local ok, r = pcall(C_ActionBar.IsActionInRange, wowSlot)
        if ok and r ~= nil and not (issecretvalue and issecretvalue(r)) then
            outOfRange = (r == false or r == 0)
        end
    end

    return isUsable, notEnoughMana, outOfRange
end

local function ScanSingleWoWActionSlotOutOfCombat(wowSlot, blizzBtnName)
    if InCombatLockdown() then
        return
    end

    local tex = nil
    if GetActionTexture then
        local ok, t = pcall(GetActionTexture, wowSlot)
        if ok then tex = t end
    elseif C_ActionBar and C_ActionBar.GetActionTexture then
        local ok, t = pcall(C_ActionBar.GetActionTexture, wowSlot)
        if ok then tex = t end
    end

    local hasAct = (tex ~= nil)
    if not hasAct and HasAction then
        local ok, h = pcall(HasAction, wowSlot)
        if ok then hasAct = SafeBoolean(h, false) end
    end

    wowSlotHasAction[wowSlot] = hasAct
    if not hasAct then
        wowSlotFileDataID[wowSlot] = 0
        wowSlotSpellID[wowSlot] = 0
        wowSlotStacks[wowSlot] = 0
        wowSlotCooldownEnd[wowSlot] = 0
        wowSlotCooldownDuration[wowSlot] = 0
        return
    end

    local spellID = ResolveActionSlotSpellIDOutOfCombat(wowSlot)
    wowSlotSpellID[wowSlot] = spellID
    if spellID > 0 then
        CacheBaseCooldownForSpell(spellID)
    end

    local blizzBtn = blizzBtnName and _G[blizzBtnName] or nil
    local fid = ResolveTextureToFileDataID(tex, nil, spellID, blizzBtn)
    if fid > 0 then
        wowSlotFileDataID[wowSlot] = fid
    end

    local stacks = 0
    if GetActionCount then
        local ok, c = pcall(GetActionCount, wowSlot)
        if ok then stacks = SafeNumber(c) end
    end
    wowSlotStacks[wowSlot] = stacks

    local start, duration, enable = ReadCooldownOutOfCombat(wowSlot)
    if start > 0 and duration > GCD_THRESHOLD and enable ~= 0 then
        wowSlotCooldownEnd[wowSlot] = start + duration
        wowSlotCooldownDuration[wowSlot] = duration
        if spellID > 0 then
            spellBaseCooldown[spellID] = duration
        end
    elseif start == 0 or duration <= GCD_THRESHOLD then
        wowSlotCooldownEnd[wowSlot] = 0
        wowSlotCooldownDuration[wowSlot] = 0
    end
end

local function ScanAllBonusBarSlotsOutOfCombat()
    if InCombatLockdown() then
        return
    end
    -- Scan bonus bar / paging action slots 73..120 out of combat so stance swaps in combat have icons & spellIDs ready
    for wowSlot = 73, 120 do
        ScanSingleWoWActionSlotOutOfCombat(wowSlot, nil)
    end
end

local function EncodeCooldownByte(seconds)
    local sec = SafeNumber(seconds)
    if sec <= 0 then
        return 0
    end
    local rounded = ceil(sec)
    if rounded <= 240 then
        return rounded
    end
    return min(255, 240 + ceil((rounded - 240) / 60))
end

local function ComputeSmoothCooldownMetrics(rem, totalDuration)
    if rem <= 0 then
        return 0, 0.0, false
    end
    local cdSeconds = EncodeCooldownByte(rem)
    local actualSeconds = ceil(rem)
    local denom = (totalDuration and totalDuration > 0) and totalDuration or max(1.0, actualSeconds)
    local progress = min(1.0, max(0.0, rem / denom))
    return cdSeconds, progress, true
end

local function QuerySlotTelemetry(sdIndex, now)
    local inCombat = InCombatLockdown()

    -- 1. Action Bars 1..8 (sdIndex 1..96)
    if sdIndex >= 1 and sdIndex <= 96 then
        local wowSlot = GetEffectiveWoWSlot(sdIndex)
        if not wowSlot then
            return false, 0, 0, false, false, false, false, 0, 0.0, 0
        end

        if not inCombat then
            ScanSingleWoWActionSlotOutOfCombat(wowSlot, SD_INDEX_TO_BLIZZ_BTN_NAME[sdIndex])
            slotHasAction[sdIndex] = wowSlotHasAction[wowSlot]
            slotFileDataID[sdIndex] = wowSlotFileDataID[wowSlot]
            slotSpellID[sdIndex] = wowSlotSpellID[wowSlot]
            slotStacks[sdIndex] = wowSlotStacks[wowSlot]
            activeCooldownEnd[sdIndex] = wowSlotCooldownEnd[wowSlot]
            activeCooldownDuration[sdIndex] = wowSlotCooldownDuration[wowSlot]
        end

        local hasAction = wowSlotHasAction[wowSlot]
        if hasAction == nil then
            hasAction = slotHasAction[sdIndex]
        end
        if not hasAction then
            return false, 0, 0, false, false, false, false, 0, 0.0, 0
        end

        local fileDataID = wowSlotFileDataID[wowSlot]
        if not fileDataID or fileDataID <= 0 then
            fileDataID = slotFileDataID[sdIndex] or 0
        end

        local endTime = max(activeCooldownEnd[sdIndex] or 0, wowSlotCooldownEnd[wowSlot] or 0)
        local totalDuration = max(activeCooldownDuration[sdIndex] or 0, wowSlotCooldownDuration[wowSlot] or 0)
        if totalDuration <= 0 then
            local spID = wowSlotSpellID[wowSlot] or slotSpellID[sdIndex] or 0
            if spID > 0 then
                totalDuration = spellBaseCooldown[spID] or 0
            end
        end

        local rem = endTime - now
        local cdSeconds, cdProgress, onCooldown = ComputeSmoothCooldownMetrics(rem, totalDuration)

        local isUsable, notEnoughMana, outOfRange = ReadUsableAndRange(wowSlot)
        local stacks = wowSlotStacks[wowSlot] or slotStacks[sdIndex] or 0

        return true, fileDataID, cdSeconds, onCooldown, isUsable, notEnoughMana, outOfRange, stacks, cdProgress, totalDuration

    -- 2. Stance Bar (sdIndex 97..106 -> Stance 1..10)
    elseif sdIndex >= 97 and sdIndex <= 106 then
        local stanceIndex = sdIndex - 96
        if not GetShapeshiftFormInfo then
            return false, 0, 0, false, false, false, false, 0, 0.0, 0
        end
        local numForms = GetNumShapeshiftForms and SafeNumber(GetNumShapeshiftForms()) or 0
        if stanceIndex < 1 or stanceIndex > numForms then
            slotHasAction[sdIndex] = false
            return false, 0, 0, false, false, false, false, 0, 0.0, 0
        end

        local icon, active, castable, spellID = GetShapeshiftFormInfo(stanceIndex)
        if not icon then
            slotHasAction[sdIndex] = false
            return false, 0, 0, false, false, false, false, 0, 0.0, 0
        end

        slotHasAction[sdIndex] = true
        local safeSpell = SafeNumber(spellID)

        if not inCombat then
            if safeSpell > 0 then
                slotSpellID[sdIndex] = safeSpell
                CacheBaseCooldownForSpell(safeSpell)
            end
            local stanceBtn = _G["StanceButton" .. stanceIndex] or _G["ShapeshiftButton" .. stanceIndex]
            local fid = ResolveTextureToFileDataID(icon, nil, safeSpell, stanceBtn)
            if fid > 0 then
                slotFileDataID[sdIndex] = fid
            end
            if GetShapeshiftFormCooldown then
                local ok, s, d, e = pcall(GetShapeshiftFormCooldown, stanceIndex)
                if ok then
                    local start = SafeNumber(s)
                    local duration = SafeNumber(d)
                    local enable = SafeBoolean(e, true)
                    if start > 0 and duration > GCD_THRESHOLD and enable then
                        activeCooldownEnd[sdIndex] = start + duration
                        activeCooldownDuration[sdIndex] = duration
                        if safeSpell > 0 then
                            spellBaseCooldown[safeSpell] = duration
                        end
                    elseif start == 0 or duration <= GCD_THRESHOLD then
                        activeCooldownEnd[sdIndex] = 0
                        activeCooldownDuration[sdIndex] = 0
                    end
                end
            end
        end

        local endTime = activeCooldownEnd[sdIndex] or 0
        local totalDuration = activeCooldownDuration[sdIndex] or (safeSpell > 0 and spellBaseCooldown[safeSpell]) or 0
        local rem = endTime - now
        local cdSeconds, cdProgress, onCooldown = ComputeSmoothCooldownMetrics(rem, totalDuration)

        local isCastable = SafeBoolean(castable, true)
        local isActive = SafeBoolean(active, false)
        return true, slotFileDataID[sdIndex] or 0, cdSeconds, onCooldown, isCastable, not isCastable, false, isActive and 1 or 0, cdProgress, totalDuration

    -- 3. Pet Bar (sdIndex 107..116 -> Pet 1..10)
    elseif sdIndex >= 107 and sdIndex <= 116 then
        local petIndex = sdIndex - 106
        if not GetPetActionInfo then
            return false, 0, 0, false, false, false, false, 0, 0.0, 0
        end
        local name, texture, isToken, isActive, _, _, spellID = GetPetActionInfo(petIndex)
        if not name and not texture then
            slotHasAction[sdIndex] = false
            return false, 0, 0, false, false, false, false, 0, 0.0, 0
        end

        slotHasAction[sdIndex] = true
        local safeSpell = SafeNumber(spellID)

        if not inCombat then
            if safeSpell > 0 then
                slotSpellID[sdIndex] = safeSpell
                CacheBaseCooldownForSpell(safeSpell)
            end
            local petBtn = _G["PetActionButton" .. petIndex]
            local resolvedTex = (SafeBoolean(isToken, false) and type(texture) == "string" and _G[texture]) or texture
            local fid = ResolveTextureToFileDataID(resolvedTex, name, safeSpell, petBtn)
            if fid == 0 and texture ~= resolvedTex then
                fid = ResolveTextureToFileDataID(texture, name, safeSpell, petBtn)
            end
            if fid > 0 then
                slotFileDataID[sdIndex] = fid
            end
            if GetPetActionCooldown then
                local ok, s, d, e = pcall(GetPetActionCooldown, petIndex)
                if ok then
                    local start = SafeNumber(s)
                    local duration = SafeNumber(d)
                    local enable = SafeBoolean(e, true)
                    if start > 0 and duration > GCD_THRESHOLD and enable then
                        activeCooldownEnd[sdIndex] = start + duration
                        activeCooldownDuration[sdIndex] = duration
                        if safeSpell > 0 then
                            spellBaseCooldown[safeSpell] = duration
                        end
                    elseif start == 0 or duration <= GCD_THRESHOLD then
                        activeCooldownEnd[sdIndex] = 0
                        activeCooldownDuration[sdIndex] = 0
                    end
                end
            end
        end

        local endTime = activeCooldownEnd[sdIndex] or 0
        local totalDuration = activeCooldownDuration[sdIndex] or (safeSpell > 0 and spellBaseCooldown[safeSpell]) or 0
        local rem = endTime - now
        local cdSeconds, cdProgress, onCooldown = ComputeSmoothCooldownMetrics(rem, totalDuration)

        local petUsable = true
        if GetPetActionsUsable then
            local ok, u = pcall(GetPetActionsUsable)
            if ok then
                petUsable = SafeBoolean(u, true)
            end
        end
        local activeFlag = SafeBoolean(isActive, false)
        return true, slotFileDataID[sdIndex] or 0, cdSeconds, onCooldown, petUsable, false, false, activeFlag and 1 or 0, cdProgress, totalDuration
    end

    return false, 0, 0, false, false, false, false, 0, 0.0, 0
end

-- ============================================================================
-- 5. CANDIDATE_KEY_POOL (174 VERIFIED CANDIDATES, INDEX 1..174)
-- ============================================================================

local BASE_KEYS_41 = {
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "NUMPADMULTIPLY",
    "NUMPADPLUS",
    "NUMPADMINUS",
    "NUMPADDIVIDE",
    "INSERT",
    "DELETE",
    "HOME",
    "END",
    "PAGEUP",
    "PAGEDOWN",
    "BACKSPACE",
    "UP",
    "DOWN",
    "LEFT",
    "RIGHT",
    "B",
    "C",
    "F",
    "G",
    "H",
    "I",
    "J",
    "K",
    "L",
    "M",
    "N",
    "O",
    "P",
    "T",
    "U",
    "V",
    "X",
}

local MOD_PREFIXES_4 = {
    "CTRL-SHIFT-", -- Pool 1..41
    "ALT-SHIFT-",  -- Pool 42..82
    "CTRL-",       -- Pool 83..123
    "ALT-",        -- Pool 124..164
}

local CANDIDATE_KEY_POOL = {}

for modIdx = 1, 4 do
    local prefix = MOD_PREFIXES_4[modIdx]
    for keyIdx = 1, 41 do
        CANDIDATE_KEY_POOL[#CANDIDATE_KEY_POOL + 1] = prefix .. BASE_KEYS_41[keyIdx]
    end
end

for numDigit = 0, 9 do
    CANDIDATE_KEY_POOL[#CANDIDATE_KEY_POOL + 1] = "CTRL-NUMPAD" .. numDigit
end

local TOTAL_CANDIDATES = #CANDIDATE_KEY_POOL -- 174

local PROTECTED_KEYS = {
    ["Q"] = true,
    ["E"] = true,
    ["R"] = true,
    ["W"] = true,
    ["A"] = true,
    ["S"] = true,
    ["D"] = true,
}

local slotToPoolIndex = {}
for s = 1, MAX_SLOTS do
    slotToPoolIndex[s] = s
end

-- ============================================================================
-- 6. TELEMETRY PIXEL STRIP LAYOUT & 20 Hz SECRET-FREE ENCODER
-- ============================================================================

local pixels = {}
local progressPixels = {}
local lastAppliedPhysHeight = 0
local lastAppliedUiHeight = 0

local function ApplyOneToOnePhysicalPixelScale()
    local _, physHeight = GetPhysicalScreenSize()
    physHeight = SafeNumber(physHeight)
    if physHeight <= 0 then
        physHeight = 1080
    end

    local uiHeight = (UIParent and UIParent.GetHeight and SafeNumber(UIParent:GetHeight())) or 768
    if uiHeight <= 0 then
        uiHeight = 768
    end

    lastAppliedPhysHeight = physHeight
    lastAppliedUiHeight = uiHeight

    local scale = uiHeight / physHeight
    if scale <= 0 then
        scale = 1
    end

    telemetryFrame:SetScale(scale)
    telemetryFrame:ClearAllPoints()
    telemetryFrame:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 0, 0)
end

local function LayoutTelemetryPixels()
    ApplyOneToOnePhysicalPixelScale()
    telemetryFrame:SetSize(TOTAL_PIXELS, 2)

    for pixelIndex = 0, TOTAL_PIXELS - 1 do
        local tex = pixels[pixelIndex]
        if not tex then
            tex = telemetryFrame:CreateTexture(nil, "OVERLAY")
            if tex.SetSnapToPixelGrid then
                tex:SetSnapToPixelGrid(false)
                tex:SetTexelSnappingBias(0)
            end
            tex:SetColorTexture(0, 0, 0, 1)
            pixels[pixelIndex] = tex
        end
        tex:ClearAllPoints()
        tex:SetSize(1, 1)
        tex:SetPoint("TOPLEFT", telemetryFrame, "TOPLEFT", pixelIndex, 0)

        local progTex = progressPixels[pixelIndex]
        if not progTex then
            progTex = telemetryFrame:CreateTexture(nil, "OVERLAY")
            if progTex.SetSnapToPixelGrid then
                progTex:SetSnapToPixelGrid(false)
                progTex:SetTexelSnappingBias(0)
            end
            progTex:SetColorTexture(0, 0, 0, 1)
            progressPixels[pixelIndex] = progTex
        end
        progTex:ClearAllPoints()
        progTex:SetSize(1, 1)
        progTex:SetPoint("TOPLEFT", telemetryFrame, "TOPLEFT", pixelIndex, -1)
    end

    pixels[0]:SetColorTexture(18 / 255, 52 / 255, 86 / 255, 1)
    pixels[1]:SetColorTexture(120 / 255, 154 / 255, 188 / 255, 1)

    progressPixels[0]:SetColorTexture(18 / 255, 52 / 255, 86 / 255, 1)
    progressPixels[1]:SetColorTexture(188 / 255, 154 / 255, 120 / 255, 1)
end

LayoutTelemetryPixels()

local function UpdateTelemetry()
    local _, curPhysH = GetPhysicalScreenSize()
    local curUiH = (UIParent and UIParent.GetHeight and SafeNumber(UIParent:GetHeight())) or 768
    if SafeNumber(curPhysH) ~= lastAppliedPhysHeight or math.abs(curUiH - lastAppliedUiHeight) > 0.01 then
        LayoutTelemetryPixels()
    end

    local p0 = pixels[0]
    local p1 = pixels[1]
    if p0 then p0:SetColorTexture(18 / 255, 52 / 255, 86 / 255, 1) end
    if p1 then p1:SetColorTexture(120 / 255, 154 / 255, 188 / 255, 1) end

    local pp0 = progressPixels[0]
    local pp1 = progressPixels[1]
    if pp0 then pp0:SetColorTexture(18 / 255, 52 / 255, 86 / 255, 1) end
    if pp1 then pp1:SetColorTexture(188 / 255, 154 / 255, 120 / 255, 1) end

    local now = SafeNumber(GetTime())

    for s = 1, MAX_SLOTS do
        local pixelAIndex = 2 + (s - 1) * 2
        local pixelBIndex = pixelAIndex + 1
        local texA = pixels[pixelAIndex]
        local texB = pixels[pixelBIndex]
        local progTexA = progressPixels[pixelAIndex]
        local progTexB = progressPixels[pixelBIndex]

        if texA and texB then
            local poolIdx = ClampByte(slotToPoolIndex[s] or s)

            local ok, hasAction, fileDataID, cdSeconds, onCooldown, isUsable, notEnoughMana, outOfRange, stacks, cdProgress, totalDuration =
                pcall(QuerySlotTelemetry, s, now)
            if not ok then
                hasAction = false
                cdProgress = 0.0
                totalDuration = 0
            end

            fileDataID = SafeNumber(fileDataID)
            cdSeconds = ClampByte(cdSeconds)
            stacks = SafeNumber(stacks)
            cdProgress = min(1.0, max(0.0, SafeNumber(cdProgress)))
            totalDuration = SafeNumber(totalDuration)

            if hasAction and fileDataID > 0 then
                local rA = band(rshift(fileDataID, 16), 0xFF)
                local gA = band(rshift(fileDataID, 8), 0xFF)
                local bA = band(fileDataID, 0xFF)
                texA:SetColorTexture(rA / 255, gA / 255, bA / 255, 1)
            else
                texA:SetColorTexture(0, 0, 0, 1)
            end

            if hasAction then
                local mask = 1 -- Bit 0: hasAction
                if isUsable then
                    mask = bor(mask, 2) -- Bit 1: isUsable
                end
                if notEnoughMana then
                    mask = bor(mask, 4) -- Bit 2: notEnoughMana
                end
                if outOfRange then
                    mask = bor(mask, 8) -- Bit 3: outOfRange
                end
                if onCooldown then
                    mask = bor(mask, 16) -- Bit 4: onCooldown / active
                end

                local clampedStacks = min(7, max(0, floor(stacks)))
                local greenByte = bor(mask, lshift(clampedStacks, 5))

                texB:SetColorTexture(cdSeconds / 255, greenByte / 255, poolIdx / 255, 1)

                if progTexA and progTexB then
                    if onCooldown and cdProgress > 0 then
                        local prog16 = min(65535, max(0, floor(cdProgress * 65535 + 0.5)))
                        local pHigh = band(rshift(prog16, 8), 0xFF)
                        local pLow = band(prog16, 0xFF)
                        local durByte = EncodeCooldownByte(totalDuration)
                        progTexA:SetColorTexture(pHigh / 255, pLow / 255, durByte / 255, 1)
                        progTexB:SetColorTexture(cdProgress, cdProgress, cdProgress, 1)
                    else
                        progTexA:SetColorTexture(0, 0, 0, 1)
                        progTexB:SetColorTexture(0, 0, 0, 1)
                    end
                end
            else
                texB:SetColorTexture(0, 0, poolIdx / 255, 1)
                if progTexA and progTexB then
                    progTexA:SetColorTexture(0, 0, 0, 1)
                    progTexB:SetColorTexture(0, 0, 0, 1)
                end
            end
        end
    end
end

local elapsedAccumulator = 0
telemetryFrame:SetScript("OnUpdate", function(self, elapsed)
    elapsedAccumulator = elapsedAccumulator + SafeNumber(elapsed)
    if elapsedAccumulator >= UPDATE_INTERVAL then
        elapsedAccumulator = 0
        UpdateTelemetry()
    end
end)

-- ============================================================================
-- 7. DYNAMIC ZERO-COLLISION RUNTIME KEYBINDING ALLOCATOR & EVENT HANDLER
-- ============================================================================

local bindingOwner = CreateFrame("Frame", "WoWDeckBindingOwnerFrame", UIParent)
local secureButtons = {}
local needsBindingUpdate = false
local isAllocatingBindings = false

local function ConfigureSecureButtonForSlot(btn, sdIndex)
    if InCombatLockdown() then
        needsBindingUpdate = true
        return
    end

    if sdIndex >= 1 and sdIndex <= 12 then
        local blizzBtnName = SD_INDEX_TO_BLIZZ_BTN_NAME[sdIndex]
        local blizzBtn = blizzBtnName and _G[blizzBtnName] or nil
        if blizzBtn then
            btn:SetAttribute("type", "click")
            btn:SetAttribute("clickbutton", blizzBtn)
        else
            btn:SetAttribute("type", "action")
            btn:SetAttribute("action", SD_INDEX_TO_WOW_SLOT[sdIndex])
        end
    elseif sdIndex >= 13 and sdIndex <= 96 then
        local wowSlot = SD_INDEX_TO_WOW_SLOT[sdIndex]
        btn:SetAttribute("type", "action")
        btn:SetAttribute("action", wowSlot)
    elseif sdIndex >= 97 and sdIndex <= 106 then
        local stanceIndex = sdIndex - 96
        local stanceBtn = _G["StanceButton" .. stanceIndex] or _G["ShapeshiftButton" .. stanceIndex]
        if stanceBtn then
            btn:SetAttribute("type", "click")
            btn:SetAttribute("clickbutton", stanceBtn)
        else
            local numForms = GetNumShapeshiftForms and SafeNumber(GetNumShapeshiftForms()) or 0
            local spellID = 0
            if GetShapeshiftFormInfo and stanceIndex >= 1 and stanceIndex <= numForms then
                local _, _, _, sID = GetShapeshiftFormInfo(stanceIndex)
                spellID = SafeNumber(sID)
            end
            if spellID > 0 then
                btn:SetAttribute("type", "spell")
                btn:SetAttribute("spell", spellID)
            else
                btn:SetAttribute("type", "click")
            end
        end
    elseif sdIndex >= 107 and sdIndex <= 116 then
        local petIndex = sdIndex - 106
        local petBtn = _G["PetActionButton" .. petIndex]
        if petBtn then
            btn:SetAttribute("type", "click")
            btn:SetAttribute("clickbutton", petBtn)
        else
            btn:SetAttribute("type", "pet")
            btn:SetAttribute("action", petIndex)
        end
    end
end

local function IsCandidateKeyFreeInWoW(wowKey)
    if not wowKey or wowKey == "" then
        return false
    end
    if PROTECTED_KEYS[wowKey] then
        return false
    end
    if GetBindingAction then
        local existingAction = GetBindingAction(wowKey, false)
        if existingAction and existingAction ~= "" then
            return false
        end
    end
    return true
end

local function AllocateDynamicZeroCollisionBindings()
    if InCombatLockdown() then
        needsBindingUpdate = true
        return false
    end
    if isAllocatingBindings then
        return false
    end

    isAllocatingBindings = true

    ClearOverrideBindings(bindingOwner)

    local usedPoolIndices = {}
    local searchCursor = 1

    for sdIndex = 1, MAX_SLOTS do
        local btnName = "WoWDeckSecureBtn" .. sdIndex
        local btn = secureButtons[sdIndex]
        if not btn then
            btn = CreateFrame("Button", btnName, UIParent, "SecureActionButtonTemplate")
            btn:SetSize(1, 1)
            btn:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 0, 0)
            btn:SetAlpha(0)
            btn:EnableMouse(false)
            btn:RegisterForClicks("AnyDown", "AnyUp")
            btn:Show()
            secureButtons[sdIndex] = btn
        else
            btn:RegisterForClicks("AnyDown", "AnyUp")
        end

        ConfigureSecureButtonForSlot(btn, sdIndex)

        local assignedPoolIdx = nil
        while searchCursor <= TOTAL_CANDIDATES do
            local candidateKey = CANDIDATE_KEY_POOL[searchCursor]
            local idx = searchCursor
            searchCursor = searchCursor + 1

            if IsCandidateKeyFreeInWoW(candidateKey) then
                assignedPoolIdx = idx
                usedPoolIndices[idx] = true
                break
            end
        end

        if not assignedPoolIdx then
            for fallbackIdx = 1, TOTAL_CANDIDATES do
                if not usedPoolIndices[fallbackIdx] then
                    assignedPoolIdx = fallbackIdx
                    usedPoolIndices[fallbackIdx] = true
                    break
                end
            end
        end

        if assignedPoolIdx then
            slotToPoolIndex[sdIndex] = assignedPoolIdx
            local candidateKey = CANDIDATE_KEY_POOL[assignedPoolIdx]
            SetOverrideBindingClick(bindingOwner, false, candidateKey, btnName, "LeftButton")
        end
    end

    ScanAllBonusBarSlotsOutOfCombat()

    needsBindingUpdate = false
    isAllocatingBindings = false
    return true
end

if not InCombatLockdown() then
    AllocateDynamicZeroCollisionBindings()
else
    needsBindingUpdate = true
end

bindingOwner:RegisterEvent("PLAYER_LOGIN")
bindingOwner:RegisterEvent("PLAYER_ENTERING_WORLD")
bindingOwner:RegisterEvent("PLAYER_REGEN_ENABLED")
bindingOwner:RegisterEvent("ACTIONBAR_SLOT_CHANGED")
bindingOwner:RegisterEvent("SPELLS_CHANGED")
bindingOwner:RegisterEvent("UPDATE_SHAPESHIFT_FORMS")
bindingOwner:RegisterEvent("UNIT_SPELLCAST_SUCCEEDED")
bindingOwner:RegisterEvent("UI_SCALE_CHANGED")
bindingOwner:RegisterEvent("DISPLAY_SIZE_CHANGED")

local function SafeReallocate()
    if InCombatLockdown() then
        needsBindingUpdate = true
        return
    end
    if isAllocatingBindings then
        return
    end
    AllocateDynamicZeroCollisionBindings()
    UpdateTelemetry()
end

bindingOwner:SetScript("OnEvent", function(self, event, arg1, arg2, arg3)
    if event == "UNIT_SPELLCAST_SUCCEEDED" then
        if arg1 == "player" or arg1 == "pet" then
            local castSpellID = SafeNumber(arg3)
            if castSpellID > 0 then
                local baseCD = spellBaseCooldown[castSpellID] or 0
                if baseCD > GCD_THRESHOLD then
                    local endTime = SafeNumber(GetTime()) + baseCD
                    for s = 1, MAX_SLOTS do
                        if slotSpellID[s] == castSpellID then
                            activeCooldownEnd[s] = endTime
                            activeCooldownDuration[s] = baseCD
                        end
                    end
                    for w = 1, 180 do
                        if wowSlotSpellID[w] == castSpellID then
                            wowSlotCooldownEnd[w] = endTime
                            wowSlotCooldownDuration[w] = baseCD
                        end
                    end
                end
            end
        end
    elseif event == "PLAYER_LOGIN" or event == "PLAYER_ENTERING_WORLD" then
        LayoutTelemetryPixels()
        SafeReallocate()
    elseif event == "PLAYER_REGEN_ENABLED" then
        if needsBindingUpdate then
            SafeReallocate()
        else
            ScanAllBonusBarSlotsOutOfCombat()
            UpdateTelemetry()
        end
    elseif event == "ACTIONBAR_SLOT_CHANGED" or event == "SPELLS_CHANGED" then
        if not InCombatLockdown() then
            ScanAllBonusBarSlotsOutOfCombat()
            UpdateTelemetry()
        end
    elseif event == "UPDATE_SHAPESHIFT_FORMS" then
        UpdateTelemetry()
    elseif event == "UI_SCALE_CHANGED" or event == "DISPLAY_SIZE_CHANGED" then
        LayoutTelemetryPixels()
        UpdateTelemetry()
        if C_Timer and C_Timer.After then
            C_Timer.After(0.2, function()
                LayoutTelemetryPixels()
                UpdateTelemetry()
            end)
            C_Timer.After(0.5, function()
                LayoutTelemetryPixels()
                UpdateTelemetry()
            end)
        end
    end
end)

SLASH_WOWDECK1 = "/wowdeck"
SlashCmdList["WOWDECK"] = function()
    if InCombatLockdown() then
        needsBindingUpdate = true
        print("|cff00ff98WoWDeckBridge Forever:|r In combat lockdown – binding update queued for combat end.")
    else
        LayoutTelemetryPixels()
        SafeReallocate()
        local k1 = CANDIDATE_KEY_POOL[slotToPoolIndex[1] or 1] or "?"
        local k2 = CANDIDATE_KEY_POOL[slotToPoolIndex[2] or 2] or "?"
        print("|cff00ff98WoWDeckBridge Forever:|r 116 slots active (Slot 1 -> " .. k1 .. ", Slot 2 -> " .. k2 .. ").")
    end
end
