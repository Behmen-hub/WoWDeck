import streamDeck, {
	action,
	SingletonAction,
	type DidReceiveSettingsEvent,
	type KeyDownEvent,
	type PropertyInspectorDidAppearEvent,
	type SendToPluginEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { IconResolverAndRenderer } from "../icon-renderer.js";
import {
	getCandidateKeyByPoolIndex,
	MAX_ACTION_SLOTS,
	MAX_CANDIDATE_POOL_SIZE,
	type DecodedSlotTelemetry,
} from "../telemetry-decoder.js";
import { Win32TelemetryBridge } from "../win32-bridge.js";

export type SlotActionSettings = {
	slot?: number | string;
	category?: string;
	buttonIndex?: number;
};

export type SlotPiRequestPayload = {
	event?: string;
	slot?: number;
};

@action({ UUID: "com.behmen.wowdeck.slot" })
export class WoWSlotAction extends SingletonAction<SlotActionSettings> {
	private readonly bridge: Win32TelemetryBridge;
	private readonly renderer: IconResolverAndRenderer;
	private readonly actionSettings = new Map<string, number>();
	private readonly slotKeyPoolMap = new Map<number, number>();
	private readonly lastRenderSignatures = new Map<string, string>();
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private isPollingTick = false;
	private isTelemetryActive = false;
	private lastPiSignature = "";

	constructor() {
		super();
		const pluginDir = path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			"..",
		);
		const cacheDir = path.join(pluginDir, "cache", "icons");
		this.bridge = new Win32TelemetryBridge();
		this.renderer = new IconResolverAndRenderer(cacheDir);
	}

	private parseSlot(settings: SlotActionSettings | undefined): number {
		const raw = settings?.slot;
		const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? "1"), 10);
		if (Number.isNaN(parsed) || parsed < 1) return 1;
		if (parsed > MAX_ACTION_SLOTS) return MAX_ACTION_SLOTS;
		return parsed;
	}

	public override async onWillAppear(
		ev: WillAppearEvent<SlotActionSettings>,
	): Promise<void> {
		const slot = this.parseSlot(ev.payload.settings);
		this.actionSettings.set(ev.action.id, slot);
		this.lastRenderSignatures.delete(ev.action.id);

		if (ev.payload.settings?.slot === undefined) {
			await ev.action.setSettings({ slot: 1 });
		}

		await this.renderStandbyIfNeeded(ev.action.id, slot);
		this.ensurePollingLoop();
	}

	public override onWillDisappear(
		ev: WillDisappearEvent<SlotActionSettings>,
	): void {
		this.actionSettings.delete(ev.action.id);
		this.lastRenderSignatures.delete(ev.action.id);
		if (this.actionSettings.size === 0 && this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	public override async onDidReceiveSettings(
		ev: DidReceiveSettingsEvent<SlotActionSettings>,
	): Promise<void> {
		const slot = this.parseSlot(ev.payload.settings);
		this.actionSettings.set(ev.action.id, slot);
		this.lastRenderSignatures.delete(ev.action.id);
		await this.pollOnce();
		await this.pushLiveBindingsToPropertyInspector(true, slot);
	}

	public override async onPropertyInspectorDidAppear(
		ev: PropertyInspectorDidAppearEvent<SlotActionSettings>,
	): Promise<void> {
		this.ensurePollingLoop();
		const activeSlot = this.actionSettings.get(ev.action.id) ?? 1;
		await this.pushLiveBindingsToPropertyInspector(true, activeSlot);
	}

	public override async onSendToPlugin(
		ev: SendToPluginEvent<SlotPiRequestPayload, SlotActionSettings>,
	): Promise<void> {
		const requestedSlot =
			ev.payload && typeof ev.payload.slot === "number"
				? this.parseSlot({ slot: ev.payload.slot })
				: (this.actionSettings.get(ev.action.id) ?? 1);
		await this.pushLiveBindingsToPropertyInspector(true, requestedSlot);
	}

	public override async onKeyDown(
		ev: KeyDownEvent<SlotActionSettings>,
	): Promise<void> {
		const slot = this.parseSlot(ev.payload.settings);
		this.actionSettings.set(ev.action.id, slot);
		const poolIndex = this.slotKeyPoolMap.get(slot) ?? slot;
		try {
			await this.bridge.triggerKeyPoolIndex(poolIndex);
		} catch (err) {
			streamDeck.logger.error(
				`Failed to trigger slot ${slot} (poolIndex ${poolIndex}):`,
				err,
			);
		}
	}

	private ensurePollingLoop(): void {
		if (this.pollTimer) return;
		this.pollTimer = setInterval(() => {
			void this.pollOnce();
		}, 50); // 20 Hz (50ms) matching WoWDeckBridge.lua for smooth sub-second cooldown sweep
	}

	private async pushLiveBindingsToPropertyInspector(
		force = false,
		explicitSlot?: number,
	): Promise<void> {
		const currentPiAction = streamDeck.ui.action;
		if (!currentPiAction && !force) {
			return;
		}

		const activeSlot =
			explicitSlot ??
			(currentPiAction ? (this.actionSettings.get(currentPiAction.id) ?? 1) : 1);

		const poolBySlot: Record<string, number> = {};
		const comboBySlot: Record<string, string> = {};
		let mapSig = "";

		for (let s = 1; s <= MAX_ACTION_SLOTS; s++) {
			const pIdx = this.slotKeyPoolMap.get(s);
			if (pIdx && pIdx >= 1 && pIdx <= MAX_CANDIDATE_POOL_SIZE) {
				poolBySlot[String(s)] = pIdx;
				comboBySlot[String(s)] = getCandidateKeyByPoolIndex(pIdx).wowComboString;
				mapSig += `${s}:${pIdx},`;
			}
		}

		const activePoolIdx = this.slotKeyPoolMap.get(activeSlot) ?? null;
		const activeKeyCombo = activePoolIdx
			? getCandidateKeyByPoolIndex(activePoolIdx).wowComboString
			: null;

		const nextPiSig = `${this.isTelemetryActive ? 1 : 0}|${activeSlot}|${activePoolIdx ?? 0}|${mapSig}`;
		if (!force && nextPiSig === this.lastPiSignature) {
			return;
		}
		this.lastPiSignature = nextPiSig;

		try {
			await streamDeck.ui.sendToPropertyInspector({
				event: "activeKeyBinding",
				telemetryActive: this.isTelemetryActive,
				slot: activeSlot,
				keyPoolIndex: activePoolIdx,
				activeKeyCombo,
				poolBySlot,
				comboBySlot,
			});
		} catch {
			// Ignore if Property Inspector closed concurrently
		}
	}

	private async pollOnce(): Promise<void> {
		if (this.isPollingTick || this.actionSettings.size === 0) {
			return;
		}
		this.isPollingTick = true;

		try {
			const slots = await this.bridge.captureAndDecodeTelemetry();

			if (slots) {
				this.isTelemetryActive = true;
				for (const st of slots) {
					if (
						st.keyPoolIndex >= 1 &&
						st.keyPoolIndex <= MAX_CANDIDATE_POOL_SIZE
					) {
						this.slotKeyPoolMap.set(st.slot, st.keyPoolIndex);
					}
				}
			} else {
				this.isTelemetryActive = false;
			}

			await this.pushLiveBindingsToPropertyInspector(false);

			for (const actionItem of this.actions) {
				const slotNumber = this.actionSettings.get(actionItem.id) ?? 1;

				if (!slots) {
					await this.renderStandbyIfNeeded(actionItem.id, slotNumber);
					continue;
				}

				const slotState: DecodedSlotTelemetry | undefined =
					slots[slotNumber - 1];
				if (!slotState) {
					continue;
				}

				// Trigger non-blocking background fetch for new FileDataIDs
				if (
					slotState.hasAction &&
					slotState.fileDataId > 0 &&
					!this.renderer.hasIconInMemory(slotState.fileDataId)
				) {
					void this.renderer
						.resolveIconDataUri(slotState.fileDataId)
						.then((uri) => {
							if (uri) {
								// Invalidate signature so next tick draws the newly cached spell icon
								this.lastRenderSignatures.delete(actionItem.id);
							}
						});
				}

				const sig = this.renderer.computeRenderSignature(slotState);
				if (this.lastRenderSignatures.get(actionItem.id) === sig) {
					continue;
				}

				this.lastRenderSignatures.set(actionItem.id, sig);
				const dataUri = this.renderer.renderSlotSvgDataUri(slotState);
				await actionItem.setImage(dataUri);
				await actionItem.setTitle("");
			}
		} catch (err) {
			streamDeck.logger.error("Telemetry poll error:", err);
		} finally {
			this.isPollingTick = false;
		}
	}

	private async renderStandbyIfNeeded(
		actionId: string,
		slot: number,
	): Promise<void> {
		const standbySig = `standby:${slot}`;
		if (this.lastRenderSignatures.get(actionId) === standbySig) {
			return;
		}

		for (const actionItem of this.actions) {
			if (actionItem.id === actionId) {
				this.lastRenderSignatures.set(actionId, standbySig);
				const emptyState: DecodedSlotTelemetry = {
					slot,
					fileDataId: 0,
					cooldown: 0,
					stacks: 0,
					rawMask: 0,
					keyPoolIndex: this.slotKeyPoolMap.get(slot) ?? slot,
					hasAction: false,
					isUsable: false,
					notEnoughMana: false,
					outOfRange: false,
					onCooldown: false,
				};
				const svgUri = this.renderer.renderSlotSvgDataUri(emptyState, null);
				await actionItem.setImage(svgUri);
				await actionItem.setTitle("");
				break;
			}
		}
	}
}
