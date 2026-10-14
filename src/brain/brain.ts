/**
 * Brain — das Herz des Plugins.
 *
 * Es verbindet die beiden Zustandsquellen (WhisPaste-Automation-API und
 * Discord-RPC), führt die Regeln aus (Diktat → Mute, danach den Zustand von
 * vorher wiederherstellen) und meldet Zustandsänderungen an die Actions.
 *
 * Die eigentliche Logik liegt unverändert in den bewährten Modulen
 * whispaste.js / discord-rpc.js / sync.js (vormals Hintergrunddienst).
 */

import streamDeck from "@elgato/streamdeck";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Die JS-Module stammen aus dem getesteten Hintergrunddienst und werden
// unverändert übernommen; die Typen stehen in den jeweiligen .d.ts-Dateien.
import * as whispasteModule from "./whispaste";
import * as discordModule from "./discord-rpc";
import * as syncModule from "./sync";

import { DEFAULT_SETTINGS, normalizeSettings, settingsProblems, type GlobalSettings } from "./settings";
import type { RenderState } from "./render";

const WhisPasteClient: any = (whispasteModule as any).WhisPasteClient;
const DiscordRpc: any = (discordModule as any).DiscordRpc;
const SyncEngine: any = (syncModule as any).SyncEngine;

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_FILE = path.join(PLUGIN_ROOT, "discord-token.json");
const LOG_FILE = path.join(PLUGIN_ROOT, "whispaste-sync.log");
const MAX_LOG_BYTES = 2 * 1024 * 1024;

function writeFileLog(message: string): void {
	try {
		if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) {
			fs.rmSync(LOG_FILE, { force: true });
		}
		fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`, "utf8");
	} catch {
		/* Logdatei ist nicht kritisch */
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function format(args: unknown[]): string {
	return args
		.map((value) => {
			if (typeof value === "string") return value;
			if (value instanceof Error) return value.stack ?? value.message;
			try {
				return JSON.stringify(value);
			} catch {
				return String(value);
			}
		})
		.join(" ");
}

/** Adapter, damit die übernommenen Module mit dem Stream-Deck-Logger reden. */
const log = {
	debug: (...args: unknown[]) => {
		const message = format(args);
		writeFileLog(`[debug] ${message}`);
		streamDeck.logger.debug(message);
	},
	info: (...args: unknown[]) => {
		const message = format(args);
		writeFileLog(`[info ] ${message}`);
		streamDeck.logger.info(message);
	},
	warn: (...args: unknown[]) => {
		const message = format(args);
		writeFileLog(`[warn ] ${message}`);
		streamDeck.logger.warn(message);
	},
	error: (...args: unknown[]) => {
		const message = format(args);
		writeFileLog(`[error] ${message}`);
		streamDeck.logger.error(message);
	},
};

export class Brain extends EventEmitter {
	settings: GlobalSettings = normalizeSettings({});
	problems: string[] = [];
	lastMessage: string | null = null;

	private whispaste: any = null;
	private discord: any = null;
	private engine: any = null;
	private tickTimer: NodeJS.Timeout | null = null;
	private keeperRunning = false;
	private lastSignature = "";
	private nextAuthAttemptAt = 0;
	private started = false;

	async init(): Promise<void> {
		streamDeck.settings.onDidReceiveGlobalSettings((ev) => {
			void this.applySettings(normalizeSettings(ev.settings));
		});
		this.settings = await this.loadSettingsWithRetry();
		this.started = true;
		log.info("Gehirn gestartet.");
		log.info(
			`Einstellungen: WhisPaste ${this.settings.whispaste.host}:${this.settings.whispaste.port} ` +
				`(Token ${this.settings.whispaste.token ? "gesetzt" : "FEHLT"}), Discord Client-ID ${this.settings.discord.clientId ? "gesetzt" : "FEHLT"}, ` +
				`Modus ${this.settings.rules.mode}, Start-Toleranz ${this.settings.rules.startGraceMs} ms, Pruef-Verzoegerung ${this.settings.rules.verifyDelayMs} ms.`,
		);
		for (const problem of settingsProblems(this.settings)) log.warn(problem);
		await this.rebuild();
	}

	private async loadSettingsWithRetry(): Promise<GlobalSettings> {
		for (let attempt = 0; attempt < 20; attempt += 1) {
			try {
				return normalizeSettings(await streamDeck.settings.getGlobalSettings());
			} catch {
				await sleep(250);
			}
		}
		return normalizeSettings({});
	}

	async applySettings(next: GlobalSettings): Promise<void> {
		const credentialsChanged =
			JSON.stringify([this.settings.whispaste, this.settings.discord]) !== JSON.stringify([next.whispaste, next.discord]);
		this.settings = next;
		this.emitState(true);

		if (credentialsChanged) {
			this.setMessage("Einstellungen geändert — Verbindungen werden neu aufgebaut.");
			await this.rebuild();
		} else if (this.engine) {
			this.engine.config = { whispaste: this.settings.whispaste, rules: this.settings.rules };
			this.restartTickLoop();
		}
	}

	private async rebuild(): Promise<void> {
		this.dispose();
		this.problems = settingsProblems(this.settings);

		this.whispaste = new WhisPasteClient(
			{
				host: this.settings.whispaste.host,
				portRangeStart: this.settings.whispaste.port,
				portRangeCount: 20,
				token: this.settings.whispaste.token,
				requestTimeoutMs: this.settings.whispaste.requestTimeoutMs,
			},
			log,
		);

		this.discord = new DiscordRpc(
			{
				clientId: this.settings.discord.clientId,
				clientSecret: this.settings.discord.clientSecret,
				redirectUri: this.settings.discord.redirectUri,
				scopes: ["rpc", "rpc.voice.read", "rpc.voice.write"],
				tokenFile: TOKEN_FILE,
				commandTimeoutMs: this.settings.discord.commandTimeoutMs,
				authorizeTimeoutMs: this.settings.discord.authorizeTimeoutMs,
			},
			log,
		);

		this.engine = new SyncEngine({
			whispaste: this.whispaste,
			discord: this.discord,
			config: { whispaste: this.settings.whispaste, rules: this.settings.rules },
			log,
		});

		this.discord.on("event", (evt: string, data: unknown) => {
			try {
				if (evt === "VOICE_SETTINGS_UPDATE") this.engine.applyVoiceSettings(data, "event");
				else if (evt === "VOICE_CHANNEL_SELECT") this.engine.onVoiceChannelSelect(data);
			} catch (err) {
				log.debug(`Event-Verarbeitung fehlgeschlagen: ${String(err)}`);
			}
			this.emitState();
		});

		this.discord.on("rpcError", (err: Error) => log.warn(`Discord RPC: ${err.message}`));

		this.discord.on("disconnected", (reason: string) => {
			log.warn(`Discord: Verbindung verloren (${reason}).`);
			this.engine.onDiscordDisconnected(reason).catch(() => undefined);
			this.emitState(true);
		});

		this.restartTickLoop();
		if (!this.keeperRunning) {
			this.keeperRunning = true;
			void this.discordKeeper();
		}
		this.emitState(true);
	}

	private restartTickLoop(): void {
		if (this.tickTimer) clearInterval(this.tickTimer);
		const interval = Math.max(100, this.settings.whispaste.pollIntervalMs);
		this.tickTimer = setInterval(() => {
			this.tick().catch((err) => log.error(`Tick fehlgeschlagen: ${String(err)}`));
		}, interval);
	}

	private async tick(): Promise<void> {
		if (!this.engine) return;
		const before = { available: this.engine.state.whispaste.available, phase: this.engine.state.whispaste.phase };
		await this.engine.tick();
		const after = this.engine.state.whispaste;

		if (before.available !== after.available) {
			if (after.available) log.info(`WhisPaste: erreichbar (Port ${this.whispaste?.port}).`);
			else log.warn(`WhisPaste: nicht erreichbar — ${after.lastError ?? "unbekannter Fehler"}`);
		} else if (before.phase !== after.phase) {
			log.debug(`WhisPaste: Phase ${before.phase ?? "-"} → ${after.phase ?? "-"}`);
		}

		this.emitState();
	}

	private async discordKeeper(): Promise<void> {
		while (this.keeperRunning) {
			try {
				await this.connectDiscordOnce();
			} catch (err) {
				log.debug(`Discord-Keeper: ${String(err)}`);
			}
			await sleep(this.settings.discord.reconnectDelayMs);
		}
	}

	private async connectDiscordOnce(): Promise<void> {
		if (!this.discord) return;
		if (this.discord.available && this.discord.authenticated) return;
		if (!this.settings.discord.clientId) return;

		if (!this.discord.available) {
			try {
				const pipe = await this.discord.connect();
				log.info(`Discord: IPC verbunden (${pipe}).`);
			} catch (err) {
				log.debug(`Discord: ${String(err)}`);
				return;
			}
		}

		if (Date.now() < this.nextAuthAttemptAt) return;

		try {
			const how = await this.discord.authenticate({ allowAuthorize: !this.discord.authorizeAttempted });
			log.info(`Discord: angemeldet (${how}).`);
			await this.discord.subscribe("VOICE_SETTINGS_UPDATE");
			this.engine.applyVoiceSettings(await this.discord.getVoiceSettings(), "initial");
			await this.engine.refreshVoiceChannel();
			this.nextAuthAttemptAt = 0;
			this.setMessage(`Discord verbunden als ${this.discord.user?.username ?? "?"}.`);
		} catch (err) {
			log.warn(`Discord: Anmeldung fehlgeschlagen — ${String(err)}`);
			this.nextAuthAttemptAt = Date.now() + 60000;
		}
	}

	dispose(): void {
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
		this.keeperRunning = false;
		try {
			this.discord?.destroy();
		} catch {
			/* egal */
		}
		this.whispaste = null;
		this.discord = null;
		this.engine = null;
	}

	// ── API für die Actions ───────────────────────────────────────────────────

	getRenderState(): RenderState {
		const engineState = this.engine?.state ?? {
			whispaste: { available: false, phase: null, busy: false },
			discord: { available: false, authenticated: false, inVoice: null, mute: null },
			sync: { active: false },
		};

		return {
			configured: this.engine !== null && this.problems.length === 0,
			whispasteAvailable: Boolean(engineState.whispaste.available),
			phase: engineState.whispaste.phase ?? null,
			busy: Boolean(engineState.whispaste.busy),
			recording: engineState.whispaste.phase === "recording",
			discordAvailable: Boolean(engineState.discord.available),
			discordAuthenticated: Boolean(engineState.discord.authenticated),
			discordReady: Boolean(engineState.discord.available && engineState.discord.authenticated),
			inVoice: engineState.discord.inVoice ?? null,
			mute: typeof engineState.discord.mute === "boolean" ? engineState.discord.mute : null,
			syncActive: Boolean(engineState.sync.active),
			problems: this.problems,
			lastMessage: this.lastMessage,
		};
	}

	async handleToggle(): Promise<{ ok: boolean; message: string }> {
		if (!this.engine) return { ok: false, message: "Plugin ist noch nicht bereit." };
		if (!this.settings.whispaste.token) {
			return { ok: false, message: "WhisPaste-Token fehlt — bitte in den Plugin-Einstellungen eintragen." };
		}

		const result = await this.engine.handleToggle();
		const body = result?.body ?? {};
		if (result?.status >= 200 && result?.status < 300) {
			const message = body.action === "stop" ? "Diktat beendet." : "Diktat gestartet.";
			this.setMessage(message);
			return { ok: true, message };
		}

		const message = `Fehler: ${body.error ?? result?.status ?? "unbekannt"}`;
		this.setMessage(message);
		return { ok: false, message };
	}

	async diagnose(repair = false): Promise<string> {
		const lines: string[] = [];

		if (!this.whispaste) {
			lines.push("Plugin nicht initialisiert.");
			return lines.join("\n");
		}

		const status = await this.whispaste.getStatus();
		lines.push(
			status?.ok
				? `WhisPaste: ok (Port ${this.whispaste.port}) · Phase ${status.data?.phase ?? "-"}`
				: `WhisPaste: ${status?.error ?? "nicht erreichbar"}`,
		);

		if (!this.settings.discord.clientId) {
			lines.push("Discord: Client-ID fehlt (Einstellungen).");
		} else if (!this.discord?.available) {
			lines.push("Discord: nicht verbunden.");
			if (repair) {
				this.setMessage("Discord: Verbindung wird neu aufgebaut …");
				await this.connectDiscordOnce();
				lines.push(this.discord?.available ? "Discord: Verbindung hergestellt." : "Discord: weiterhin keine Verbindung.");
			}
		} else if (!this.discord.authenticated) {
			lines.push("Discord: nicht angemeldet.");
			if (repair) {
				this.setMessage("Discord: Autorisierung angefordert (Dialog bestätigen!).");
				this.discord.clearToken();
				this.discord.authorizeAttempted = false;
				this.nextAuthAttemptAt = 0;
				await this.connectDiscordOnce();
				lines.push(this.discord.authenticated ? "Discord: angemeldet." : "Discord: Anmeldung ausstehend.");
			}
		} else {
			const state = this.engine?.state;
			lines.push(`Discord: ok als ${this.discord.user?.username ?? "?"}.`);
			lines.push(
				`Call: ${state?.discord.inVoice === true ? "ja" : state?.discord.inVoice === false ? "nein" : "?"} · Mute: ${state?.discord.mute === true ? "ja" : "nein"}`,
			);
		}

		if (this.problems.length > 0) lines.push(`⚠ ${this.problems.join(" ")}`);
		this.setMessage(lines[lines.length - 1] ?? null);
		return lines.join("\n");
	}

	async reauthorize(): Promise<string> {
		if (!this.discord) return "Plugin nicht initialisiert.";
		log.info("Discord: Token verworfen — neue Autorisierung.");
		this.discord.clearToken();
		this.discord.authorizeAttempted = false;
		this.nextAuthAttemptAt = 0;
		this.discord.destroy();
		await this.connectDiscordOnce();
		return this.discord.authenticated ? "Discord: neu autorisiert." : "Discord: Autorisierungsdialog bestätigen.";
	}

	setMessage(message: string | null): void {
		this.lastMessage = message;
		this.emitState(true);
	}

	private emitState(force = false): void {
		if (!this.started) return;
		const state = this.getRenderState();
		const signature = JSON.stringify([
			state.configured,
			state.whispasteAvailable,
			state.phase,
			state.busy,
			state.discordAvailable,
			state.discordAuthenticated,
			state.inVoice,
			state.mute,
			state.syncActive,
			state.problems.length,
			state.lastMessage,
		]);
		if (!force && signature === this.lastSignature) return;
		this.lastSignature = signature;
		this.emit("state", state);
	}

	isReady(): boolean {
		return this.engine !== null;
	}

	defaults(): GlobalSettings {
		return DEFAULT_SETTINGS;
	}
}

export const brain = new Brain();

// Datei-Token, damit ein Speichern der Einstellungen im Property Inspector
// den Discord-Token nicht überschreibt.
export function tokenFileExists(): boolean {
	return fs.existsSync(TOKEN_FILE);
}
