import streamDeck from "@elgato/streamdeck";

import { DictateAction } from "./actions/dictate";
import { StatusAction } from "./actions/status";
import { brain } from "./brain/brain";

streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new DictateAction());
streamDeck.actions.registerAction(new StatusAction());

streamDeck.connect();

void brain.init().catch((err) => {
	streamDeck.logger.error(`Gehirn konnte nicht gestartet werden: ${String(err)}`);
});
