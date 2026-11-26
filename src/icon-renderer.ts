import * as fs from "node:fs";
import * as path from "node:path";
import { decodeBlp2ToPng, isBlp2Buffer } from "./blp-decoder.js";
import { LocalCascReader, type WowInstallInfo } from "./casc-reader.js";
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

export const NEGATIVE_CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes
export const CIRCUIT_BREAKER_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
export const FETCH_TIMEOUT_MS = 5000;
export const MIN_REQUEST_INTERVAL_MS = 300;

export interface IconRendererLogger {
	info?(message: string): void;
	debug?(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface CascIconSource {
	readFileByDataId(fileDataId: number): Promise<Buffer | null>;
}

export interface IconRendererOptions {
	cacheDir?: string;
	iconMapPath?: string;
	minRequestIntervalMs?: number;
	fetchTimeoutMs?: number;
	negativeCacheTtlMs?: number;
	circuitBreakerCooldownMs?: number;
	wowInstallPath?: string;
	resolveWowInstallInfo?: () => Promise<WowInstallInfo | null>;
	enableLocalCasc?: boolean;
	cascReader?: CascIconSource | null;
	logger?: IconRendererLogger;
}

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
	private readonly failedFetches = new Map<number, number>(); // fileDataId -> negative-cache expiry timestamp (ms)
	private readonly blockedHosts = new Map<string, number>(); // hostname -> circuit-breaker expiry timestamp (ms)
	private readonly iconNameMap: Readonly<Record<number, string>>;
	private readonly minRequestIntervalMs: number;
	private readonly fetchTimeoutMs: number;
	private readonly negativeCacheTtlMs: number;
	private readonly circuitBreakerCooldownMs: number;
	private readonly cascReader: CascIconSource | null;
	private readonly logger?: IconRendererLogger;
	private requestQueueTail: Promise<void> = Promise.resolve();
	private lastNetworkRequestEndMs = 0;
	private readonly slotMaxCooldown = new Map<number, number>(); // slot -> max observed cooldown seconds
	private readonly slotCooldownTrackers = new Map<number, SlotCooldownTracker>(); // slot -> sub-second millisecond tracker

	constructor(cacheDirOrOptions?: string | IconRendererOptions) {
		const opts: IconRendererOptions =
			typeof cacheDirOrOptions === "string" ? { cacheDir: cacheDirOrOptions } : (cacheDirOrOptions ?? {});
		this.cacheDir =
			opts.cacheDir ?? path.resolve(process.cwd(), "cache", "icons");
		this.minRequestIntervalMs = opts.minRequestIntervalMs ?? MIN_REQUEST_INTERVAL_MS;
		this.fetchTimeoutMs = opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
		this.negativeCacheTtlMs = opts.negativeCacheTtlMs ?? NEGATIVE_CACHE_TTL_MS;
		this.circuitBreakerCooldownMs = opts.circuitBreakerCooldownMs ?? CIRCUIT_BREAKER_COOLDOWN_MS;
		this.logger = opts.logger;
		if (opts.cascReader !== undefined) {
			this.cascReader = opts.cascReader;
		} else if (opts.enableLocalCasc === false) {
			this.cascReader = null;
		} else {
			this.cascReader = new LocalCascReader({
				wowInstallPath: opts.wowInstallPath,
				resolveWowInstallInfo: opts.resolveWowInstallInfo,
				logger: opts.logger,
			});
		}
		this.iconNameMap = this.loadIconNameMap(opts.iconMapPath);
		try {
			fs.mkdirSync(this.cacheDir, { recursive: true });
		} catch {
			// Ignore directory creation errors in restricted environments
		}
	}

	private loadIconNameMap(customPath?: string): Readonly<Record<number, string>> {
		const merged: Record<number, string> = { ...KNOWN_ICON_NAMES };
		const candidatePaths = customPath
			? [customPath]
			: [
					path.resolve(this.cacheDir, "..", "..", "assets", "icon-map.json"),
					path.resolve(process.cwd(), "assets", "icon-map.json"),
					path.resolve(this.cacheDir, "..", "..", "icon-map.json"),
					path.resolve(process.cwd(), "icon-map.json"),
				];

		let loadedFromPath: string | null = null;
		let loadedCount = 0;

		for (const mapPath of candidatePaths) {
			try {
				if (!fs.existsSync(mapPath)) continue;
				const parsed = JSON.parse(fs.readFileSync(mapPath, "utf8")) as Record<string, unknown>;
				for (const [key, value] of Object.entries(parsed)) {
					const numericId = Number(key);
					if (Number.isFinite(numericId) && numericId > 0 && typeof value === "string" && value.trim()) {
						merged[numericId] = value.trim().toLowerCase();
						loadedCount++;
					}
				}
				loadedFromPath = mapPath;
				break;
			} catch {
				// Ignore unreadable/malformed optional icon-map.json
			}
		}

		if (loadedFromPath) {
			const msg = `[IconFetcher] Loaded ${loadedCount} icon mappings from ${loadedFromPath}`;
			if (this.logger?.info) {
				this.logger.info(msg);
			}
		} else {
			this.logger?.warn(
				`[IconFetcher] No external icon-map.json found; using ${Object.keys(KNOWN_ICON_NAMES).length} built-in mappings`,
			);
		}

		return Object.freeze(merged);
	}

	public getCacheFilePath(fileDataId: number): string {
		return path.join(this.cacheDir, `${fileDataId}.png`);
	}

	public hasIconInMemory(fileDataId: number): boolean {
		return this.memoryCache.has(fileDataId);
	}

	public isNegativelyCached(fileDataId: number): boolean {
		const expiresAt = this.failedFetches.get(fileDataId);
		if (expiresAt === undefined) {
			return false;
		}
		if (Date.now() >= expiresAt) {
			this.failedFetches.delete(fileDataId);
			return false;
		}
		return true;
	}

	public isHostBlocked(host: string): boolean {
		const normalized = host.toLowerCase();
		const blockedUntil = this.blockedHosts.get(normalized);
		if (blockedUntil === undefined) {
			return false;
		}
		if (Date.now() >= blockedUntil) {
			this.blockedHosts.delete(normalized);
			return false;
		}
		return true;
	}

	public canAttemptResolve(fileDataId: number): boolean {
		if (!fileDataId || fileDataId <= 0) {
			return false;
		}
		if (this.memoryCache.has(fileDataId) || this.pendingFetches.has(fileDataId)) {
			return false;
		}
		return !this.isNegativelyCached(fileDataId);
	}

	/**
	 * Resolves a FileDataID to a Base64 image data URI, reading from disk cache
	 * `/cache/icons/{fileDataId}.png` or downloading from static CDNs / Wago Tools CASC API.
	 */
	public async resolveIconDataUri(fileDataId: number): Promise<string | null> {
		if (!fileDataId || fileDataId <= 0) {
			return null;
		}

		const mem = this.memoryCache.get(fileDataId);
		if (mem) {
			return mem;
		}

		if (this.isNegativelyCached(fileDataId)) {
			return null;
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

		const fetchPromise = this.fetchAndCacheRemoteIcon(fileDataId, diskPath)
			.then((dataUri) => {
				if (dataUri) {
					this.failedFetches.delete(fileDataId);
				} else {
					this.recordNegativeCache(fileDataId);
				}
				return dataUri;
			})
			.catch(() => {
				this.recordNegativeCache(fileDataId);
				return null;
			})
			.finally(() => {
				this.pendingFetches.delete(fileDataId);
			});
		this.pendingFetches.set(fileDataId, fetchPromise);
		return fetchPromise;
	}

	private recordNegativeCache(fileDataId: number): void {
		const ttlMinutes = Math.round(this.negativeCacheTtlMs / 60000);
		this.failedFetches.set(fileDataId, Date.now() + this.negativeCacheTtlMs);
		this.logger?.warn(
			`[IconFetcher] Negative-caching fileDataId=${fileDataId} for ${ttlMinutes}m after all sources failed`,
		);
	}

	private formatError(err: unknown): string {
		if (err instanceof Error) {
			const base = `${err.name}:${err.message}`;
			const errWithCause = err as Error & { cause?: unknown };
			if (errWithCause.cause !== undefined) {
				const causeStr =
					errWithCause.cause instanceof Error
						? `${errWithCause.cause.name}:${errWithCause.cause.message}`
						: String(errWithCause.cause);
				return `${base} (cause: ${causeStr})`;
			}
			return base;
		}
		return String(err);
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

	private enqueueNetworkRequest<T>(task: () => Promise<T>): Promise<T> {
		const run = async (): Promise<T> => {
			if (this.minRequestIntervalMs > 0 && this.lastNetworkRequestEndMs > 0) {
				const elapsed = Date.now() - this.lastNetworkRequestEndMs;
				const remaining = this.minRequestIntervalMs - elapsed;
				if (remaining > 0) {
					await new Promise((resolve) => setTimeout(resolve, remaining));
				}
			}
			try {
				return await task();
			} finally {
				this.lastNetworkRequestEndMs = Date.now();
			}
		};

		const resultPromise = this.requestQueueTail.then(run, run);
		this.requestQueueTail = resultPromise.then(
			() => undefined,
			() => undefined,
		);
		return resultPromise;
	}

	private async tryDownloadImageBytes(url: string): Promise<Buffer | null> {
		let hostname: string;
		try {
			hostname = new URL(url).hostname.toLowerCase();
		} catch {
			return null;
		}

		if (this.isHostBlocked(hostname)) {
			return null;
		}

		return this.enqueueNetworkRequest(async () => {
			if (this.isHostBlocked(hostname)) {
				return null;
			}
			try {
				const res = await fetch(url, {
					headers: {
						Accept: "image/png,image/jpeg,image/*;q=0.8",
					},
					signal: AbortSignal.timeout(this.fetchTimeoutMs),
				});
				const contentType = res.headers.get("content-type") ?? "none";
				if (res.status === 403 || res.status === 429 || res.status === 503) {
					const cooldownMinutes = Math.round(this.circuitBreakerCooldownMs / 60000);
					this.blockedHosts.set(hostname, Date.now() + this.circuitBreakerCooldownMs);
					this.logger?.warn(
						`[IconFetcher] Circuit breaker triggered host=${hostname} url=${url} status=${res.status} content-type=${contentType} cooldown=${cooldownMinutes}m`,
					);
					return null;
				}
				if (!res.ok) {
					this.logger?.warn(
						`[IconFetcher] HTTP error url=${url} status=${res.status} content-type=${contentType}`,
					);
					return null;
				}
				const arrayBuf = await res.arrayBuffer();
				const buf = Buffer.from(arrayBuf);
				if (buf.length > 64 && this.IsValidImageBuffer(buf)) {
					return buf;
				}
				if (isBlp2Buffer(buf)) {
					const converted = decodeBlp2ToPng(buf);
					if (converted) {
						return converted;
					}
					this.logger?.warn(
						`[IconFetcher] BLP2 decode failed url=${url} status=${res.status} content-type=${contentType} length=${buf.length}`,
					);
					return null;
				}
				const hexPrefix = buf.subarray(0, 8).toString("hex");
				this.logger?.warn(
					`[IconFetcher] Invalid image buffer url=${url} status=${res.status} content-type=${contentType} length=${buf.length} hex=${hexPrefix}`,
				);
			} catch (err) {
				this.logger?.error(
					`[IconFetcher] Fetch failed url=${url} error=${this.formatError(err)}`,
				);
			}
			return null;
		});
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

	private async fetchBufferForFileDataId(fileDataId: number): Promise<Buffer | null> {
		// Stage 1: Local Read-Only WoW CASC archive (100% offline, primary)
		if (this.cascReader) {
			try {
				const rawCasc = await this.cascReader.readFileByDataId(fileDataId);
				if (rawCasc) {
					if (isBlp2Buffer(rawCasc)) {
						const decodedPng = decodeBlp2ToPng(rawCasc);
						if (decodedPng) {
							this.logger?.info?.(
								`[IconFetcher] Resolved fileDataId=${fileDataId} via Stage 1 (Local CASC BLP2->PNG)`,
							);
							return decodedPng;
						}
						this.logger?.warn(
							`[IconFetcher] Stage 1 BLP2 decode failed for fileDataId=${fileDataId}; falling back to Stage 2`,
						);
					} else if (rawCasc.length > 64 && this.IsValidImageBuffer(rawCasc)) {
						this.logger?.info?.(
							`[IconFetcher] Resolved fileDataId=${fileDataId} via Stage 1 (Local CASC image)`,
						);
						return rawCasc;
					} else {
						this.logger?.warn(
							`[IconFetcher] Stage 1 returned unsupported buffer for fileDataId=${fileDataId} (len=${rawCasc.length}); falling back to Stage 2`,
						);
					}
				}
			} catch (err) {
				this.logger?.warn(
					`[IconFetcher] Stage 1 failed for fileDataId=${fileDataId} (${this.formatError(err)}); falling back to Stage 2`,
				);
			}
		}

		// Stage 2: Resolve icon name from bundled icon-map.json / built-in map -> Blizzard Render / Zamimg CDN
		const iconName = this.iconNameMap[fileDataId];
		if (iconName) {
			const candidateImageUrls = [
				`https://render.worldofwarcraft.com/eu/icons/56/${iconName}.jpg`,
				`https://render.worldofwarcraft.com/us/icons/56/${iconName}.jpg`,
				`https://wow.zamimg.com/images/wow/icons/large/${iconName}.jpg`,
			];
			for (const imgUrl of candidateImageUrls) {
				const buf = await this.tryDownloadImageBytes(imgUrl);
				if (buf) {
					this.logger?.info?.(
						`[IconFetcher] Resolved fileDataId=${fileDataId} via Stage 2 (Static CDN: ${imgUrl})`,
					);
					return buf;
				}
			}
		}

		// Stage 3: Last fallback via Wago Tools CASC API (supports PNG & raw BLP2 auto-conversion)
		const wagoUrl = `https://wago.tools/api/casc/${fileDataId}?format=png`;
		const wagoBuf = await this.tryDownloadImageBytes(wagoUrl);
		if (wagoBuf) {
			this.logger?.info?.(
				`[IconFetcher] Resolved fileDataId=${fileDataId} via Stage 3 (Wago CASC)`,
			);
			return wagoBuf;
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
				const cdText =
					state.cooldown >= 120
						? `${Math.ceil(state.cooldown / 60)}m`
						: String(state.cooldown);
				const fontSize = cdText.length >= 4 ? 36 : cdText.length === 3 ? 40 : 46;
				layers.push(
					`<text x="72" y="74" text-anchor="middle" dominant-baseline="central" font-family="Arial Black, sans-serif" font-size="${fontSize}" font-weight="900" fill="#FFFFFF">${cdText}</text>`,
				);
			}
		}

		// Z-Order 4: Stacks / Charges (> 1) at bottom-right corner — above icon, status overlays & cooldown sweep
		if (state.stacks > 1) {
			const stackText = String(state.stacks);
			const charCount = stackText.length;
			const stackFontSize = charCount >= 3 ? 28 : charCount === 2 ? 34 : 36;
			const pillHeight = stackFontSize + 8;
			const pillWidth = Math.round(charCount * stackFontSize * 0.72) + 18;
			const pillRight = 134;
			const pillBottom = 134;
			const pillX = pillRight - pillWidth;
			const pillY = pillBottom - pillHeight;
			const textX = pillRight - 9;
			const textY = pillY + Math.round((pillHeight + stackFontSize * 0.72) / 2);

			// Render dark rounded pill + stroked outline layer behind + crisp pure-white fill on top
			// (two-pass text ensures high contrast even in QtSvg renderers that ignore SVG2 paint-order)
			layers.push(
				`<rect x="${pillX}" y="${pillY}" width="${pillWidth}" height="${pillHeight}" rx="9" ry="9" fill="#000000" fill-opacity="0.72" />`,
				`<text x="${textX}" y="${textY}" text-anchor="end" font-family="Arial Black, sans-serif" font-size="${stackFontSize}" font-weight="900" fill="#000000" stroke="#000000" stroke-width="5" stroke-linejoin="round" paint-order="stroke fill">${stackText}</text>`,
				`<text x="${textX}" y="${textY}" text-anchor="end" font-family="Arial Black, sans-serif" font-size="${stackFontSize}" font-weight="900" fill="#FFFFFF">${stackText}</text>`,
			);
		}

		return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">${layers.join("")}</svg>`;
	}
}
