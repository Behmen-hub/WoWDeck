import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const LISTFILE_URL =
	"https://github.com/wowdev/wow-listfile/releases/latest/download/community-listfile.csv";
const ICON_PATH_REGEX = /^(\d+);interface\/icons\/([^/\\]+)\.blp$/i;

async function main() {
	const scriptDir = path.dirname(fileURLToPath(import.meta.url));
	const outPath = path.resolve(scriptDir, "..", "com.behmen.wowdeck.sdPlugin", "assets", "icon-map.json");

	console.log(`Downloading WoW community listfile from ${LISTFILE_URL}...`);
	const res = await fetch(LISTFILE_URL, {
		headers: { Accept: "text/csv,text/plain,*/*;q=0.8" },
	});
	if (!res.ok || !res.body) {
		throw new Error(`Failed to fetch listfile: HTTP ${res.status} ${res.statusText}`);
	}

	const iconMap = new Map();
	const rl = readline.createInterface({
		input: Readable.fromWeb(res.body),
		crlfDelay: Infinity,
	});

	for await (const line of rl) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const match = ICON_PATH_REGEX.exec(trimmed);
		if (!match) continue;
		const fileDataId = Number.parseInt(match[1], 10);
		if (!Number.isFinite(fileDataId) || fileDataId <= 0) continue;
		iconMap.set(fileDataId, match[2].toLowerCase());
	}

	const sortedIds = Array.from(iconMap.keys()).sort((a, b) => a - b);
	const outputObject = Object.create(null);
	for (const id of sortedIds) {
		outputObject[String(id)] = iconMap.get(id);
	}

	fs.mkdirSync(path.dirname(outPath), { recursive: true });
	const json = JSON.stringify(outputObject);
	fs.writeFileSync(outPath, json, "utf8");

	const sizeMb = (Buffer.byteLength(json, "utf8") / (1024 * 1024)).toFixed(2);
	console.log(`Wrote ${sortedIds.length} icon mappings (${sizeMb} MB) to ${outPath}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
