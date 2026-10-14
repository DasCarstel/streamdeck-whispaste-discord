#!/usr/bin/env node
/**
 * Prüft, ob der Discord-RPC-Autorisierungsfluss OHNE Client-Secret funktioniert
 * (Public Client). Dient nur der Entwicklung/Dokumentation.
 *
 * Aufruf:
 *   node tools/test-auth.mjs <clientId> [clientSecret]
 *
 * Wichtig: Im Discord-Client erscheint ein „Autorisieren"-Dialog, der
 * bestätigt werden muss.
 */

import os from "node:os";
import path from "node:path";
import { DiscordRpc } from "../src/brain/discord-rpc.js";

const clientId = process.argv[2];
const clientSecret = process.argv[3] ?? "";

if (!clientId) {
	console.error("Aufruf: node tools/test-auth.mjs <clientId> [clientSecret]");
	process.exit(2);
}

const scopes = ["rpc", "rpc.voice.read", "rpc.voice.write"];

const log = {
	debug: (...args) => console.log("[debug]", ...args),
	info: (...args) => console.log("[info ]", ...args),
	warn: (...args) => console.warn("[warn ]", ...args),
	error: (...args) => console.error("[error]", ...args),
};

const client = new DiscordRpc(
	{
		clientId,
		clientSecret,
		redirectUri: "http://localhost",
		scopes,
		tokenFile: path.join(os.tmpdir(), "whispaste-auth-test.json"),
		commandTimeoutMs: 15000,
		authorizeTimeoutMs: 300000,
	},
	log
);

try {
	await client.connect();
	console.log(`IPC verbunden: ${client.pipePath}`);
	console.log(
		`Autorisierung ${clientSecret ? "MIT" : "OHNE"} Client-Secret — im Discord-Client erscheint jetzt ein Dialog …`
	);

	const data = await client.request("AUTHORIZE", { client_id: clientId, scopes }, { timeoutMs: 300000 });
	console.log("AUTHORIZE-Code erhalten, tausche gegen Token …");

	const token = await client._exchangeCode(data.code);
	console.log(`ERFOLGREICH — Token erhalten (Scopes: ${token.scope ?? "?"}).`);
	console.log(clientSecret ? "Ergebnis: Secret war nötig." : "Ergebnis: OHNE Client-Secret möglich! ✅");
	process.exitCode = 0;
} catch (err) {
	console.error(`FEHLGESCHLAGEN: ${err.message}`);
	console.log(clientSecret ? "Ergebnis: auch mit Secret fehlgeschlagen (Client-ID/Redirect prüfen)." : "Ergebnis: Secret ist erforderlich (oder Redirect-URI/Client-ID falsch).");
	process.exitCode = 1;
} finally {
	client.destroy();
}
