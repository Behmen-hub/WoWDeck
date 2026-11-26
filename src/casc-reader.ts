import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

export interface CascReaderLogger {
	info?(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface WowInstallInfo {
	wowRoot: string;
	exePath?: string;
	source?: string;
}

export interface LocalCascReaderOptions {
	wowInstallPath?: string;
	resolveWowInstallInfo?: () => Promise<WowInstallInfo | null>;
	logger?: CascReaderLogger;
}

interface BuildInfoEntry {
	product: string;
	buildKey: string;
}

interface IdxBucket {
	buf: Buffer;
	dataStart: number;
	count: number;
	entryLen: number;
	keyBytes: number;
	offsetBytes: number;
	sizeBytes: number;
	offsetBits: number;
	sorted: boolean;
}

interface EncodingTable {
	buf: Buffer;
	ckeyLen: number;
	ekeyLen: number;
	cPageSize: number;
	cPageCount: number;
	indexStart: number;
	pagesStart: number;
}

interface RootBlockMeta {
	minFdid: number;
	maxFdid: number;
	numRecords: number;
	fdidStart: number;
	ckeyStart: number;
	localeFlags: number;
	contentFlags: number;
	interleaved: boolean;
}

interface LoadedProductCasc {
	product: string;
	encoding: EncodingTable;
	rootBuf: Buffer;
	blocks: RootBlockMeta[];
}

const FLAVOR_TO_PRODUCT: Readonly<Record<string, string>> = Object.freeze({
	_forever_: "wowf",
	_retail_: "wow",
	_classic_: "wow_classic",
	_classic_era_: "wow_classic_era",
	_anniversary_: "wow_anniversary",
	_classic_beta_: "wow_classic_beta",
});

const PRODUCT_PRIORITY = [
	"wowf",
	"wow",
	"wow_classic",
	"wow_classic_era",
	"wow_anniversary",
	"wow_classic_beta",
];

const LOCALE_ALL = 0xffffffff;
const LOCALE_ENUS = 0x2;
const LOCALE_DEDE = 0x20;
const CONTENT_NO_NAME_HASH = 0x10000000;
const CONTENT_INTERLEAVED = 0x02000000;
const CONTENT_LOW_VIOLENCE = 0x80;

/**
 * Normalizes a WoW install path, flavor folder (_retail_, _forever_, ...), or exe path
 * to the shared <WoW-Root> containing `.build.info` and `Data\`.
 */
export function normalizeWowRootPath(
	candidatePath: string,
): { wowRoot: string; flavorHint?: string } | null {
	if (!candidatePath || !candidatePath.trim()) {
		return null;
	}

	let current = path.resolve(candidatePath.trim().replace(/^"|"$/g, ""));
	let flavorHint: string | undefined;

	const segments = current.split(/[\\/]+/).map((s) => s.toLowerCase());
	for (let i = segments.length - 1; i >= 0; i--) {
		const product = FLAVOR_TO_PRODUCT[segments[i]];
		if (product) {
			flavorHint = product;
			break;
		}
	}

	try {
		if (fs.existsSync(current) && fs.statSync(current).isFile()) {
			current = path.dirname(current);
		}
	} catch {
		// Continue walking parent directories even if file stat fails
	}

	for (let depth = 0; depth < 3; depth++) {
		try {
			const buildInfoPath = path.join(current, ".build.info");
			const dataPath = path.join(current, "Data");
			if (fs.existsSync(buildInfoPath) && fs.existsSync(dataPath)) {
				return { wowRoot: current, flavorHint };
			}
		} catch {
			// Ignore stat errors
		}
		const parent = path.dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}

	return null;
}

function execFileAsync(file: string, args: string[]): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(file, args, { windowsHide: true, timeout: 2500 }, (err, stdout) => {
			if (err || !stdout) {
				resolve(null);
				return;
			}
			resolve(stdout);
		});
	});
}

async function queryWowRegistryInstallPath(): Promise<string | null> {
	if (process.platform !== "win32") {
		return null;
	}
	const queries: Array<[string, string]> = [
		["HKLM\\SOFTWARE\\WOW6432Node\\Blizzard Entertainment\\World of Warcraft", "InstallPath"],
		["HKLM\\SOFTWARE\\Blizzard Entertainment\\World of Warcraft", "InstallPath"],
		["HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\World of Warcraft", "InstallLocation"],
		["HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\World of Warcraft", "InstallLocation"],
		["HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\World of Warcraft Classic Era", "InstallLocation"],
		["HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Cataclysm Classic", "InstallLocation"],
	];
	for (const [key, valueName] of queries) {
		const out = await execFileAsync("reg", ["query", key, "/v", valueName]);
		if (!out) continue;
		const match = out.match(/(?:InstallPath|InstallLocation)\s+REG_\w+\s+(.+)/i);
		if (match && match[1]) {
			return match[1].trim();
		}
	}
	return null;
}

function getBucketIndex(key9: Buffer): number {
	let x = 0;
	for (let i = 0; i < key9.length; i++) {
		x ^= key9[i];
	}
	return ((x >> 4) ^ x) & 0x0f;
}

function parseBuildInfo(content: string): BuildInfoEntry[] {
	const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
	if (lines.length < 2) {
		return [];
	}

	const headers = lines[0].split("|").map((h) => h.split("!")[0].trim());
	const activeCol = headers.indexOf("Active");
	const buildKeyCol = headers.indexOf("Build Key");
	const productCol = headers.indexOf("Product");
	if (activeCol < 0 || buildKeyCol < 0 || productCol < 0) {
		return [];
	}

	const entries: BuildInfoEntry[] = [];
	for (let i = 1; i < lines.length; i++) {
		const cols = lines[i].split("|");
		const active = (cols[activeCol] ?? "").trim();
		const buildKey = (cols[buildKeyCol] ?? "").trim().toLowerCase();
		const product = (cols[productCol] ?? "").trim().toLowerCase();
		if (active === "1" && /^[0-9a-f]{32}$/.test(buildKey) && product.length > 0) {
			entries.push({ product, buildKey });
		}
	}
	return entries;
}

function parseBuildConfig(content: string): { rootCKey?: string; encodingEKey?: string } {
	let rootCKey: string | undefined;
	let encodingEKey: string | undefined;

	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eqIdx = line.indexOf("=");
		if (eqIdx < 0) continue;
		const key = line.slice(0, eqIdx).trim();
		const tokens = line.slice(eqIdx + 1).trim().split(/\s+/);
		if (key === "root" && tokens[0] && /^[0-9a-f]{32}$/i.test(tokens[0])) {
			rootCKey = tokens[0].toLowerCase();
		} else if (key === "encoding" && tokens.length > 0) {
			const ekey = tokens[1] ?? tokens[0];
			if (/^[0-9a-f]{32}$/i.test(ekey)) {
				encodingEKey = ekey.toLowerCase();
			}
		}
	}

	return { rootCKey, encodingEKey };
}

function parseIdxBuckets(dataDir: string): IdxBucket[] {
	const entries = fs.readdirSync(dataDir);
	const latestByBucket = new Map<number, { fileName: string; version: number }>();

	for (const name of entries) {
		if (!/^[0-9a-f]{10}\.idx$/i.test(name)) continue;
		const bucket = Number.parseInt(name.slice(0, 2), 16);
		const version = Number.parseInt(name.slice(2, 10), 16);
		const current = latestByBucket.get(bucket);
		if (!current || version > current.version) {
			latestByBucket.set(bucket, { fileName: name, version });
		}
	}

	const buckets = new Array<IdxBucket>(16);
	for (const [bucket, info] of latestByBucket.entries()) {
		const buf = fs.readFileSync(path.join(dataDir, info.fileName));
		if (buf.length < 40) continue;
		const hdrHashSize = buf.readUInt32LE(0);
		const sizeBytes = buf[12];
		const offsetBytes = buf[13];
		const keyBytes = buf[14];
		const offsetBits = buf[15];
		const entriesOff = (8 + hdrHashSize + 0x0f) & ~0x0f;
		if (entriesOff + 8 > buf.length) continue;

		const entriesSize = buf.readUInt32LE(entriesOff);
		const entryLen = keyBytes + offsetBytes + sizeBytes;
		if (entryLen <= 0) continue;
		const dataStart = entriesOff + 8;
		const maxAvailable = Math.max(0, buf.length - dataStart);
		const count = Math.floor(Math.min(entriesSize, maxAvailable) / entryLen);

		let sorted = true;
		const sampleLimit = Math.min(count, 512);
		for (let i = 1; i < sampleLimit; i++) {
			const prevOff = dataStart + (i - 1) * entryLen;
			const curOff = dataStart + i * entryLen;
			if (Buffer.compare(buf.subarray(prevOff, prevOff + keyBytes), buf.subarray(curOff, curOff + keyBytes)) > 0) {
				sorted = false;
				break;
			}
		}

		buckets[bucket] = {
			buf,
			dataStart,
			count,
			entryLen,
			keyBytes,
			offsetBytes,
			sizeBytes,
			offsetBits,
			sorted,
		};
	}

	return buckets;
}

function decodeIdxEntry(bucket: IdxBucket, entryOffset: number): { archive: number; offset: number; size: number } {
	let combined = 0n;
	const offStart = entryOffset + bucket.keyBytes;
	for (let i = 0; i < bucket.offsetBytes; i++) {
		combined = (combined << 8n) | BigInt(bucket.buf[offStart + i]);
	}
	const archive = Number(combined >> BigInt(bucket.offsetBits));
	const offset = Number(combined & ((1n << BigInt(bucket.offsetBits)) - 1n));

	let size = 0;
	const sizeStart = offStart + bucket.offsetBytes;
	for (let i = 0; i < bucket.sizeBytes; i++) {
		size |= bucket.buf[sizeStart + i] << (i * 8);
	}

	return { archive, offset, size: size >>> 0 };
}

function lookupIdxBucket(buckets: ReadonlyArray<IdxBucket | undefined>, ekey: Buffer): { archive: number; offset: number; size: number } | null {
	const keyPrefix = ekey.subarray(0, 9);
	const bucket = buckets[getBucketIndex(keyPrefix)];
	if (!bucket || bucket.count === 0) {
		return null;
	}

	const keySlice = ekey.subarray(0, bucket.keyBytes);
	if (bucket.sorted) {
		let lo = 0;
		let hi = bucket.count - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const off = bucket.dataStart + mid * bucket.entryLen;
			const cmp = Buffer.compare(bucket.buf.subarray(off, off + bucket.keyBytes), keySlice);
			if (cmp === 0) {
				return decodeIdxEntry(bucket, off);
			}
			if (cmp < 0) {
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}
		return null;
	}

	for (let i = 0; i < bucket.count; i++) {
		const off = bucket.dataStart + i * bucket.entryLen;
		if (bucket.buf.subarray(off, off + bucket.keyBytes).equals(keySlice)) {
			return decodeIdxEntry(bucket, off);
		}
	}
	return null;
}

function decompressBlte(raw: Buffer): Buffer | null {
	let blteOff = -1;
	if (raw.length >= 38 && raw[30] === 0x42 && raw[31] === 0x4c && raw[32] === 0x54 && raw[33] === 0x45) {
		blteOff = 30;
	} else if (raw.length >= 8 && raw[0] === 0x42 && raw[1] === 0x4c && raw[2] === 0x54 && raw[3] === 0x45) {
		blteOff = 0;
	}
	if (blteOff < 0) {
		return null;
	}

	const headerSize = raw.readUInt32BE(blteOff + 4);
	if (headerSize === 0) {
		const chunk = raw.subarray(blteOff + 8);
		if (chunk.length === 0) return null;
		if (chunk[0] === 0x4e) return Buffer.from(chunk.subarray(1));
		if (chunk[0] === 0x5a) return zlib.inflateSync(chunk.subarray(1));
		return null;
	}

	if (blteOff + headerSize > raw.length || headerSize < 12) {
		return null;
	}

	const chunkCount = (raw[blteOff + 9] << 16) | (raw[blteOff + 10] << 8) | raw[blteOff + 11];
	if (blteOff + 12 + chunkCount * 24 > blteOff + headerSize) {
		return null;
	}

	let dataPos = blteOff + headerSize;
	const parts: Buffer[] = [];
	for (let i = 0; i < chunkCount; i++) {
		const metaPos = blteOff + 12 + i * 24;
		const compSize = raw.readUInt32BE(metaPos);
		if (compSize === 0 || dataPos + compSize > raw.length) {
			return null;
		}
		const chunk = raw.subarray(dataPos, dataPos + compSize);
		dataPos += compSize;
		const mode = chunk[0];
		if (mode === 0x4e) {
			parts.push(chunk.subarray(1));
		} else if (mode === 0x5a) {
			parts.push(zlib.inflateSync(chunk.subarray(1)));
		} else {
			return null;
		}
	}

	return parts.length === 1 ? Buffer.from(parts[0]) : Buffer.concat(parts);
}

function parseEncodingTable(buf: Buffer): EncodingTable | null {
	if (buf.length < 22 || buf[0] !== 0x45 || buf[1] !== 0x4e) {
		return null;
	}
	const ckeyLen = buf[3];
	const ekeyLen = buf[4];
	const cPageSize = buf.readUInt16BE(5) * 1024;
	const cPageCount = buf.readUInt32BE(9);
	const especSize = buf.readUInt32BE(18);
	const indexStart = 22 + especSize;
	const pagesStart = indexStart + cPageCount * (ckeyLen + 16);
	const cSectionEnd = pagesStart + cPageCount * cPageSize;
	if (ckeyLen === 0 || ekeyLen === 0 || cPageSize === 0 || cSectionEnd > buf.length) {
		return null;
	}

	// Retain only the CKey index + CKey pages so the EKey section can be garbage-collected
	const slice = Buffer.from(buf.subarray(0, cSectionEnd));
	return {
		buf: slice,
		ckeyLen,
		ekeyLen,
		cPageSize,
		cPageCount,
		indexStart,
		pagesStart,
	};
}

function lookupEncodingEKey(table: EncodingTable, ckey: Buffer): Buffer | null {
	if (ckey.length !== table.ckeyLen || table.cPageCount === 0) {
		return null;
	}

	const indexEntryLen = table.ckeyLen + 16;
	let lo = 0;
	let hi = table.cPageCount - 1;
	let pageIdx = -1;

	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const off = table.indexStart + mid * indexEntryLen;
		const cmp = Buffer.compare(table.buf.subarray(off, off + table.ckeyLen), ckey);
		if (cmp <= 0) {
			pageIdx = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}

	if (pageIdx < 0) {
		return null;
	}

	let pos = table.pagesStart + pageIdx * table.cPageSize;
	const pageEnd = pos + table.cPageSize;
	while (pos + 6 + table.ckeyLen <= pageEnd) {
		const keyCount = table.buf[pos];
		if (keyCount === 0) break;
		const entryCKey = table.buf.subarray(pos + 6, pos + 6 + table.ckeyLen);
		const cmp = Buffer.compare(entryCKey, ckey);
		if (cmp === 0) {
			if (pos + 6 + table.ckeyLen + table.ekeyLen > pageEnd) {
				return null;
			}
			return table.buf.subarray(pos + 6 + table.ckeyLen, pos + 6 + table.ckeyLen + table.ekeyLen);
		}
		if (cmp > 0) {
			break;
		}
		pos += 6 + table.ckeyLen + keyCount * table.ekeyLen;
	}

	return null;
}

function parseRootBlocks(rootBuf: Buffer): RootBlockMeta[] {
	if (rootBuf.length < 16) {
		return [];
	}

	let pos = 0;
	let isV2 = false;
	const hasTsfm =
		rootBuf[0] === 0x54 && // 'T'
		rootBuf[1] === 0x53 && // 'S'
		rootBuf[2] === 0x46 && // 'F'
		rootBuf[3] === 0x4d; // 'M'

	if (hasTsfm) {
		const headerSize = rootBuf.readUInt32LE(4);
		const version = rootBuf.readUInt32LE(8);
		if (headerSize < 12 || headerSize > rootBuf.length) {
			return [];
		}
		pos = headerSize;
		isV2 = version >= 2;
	}

	const blocks: RootBlockMeta[] = [];
	const blockHeaderSize = isV2 ? 17 : 12;

	while (pos + blockHeaderSize <= rootBuf.length) {
		const numRecords = rootBuf.readUInt32LE(pos);
		let localeFlags = 0;
		let contentFlags = 0;

		if (isV2) {
			localeFlags = rootBuf.readUInt32LE(pos + 4);
			const unk1 = rootBuf.readUInt32LE(pos + 8);
			const unk2 = rootBuf.readUInt32LE(pos + 12);
			const unk3 = rootBuf[pos + 16];
			contentFlags = (unk1 | unk2 | (unk3 << 17)) >>> 0;
		} else {
			contentFlags = rootBuf.readUInt32LE(pos + 4);
			localeFlags = rootBuf.readUInt32LE(pos + 8);
		}

		pos += blockHeaderSize;
		const noNameHash = (contentFlags & CONTENT_NO_NAME_HASH) !== 0;
		const interleaved = !isV2 && (contentFlags & CONTENT_INTERLEAVED) !== 0;
		const fdidStart = pos;
		const recordBytes = numRecords * (4 + 16 + (noNameHash ? 0 : 8));
		if (numRecords === 0 || pos + recordBytes > rootBuf.length) {
			break;
		}

		let minFdid = 0;
		let maxFdid = 0;
		let fdid = 0;
		for (let i = 0; i < numRecords; i++) {
			const delta = rootBuf.readInt32LE(fdidStart + i * 4);
			fdid = i === 0 ? delta : fdid + 1 + delta;
			if (i === 0) minFdid = fdid;
			maxFdid = fdid;
		}

		const ckeyStart = fdidStart + numRecords * 4;
		blocks.push({
			minFdid,
			maxFdid,
			numRecords,
			fdidStart,
			ckeyStart,
			localeFlags: localeFlags >>> 0,
			contentFlags,
			interleaved,
		});

		pos += recordBytes;
	}

	return blocks;
}

function scoreRootBlock(block: RootBlockMeta): number {
	let score = 0;
	if ((block.contentFlags & CONTENT_LOW_VIOLENCE) === 0) score += 100;
	if ((block.localeFlags & LOCALE_ENUS) !== 0) score += 20;
	if ((block.localeFlags & LOCALE_DEDE) !== 0) score += 15;
	if (block.localeFlags === LOCALE_ALL) score += 10;
	return score;
}

function lookupRootCKey(rootBuf: Buffer, blocks: ReadonlyArray<RootBlockMeta>, targetFdid: number): Buffer | null {
	let bestCKey: Buffer | null = null;
	let bestScore = -1;

	for (const block of blocks) {
		if (targetFdid < block.minFdid || targetFdid > block.maxFdid) {
			continue;
		}

		const score = scoreRootBlock(block);
		if (bestCKey && score <= bestScore) {
			continue;
		}

		let fdid = 0;
		for (let i = 0; i < block.numRecords; i++) {
			const delta = rootBuf.readInt32LE(block.fdidStart + i * 4);
			fdid = i === 0 ? delta : fdid + 1 + delta;
			if (fdid === targetFdid) {
				const ckeyOffset = block.ckeyStart + i * (block.interleaved ? 24 : 16);
				bestCKey = rootBuf.subarray(ckeyOffset, ckeyOffset + 16);
				bestScore = score;
				break;
			}
			if (fdid > targetFdid) {
				break;
			}
		}
	}

	return bestCKey;
}

/**
 * Strictly Read-Only local WoW CASC reader resolving FileDataID -> raw asset bytes (typically BLP2).
 * Initializes lazily on first lookup and falls back cleanly on missing or unreadable installations.
 */
export class LocalCascReader {
	private readonly wowInstallPath?: string;
	private readonly resolveWowInstallInfo?: () => Promise<WowInstallInfo | null>;
	private readonly logger?: CascReaderLogger;

	private initPromise: Promise<boolean> | null = null;
	private wowRoot: string | null = null;
	private dataDir: string | null = null;
	private orderedProducts: BuildInfoEntry[] = [];
	private loadedProductIndex = 0;
	private idxBuckets: IdxBucket[] = [];
	private readonly loadedProducts: LoadedProductCasc[] = [];

	constructor(options?: LocalCascReaderOptions) {
		this.wowInstallPath = options?.wowInstallPath;
		this.resolveWowInstallInfo = options?.resolveWowInstallInfo;
		this.logger = options?.logger;
	}

	private async resolveInstallRoot(): Promise<{ wowRoot: string; flavorHint?: string } | null> {
		if (this.wowInstallPath) {
			const explicit = normalizeWowRootPath(this.wowInstallPath);
			if (explicit) return explicit;
		}

		if (this.resolveWowInstallInfo) {
			try {
				const info = await this.resolveWowInstallInfo();
				if (info?.wowRoot) {
					const fromHelper = normalizeWowRootPath(info.exePath ?? info.wowRoot) ?? normalizeWowRootPath(info.wowRoot);
					if (fromHelper) return fromHelper;
				}
			} catch {
				// Fall through to registry query
			}
		}

		const regPath = await queryWowRegistryInstallPath();
		if (regPath) {
			return normalizeWowRootPath(regPath);
		}

		return null;
	}

	private readArchiveRange(archive: number, offset: number, size: number): Buffer | null {
		if (!this.dataDir || size <= 0) {
			return null;
		}
		const archivePath = path.join(this.dataDir, `data.${String(archive).padStart(3, "0")}`);
		let fd = -1;
		try {
			fd = fs.openSync(archivePath, "r");
			const buf = Buffer.allocUnsafe(size);
			const bytesRead = fs.readSync(fd, buf, 0, size, offset);
			if (bytesRead < size) {
				return null;
			}
			return buf;
		} catch {
			return null;
		} finally {
			if (fd >= 0) {
				try {
					fs.closeSync(fd);
				} catch {
					// Ignore close error
				}
			}
		}
	}

	private readBlteByEKey(ekey: Buffer): Buffer | null {
		const loc = lookupIdxBucket(this.idxBuckets, ekey);
		if (!loc) {
			return null;
		}
		const raw = this.readArchiveRange(loc.archive, loc.offset, loc.size);
		if (!raw) {
			return null;
		}
		return decompressBlte(raw);
	}

	private loadProduct(entry: BuildInfoEntry): LoadedProductCasc | null {
		if (!this.wowRoot) return null;
		const cfgPath = path.join(
			this.wowRoot,
			"Data",
			"config",
			entry.buildKey.slice(0, 2),
			entry.buildKey.slice(2, 4),
			entry.buildKey,
		);
		if (!fs.existsSync(cfgPath)) {
			return null;
		}

		const { rootCKey, encodingEKey } = parseBuildConfig(fs.readFileSync(cfgPath, "utf8"));
		if (!rootCKey || !encodingEKey) {
			return null;
		}

		const encRaw = this.readBlteByEKey(Buffer.from(encodingEKey, "hex"));
		if (!encRaw) return null;
		const encoding = parseEncodingTable(encRaw);
		if (!encoding) return null;

		const rootEKey = lookupEncodingEKey(encoding, Buffer.from(rootCKey, "hex"));
		if (!rootEKey) return null;
		const rootBuf = this.readBlteByEKey(rootEKey);
		if (!rootBuf) return null;
		const blocks = parseRootBlocks(rootBuf);
		if (blocks.length === 0) return null;

		return {
			product: entry.product,
			encoding,
			rootBuf,
			blocks,
		};
	}

	private ensureInitialized(): Promise<boolean> {
		if (!this.initPromise) {
			this.initPromise = this.initializeInternal();
		}
		return this.initPromise;
	}

	private async initializeInternal(): Promise<boolean> {
		try {
			const resolved = await this.resolveInstallRoot();
			if (!resolved) {
				this.logger?.warn("[CASC] Could not locate local World of Warcraft installation; Stage 1 disabled");
				return false;
			}

			const { wowRoot, flavorHint } = resolved;
			const buildInfoPath = path.join(wowRoot, ".build.info");
			const dataDir = path.join(wowRoot, "Data", "data");
			if (!fs.existsSync(buildInfoPath) || !fs.existsSync(dataDir)) {
				this.logger?.warn(`[CASC] Incomplete CASC layout under ${wowRoot}; Stage 1 disabled`);
				return false;
			}

			const buildEntries = parseBuildInfo(fs.readFileSync(buildInfoPath, "utf8"));
			if (buildEntries.length === 0) {
				this.logger?.warn(`[CASC] No active products found in ${buildInfoPath}; Stage 1 disabled`);
				return false;
			}

			const priorityList = flavorHint
				? [flavorHint, ...PRODUCT_PRIORITY.filter((p) => p !== flavorHint)]
				: PRODUCT_PRIORITY;
			this.orderedProducts = [...buildEntries].sort((a, b) => {
				const idxA = priorityList.indexOf(a.product);
				const idxB = priorityList.indexOf(b.product);
				const scoreA = idxA >= 0 ? idxA : 999;
				const scoreB = idxB >= 0 ? idxB : 999;
				return scoreA - scoreB;
			});

			this.wowRoot = wowRoot;
			this.dataDir = dataDir;
			this.idxBuckets = parseIdxBuckets(dataDir);

			while (this.loadedProductIndex < this.orderedProducts.length) {
				const entry = this.orderedProducts[this.loadedProductIndex++];
				const loaded = this.loadProduct(entry);
				if (loaded) {
					this.loadedProducts.push(loaded);
					this.logger?.info?.(
						`[CASC] Stage 1 initialized (root=${wowRoot}, primary=${loaded.product}, rootBlocks=${loaded.blocks.length})`,
					);
					return true;
				}
			}

			this.logger?.warn(`[CASC] Failed to load encoding/root for active products under ${wowRoot}`);
			return false;
		} catch (err) {
			const msg = err instanceof Error ? `${err.name}:${err.message}` : String(err);
			this.logger?.warn(`[CASC] Stage 1 initialization failed cleanly (${msg}); falling back to Stage 2/3`);
			return false;
		}
	}

	/**
	 * Reads raw file bytes (e.g., BLP2 texture) for a WoW FileDataID from local CASC storage.
	 */
	public async readFileByDataId(fileDataId: number): Promise<Buffer | null> {
		if (!fileDataId || fileDataId <= 0) {
			return null;
		}

		const ready = await this.ensureInitialized();
		if (!ready) {
			return null;
		}

		const readFromLoaded = (prod: LoadedProductCasc): Buffer | null => {
			const ckey = lookupRootCKey(prod.rootBuf, prod.blocks, fileDataId);
			if (!ckey) return null;
			const ekey = lookupEncodingEKey(prod.encoding, ckey);
			if (!ekey) return null;
			return this.readBlteByEKey(ekey);
		};

		for (const prod of this.loadedProducts) {
			const result = readFromLoaded(prod);
			if (result) return result;
		}

		while (this.loadedProductIndex < this.orderedProducts.length) {
			const entry = this.orderedProducts[this.loadedProductIndex++];
			const loaded = this.loadProduct(entry);
			if (loaded) {
				this.loadedProducts.push(loaded);
				const result = readFromLoaded(loaded);
				if (result) return result;
			}
		}

		return null;
	}
}
