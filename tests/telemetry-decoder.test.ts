import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { IconResolverAndRenderer } from "../src/icon-renderer.js";
import {
	CANDIDATE_KEY_POOL,
	decodeCooldownByte,
	decodeFileDataId,
	decodeSlotPixels,
	decodeStatusBitmask,
	decodeTelemetryStripAtOffset,
	encodeCooldownByte,
	encodeFileDataId,
	encodeSlotPixelB,
	encodeStatusBitmask,
	encodeTelemetryRow1Strip,
	encodeTelemetryStrip,
	getCandidateKeyByPoolIndex,
	getWoWActionSlotForStreamDeckIndex,
	MAX_ACTION_SLOTS,
	MAX_CANDIDATE_POOL_SIZE,
	scanAndDecodeBgraBuffer,
	STATUS_BITS,
	SYNC_HEADER_0,
	SYNC_HEADER_1,
	SYNC_HEADER_ROW1,
	TELEMETRY_STRIP_WIDTH,
	type DecodedSlotTelemetry,
	type SlotStatusFlags,
} from "../src/telemetry-decoder.js";

/**
 * Mirrors the exact Lua CANDIDATE_KEY_POOL[poolIndex] from WoWDeckBridge.lua
 * and C# ResolvePoolIndexBinding(poolIndex) from Win32Helper.cs to prove 100% parity.
 */
function simulateLuaCandidatePoolKey(poolIndex: number): string {
	const BASE_KEYS_41 = [
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
	];
	const NUMPAD_DIGITS_10 = [
		"NUMPAD0",
		"NUMPAD1",
		"NUMPAD2",
		"NUMPAD3",
		"NUMPAD4",
		"NUMPAD5",
		"NUMPAD6",
		"NUMPAD7",
		"NUMPAD8",
		"NUMPAD9",
	];

	if (poolIndex <= 41) {
		return `CTRL-SHIFT-${BASE_KEYS_41[poolIndex - 1]}`;
	}
	if (poolIndex <= 82) {
		return `ALT-SHIFT-${BASE_KEYS_41[poolIndex - 42]}`;
	}
	if (poolIndex <= 123) {
		return `CTRL-${BASE_KEYS_41[poolIndex - 83]}`;
	}
	if (poolIndex <= 164) {
		return `ALT-${BASE_KEYS_41[poolIndex - 124]}`;
	}
	return `CTRL-${NUMPAD_DIGITS_10[poolIndex - 165]}`;
}

function simulateCSharpResolvePoolIndexBinding(poolIndex: number): {
	vk: number;
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
} {
	const BASE_KEYS_41_VK = [
		0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x6a, 0x6b, 0x6d,
		0x6f, 0x2d, 0x2e, 0x24, 0x23, 0x21, 0x22, 0x08, 0x26, 0x28, 0x25, 0x27,
		0x42, 0x43, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f,
		0x50, 0x54, 0x55, 0x56, 0x58,
	];
	const NUMPAD_DIGITS_10_VK = [
		0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
	];

	if (poolIndex <= 41) {
		return { vk: BASE_KEYS_41_VK[poolIndex - 1], ctrl: true, alt: false, shift: true };
	}
	if (poolIndex <= 82) {
		return { vk: BASE_KEYS_41_VK[poolIndex - 42], ctrl: false, alt: true, shift: true };
	}
	if (poolIndex <= 123) {
		return { vk: BASE_KEYS_41_VK[poolIndex - 83], ctrl: true, alt: false, shift: false };
	}
	if (poolIndex <= 164) {
		return { vk: BASE_KEYS_41_VK[poolIndex - 124], ctrl: false, alt: true, shift: false };
	}
	return { vk: NUMPAD_DIGITS_10_VK[poolIndex - 165], ctrl: true, alt: false, shift: false };
}

describe("WoWDeck 234-Pixel (116 Slots) Telemetry Protocol & 174-Key Zero-Collision Dynamic Pool", () => {
	it("verifies protocol dimensions (116 slots = 234 pixels, 174 pool keys) and Sync Header constants", () => {
		expect(MAX_ACTION_SLOTS).toBe(116);
		expect(MAX_CANDIDATE_POOL_SIZE).toBe(174);
		expect(CANDIDATE_KEY_POOL).toHaveLength(174);
		expect(TELEMETRY_STRIP_WIDTH).toBe(234);
		expect(SYNC_HEADER_0).toEqual({ r: 18, g: 52, b: 86 });
		expect(SYNC_HEADER_1).toEqual({ r: 120, g: 154, b: 188 });
	});

	it("maps Stream-Deck-Indices 1..96 to exact WoW Action-Slots for Action Bars 1..8", () => {
		const expectedRanges: Array<{ startIdx: number; endIdx: number; wowStart: number; wowEnd: number }> = [
			{ startIdx: 1, endIdx: 12, wowStart: 1, wowEnd: 12 }, // Aktionsleiste 1
			{ startIdx: 13, endIdx: 24, wowStart: 61, wowEnd: 72 }, // Aktionsleiste 2
			{ startIdx: 25, endIdx: 36, wowStart: 49, wowEnd: 60 }, // Aktionsleiste 3
			{ startIdx: 37, endIdx: 48, wowStart: 25, wowEnd: 36 }, // Aktionsleiste 4
			{ startIdx: 49, endIdx: 60, wowStart: 37, wowEnd: 48 }, // Aktionsleiste 5
			{ startIdx: 61, endIdx: 72, wowStart: 145, wowEnd: 156 }, // Aktionsleiste 6
			{ startIdx: 73, endIdx: 84, wowStart: 157, wowEnd: 168 }, // Aktionsleiste 7
			{ startIdx: 85, endIdx: 96, wowStart: 169, wowEnd: 180 }, // Aktionsleiste 8
		];

		for (const range of expectedRanges) {
			for (let offset = 0; offset < 12; offset++) {
				const sdIndex = range.startIdx + offset;
				const expectedWoWSlot = range.wowStart + offset;
				expect(getWoWActionSlotForStreamDeckIndex(sdIndex)).toBe(expectedWoWSlot);
			}
			expect(getWoWActionSlotForStreamDeckIndex(range.endIdx)).toBe(range.wowEnd);
		}

		// Stance (97..106) and Pet (107..116) return null from action slot mapper
		for (let idx = 97; idx <= 116; idx++) {
			expect(getWoWActionSlotForStreamDeckIndex(idx)).toBeNull();
		}
	});

	it("encodes and decodes 24-bit FileDataIDs bit-accurately across the full 24-bit range", () => {
		const testIds = [
			0,
			1,
			255,
			256,
			65535,
			65536,
			132152, // PET_ACTION_ATTACK
			132328, // PET_ACTION_FOLLOW
			136106, // PET_ACTION_WAIT
			457329, // PET_ACTION_MOVE_TO
			132270, // PET_MODE_AGGRESSIVE
			132110, // PET_MODE_DEFENSIVE
			132311, // PET_MODE_PASSIVE
			524348, // PET_MODE_ASSIST
			0x123456,
			0xabcdef,
			0xffffff,
		];

		for (const id of testIds) {
			const pixel = encodeFileDataId(id);
			expect(pixel.r).toBe((id >>> 16) & 0xff);
			expect(pixel.g).toBe((id >>> 8) & 0xff);
			expect(pixel.b).toBe(id & 0xff);
			expect(decodeFileDataId(pixel)).toBe(id);
		}
	});

	it("encodes and decodes all 32 combinations of the 5-bit status bitmask bit-accurately", () => {
		expect(STATUS_BITS.HAS_ACTION).toBe(1);
		expect(STATUS_BITS.IS_USABLE).toBe(2);
		expect(STATUS_BITS.NOT_ENOUGH_MANA).toBe(4);
		expect(STATUS_BITS.OUT_OF_RANGE).toBe(8);
		expect(STATUS_BITS.ON_COOLDOWN).toBe(16);

		for (let mask = 0; mask < 32; mask++) {
			const decodedFlags = decodeStatusBitmask(mask);
			expect(encodeStatusBitmask(decodedFlags)).toBe(mask);
		}
	});

	it("encodes and decodes Cooldown (R), 5-bit Status + 3-bit Stacks (G), and dynamic keyPoolIndex (B) even when hasAction is false", () => {
		const flags: SlotStatusFlags = {
			hasAction: true,
			isUsable: false,
			notEnoughMana: true,
			outOfRange: true,
			onCooldown: true,
		};

		const pixelA = encodeFileDataId(136048);
		const pixelB = encodeSlotPixelB({
			cooldown: 42,
			flags,
			stacks: 5,
			keyPoolIndex: 147,
		});
		const slotState = decodeSlotPixels(100, pixelA, pixelB);

		expect(slotState.slot).toBe(100);
		expect(slotState.fileDataId).toBe(136048);
		expect(slotState.cooldown).toBe(42);
		expect(slotState.stacks).toBe(5);
		expect(slotState.keyPoolIndex).toBe(147);
		expect(slotState.notEnoughMana).toBe(true);
		expect(slotState.outOfRange).toBe(true);
		expect(slotState.onCooldown).toBe(true);

		// Verify stacks clamping to 7 (3 bits: 0..7)
		const pixelBMaxStacks = encodeSlotPixelB({
			cooldown: 10,
			flags,
			stacks: 19,
			keyPoolIndex: 174,
		});
		const stateMaxStacks = decodeSlotPixels(12, pixelA, pixelBMaxStacks);
		expect(stateMaxStacks.stacks).toBe(7);
		expect(stateMaxStacks.keyPoolIndex).toBe(174);

		// Verify empty slot (hasAction == false) STILL preserves keyPoolIndex in Blue channel!
		const emptyPixelB = encodeSlotPixelB({
			cooldown: 0,
			flags: {
				hasAction: false,
				isUsable: false,
				notEnoughMana: false,
				outOfRange: false,
				onCooldown: false,
			},
			stacks: 0,
			keyPoolIndex: 88,
		});
		expect(emptyPixelB).toEqual({ r: 0, g: 0, b: 88 });
		const emptyDecoded = decodeSlotPixels(5, { r: 0, g: 0, b: 0 }, emptyPixelB);
		expect(emptyDecoded.hasAction).toBe(false);
		expect(emptyDecoded.keyPoolIndex).toBe(88);
	});

	it("encodes and decodes a full 234-pixel strip for all 116 slots with dynamic keyPoolIndex", () => {
		const inputSlots: Array<Partial<DecodedSlotTelemetry>> = [];
		for (let s = 1; s <= MAX_ACTION_SLOTS; s++) {
			inputSlots.push({
				slot: s,
				hasAction: s % 3 !== 0, // Mix of populated and empty slots
				fileDataId: 130000 + s * 19,
				cooldown: (s * 2) % 256,
				stacks: s % 8,
				keyPoolIndex: s + 20, // Shifted pool index simulating runtime collision avoidance
				isUsable: s % 2 === 0,
				notEnoughMana: s % 5 === 0,
				outOfRange: s % 7 === 0,
				onCooldown: (s * 2) % 256 > 0,
			});
		}

		const strip = encodeTelemetryStrip(inputSlots);
		expect(strip).toHaveLength(234);
		expect(strip[0]).toEqual(SYNC_HEADER_0);
		expect(strip[1]).toEqual(SYNC_HEADER_1);

		const decoded = decodeTelemetryStripAtOffset(strip, 0);
		expect(decoded).not.toBeNull();
		expect(decoded).toHaveLength(116);

		for (let s = 1; s <= 116; s++) {
			const item = decoded![s - 1];
			expect(item.slot).toBe(s);
			// keyPoolIndex must ALWAYS be transmitted even for empty slots
			expect(item.keyPoolIndex).toBe(s + 20);
			if (s % 3 !== 0) {
				expect(item.hasAction).toBe(true);
				expect(item.fileDataId).toBe(130000 + s * 19);
				expect(item.cooldown).toBe(decodeCooldownByte(encodeCooldownByte((s * 2) % 256)));
				expect(item.stacks).toBe(s % 8);
			} else {
				expect(item.hasAction).toBe(false);
				expect(item.fileDataId).toBe(0);
			}
		}
	});

	it("scans and decodes a 2D 320x24 BGRA buffer containing the 234-pixel strip at a windowed offset", () => {
		const width = 320;
		const height = 24;
		const bgra = Buffer.alloc(width * height * 4, 0);

		const strip = encodeTelemetryStrip([
			{
				slot: 1,
				hasAction: true,
				fileDataId: 135932,
				cooldown: 12,
				stacks: 3,
				keyPoolIndex: 5,
				isUsable: true,
				notEnoughMana: false,
				outOfRange: false,
				onCooldown: true,
			},
			{
				slot: 61,
				hasAction: true,
				fileDataId: 136048,
				cooldown: 30,
				stacks: 1,
				keyPoolIndex: 77,
				isUsable: true,
				notEnoughMana: false,
				outOfRange: false,
				onCooldown: true,
			},
			{
				slot: 97,
				hasAction: true,
				fileDataId: 132270,
				cooldown: 0,
				stacks: 1,
				keyPoolIndex: 130,
				isUsable: true,
				notEnoughMana: false,
				outOfRange: false,
				onCooldown: false,
			},
			{
				slot: 116,
				hasAction: false,
				fileDataId: 0,
				cooldown: 0,
				stacks: 0,
				keyPoolIndex: 174,
			},
		]);

		const targetX = 19;
		const targetY = 5;
		for (let i = 0; i < strip.length; i++) {
			const px = strip[i];
			const offset = (targetY * width + (targetX + i)) * 4;
			bgra[offset] = px.b;
			bgra[offset + 1] = px.g;
			bgra[offset + 2] = px.r;
			bgra[offset + 3] = 255;
		}

		const scanResult = scanAndDecodeBgraBuffer(bgra, width, height);
		expect(scanResult).not.toBeNull();
		expect(scanResult!.syncX).toBe(targetX);
		expect(scanResult!.syncY).toBe(targetY);
		expect(scanResult!.slots).toHaveLength(116);
		expect(scanResult!.slots[0].fileDataId).toBe(135932);
		expect(scanResult!.slots[0].keyPoolIndex).toBe(5);
		expect(scanResult!.slots[60].fileDataId).toBe(136048);
		expect(scanResult!.slots[60].keyPoolIndex).toBe(77);
		expect(scanResult!.slots[96].fileDataId).toBe(132270);
		expect(scanResult!.slots[96].keyPoolIndex).toBe(130);
		expect(scanResult!.slots[115].hasAction).toBe(false);
		expect(scanResult!.slots[115].keyPoolIndex).toBe(174);
	});

	it("guarantees all 174 CANDIDATE_KEY_POOL entries are 100% identical across Lua, TypeScript, and C# and free of forbidden keys", () => {
		const seenComboStrings = new Set<string>();
		const seenVkTuples = new Set<string>();
		const fKeyRegex = /\bF\d+\b/;
		const forbiddenKeyNames = new Set([
			"0",
			"NUMPADADD",
			"NUMPADSUBTRACT",
			"PAUSE",
			"SCROLLLOCK",
			"Q",
			"E",
			"R",
			"W",
			"A",
			"S",
			"D",
			"Y",
			"Z",
		]);

		const luaPath = path.resolve(
			process.cwd(),
			"..",
			"wow-addon",
			"WoWDeckBridgeForever",
			"WoWDeckBridge.lua",
		);
		const luaSource = fs.readFileSync(luaPath, "utf-8");
		expect(luaSource).toContain("local MAX_SLOTS = 116");
		expect(luaSource).toContain("local TOTAL_PIXELS = 234");
		expect(luaSource).toContain("ClearOverrideBindings(bindingOwner)");
		expect(luaSource).toContain("GetBindingAction(wowKey, false)");
		expect(luaSource).toContain(
			'SetOverrideBindingClick(bindingOwner, false, candidateKey, btnName, "LeftButton")',
		);

		for (let poolIdx = 1; poolIdx <= 174; poolIdx++) {
			const tsEntry = getCandidateKeyByPoolIndex(poolIdx);
			const luaCombo = simulateLuaCandidatePoolKey(poolIdx);
			const csEntry = simulateCSharpResolvePoolIndexBinding(poolIdx);

			// 1. Exact parity across Lua, TypeScript, and C#
			expect(tsEntry.poolIndex).toBe(poolIdx);
			expect(tsEntry.wowComboString).toBe(luaCombo);
			expect(tsEntry.vkCode).toBe(csEntry.vk);
			expect(tsEntry.ctrl).toBe(csEntry.ctrl);
			expect(tsEntry.alt).toBe(csEntry.alt);
			expect(tsEntry.shift).toBe(csEntry.shift);

			// 2. Zero forbidden key names (no "0", "NUMPADADD", "NUMPADSUBTRACT", "PAUSE", "SCROLLLOCK", Q/E/R/W/A/S/D/Y/Z)
			expect(forbiddenKeyNames.has(tsEntry.keyName)).toBe(false);
			expect(tsEntry.wowComboString).not.toContain("NUMPADADD");
			expect(tsEntry.wowComboString).not.toContain("NUMPADSUBTRACT");
			expect(tsEntry.wowComboString).not.toContain("PAUSE");
			expect(tsEntry.wowComboString).not.toContain("SCROLLLOCK");

			// 3. Zero F-Keys (F1..F24)
			expect(fKeyRegex.test(tsEntry.wowComboString)).toBe(false);
			expect(tsEntry.vkCode >= 0x70 && tsEntry.vkCode <= 0x87).toBe(false);

			// 4. Zero CTRL+ALT combinations (100% AltGr-free)
			expect(tsEntry.ctrl && tsEntry.alt).toBe(false);
			expect(tsEntry.wowComboString).not.toContain("CTRL-ALT");

			// 5. Unique across all 174 entries
			expect(seenComboStrings.has(tsEntry.wowComboString)).toBe(false);
			seenComboStrings.add(tsEntry.wowComboString);

			const vkTuple = `${tsEntry.vkCode}:${tsEntry.ctrl ? 1 : 0}:${tsEntry.alt ? 1 : 0}:${tsEntry.shift ? 1 : 0}`;
			expect(seenVkTuples.has(vkTuple)).toBe(false);
			seenVkTuples.add(vkTuple);
		}

		expect(seenComboStrings.size).toBe(174);
		expect(seenVkTuples.size).toBe(174);
	});

	it("renders 144x144 SVG with radial clockwise cooldown sweep, correct Z-Order, and ZERO <filter> tags", () => {
		const renderer = new IconResolverAndRenderer();
		const initialState: DecodedSlotTelemetry = {
			slot: 2,
			fileDataId: 136048,
			cooldown: 36,
			stacks: 4,
			rawMask: 31,
			keyPoolIndex: 2,
			hasAction: true,
			isUsable: true,
			notEnoughMana: false,
			outOfRange: false,
			onCooldown: true,
		};
		// First frame establishes maxCooldown = 36s for slot 2
		renderer.renderSlotSvgMarkup(initialState, "data:image/png;base64,AAAA");

		// Second frame at 18s remaining (50% cooldown remaining -> clockwise pie sweep from 6 o'clock to 12 o'clock)
		const state: DecodedSlotTelemetry = {
			...initialState,
			cooldown: 18,
		};

		const svg = renderer.renderSlotSvgMarkup(state, "data:image/png;base64,AAAA");
		expect(svg).toContain('width="144"');
		expect(svg).toContain('height="144"');
		// Strictly no <filter> or <feColorMatrix> (prevents Stream Deck black icon bug)
		expect(svg).not.toContain("<filter");
		expect(svg).not.toContain("feColorMatrix");
		// Layer 1: Unfiltered base image at full brightness
		const imageTag =
			'<image x="0" y="0" width="144" height="144" preserveAspectRatio="xMidYMid slice" href="data:image/png;base64,AAAA"/>';
		expect(svg).toContain(imageTag);
		// Layer 2: Radial Cooldown-Sweep pie sector
		expect(svg).toContain('<path d="M 72 72 L ');
		expect(svg).toContain('A 108 108 0 ');
		expect(svg).toContain('1 72 -36 Z" fill="#000000" fill-opacity="0.65" />');
		// Layer 3: Cooldown-Text in pure white (#FFFFFF) without black stroke on top
		const cooldownTextStyle =
			'font-family="Arial Black, sans-serif" font-size="46" font-weight="900" fill="#FFFFFF"';
		expect(svg).toContain(cooldownTextStyle);
		expect(svg).toContain(">18</text>");
		expect(svg).toContain(">4</text>");

		// Verify strict Z-Order: 1. Base Icon -> 2. Radial Cooldown-Sweep -> 3. Cooldown-Text
		const imageIndex = svg.indexOf("<image ");
		const sweepIndex = svg.indexOf('<path d="M 72 72 L ');
		const textIndex = svg.indexOf(">18</text>");
		expect(imageIndex).toBeGreaterThan(-1);
		expect(sweepIndex).toBeGreaterThan(imageIndex);
		expect(textIndex).toBeGreaterThan(sweepIndex);
	});

	it("renders smooth sub-second floating-point cooldown sweep (progress 0.0..1.0) without coarse jumps on short 10s cooldowns", () => {
		const renderer = new IconResolverAndRenderer();
		const paths = new Set<string>();
		const signatures = new Set<string>();

		// Simulate 20 sub-second steps within a single second (from rem = 10.0s down to 9.05s on a 10.0s cooldown)
		// Even though integer cooldown stays at 10s for all 20 frames, every frame produces a distinct smooth sweep path & render signature
		for (let i = 0; i < 20; i++) {
			const rem = 10.0 - i * 0.05; // 10.00, 9.95, 9.90, ..., 9.05
			const progress = rem / 10.0; // 1.000, 0.995, 0.990, ..., 0.905
			const state: DecodedSlotTelemetry = {
				slot: 5,
				fileDataId: 136048,
				cooldown: 10,
				cooldownProgress: progress,
				cooldownTotalDuration: 10,
				stacks: 0,
				rawMask: 19,
				keyPoolIndex: 5,
				hasAction: true,
				isUsable: true,
				notEnoughMana: false,
				outOfRange: false,
				onCooldown: true,
			};

			const sig = renderer.computeRenderSignature(state);
			const sweepPath = renderer.buildRadialCooldownSweepPath(
				state.slot,
				state.cooldown,
				state.cooldownProgress,
				state.cooldownTotalDuration,
			);
			signatures.add(sig);
			paths.add(sweepPath);
		}

		expect(signatures.size).toBe(20);
		expect(paths.size).toBe(20);
	});

	it("encodes and decodes cooldown bytes with 120s threshold and supports up to 137 minutes (8220s)", () => {
		// Exact seconds 0..120
		expect(encodeCooldownByte(0)).toBe(0);
		expect(decodeCooldownByte(0)).toBe(0);

		expect(encodeCooldownByte(1)).toBe(1);
		expect(decodeCooldownByte(1)).toBe(1);

		expect(encodeCooldownByte(119)).toBe(119);
		expect(decodeCooldownByte(119)).toBe(119);

		expect(encodeCooldownByte(120)).toBe(120);
		expect(decodeCooldownByte(120)).toBe(120);

		// > 120 seconds: minute increments
		// 121 seconds -> ceil((121-120)/60) = 1 minute step -> byte 121 -> decodes to 120 + 1*60 = 180s (3m)
		expect(encodeCooldownByte(121)).toBe(121);
		expect(decodeCooldownByte(121)).toBe(180);

		// 1800s (30m) -> 120 + ceil((1800-120)/60) = 120 + 28 = 148 -> decodes to 120 + 28*60 = 1800s (30m)
		expect(encodeCooldownByte(1800)).toBe(148);
		expect(decodeCooldownByte(148)).toBe(1800);

		// 3600s (60m) -> 120 + ceil((3600-120)/60) = 120 + 58 = 178 -> decodes to 120 + 58*60 = 3600s (60m)
		expect(encodeCooldownByte(3600)).toBe(178);
		expect(decodeCooldownByte(178)).toBe(3600);

		// 8220s (137m) -> 120 + ceil((8220-120)/60) = 120 + 135 = 255 -> decodes to 120 + 135*60 = 8220s (137m)
		expect(encodeCooldownByte(8220)).toBe(255);
		expect(decodeCooldownByte(255)).toBe(8220);

		// > 8220s (e.g. 10000s) -> capped at byte 255 -> decodes to 8220s (137m)
		expect(encodeCooldownByte(10000)).toBe(255);
		expect(decodeCooldownByte(encodeCooldownByte(10000))).toBe(8220);
	});

	it("renders minute-based cooldowns (e.g. 30m, 60m, 137m) cleanly centered without overflow", () => {
		const renderer = new IconResolverAndRenderer();
		const baseState: DecodedSlotTelemetry = {
			slot: 1,
			fileDataId: 136048,
			cooldown: 0,
			stacks: 0,
			rawMask: 1,
			keyPoolIndex: 1,
			hasAction: true,
			isUsable: true,
			notEnoughMana: false,
			outOfRange: false,
			onCooldown: true,
		};

		// 30m (1800s) -> 3 chars -> font-size 40
		const svg30m = renderer.renderSlotSvgMarkup({ ...baseState, cooldown: 1800 }, "data:image/png;base64,AAAA");
		expect(svg30m).toContain('>30m</text>');
		expect(svg30m).toContain('font-size="40"');

		// 60m (3600s) -> 3 chars -> font-size 40
		const svg60m = renderer.renderSlotSvgMarkup({ ...baseState, cooldown: 3600 }, "data:image/png;base64,AAAA");
		expect(svg60m).toContain('>60m</text>');
		expect(svg60m).toContain('font-size="40"');

		// 137m (8220s) -> 4 chars -> font-size 36
		const svg137m = renderer.renderSlotSvgMarkup({ ...baseState, cooldown: 8220 }, "data:image/png;base64,AAAA");
		expect(svg137m).toContain('>137m</text>');
		expect(svg137m).toContain('font-size="36"');
	});

	it("renders high-contrast stacks/charges badge (pill + outline + white text) above overlays and cooldown sweep with dynamic sizing", () => {
		const renderer = new IconResolverAndRenderer();
		const baseState: DecodedSlotTelemetry = {
			slot: 3,
			fileDataId: 136048,
			cooldown: 12,
			cooldownProgress: 0.5,
			cooldownTotalDuration: 24,
			stacks: 4,
			rawMask: 31,
			keyPoolIndex: 3,
			hasAction: true,
			isUsable: true,
			notEnoughMana: true,
			outOfRange: true,
			onCooldown: true,
		};

		// 1-digit stack (4) -> font-size 36
		const svg4 = renderer.renderSlotSvgMarkup(baseState, "data:image/png;base64,AAAA");
		expect(svg4).toContain('fill="#000000" fill-opacity="0.72"');
		expect(svg4).toContain('text-anchor="end" font-family="Arial Black, sans-serif" font-size="36" font-weight="900" fill="#000000" stroke="#000000" stroke-width="5" stroke-linejoin="round" paint-order="stroke fill">4</text>');
		expect(svg4).toContain('text-anchor="end" font-family="Arial Black, sans-serif" font-size="36" font-weight="900" fill="#FFFFFF">4</text>');

		// Verify Z-Order: Base Icon < Mana/Range Overlays < Cooldown Sweep < Stack Pill < Stack Outline < Stack Fill
		const iconIdx = svg4.indexOf("<image ");
		const manaIdx = svg4.indexOf('fill="#0032B4"');
		const rangeIdx = svg4.indexOf('fill="#B40000"');
		const sweepIdx = svg4.indexOf('<path d="M 72 72 L ');
		const pillIdx = svg4.indexOf('fill="#000000" fill-opacity="0.72"');
		const stackOutlineIdx = svg4.indexOf('stroke="#000000" stroke-width="5"');
		const stackFillIdx = svg4.indexOf('fill="#FFFFFF">4</text>');
		expect(iconIdx).toBeGreaterThan(-1);
		expect(manaIdx).toBeGreaterThan(iconIdx);
		expect(rangeIdx).toBeGreaterThan(manaIdx);
		expect(sweepIdx).toBeGreaterThan(rangeIdx);
		expect(pillIdx).toBeGreaterThan(sweepIdx);
		expect(stackOutlineIdx).toBeGreaterThan(pillIdx);
		expect(stackFillIdx).toBeGreaterThan(stackOutlineIdx);

		// 2-digit stack (20) -> font-size 34
		const svg20 = renderer.renderSlotSvgMarkup({ ...baseState, stacks: 20 }, "data:image/png;base64,AAAA");
		expect(svg20).toContain('font-size="34" font-weight="900" fill="#FFFFFF">20</text>');

		// 3-digit stack (100) -> font-size 28
		const svg100 = renderer.renderSlotSvgMarkup({ ...baseState, stacks: 100 }, "data:image/png;base64,AAAA");
		expect(svg100).toContain('font-size="28" font-weight="900" fill="#FFFFFF">100</text>');
	});

	it("verifies full English Property Inspector UI and live active keybinding telemetry listener in slot-action.html", () => {
		const htmlPath = path.resolve(
			process.cwd(),
			"com.behmen.wowdeck.sdPlugin",
			"ui",
			"slot-action.html",
		);
		const html = fs.readFileSync(htmlPath, "utf-8");

		expect(html).toContain('<html lang="en">');
		expect(html).toContain("Action Bar 1 – Button 1");
		expect(html).toContain("Stream Deck Index:");
		expect(html).toContain("WoW Action Slot / Target:");
		expect(html).toContain("Zero-Config Keybinding:");
		expect(html).toContain(
			"No manual keybinding required in WoW! The <strong>WoWDeckBridge</strong> addon automatically links the 8 action bars, stance bar &amp; pet bar (116 slots) in the background.",
		);
		expect(html).toContain("Dynamic (Zero-Collision, active: ");
		expect(html).toContain("sendToPropertyInspector");
	});

	it("avoids Wowhead scraping and negatively caches failed icon fetches", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wowdeck-icon-neg-"));
		const originalFetch = globalThis.fetch;
		const requests: Array<{ url: string; userAgent: string | null; accept: string | null }> = [];

		globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input.toString();
			const headers = new Headers(init?.headers);
			requests.push({
				url,
				userAgent: headers.get("User-Agent"),
				accept: headers.get("Accept"),
			});
			return new Response("Not Found", { status: 404 });
		}) as typeof fetch;

		try {
			const renderer = new IconResolverAndRenderer({
				cacheDir: tempDir,
				minRequestIntervalMs: 0,
				enableLocalCasc: false,
			});

			const first = await renderer.resolveIconDataUri(999999);
			expect(first).toBeNull();
			expect(requests).toHaveLength(1);
			expect(requests[0].url).toBe("https://wago.tools/api/casc/999999?format=png");
			expect(requests.some((r) => r.url.includes("wowhead.com"))).toBe(false);
			expect(requests[0].userAgent).toBeNull();
			expect(requests[0].accept).toContain("image/png");
			expect(renderer.isNegativelyCached(999999)).toBe(true);
			expect(renderer.canAttemptResolve(999999)).toBe(false);

			const second = await renderer.resolveIconDataUri(999999);
			expect(second).toBeNull();
			expect(requests).toHaveLength(1);
		} finally {
			globalThis.fetch = originalFetch;
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("triggers host circuit breaker on HTTP 403 and 429 responses", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wowdeck-icon-cb-"));
		const iconMapPath = path.join(tempDir, "icon-map.json");
		fs.writeFileSync(
			iconMapPath,
			JSON.stringify({
				"777001": "spell_fire_fireball",
				"777002": "spell_frost_frostbolt",
			}),
			"utf8",
		);
		const originalFetch = globalThis.fetch;
		const requestedUrls: string[] = [];

		globalThis.fetch = (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
			const url = typeof input === "string" ? input : input.toString();
			requestedUrls.push(url);
			if (url.includes("render.worldofwarcraft.com")) {
				return new Response("Too Many Requests", { status: 429 });
			}
			if (url.includes("wago.tools")) {
				return new Response("Forbidden", { status: 403 });
			}
			return new Response("Not Found", { status: 404 });
		}) as typeof fetch;

		try {
			const renderer = new IconResolverAndRenderer({
				cacheDir: tempDir,
				iconMapPath,
				minRequestIntervalMs: 0,
				enableLocalCasc: false,
			});

			await renderer.resolveIconDataUri(777001);
			expect(renderer.isHostBlocked("render.worldofwarcraft.com")).toBe(true);
			expect(renderer.isHostBlocked("wago.tools")).toBe(true);

			const countAfterFirst = requestedUrls.length;
			await renderer.resolveIconDataUri(777002);

			const extraUrls = requestedUrls.slice(countAfterFirst);
			expect(extraUrls.some((u) => u.includes("render.worldofwarcraft.com"))).toBe(false);
			expect(extraUrls.some((u) => u.includes("wago.tools"))).toBe(false);
			expect(requestedUrls.filter((u) => u.includes("render.worldofwarcraft.com"))).toHaveLength(1);
			expect(requestedUrls.filter((u) => u.includes("wago.tools"))).toHaveLength(1);
		} finally {
			globalThis.fetch = originalFetch;
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("serializes concurrent icon downloads through a paced queue", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wowdeck-icon-queue-"));
		const originalFetch = globalThis.fetch;
		const validPng = Buffer.alloc(70, 0);
		validPng[0] = 0x89;
		validPng[1] = 0x50;
		validPng[2] = 0x4e;
		validPng[3] = 0x47;

		let active = 0;
		let maxConcurrent = 0;
		const startTimes: number[] = [];

		globalThis.fetch = (async (): Promise<Response> => {
			active += 1;
			maxConcurrent = Math.max(maxConcurrent, active);
			startTimes.push(Date.now());
			await new Promise((resolve) => setTimeout(resolve, 5));
			active -= 1;
			return new Response(validPng, { status: 200 });
		}) as typeof fetch;

		try {
			const renderer = new IconResolverAndRenderer({
				cacheDir: tempDir,
				minRequestIntervalMs: 35,
				enableLocalCasc: false,
			});

			const results = await Promise.all([
				renderer.resolveIconDataUri(700001),
				renderer.resolveIconDataUri(700002),
				renderer.resolveIconDataUri(700003),
			]);

			expect(results.every((uri) => uri?.startsWith("data:image/png;base64,"))).toBe(true);
			expect(maxConcurrent).toBe(1);
			expect(startTimes).toHaveLength(3);
			expect(startTimes[1] - startTimes[0]).toBeGreaterThanOrEqual(25);
			expect(startTimes[2] - startTimes[1]).toBeGreaterThanOrEqual(25);
		} finally {
			globalThis.fetch = originalFetch;
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("encodes and decodes full 8-bit stacks (0..255) via Row 1 both on and off cooldown with Lua parity", () => {
		const testSlots: Array<Partial<DecodedSlotTelemetry>> = [
			{ slot: 1, hasAction: true, fileDataId: 136048, stacks: 67, onCooldown: false, cooldown: 0 },
			{
				slot: 2,
				hasAction: true,
				fileDataId: 135813,
				stacks: 200,
				onCooldown: true,
				cooldown: 5,
				cooldownProgress: 0.4,
				cooldownTotalDuration: 12,
			},
			{ slot: 3, hasAction: true, fileDataId: 135907, stacks: 255, onCooldown: false, cooldown: 0 },
			{ slot: 4, hasAction: true, fileDataId: 132328, stacks: 7, onCooldown: false, cooldown: 0 },
			{
				slot: 5,
				hasAction: true,
				fileDataId: 132152,
				stacks: 1,
				onCooldown: true,
				cooldown: 3,
				cooldownProgress: 0.25,
				cooldownTotalDuration: 10,
			},
			{ slot: 6, hasAction: true, fileDataId: 136106, stacks: 0, onCooldown: false, cooldown: 0 },
		];

		const row0 = encodeTelemetryStrip(testSlots);
		const row1 = encodeTelemetryRow1Strip(testSlots);
		expect(row1[1]).toEqual(SYNC_HEADER_ROW1);

		const bgra = new Uint8Array(TELEMETRY_STRIP_WIDTH * 2 * 4);
		for (let x = 0; x < TELEMETRY_STRIP_WIDTH; x++) {
			const off0 = x * 4;
			bgra[off0] = row0[x].b;
			bgra[off0 + 1] = row0[x].g;
			bgra[off0 + 2] = row0[x].r;
			bgra[off0 + 3] = 255;

			const off1 = (TELEMETRY_STRIP_WIDTH + x) * 4;
			bgra[off1] = row1[x].b;
			bgra[off1 + 1] = row1[x].g;
			bgra[off1 + 2] = row1[x].r;
			bgra[off1 + 3] = 255;
		}

		const decoded = scanAndDecodeBgraBuffer(bgra, TELEMETRY_STRIP_WIDTH, 2);
		expect(decoded).not.toBeNull();
		const slots = decoded!.slots;

		expect(slots[0].stacks).toBe(67);
		expect(slots[0].cooldownProgress).toBe(0);

		expect(slots[1].stacks).toBe(200);
		expect(slots[1].cooldownProgress).toBeCloseTo(0.4, 3);
		expect(slots[1].cooldownTotalDuration).toBe(12);

		expect(slots[2].stacks).toBe(255);
		expect(slots[2].cooldownProgress).toBe(0);

		expect(slots[3].stacks).toBe(7);
		expect(slots[4].stacks).toBe(1);
		expect(slots[4].cooldownProgress).toBeCloseTo(0.25, 3);
		expect(slots[5].stacks).toBe(0);

		const resolveLuaPath = (addonFolder: string): string => {
			const directPath = path.resolve(process.cwd(), addonFolder, "WoWDeckBridge.lua");
			return fs.existsSync(directPath)
				? directPath
				: path.resolve(process.cwd(), "..", "wow-addon", addonFolder, "WoWDeckBridge.lua");
		};
		const luaForever = fs.readFileSync(resolveLuaPath("WoWDeckBridgeForever"), "utf8");
		const luaRetail = fs.readFileSync(resolveLuaPath("WoWDeckBridgeRetail"), "utf8");
		for (const luaSource of [luaForever, luaRetail]) {
			expect(luaSource).toContain("local fullStacksByte = ClampByte(floor(stacks))");
			expect(luaSource).toContain("progTexB:SetColorTexture(cdProgress, fullStacksByte / 255, 0, 1)");
			expect(luaSource).toContain("progTexB:SetColorTexture(0, fullStacksByte / 255, 0, 1)");
		}
	});

	it("logs diagnostic warnings and errors for circuit breaker, HTTP errors, invalid buffers, fetch exceptions, and negative caching", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wowdeck-icon-log-"));
		const iconMapPath = path.join(tempDir, "icon-map.json");
		fs.writeFileSync(
			iconMapPath,
			JSON.stringify({
				"888101": "spell_holy_heal",
			}),
			"utf8",
		);
		const originalFetch = globalThis.fetch;
		const warns: string[] = [];
		const errors: string[] = [];

		globalThis.fetch = (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("render.worldofwarcraft.com")) {
				return new Response("Forbidden", {
					status: 403,
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			}
			if (url.includes("wow.zamimg.com")) {
				return new Response("Not Found", {
					status: 404,
					headers: { "content-type": "text/plain" },
				});
			}
			if (url.includes("888101")) {
				const err = new Error("connect ETIMEDOUT") as Error & { cause?: unknown };
				err.cause = new Error("socket hang up");
				throw err;
			}
			// 888102: returns invalid non-PNG/JPEG payload (e.g. WebP / HTML challenge)
			return new Response(Buffer.from("RIFFxxxxWEBP", "ascii"), {
				status: 200,
				headers: { "content-type": "image/webp" },
			});
		}) as typeof fetch;

		try {
			const renderer = new IconResolverAndRenderer({
				cacheDir: tempDir,
				iconMapPath,
				minRequestIntervalMs: 0,
				enableLocalCasc: false,
				logger: {
					warn: (msg) => warns.push(msg),
					error: (msg) => errors.push(msg),
				},
			});

			// 1. 403 circuit breaker + 404 + Error with cause + negative cache warn
			expect(await renderer.resolveIconDataUri(888101)).toBeNull();
			expect(warns.some((m) => m.includes("403") && m.includes("30m") && m.includes("text/html"))).toBe(true);
			expect(warns.some((m) => m.includes("404") && m.includes("wow.zamimg.com") && m.includes("text/plain"))).toBe(true);
			expect(
				errors.some(
					(m) =>
						m.includes("https://wago.tools/api/casc/888101?format=png") &&
						m.includes("Error:connect ETIMEDOUT") &&
						m.includes("Error:socket hang up"),
				),
			).toBe(true);
			expect(warns.filter((m) => m.includes("Negative-caching fileDataId=888101"))).toHaveLength(1);

			// 2. Invalid buffer (200 image/webp -> hex prefix + length + status)
			expect(await renderer.resolveIconDataUri(888102)).toBeNull();
			expect(
				warns.some(
					(m) =>
						m.includes("https://wago.tools/api/casc/888102?format=png") &&
						m.includes("status=200") &&
						m.includes("content-type=image/webp") &&
						m.includes("length=12") &&
						m.includes("hex=5249464678787878"),
				),
			).toBe(true);
			expect(warns.filter((m) => m.includes("Negative-caching fileDataId=888102"))).toHaveLength(1);
		} finally {
			globalThis.fetch = originalFetch;
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("follows Stage 1 -> Stage 2 -> Stage 3 icon resolution cascade cleanly", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wowdeck-icon-cascade-"));
		const iconMapPath = path.join(tempDir, "icon-map.json");
		fs.writeFileSync(
			iconMapPath,
			JSON.stringify({
				"900001": "spell_stage1_icon",
				"900002": "spell_stage2_icon",
			}),
			"utf8",
		);

		// Minimal 4x4 uncompressed BGRA BLP2 buffer
		const makeMiniBlp2 = (b: number, g: number, r: number): Buffer => {
			const header = Buffer.alloc(148, 0);
			header.write("BLP2", 0, "ascii");
			header.writeUInt32LE(1, 4);
			header[8] = 3; // uncompressed BGRA
			header[9] = 8;
			header.writeUInt32LE(2, 12);
			header.writeUInt32LE(2, 16);
			header.writeUInt32LE(148, 20);
			header.writeUInt32LE(16, 84);
			const pixels = Buffer.alloc(16);
			for (let i = 0; i < 4; i++) {
				pixels[i * 4] = b;
				pixels[i * 4 + 1] = g;
				pixels[i * 4 + 2] = r;
				pixels[i * 4 + 3] = 255;
			}
			return Buffer.concat([header, pixels]);
		};

		const validPng = Buffer.alloc(70, 0);
		validPng[0] = 0x89;
		validPng[1] = 0x50;
		validPng[2] = 0x4e;
		validPng[3] = 0x47;

		const originalFetch = globalThis.fetch;
		const fetchedUrls: string[] = [];
		const infos: string[] = [];
		const warns: string[] = [];

		globalThis.fetch = (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
			const url = typeof input === "string" ? input : input.toString();
			fetchedUrls.push(url);
			if (url.includes("render.worldofwarcraft.com/eu/icons/56/spell_stage2_icon.jpg")) {
				return new Response(validPng, {
					status: 200,
					headers: { "content-type": "image/jpeg" },
				});
			}
			if (url === "https://wago.tools/api/casc/900003?format=png") {
				return new Response(makeMiniBlp2(255, 0, 0), {
					status: 200,
					headers: { "content-type": "application/octet-stream" },
				});
			}
			if (url === "https://wago.tools/api/casc/900004?format=png") {
				return new Response("Service Unavailable", {
					status: 503,
					headers: { "content-type": "text/plain" },
				});
			}
			return new Response("Not Found", { status: 404 });
		}) as typeof fetch;

		try {
			const renderer = new IconResolverAndRenderer({
				cacheDir: tempDir,
				iconMapPath,
				minRequestIntervalMs: 0,
				cascReader: {
					async readFileByDataId(fdid: number): Promise<Buffer | null> {
						if (fdid === 900001) return makeMiniBlp2(0, 200, 100);
						if (fdid === 900002) throw new Error("Simulated CASC failure");
						return null;
					},
				},
				logger: {
					info: (msg) => infos.push(msg),
					warn: (msg) => warns.push(msg),
					error: () => undefined,
				},
			});

			// 1. Stage 1 resolves offline without any HTTP requests
			const stage1Uri = await renderer.resolveIconDataUri(900001);
			expect(stage1Uri?.startsWith("data:image/png;base64,")).toBe(true);
			expect(fetchedUrls).toHaveLength(0);
			expect(infos.some((m) => m.includes("Stage 1") && m.includes("900001"))).toBe(true);

			// 2. Stage 1 throws -> falls back cleanly to Stage 2 CDN without hitting wago.tools
			const stage2Uri = await renderer.resolveIconDataUri(900002);
			expect(stage2Uri?.startsWith("data:image/png;base64,")).toBe(true);
			expect(fetchedUrls).toEqual([
				"https://render.worldofwarcraft.com/eu/icons/56/spell_stage2_icon.jpg",
			]);
			expect(warns.some((m) => m.includes("Stage 1 failed") && m.includes("900002"))).toBe(true);

			// 3. Stage 1 & 2 miss -> Stage 3 wago.tools returns raw BLP2 bytes, converted to PNG
			const stage3Uri = await renderer.resolveIconDataUri(900003);
			expect(stage3Uri?.startsWith("data:image/png;base64,")).toBe(true);
			expect(fetchedUrls).toContain("https://wago.tools/api/casc/900003?format=png");
			expect(infos.some((m) => m.includes("Stage 3") && m.includes("900003"))).toBe(true);

			// 4. Stage 3 fails with 503 -> trips wago.tools circuit breaker & negative caches cleanly
			expect(await renderer.resolveIconDataUri(900004)).toBeNull();
			expect(renderer.isHostBlocked("wago.tools")).toBe(true);
			expect(renderer.isNegativelyCached(900004)).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("verifies bundled assets/icon-map.json contains valid lowercase icon names without .blp suffix", () => {
		const mapPath = path.resolve(process.cwd(), "com.behmen.wowdeck.sdPlugin", "assets", "icon-map.json");
		expect(fs.existsSync(mapPath)).toBe(true);
		const parsed = JSON.parse(fs.readFileSync(mapPath, "utf8")) as Record<string, string>;
		const entries = Object.entries(parsed);
		expect(entries.length).toBeGreaterThan(10000);
		expect(parsed["132796"]).toBe("inv_drink_09");
		expect(parsed["136048"]).toBe("spell_nature_lightning");
		expect(entries.every(([, val]) => val === val.toLowerCase() && !val.endsWith(".blp"))).toBe(true);
	});
});
