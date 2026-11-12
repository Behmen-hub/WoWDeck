import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
	getCandidateKeyByPoolIndex,
	scanAndDecodeBgraBuffer,
	type DecodedSlotTelemetry,
} from "./telemetry-decoder.js";

export interface CaptureHelperResponse {
	ok: boolean;
	width?: number;
	height?: number;
	originX?: number;
	originY?: number;
	bgraBase64?: string;
	slot?: number;
	poolIndex?: number;
	vkCode?: number;
	error?: string;
}

export class Win32TelemetryBridge {
	private helperProcess: ChildProcessWithoutNullStreams | null = null;
	private rl: readline.Interface | null = null;
	private readonly pendingQueue: Array<{
		resolve: (res: CaptureHelperResponse) => void;
		reject: (err: Error) => void;
	}> = [];
	private readonly helperExePath: string;
	private isShuttingDown = false;

	constructor(customExePath?: string) {
		if (customExePath) {
			this.helperExePath = customExePath;
		} else {
			const currentDir = path.dirname(fileURLToPath(import.meta.url));
			const candidate1 = path.join(currentDir, "wowdeck-helper.exe");
			const candidate2 = path.resolve(
				process.cwd(),
				"com.behmen.wowdeck.sdPlugin",
				"bin",
				"wowdeck-helper.exe",
			);
			this.helperExePath = fs.existsSync(candidate1) ? candidate1 : candidate2;
		}
	}

	private ensureProcessStarted(): void {
		if (this.helperProcess && !this.helperProcess.killed) {
			return;
		}
		if (this.isShuttingDown) {
			return;
		}

		this.helperProcess = spawn(this.helperExePath, [], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});

		this.rl = readline.createInterface({
			input: this.helperProcess.stdout,
			crlfDelay: Infinity,
		});

		this.rl.on("line", (line) => {
			const pending = this.pendingQueue.shift();
			if (!pending) return;
			try {
				const parsed = JSON.parse(line) as CaptureHelperResponse;
				pending.resolve(parsed);
			} catch (err) {
				pending.reject(
					err instanceof Error ? err : new Error(String(err)),
				);
			}
		});

		this.helperProcess.on("exit", () => {
			this.helperProcess = null;
			this.rl = null;
			while (this.pendingQueue.length > 0) {
				const item = this.pendingQueue.shift();
				item?.resolve({ ok: false, error: "Helper process exited" });
			}
		});

		this.helperProcess.on("error", (err) => {
			while (this.pendingQueue.length > 0) {
				const item = this.pendingQueue.shift();
				item?.reject(err);
			}
		});
	}

	private sendCommand(payload: Record<string, unknown>): Promise<CaptureHelperResponse> {
		this.ensureProcessStarted();
		return new Promise<CaptureHelperResponse>((resolve, reject) => {
			if (!this.helperProcess || !this.helperProcess.stdin.writable) {
				resolve({ ok: false, error: "Helper stdin not writable" });
				return;
			}
			this.pendingQueue.push({ resolve, reject });
			this.helperProcess.stdin.write(JSON.stringify(payload) + "\n");
		});
	}

	/**
	 * Captures the top-left screen/window region via BitBlt (360x32) and runs the Sync-Scanner
	 * to decode all 116 action slots (234 pixels).
	 */
	public async captureAndDecodeTelemetry(): Promise<DecodedSlotTelemetry[] | null> {
		const res = await this.sendCommand({
			cmd: "capture",
			width: 360,
			height: 32,
		});
		if (!res.ok || !res.bgraBase64 || !res.width || !res.height) {
			return null;
		}
		const bgraBuffer = Buffer.from(res.bgraBase64, "base64");
		const match = scanAndDecodeBgraBuffer(bgraBuffer, res.width, res.height, 4);
		return match ? match.slots : null;
	}

	/**
	 * Triggers the hardware key combo for the dynamically assigned candidate pool index (1..174).
	 */
	public async triggerKeyPoolIndex(poolIndex: number): Promise<boolean> {
		const binding = getCandidateKeyByPoolIndex(poolIndex);
		const res = await this.sendCommand({
			cmd: "sendKey",
			poolIndex: binding.poolIndex,
			slot: binding.poolIndex,
			vkCode: binding.vkCode,
			ctrl: binding.ctrl,
			alt: binding.alt,
			shift: binding.shift,
		});
		return Boolean(res.ok);
	}

	/**
	 * Backwards-compatible alias that triggers the candidate key for a given pool index or slot.
	 */
	public async triggerSlotKey(slotOrPoolIndex: number): Promise<boolean> {
		return this.triggerKeyPoolIndex(slotOrPoolIndex);
	}

	public dispose(): void {
		this.isShuttingDown = true;
		if (this.helperProcess && !this.helperProcess.killed) {
			try {
				this.helperProcess.stdin.write('{"cmd":"exit"}\n');
				this.helperProcess.kill();
			} catch {
				// Ignore cleanup errors
			}
		}
		this.helperProcess = null;
	}
}
