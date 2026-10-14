import streamDeck, {
	action,
	SingletonAction,
	type KeyAction,
	type KeyDownEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import { brain } from "../brain/brain";
import { renderStatusSvg, statusLines, svgDataUrl, type RenderState } from "../brain/render";
import { STATUS_UUID } from "../uuids";

/**
 * Status- und Diagnose-Taste: zeigt auf einen Blick, ob WhisPaste und Discord
 * erreichbar sind. Ein Druck führt eine Diagnose aus und repariert, wenn
 * möglich (z. B. Discord-Verbindung neu aufbauen oder neu autorisieren).
 */
@action({ UUID: STATUS_UUID })
export class StatusAction extends SingletonAction {
	readonly #targets = new Map<string, KeyAction<any>>();
	#detail: string | null = null;

	constructor() {
		super();
		brain.on("state", () => {
			void this.renderAll();
		});
	}

	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		if (!ev.action.isKey()) return;
		this.#targets.set(ev.action.id, ev.action);
		await this.render(ev.action);
	}

	override onWillDisappear(ev: WillDisappearEvent): void {
		this.#targets.delete(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		const report = await brain.diagnose(true);
		this.#detail = report;
		streamDeck.logger.info(`Diagnose:\n${report}`);

		const healthy = /WhisPaste: ok/.test(report) && /Discord: ok/.test(report);
		if (healthy) {
			await ev.action.showOk();
		} else {
			await ev.action.showAlert();
		}

		await this.renderAll();
	}

	private async renderAll(): Promise<void> {
		const state = brain.getRenderState();
		for (const target of this.#targets.values()) {
			await this.render(target, state);
		}
	}

	private async render(target: KeyAction<any>, state: RenderState = brain.getRenderState()): Promise<void> {
		try {
			await target.setImage(svgDataUrl(renderStatusSvg(state)));
			const lines = statusLines(state);
			await target.setTitle(this.#detail ? `${lines}\n\n${this.#detail}` : lines);
		} catch (err) {
			streamDeck.logger.debug(`Status-Taste konnte nicht aktualisiert werden: ${String(err)}`);
		}
	}
}
