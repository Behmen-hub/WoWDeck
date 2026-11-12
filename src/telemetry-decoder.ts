/**
 * Binary RGB Telemetry Protocol Encoder, Decoder, Sync-Scanner & Dynamic Zero-Collision Key Pool
 * for WoWDeck (234x1 Pixel Strip @ TOPLEFT 0,0 for 116 Slots)
 *   Index 1-12:    Aktionsleiste 1 -> WoW Action-Slots 1..12
 *   Index 13-24:   Aktionsleiste 2 -> WoW Action-Slots 61..72
 *   Index 25-36:   Aktionsleiste 3 -> WoW Action-Slots 49..60
 *   Index 37-48:   Aktionsleiste 4 -> WoW Action-Slots 25..36
 *   Index 49-60:   Aktionsleiste 5 -> WoW Action-Slots 37..48
 *   Index 61-72:   Aktionsleiste 6 -> WoW Action-Slots 145..156
 *   Index 73-84:   Aktionsleiste 7 -> WoW Action-Slots 157..168
 *   Index 85-96:   Aktionsleiste 8 -> WoW Action-Slots 169..180
 *   Index 97-106:  Haltungsleiste  -> Stance-Slots 1..10
 *   Index 107-116: Begleiterleiste -> Pet-Slots 1..10
 *
 * Dynamic Runtime Key Allocation (Zero-Collision):
 *   WoW allocates unused keys from CANDIDATE_KEY_POOL (1..174) at runtime
 *   and transmits the assigned keyPoolIndex in the Blue channel of Pixel 2.
 */

export interface RGBPixel {
    r: number;
    g: number;
    b: number;
}

export interface SlotStatusFlags {
    hasAction: boolean;
    isUsable: boolean;
    notEnoughMana: boolean;
    outOfRange: boolean;
    onCooldown: boolean;
}

export interface DecodedSlotTelemetry extends SlotStatusFlags {
    slot: number;
    fileDataId: number;
    cooldown: number;
    /**
     * Floating-point remaining cooldown ratio (0.0 to 1.0, i.e. rem / totalDuration)
     * with sub-second millisecond precision.
     */
    cooldownProgress?: number;
    /**
     * Total cooldown duration in seconds when transmitted by WoWDeckBridge.lua.
     */
    cooldownTotalDuration?: number;
    stacks: number;
    rawMask: number;
    keyPoolIndex: number;
}

export interface CandidateKeyEntry {
    poolIndex: number;
    slot: number;
    keyName: string;
    vkCode: number;
    isExtendedKey: boolean;
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    wowComboString: string;
}

export type SlotKeyBinding = CandidateKeyEntry;

export const MAX_ACTION_SLOTS = 116;
export const MAX_CANDIDATE_POOL_SIZE = 174;
export const TELEMETRY_STRIP_WIDTH = 234; // 2 Sync Header pixels + 116 * 2 Slot pixels

export const SYNC_HEADER_0: Readonly<RGBPixel> = Object.freeze({ r: 18, g: 52, b: 86 }); // 0x12, 0x34, 0x56
export const SYNC_HEADER_1: Readonly<RGBPixel> = Object.freeze({ r: 120, g: 154, b: 188 }); // 0x78, 0x9A, 0xBC
export const SYNC_HEADER_ROW1: Readonly<RGBPixel> = Object.freeze({ r: 188, g: 154, b: 120 }); // Row 1 sub-second cooldown progress marker

export const STATUS_BITS = Object.freeze({
    HAS_ACTION: 1 << 0, // 1
    IS_USABLE: 1 << 1, // 2
    NOT_ENOUGH_MANA: 1 << 2, // 4
    OUT_OF_RANGE: 1 << 3, // 8
    ON_COOLDOWN: 1 << 4, // 16
});

/**
 * Base WoW Action-Slot IDs for Action Bars 1 to 8.
 */
export const ACTION_BAR_BASE_WOW_SLOTS: ReadonlyArray<number> = Object.freeze([
    1, // Aktionsleiste 1 (Index 1-12)   -> WoW Slots 1-12
    61, // Aktionsleiste 2 (Index 13-24)  -> WoW Slots 61-72
    49, // Aktionsleiste 3 (Index 25-36)  -> WoW Slots 49-60
    25, // Aktionsleiste 4 (Index 37-48)  -> WoW Slots 25-36
    37, // Aktionsleiste 5 (Index 49-60)  -> WoW Slots 37-48
    145, // Aktionsleiste 6 (Index 61-72) -> WoW Slots 145-156
    157, // Aktionsleiste 7 (Index 73-84) -> WoW Slots 157-168
    169, // Aktionsleiste 8 (Index 85-96) -> WoW Slots 169-180
]);

/**
 * Maps a Stream Deck Action Bar Index (1..96) to its true WoW Action Slot ID.
 * Returns null for Stance (97..106) and Pet (107..116) indices.
 */
export function getWoWActionSlotForStreamDeckIndex(sdIndex: number): number | null {
    if (sdIndex < 1 || sdIndex > 96) {
        return null;
    }
    const barIdx = Math.floor((sdIndex - 1) / 12); // 0..7
    const btnOffset = (sdIndex - 1) % 12; // 0..11
    return ACTION_BAR_BASE_WOW_SLOTS[barIdx] + btnOffset;
}

export interface VirtualKeyDefinition {
    keyName: string;
    vkCode: number;
    isExtendedKey: boolean;
}

export const BASE_KEYS_41: ReadonlyArray<VirtualKeyDefinition> = Object.freeze([
    { keyName: "1", vkCode: 0x31, isExtendedKey: false },
    { keyName: "2", vkCode: 0x32, isExtendedKey: false },
    { keyName: "3", vkCode: 0x33, isExtendedKey: false },
    { keyName: "4", vkCode: 0x34, isExtendedKey: false },
    { keyName: "5", vkCode: 0x35, isExtendedKey: false },
    { keyName: "6", vkCode: 0x36, isExtendedKey: false },
    { keyName: "7", vkCode: 0x37, isExtendedKey: false },
    { keyName: "8", vkCode: 0x38, isExtendedKey: false },
    { keyName: "9", vkCode: 0x39, isExtendedKey: false },
    { keyName: "NUMPADMULTIPLY", vkCode: 0x6a, isExtendedKey: false },
    { keyName: "NUMPADPLUS", vkCode: 0x6b, isExtendedKey: false },
    { keyName: "NUMPADMINUS", vkCode: 0x6d, isExtendedKey: false },
    { keyName: "NUMPADDIVIDE", vkCode: 0x6f, isExtendedKey: true },
    { keyName: "INSERT", vkCode: 0x2d, isExtendedKey: true },
    { keyName: "DELETE", vkCode: 0x2e, isExtendedKey: true },
    { keyName: "HOME", vkCode: 0x24, isExtendedKey: true },
    { keyName: "END", vkCode: 0x23, isExtendedKey: true },
    { keyName: "PAGEUP", vkCode: 0x21, isExtendedKey: true },
    { keyName: "PAGEDOWN", vkCode: 0x22, isExtendedKey: true },
    { keyName: "BACKSPACE", vkCode: 0x08, isExtendedKey: false },
    { keyName: "UP", vkCode: 0x26, isExtendedKey: true },
    { keyName: "DOWN", vkCode: 0x28, isExtendedKey: true },
    { keyName: "LEFT", vkCode: 0x25, isExtendedKey: true },
    { keyName: "RIGHT", vkCode: 0x27, isExtendedKey: true },
    { keyName: "B", vkCode: 0x42, isExtendedKey: false },
    { keyName: "C", vkCode: 0x43, isExtendedKey: false },
    { keyName: "F", vkCode: 0x46, isExtendedKey: false },
    { keyName: "G", vkCode: 0x47, isExtendedKey: false },
    { keyName: "H", vkCode: 0x48, isExtendedKey: false },
    { keyName: "I", vkCode: 0x49, isExtendedKey: false },
    { keyName: "J", vkCode: 0x4a, isExtendedKey: false },
    { keyName: "K", vkCode: 0x4b, isExtendedKey: false },
    { keyName: "L", vkCode: 0x4c, isExtendedKey: false },
    { keyName: "M", vkCode: 0x4d, isExtendedKey: false },
    { keyName: "N", vkCode: 0x4e, isExtendedKey: false },
    { keyName: "O", vkCode: 0x4f, isExtendedKey: false },
    { keyName: "P", vkCode: 0x50, isExtendedKey: false },
    { keyName: "T", vkCode: 0x54, isExtendedKey: false },
    { keyName: "U", vkCode: 0x55, isExtendedKey: false },
    { keyName: "V", vkCode: 0x56, isExtendedKey: false },
    { keyName: "X", vkCode: 0x58, isExtendedKey: false },
]);

export const NUMPAD_DIGITS_10: ReadonlyArray<VirtualKeyDefinition> = Object.freeze([
    { keyName: "NUMPAD0", vkCode: 0x60, isExtendedKey: false },
    { keyName: "NUMPAD1", vkCode: 0x61, isExtendedKey: false },
    { keyName: "NUMPAD2", vkCode: 0x62, isExtendedKey: false },
    { keyName: "NUMPAD3", vkCode: 0x63, isExtendedKey: false },
    { keyName: "NUMPAD4", vkCode: 0x64, isExtendedKey: false },
    { keyName: "NUMPAD5", vkCode: 0x65, isExtendedKey: false },
    { keyName: "NUMPAD6", vkCode: 0x66, isExtendedKey: false },
    { keyName: "NUMPAD7", vkCode: 0x67, isExtendedKey: false },
    { keyName: "NUMPAD8", vkCode: 0x68, isExtendedKey: false },
    { keyName: "NUMPAD9", vkCode: 0x69, isExtendedKey: false },
]);

function buildCandidateKeyPool(): ReadonlyArray<CandidateKeyEntry> {
    const pool: CandidateKeyEntry[] = [];

    // 1..41: CTRL-SHIFT- + BASE_KEYS_41
    for (const def of BASE_KEYS_41) {
        const idx = pool.length + 1;
        pool.push(
            Object.freeze({
                poolIndex: idx,
                slot: idx,
                keyName: def.keyName,
                vkCode: def.vkCode,
                isExtendedKey: def.isExtendedKey,
                ctrl: true,
                alt: false,
                shift: true,
                wowComboString: `CTRL-SHIFT-${def.keyName}`,
            }),
        );
    }

    // 42..82: ALT-SHIFT- + BASE_KEYS_41
    for (const def of BASE_KEYS_41) {
        const idx = pool.length + 1;
        pool.push(
            Object.freeze({
                poolIndex: idx,
                slot: idx,
                keyName: def.keyName,
                vkCode: def.vkCode,
                isExtendedKey: def.isExtendedKey,
                ctrl: false,
                alt: true,
                shift: true,
                wowComboString: `ALT-SHIFT-${def.keyName}`,
            }),
        );
    }

    // 83..123: CTRL- + BASE_KEYS_41
    for (const def of BASE_KEYS_41) {
        const idx = pool.length + 1;
        pool.push(
            Object.freeze({
                poolIndex: idx,
                slot: idx,
                keyName: def.keyName,
                vkCode: def.vkCode,
                isExtendedKey: def.isExtendedKey,
                ctrl: true,
                alt: false,
                shift: false,
                wowComboString: `CTRL-${def.keyName}`,
            }),
        );
    }

    // 124..164: ALT- + BASE_KEYS_41
    for (const def of BASE_KEYS_41) {
        const idx = pool.length + 1;
        pool.push(
            Object.freeze({
                poolIndex: idx,
                slot: idx,
                keyName: def.keyName,
                vkCode: def.vkCode,
                isExtendedKey: def.isExtendedKey,
                ctrl: false,
                alt: true,
                shift: false,
                wowComboString: `ALT-${def.keyName}`,
            }),
        );
    }

    // 165..174: CTRL-NUMPAD0 .. CTRL-NUMPAD9
    for (const def of NUMPAD_DIGITS_10) {
        const idx = pool.length + 1;
        pool.push(
            Object.freeze({
                poolIndex: idx,
                slot: idx,
                keyName: def.keyName,
                vkCode: def.vkCode,
                isExtendedKey: def.isExtendedKey,
                ctrl: true,
                alt: false,
                shift: false,
                wowComboString: `CTRL-${def.keyName}`,
            }),
        );
    }

    return Object.freeze(pool);
}

export const CANDIDATE_KEY_POOL: ReadonlyArray<CandidateKeyEntry> = buildCandidateKeyPool();

export function getCandidateKeyByPoolIndex(poolIndex: number): CandidateKeyEntry {
    const clamped = Math.max(
        1,
        Math.min(MAX_CANDIDATE_POOL_SIZE, Math.floor(Number(poolIndex) || 1)),
    );
    return CANDIDATE_KEY_POOL[clamped - 1];
}

export function getSlotKeyBinding(slotOrPoolIndex: number): CandidateKeyEntry {
    return getCandidateKeyByPoolIndex(slotOrPoolIndex);
}

export function clampByte(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (value >= 255) return 255;
    return Math.floor(value) & 0xff;
}

export function encodeFileDataId(fileDataId: number): RGBPixel {
    if (!Number.isFinite(fileDataId) || fileDataId <= 0) {
        return { r: 0, g: 0, b: 0 };
    }
    const id = Math.floor(fileDataId) >>> 0;
    return {
        r: (id >>> 16) & 0xff,
        g: (id >>> 8) & 0xff,
        b: id & 0xff,
    };
}

export function decodeFileDataId(pixel: RGBPixel): number {
    const r = pixel.r & 0xff;
    const g = pixel.g & 0xff;
    const b = pixel.b & 0xff;
    return ((r << 16) | (g << 8) | b) >>> 0;
}

export function encodeStatusBitmask(flags: SlotStatusFlags): number {
    let mask = 0;
    if (flags.hasAction) mask |= STATUS_BITS.HAS_ACTION;
    if (flags.isUsable) mask |= STATUS_BITS.IS_USABLE;
    if (flags.notEnoughMana) mask |= STATUS_BITS.NOT_ENOUGH_MANA;
    if (flags.outOfRange) mask |= STATUS_BITS.OUT_OF_RANGE;
    if (flags.onCooldown) mask |= STATUS_BITS.ON_COOLDOWN;
    return mask & 0x1f;
}

export function decodeStatusBitmask(mask: number): SlotStatusFlags {
    const m = mask & 0x1f;
    return {
        hasAction: (m & STATUS_BITS.HAS_ACTION) !== 0,
        isUsable: (m & STATUS_BITS.IS_USABLE) !== 0,
        notEnoughMana: (m & STATUS_BITS.NOT_ENOUGH_MANA) !== 0,
        outOfRange: (m & STATUS_BITS.OUT_OF_RANGE) !== 0,
        onCooldown: (m & STATUS_BITS.ON_COOLDOWN) !== 0,
    };
}

export function encodeCooldownByte(seconds: number): number {
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    const rounded = Math.ceil(seconds);
    if (rounded <= 240) return rounded;
    return Math.min(255, 240 + Math.ceil((rounded - 240) / 60));
}

export function decodeCooldownByte(byteVal: number): number {
    const b = clampByte(byteVal);
    if (b <= 240) return b;
    return 240 + (b - 240) * 60;
}

export function encodeSlotPixelB(params: {
    cooldown: number;
    flags: SlotStatusFlags;
    stacks: number;
    keyPoolIndex?: number;
}): RGBPixel {
    const poolIdx = clampByte(params.keyPoolIndex ?? 0);
    if (!params.flags.hasAction) {
        return { r: 0, g: 0, b: poolIdx };
    }
    const statusMask = encodeStatusBitmask(params.flags) & 0x1f;
    const clampedStacks = Math.min(7, Math.max(0, Math.floor(params.stacks || 0))) & 0x07;
    const gByte = (statusMask | (clampedStacks << 5)) & 0xff;
    return {
        r: encodeCooldownByte(params.cooldown),
        g: gByte,
        b: poolIdx,
    };
}

export function decodeSlotPixels(
    slot: number,
    pixelA: RGBPixel,
    pixelB: RGBPixel,
): DecodedSlotTelemetry {
    const fileDataId = decodeFileDataId(pixelA);
    const cooldown = decodeCooldownByte(pixelB.r);
    const rawG = clampByte(pixelB.g);
    const rawMask = rawG & 0x1f;
    const stacks = (rawG >>> 5) & 0x07;
    const keyPoolIndex = clampByte(pixelB.b);
    const flags = decodeStatusBitmask(rawMask);

    return {
        slot,
        fileDataId: flags.hasAction ? fileDataId : 0,
        cooldown: flags.hasAction ? cooldown : 0,
        stacks: flags.hasAction ? stacks : 0,
        rawMask,
        keyPoolIndex,
        ...flags,
    };
}

export function encodeTelemetryStrip(
    slots: ReadonlyArray<Partial<DecodedSlotTelemetry>>,
): RGBPixel[] {
    const strip: RGBPixel[] = new Array(TELEMETRY_STRIP_WIDTH);
    strip[0] = { ...SYNC_HEADER_0 };
    strip[1] = { ...SYNC_HEADER_1 };

    for (let s = 1; s <= MAX_ACTION_SLOTS; s++) {
        const idxA = 2 + (s - 1) * 2;
        const idxB = idxA + 1;
        const slotState = slots.find((item) => item.slot === s) ?? slots[s - 1];
        const poolIndex = slotState?.keyPoolIndex ?? s;

        if (slotState && slotState.hasAction) {
            strip[idxA] = encodeFileDataId(slotState.fileDataId ?? 0);
            strip[idxB] = encodeSlotPixelB({
                cooldown: slotState.cooldown ?? 0,
                stacks: slotState.stacks ?? 0,
                keyPoolIndex: poolIndex,
                flags: {
                    hasAction: true,
                    isUsable: Boolean(slotState.isUsable),
                    notEnoughMana: Boolean(slotState.notEnoughMana),
                    outOfRange: Boolean(slotState.outOfRange),
                    onCooldown: Boolean(slotState.onCooldown),
                },
            });
        } else {
            strip[idxA] = { r: 0, g: 0, b: 0 };
            strip[idxB] = { r: 0, g: 0, b: clampByte(poolIndex) };
        }
    }

    return strip;
}

export function isPixelMatch(a: RGBPixel, b: RGBPixel, tolerance = 0): boolean {
    return (
        Math.abs(a.r - b.r) <= tolerance &&
        Math.abs(a.g - b.g) <= tolerance &&
        Math.abs(a.b - b.b) <= tolerance
    );
}

export function decodeTelemetryStripAtOffset(
    pixels: ReadonlyArray<RGBPixel>,
    offset = 0,
    tolerance = 0,
): DecodedSlotTelemetry[] | null {
    if (pixels.length < offset + TELEMETRY_STRIP_WIDTH) {
        return null;
    }
    if (
        !isPixelMatch(pixels[offset], SYNC_HEADER_0, tolerance) ||
        !isPixelMatch(pixels[offset + 1], SYNC_HEADER_1, tolerance)
    ) {
        return null;
    }

    const result: DecodedSlotTelemetry[] = new Array(MAX_ACTION_SLOTS);
    for (let s = 1; s <= MAX_ACTION_SLOTS; s++) {
        const pixelA = pixels[offset + 2 + (s - 1) * 2];
        const pixelB = pixels[offset + 2 + (s - 1) * 2 + 1];
        result[s - 1] = decodeSlotPixels(s, pixelA, pixelB);
    }
    return result;
}

/**
 * Scans a 2D BGRA pixel buffer (as returned by Windows GDI GetDIBits)
 * in the top-left region for the 1:1 Physical Pixel Sync Header:
 *   Pixel 0 == [18, 52, 86] (0x12, 0x34, 0x56)
 *   Pixel 1 == [120, 154, 188] (0x78, 0x9A, 0xBC)
 * Decodes all 116 slots (234 pixels total).
 */
export function scanAndDecodeBgraBuffer(
    bgra: Uint8Array | Buffer,
    width: number,
    height: number,
    tolerance = 4,
): { slots: DecodedSlotTelemetry[]; syncX: number; syncY: number } | null {
    if (width < TELEMETRY_STRIP_WIDTH || height < 1) {
        return null;
    }
    const requiredBytes = width * height * 4;
    if (bgra.length < requiredBytes) {
        return null;
    }

    const maxSearchX = width - TELEMETRY_STRIP_WIDTH;

    for (let y = 0; y < height; y++) {
        const rowOffset = y * width * 4;
        for (let x = 0; x <= maxSearchX; x++) {
            const idx0 = rowOffset + x * 4;
            const b0 = bgra[idx0];
            const g0 = bgra[idx0 + 1];
            const r0 = bgra[idx0 + 2];

            if (
                Math.abs(r0 - SYNC_HEADER_0.r) <= tolerance &&
                Math.abs(g0 - SYNC_HEADER_0.g) <= tolerance &&
                Math.abs(b0 - SYNC_HEADER_0.b) <= tolerance
            ) {
                const idx1 = idx0 + 4;
                const b1 = bgra[idx1];
                const g1 = bgra[idx1 + 1];
                const r1 = bgra[idx1 + 2];

                if (
                    Math.abs(r1 - SYNC_HEADER_1.r) <= tolerance &&
                    Math.abs(g1 - SYNC_HEADER_1.g) <= tolerance &&
                    Math.abs(b1 - SYNC_HEADER_1.b) <= tolerance
                ) {
                    const slots: DecodedSlotTelemetry[] = new Array(MAX_ACTION_SLOTS);
                    for (let s = 1; s <= MAX_ACTION_SLOTS; s++) {
                        const offsetA = idx0 + (2 + (s - 1) * 2) * 4;
                        const offsetB = offsetA + 4;

                        const pixelA: RGBPixel = {
                            r: bgra[offsetA + 2],
                            g: bgra[offsetA + 1],
                            b: bgra[offsetA],
                        };
                        const pixelB: RGBPixel = {
                            r: bgra[offsetB + 2],
                            g: bgra[offsetB + 1],
                            b: bgra[offsetB],
                        };
                        slots[s - 1] = decodeSlotPixels(s, pixelA, pixelB);
                    }

                    // Check Row 1 (immediately below Row 0) for sub-second floating-point cooldown progress (0.0..1.0)
                    const maxProgressRowY = Math.min(height - 1, y + 3);
                    for (let progY = y + 1; progY <= maxProgressRowY; progY++) {
                        const progRowIdx0 = (progY * width + x) * 4;
                        const pr0 = bgra[progRowIdx0 + 2];
                        const pg0 = bgra[progRowIdx0 + 1];
                        const pb0 = bgra[progRowIdx0];

                        const progRowIdx1 = progRowIdx0 + 4;
                        const pr1 = bgra[progRowIdx1 + 2];
                        const pg1 = bgra[progRowIdx1 + 1];
                        const pb1 = bgra[progRowIdx1];

                        if (
                            Math.abs(pr0 - SYNC_HEADER_0.r) <= tolerance &&
                            Math.abs(pg0 - SYNC_HEADER_0.g) <= tolerance &&
                            Math.abs(pb0 - SYNC_HEADER_0.b) <= tolerance &&
                            Math.abs(pr1 - SYNC_HEADER_ROW1.r) <= tolerance &&
                            Math.abs(pg1 - SYNC_HEADER_ROW1.g) <= tolerance &&
                            Math.abs(pb1 - SYNC_HEADER_ROW1.b) <= tolerance
                        ) {
                            for (let s = 1; s <= MAX_ACTION_SLOTS; s++) {
                                const slotEntry = slots[s - 1];
                                if (!slotEntry.hasAction || (slotEntry.cooldown <= 0 && !slotEntry.onCooldown)) {
                                    slotEntry.cooldownProgress = 0;
                                    continue;
                                }

                                const progOffsetA = progRowIdx0 + (2 + (s - 1) * 2) * 4;
                                const progOffsetB = progOffsetA + 4;

                                const pHigh = bgra[progOffsetA + 2];
                                const pLow = bgra[progOffsetA + 1];
                                const durByte = bgra[progOffsetA];
                                const directFloatByte = bgra[progOffsetB + 2];

                                const prog16 = ((pHigh << 8) | pLow) / 65535;
                                const prog8 = directFloatByte / 255;
                                const resolvedProgress = prog16 > 0 ? prog16 : prog8;

                                if (resolvedProgress > 0) {
                                    slotEntry.cooldownProgress = Math.min(1.0, Math.max(0.0, resolvedProgress));
                                }
                                if (durByte > 0) {
                                    slotEntry.cooldownTotalDuration = decodeCooldownByte(durByte);
                                }
                            }
                            break;
                        }
                    }

                    return { slots, syncX: x, syncY: y };
                }
            }
        }
    }

    return null;
}