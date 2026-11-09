import * as fs from "node:fs";
import * as path from "node:path";
import type { DecodedSlotTelemetry } from "./telemetry-decoder.js";

/**
 * Known icon names for standard Pet/Stance FileDataIDs so they can be fetched
 * directly from Zamimg & Blizzard Render CDN without an extra HTML lookup step.
 */
const KNOWN_ICON_NAMES: Readonly<Record<number, string>> = Object.freeze({
	132152: "ability_ghoulfrenzy", // PET_ACTION_ATTACK
	132328: "ability_tracking", // PET_ACTION_FOLLOW
	136106: "spell_nature_timestop", // PET_ACTION_WAIT / STAY
	457329: "ability_hunter_pet_goto", // PET_ACTION_MOVE_TO
	132294: "ability_rogue_feint", // PET_ACTION_MOVE_TO fallback
	132270: "ability_physical_taunt", // PET_MODE_AGGRESSIVE
	132275: "ability_racial_avatar", // PET_MODE_AGGRESSIVE alt
	132110: "ability_defend", // PET_MODE_DEFENSIVE
	132311: "ability_seal", // PET_MODE_PASSIVE
	524348: "ability_hunter_pet_assist", // PET_MODE_ASSIST
});

/**
 * Fallback FileDataIDs if a primary FileDataID returns 404 on CDNs.
 */
const FALLBACK_FILEDATA_IDS: Readonly<Record<number, number>> = Object.freeze({
	524348: 132270, // PET_MODE_ASSIST -> PET_MODE_AGGRESSIVE
	457329: 132294, // PET_ACTION_MOVE_TO -> classic fallback
});

export interface SlotCooldownTracker {
	totalDurationSec: number;
	totalDurationMs: number;
	endTimestampMs: number;
	lastCooldownSec: number;
	lastTelemetryProgress: number;
}

export class IconResolverAndRenderer {
	private readonly cacheDir: string;
	private readonly memoryCache = new Map<number, string>(); // fileDataId -> data URI
	private readonly pendingFetches = new Map<number, Promise<string | null>>();
	private readonly slotMaxCooldown = new Map<number, number>(); // slot -> max observed cooldown seconds
	private readonly slotCooldownTrackers = new Map<number, SlotCooldownTracker>(); // slot -> sub-second millisecond tracker

	constructor(cacheDir?: string) {
		this.cacheDir =
			cacheDir ?? path.resolve(process.cwd(), "cache", "icons");
		try {
			fs.mkdirSync(this.cacheDir, { recursive: true });
		} catch {
			// Ignore directory creation errors in restricted environments
		}
	}

	public getCacheFilePath(fileDataId: number): string {
		return path.join(this.cacheDir, `${fileDataId}.png`);
	}

	public hasIconInMemory(fileDataId: number): boolean {
		return this.memoryCache.has(fileDataId);
	}

	/**
	 * Resolves a FileDataID to a Base64 image data URI, reading from disk cache
	 * `/cache/icons/{fileDataId}.png` or downloading from Wowhead / Blizzard Render / Wago CDN.
	 */
	public async resolveIconDataUri(fileDataId: number): Promise<string | null> {
		if (!fileDataId || fileDataId <= 0) {
			return null;
		}

		const mem = this.memoryCache.get(fileDataId);
		if (mem) {
			return mem;
		}

		const diskPath = this.getCacheFilePath(fileDataId);
		if (fs.existsSync(diskPath)) {
			try {
				const bytes = await fs.promises.readFile(diskPath);
				if (bytes.length > 64) {
					const mime = this.detectMimeType(bytes);
					const dataUri = `data:${mime};base64,${bytes.toString("base64")}`;
					this.memoryCache.set(fileDataId, dataUri);
					return dataUri;
				}
			} catch {
				// Fall through to remote fetch
			}
		}

		const existingPromise = this.pendingFetches.get(fileDataId);
		if (existingPromise) {
			return existingPromise;
		}

		const fetchPromise = this.fetchAndCacheRemoteIcon(fileDataId, diskPath).finally(() => {
			this.pendingFetches.delete(fileDataId);
		});
		this.pendingFetches.set(fileDataId, fetchPromise);
		return fetchPromise;
	}

	private detectMimeType(buf: Buffer): string {
		if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
			return "image/png";
		}
		if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
			return "image/jpeg";
		}
		return "image/png";
	}

	private async tryDownloadImageBytes(url: string): Promise<Buffer | null> {
		try {
			const res = await fetch(url, {
				headers: {
					"User-Agent": "WoWDeck-StreamDeck-Plugin/1.1",
				},
			});
			if (!res.ok) return null;
			const arrayBuf = await res.arrayBuffer();
			const buf = Buffer.from(arrayBuf);
			if (buf.length > 64 && this.IsValidImageBuffer(buf)) {
				return buf;
			}
		} catch {
			// Ignore network errors
		}
		return null;
	}

	private IsValidImageBuffer(buf: Buffer): boolean {
		// PNG (89 50 4E 47) or JPEG (FF D8 FF)
		const isPng =
			buf.length >= 4 &&
			buf[0] === 0x89 &&
			buf[1] === 0x50 &&
			buf[2] === 0x4e &&
			buf[3] === 0x47;
		const isJpg =
			buf.length >= 3 &&
			buf[0] === 0xff &&
			buf[1] === 0xd8 &&
			buf[2] === 0xff;
		return isPng || isJpg;
	}

	private async resolveIconNameFromWowhead(fileDataId: number): Promise<string | null> {
		const known = KNOWN_ICON_NAMES[fileDataId];
		if (known) return known;

		const urls = [
			`https://www.wowhead.com/icon=${fileDataId}`,
			`https://www.wowhead.com/classic/icon=${fileDataId}`,
		];

		for (const pageUrl of urls) {
			try {
				const res = await fetch(pageUrl, {
					headers: {
						"User-Agent": "WoWDeck-StreamDeck-Plugin/1.1",
					},
				});
				if (!res.ok) continue;
				const html = await res.text();
				const match = html.match(
					/https:\/\/wow\.zamimg\.com\/images\/wow\/icons\/large\/([^"'\s>/.]+)\.(?:jpg|png)/i,
				);
				if (match && match[1]) {
					return match[1].toLowerCase();
				}
			} catch {
				// Continue to next URL
			}
		}

		return null;
	}

	private async fetchBufferForFileDataId(fileDataId: number): Promise<Buffer | null> {
		// 1. Resolve icon name (via built-in table or Wowhead icon page) and download from Zamimg / Blizzard Render CDN
		const iconName = await this.resolveIconNameFromWowhead(fileDataId);
		if (iconName) {
			const candidateImageUrls = [
				`https://wow.zamimg.com/images/wow/icons/large/${iconName}.jpg`,
				`https://render.worldofwarcraft.com/eu/icons/56/${iconName}.jpg`,
				`https://render.worldofwarcraft.com/us/icons/56/${iconName}.jpg`,
			];
			for (const imgUrl of candidateImageUrls) {
				const buf = await this.tryDownloadImageBytes(imgUrl);
				if (buf) return buf;
			}
		}

		// 2. Fallback: Wago Tools CASC API
		const wagoUrls = [
			`https://wago.tools/api/casc/${fileDataId}?format=png`,
			`https://wago.tools/api/casc/${fileDataId}`,
		];
		for (const wagoUrl of wagoUrls) {
			const buf = await this.tryDownloadImageBytes(wagoUrl);
			if (buf) return buf;
		}

		// 3. Fallback FileDataID if defined (e.g. 524348 -> 132270)
		const fallbackId = FALLBACK_FILEDATA_IDS[fileDataId];
		if (fallbackId && fallbackId !== fileDataId) {
			return this.fetchBufferForFileDataId(fallbackId);
		}

		return null;
	}

	private async fetchAndCacheRemoteIcon(
		fileDataId: number,
		diskPath: string,
	): Promise<string | null> {
		const buf = await this.fetchBufferForFileDataId(fileDataId);
		if (!buf) {
			return null;
		}

		await this.saveToDiskCache(diskPath, buf);
		const mime = this.detectMimeType(buf);
		const dataUri = `data:${mime};base64,${buf.toString("base64")}`;
		this.memoryCache.set(fileDataId, dataUri);
		return dataUri;
	}

	private async saveToDiskCache(diskPath: string, buf: Buffer): Promise<void> {
		try {
			await fs.promises.mkdir(path.dirname(diskPath), { recursive: true });
			await fs.promises.writeFile(diskPath, buf);
		} catch {
			// Ignore write errors
		}
	}

	/**
	 * Resolves the floating-point cooldown progress (`0.0` to `1.0`, i.e., `rem / totalDuration`)
	 * with millisecond precision, combining direct float telemetry from `WoWDeckBridge.lua`
	 * with high-resolution `performance.now()` interpolation so even short cooldowns
	 * (e.g. 10s) animate smoothly without steps.
	 */
	public getSmoothCooldownProgress(
		slot: number,
		cooldown: number,
		cooldownProgress?: number,
		cooldownTotalDuration?: number,
	): number {
		if (cooldown <= 0 && (cooldownProgress === undefined || cooldownProgress <= 0)) {
			this.slotMaxCooldown.delete(slot);
			this.slotCooldownTrackers.delete(slot);
			return 0;
		}

		const nowMs = performance.now();
		let maxCd = this.slotMaxCooldown.get(slot) ?? 0;
		if (cooldownTotalDuration && cooldownTotalDuration > maxCd) {
			maxCd = cooldownTotalDuration;
			this.slotMaxCooldown.set(slot, maxCd);
		}
		if (cooldown > maxCd) {
			maxCd = cooldown;
			this.slotMaxCooldown.set(slot, maxCd);
		}
		if (maxCd <= 0) {
			maxCd = Math.max(1, cooldown);
			this.slotMaxCooldown.set(slot, maxCd);
		}

		const totalDurationMs = maxCd * 1000;
		let tracker = this.slotCooldownTrackers.get(slot);

		if (cooldownProgress !== undefined && cooldownProgress > 0) {
			const clampedProg = Math.min(1.0, Math.max(0.0, cooldownProgress));
			if (
				!tracker ||
				Math.abs(clampedProg - tracker.lastTelemetryProgress) > 0.0005 ||
				tracker.totalDurationMs !== totalDurationMs
			) {
				tracker = {
					totalDurationSec: maxCd,
					totalDurationMs,
					endTimestampMs: nowMs + clampedProg * totalDurationMs,
					lastCooldownSec: cooldown,
					lastTelemetryProgress: clampedProg,
				};
				this.slotCooldownTrackers.set(slot, tracker);
			}
			const remMs = Math.max(0, tracker.endTimestampMs - nowMs);
			return Math.min(1.0, Math.max(0.0, remMs / tracker.totalDurationMs));
		}

		if (
			!tracker ||
			cooldown > tracker.lastCooldownSec ||
			tracker.totalDurationMs !== totalDurationMs
		) {
			tracker = {
				totalDurationSec: maxCd,
				totalDurationMs,
				endTimestampMs: nowMs + cooldown * 1000,
				lastCooldownSec: cooldown,
				lastTelemetryProgress: -1,
			};
			this.slotCooldownTrackers.set(slot, tracker);
		} else if (cooldown !== tracker.lastCooldownSec) {
			const targetEndMs = nowMs + cooldown * 1000;
			const driftMs = Math.abs(tracker.endTimestampMs - targetEndMs);
			tracker.lastCooldownSec = cooldown;
			if (driftMs >= 250) {
				tracker.endTimestampMs = targetEndMs;
			} else {
				tracker.endTimestampMs = 0.8 * tracker.endTimestampMs + 0.2 * targetEndMs;
			}
		}

		const remMs = Math.max(0, tracker.endTimestampMs - nowMs);
		return Math.min(1.0, Math.max(0.0, remMs / tracker.totalDurationMs));
	}

	/**
	 * Computes a deterministic state signature for diffing so the Stream Deck
	 * is updated on every smooth sub-second cooldown sweep step while remaining idle at 0 cooldown.
	 */
	public computeRenderSignature(state: DecodedSlotTelemetry): string {
		const hasIcon = state.fileDataId > 0 && this.memoryCache.has(state.fileDataId) ? 1 : 0;
		const isOnCd =
			state.hasAction &&
			(state.cooldown > 0 || (state.cooldownProgress !== undefined && state.cooldownProgress > 0));
		const progressKey = isOnCd
			? this.getSmoothCooldownProgress(
					state.slot,
					state.cooldown,
					state.cooldownProgress,
					state.cooldownTotalDuration,
				).toFixed(4)
			: "0";
		return `${state.slot}:${state.hasAction ? 1 : 0}:${state.fileDataId}:${hasIcon}:${state.cooldown}:${progressKey}:${state.rawMask}:${state.stacks}`;
	}

	/**
	 * Renders a 144x144 SVG Data-URI representing the current WoW Action Slot state.
	 */
	public renderSlotSvgDataUri(
		state: DecodedSlotTelemetry,
		iconDataUri?: string | null,
	): string {
		const resolvedIcon =
			iconDataUri !== undefined
				? iconDataUri
				: state.fileDataId > 0
					? (this.memoryCache.get(state.fileDataId) ?? null)
					: null;

		const svg = this.renderSlotSvgMarkup(state, resolvedIcon);
		return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	}

	/**
	 * Builds the clockwise radial pie-slice ("Kuchenstück") SVG path for the remaining cooldown.
	 * Uses floating-point progress (0.0 to 1.0, i.e. rem / totalDuration) with millisecond precision.
	 */
	public buildRadialCooldownSweepPath(
		slot: number,
		cooldown: number,
		cooldownProgress?: number,
		cooldownTotalDuration?: number,
	): string {
		const progress = this.getSmoothCooldownProgress(
			slot,
			cooldown,
			cooldownProgress,
			cooldownTotalDuration,
		);
		if (progress <= 0) {
			return "";
		}

		const remainingFraction = Math.min(0.9999, Math.max(0.001, progress));
		const elapsedAngleRad = 2 * Math.PI * (1 - remainingFraction);
		const radius = 108; // Covers the full 144x144 square out to the corners (diagonal radius ~101.8)
		const cx = 72;
		const cy = 72;

		const xStart = Number((cx + radius * Math.sin(elapsedAngleRad)).toFixed(3));
		const yStart = Number((cy - radius * Math.cos(elapsedAngleRad)).toFixed(3));
		const xEnd = cx;
		const yEnd = cy - radius; // -36 (12 o'clock)
		const largeArcFlag = remainingFraction > 0.5 ? 1 : 0;

		return `<path d="M ${cx} ${cy} L ${xStart} ${yStart} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${xEnd} ${yEnd} Z" fill="#000000" fill-opacity="0.65" />`;
	}

	public renderSlotSvgMarkup(
		state: DecodedSlotTelemetry,
		iconDataUri: string | null,
	): string {
		const layers: string[] = [];

		// Base background
		layers.push(`<rect x="0" y="0" width="144" height="144" rx="16" ry="16" fill="#111318"/>`);

		if (!state.hasAction) {
			this.slotMaxCooldown.delete(state.slot);
			this.slotCooldownTrackers.delete(state.slot);
			// Empty slot visual
			layers.push(
				`<rect x="6" y="6" width="132" height="132" rx="12" ry="12" fill="none" stroke="#2a2e39" stroke-width="3"/>`,
				`<text x="72" y="72" text-anchor="middle" dominant-baseline="central" font-family="Segoe UI, Arial, sans-serif" font-size="20" font-weight="600" fill="#4a5060">Slot ${state.slot}</text>`,
			);
			return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">${layers.join("")}</svg>`;
		}

		if (state.cooldown <= 0 && (!state.cooldownProgress || state.cooldownProgress <= 0)) {
			this.slotMaxCooldown.delete(state.slot);
			this.slotCooldownTrackers.delete(state.slot);
		}

		// Z-Order 1: Base Spell Icon (full brightness, completely unfiltered)
		if (iconDataUri) {
			layers.push(
				`<image x="0" y="0" width="144" height="144" preserveAspectRatio="xMidYMid slice" href="${iconDataUri}"/>`,
			);
		} else {
			layers.push(
				`<rect x="8" y="8" width="128" height="128" rx="12" ry="12" fill="#1e2433"/>`,
				`<text x="72" y="56" text-anchor="middle" dominant-baseline="central" font-family="Segoe UI, Arial, sans-serif" font-size="18" font-weight="700" fill="#c8aa6e">SLOT ${state.slot}</text>`,
				`<text x="72" y="84" text-anchor="middle" dominant-baseline="central" font-family="Consolas, monospace" font-size="14" fill="#8a94a6">#${state.fileDataId}</text>`,
			);
		}

		// Status overlays for notEnoughMana / outOfRange (NO <filter> or <feColorMatrix> tags!)
		if (state.notEnoughMana) {
			layers.push(
				`<rect x="0" y="0" width="144" height="144" fill="#0032B4" fill-opacity="0.55" />`,
			);
		}

		if (state.outOfRange) {
			layers.push(
				`<rect x="0" y="0" width="144" height="144" fill="#B40000" fill-opacity="0.50" />`,
				`<rect x="4" y="4" width="136" height="136" rx="12" ry="12" fill="none" stroke="#ff2b2b" stroke-width="8"/>`,
			);
		}

		if (!state.isUsable && !state.notEnoughMana && state.cooldown <= 0 && !state.onCooldown) {
			layers.push(
				`<rect x="0" y="0" width="144" height="144" fill="#000000" fill-opacity="0.45" />`,
			);
		}

		// Z-Order 2: Radial Cooldown-Sweep ("Kuchenstück"-Segment) + Z-Order 3: Cooldown-Text on top
		if (state.cooldown > 0 || (state.cooldownProgress !== undefined && state.cooldownProgress > 0)) {
			const sweepPath = this.buildRadialCooldownSweepPath(
				state.slot,
				state.cooldown,
				state.cooldownProgress,
				state.cooldownTotalDuration,
			);
			if (sweepPath) {
				layers.push(sweepPath);
			}
			if (state.cooldown > 0) {
				const cdText = String(state.cooldown);
				layers.push(
					`<text x="72" y="74" text-anchor="middle" dominant-baseline="central" font-family="Arial Black, sans-serif" font-size="46" font-weight="900" fill="#FFFFFF">${cdText}</text>`,
				);
			}
		}

		// Stacks / Charges (> 1): small number at bottom-right corner
		if (state.stacks > 1) {
			const stackText = String(state.stacks);
			layers.push(
				`<text x="134" y="132" text-anchor="end" font-family="Segoe UI, Arial Black, sans-serif" font-size="30" font-weight="900" fill="#ffffff" stroke="#000000" stroke-width="5" paint-order="stroke fill">${stackText}</text>`,
			);
		}

		return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">${layers.join("")}</svg>`;
	}
}
