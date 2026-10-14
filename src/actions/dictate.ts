import streamDeck, {
	action,
	SingletonAction,
	type KeyAction,
	type KeyDownEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import { brain } from "../brain/brain";
import { dictateTitle, renderDictateSvg, svgDataUrl, type RenderState } from "../brain/render";
import { DICTATE_UUID } from "../uuids";

/**
 * Die Diktat-Taste: zeigt den Zustand an und startet/stoppt das Diktat.
 * Beim Start wird zuerst Discord stummgeschaltet (macht das Gehirn).
 */
@action({ UUID: DICTATE_UUID })
export class DictateAction extends SingletonAction {
	readonly #targets = new Map<string, KeyAction<any>>();

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
		const result = await brain.handleToggle();
		streamDeck.logger.info(`Diktat-Taste: ${result.message}`);

		if (result.ok) {
			await ev.action.showOk();
		} else {
			await ev.action.showAlert();
			brain.setMessage(result.message);
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
			await target.setImage(svgDataUrl(renderDictateSvg(state)));
			await target.setTitle(dictateTitle());
		} catch (err) {
			streamDeck.logger.debug(`Taste konnte nicht aktualisiert werden: ${String(err)}`);
		}
	}
}
