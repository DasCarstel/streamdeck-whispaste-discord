/**
 * Einstellungen des Plugins — liegen in den globalen Stream-Deck-Settings
 * (Property Inspector schreibt direkt dorthin, Pfade wie "whispaste.token").
 */

export type SyncMode = "restore" | "unmute" | "mute";

export type WhisPasteSettings = {
	host: string;
	port: number;
	token: string;
	pollIntervalMs: number;
	requestTimeoutMs: number;
	stopGraceMs: number;
};

export type DiscordSettings = {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	reconnectDelayMs: number;
	commandTimeoutMs: number;
	authorizeTimeoutMs: number;
};

export type RulesSettings = {
	mode: SyncMode;
	requireVoiceChannel: boolean;
	respectManualChanges: boolean;
	startGraceMs: number;
	verifyDelayMs: number;
};

export type GlobalSettings = {
	whispaste: WhisPasteSettings;
	discord: DiscordSettings;
	rules: RulesSettings;
};

export const DEFAULT_SETTINGS: GlobalSettings = {
	whispaste: {
		host: "127.0.0.1",
		port: 8765,
		token: "",
		pollIntervalMs: 250,
		requestTimeoutMs: 1500,
		stopGraceMs: 4000,
	},
	discord: {
		clientId: "",
		clientSecret: "",
		redirectUri: "http://localhost",
		reconnectDelayMs: 5000,
		commandTimeoutMs: 10000,
		authorizeTimeoutMs: 300000,
	},
	rules: {
		mode: "restore",
		requireVoiceChannel: true,
		respectManualChanges: true,
		startGraceMs: 2000,
		verifyDelayMs: 900,
	},
};

function asString(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
	const num = typeof value === "string" ? Number.parseFloat(value) : typeof value === "number" ? value : Number.NaN;
	if (!Number.isFinite(num)) return fallback;
	return Math.min(max, Math.max(min, num));
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return fallback;
}

function asMode(value: unknown): SyncMode {
	return value === "unmute" || value === "mute" || value === "restore" ? value : DEFAULT_SETTINGS.rules.mode;
}

export function normalizeSettings(raw: unknown): GlobalSettings {
	const input = (raw ?? {}) as Record<string, any>;
	const whispaste = (input.whispaste ?? {}) as Record<string, unknown>;
	const discord = (input.discord ?? {}) as Record<string, unknown>;
	const rules = (input.rules ?? {}) as Record<string, unknown>;

	return {
		whispaste: {
			host: asString(whispaste.host, DEFAULT_SETTINGS.whispaste.host),
			port: asNumber(whispaste.port, DEFAULT_SETTINGS.whispaste.port, 1, 65535),
			token: typeof whispaste.token === "string" ? whispaste.token.trim() : "",
			pollIntervalMs: asNumber(whispaste.pollIntervalMs, DEFAULT_SETTINGS.whispaste.pollIntervalMs, 100, 5000),
			requestTimeoutMs: asNumber(whispaste.requestTimeoutMs, DEFAULT_SETTINGS.whispaste.requestTimeoutMs, 200, 10000),
			stopGraceMs: asNumber(whispaste.stopGraceMs, DEFAULT_SETTINGS.whispaste.stopGraceMs, 1000, 60000),
		},
		discord: {
			clientId: typeof discord.clientId === "string" ? discord.clientId.trim() : "",
			clientSecret: typeof discord.clientSecret === "string" ? discord.clientSecret.trim() : "",
			redirectUri: asString(discord.redirectUri, DEFAULT_SETTINGS.discord.redirectUri),
			reconnectDelayMs: asNumber(discord.reconnectDelayMs, DEFAULT_SETTINGS.discord.reconnectDelayMs, 1000, 120000),
			commandTimeoutMs: asNumber(discord.commandTimeoutMs, DEFAULT_SETTINGS.discord.commandTimeoutMs, 1000, 60000),
			authorizeTimeoutMs: asNumber(discord.authorizeTimeoutMs, DEFAULT_SETTINGS.discord.authorizeTimeoutMs, 10000, 900000),
		},
		rules: {
			mode: asMode(rules.mode),
			requireVoiceChannel: asBoolean(rules.requireVoiceChannel, DEFAULT_SETTINGS.rules.requireVoiceChannel),
			respectManualChanges: asBoolean(rules.respectManualChanges, DEFAULT_SETTINGS.rules.respectManualChanges),
			startGraceMs: asNumber(rules.startGraceMs, DEFAULT_SETTINGS.rules.startGraceMs, 500, 15000),
			verifyDelayMs: asNumber(rules.verifyDelayMs, DEFAULT_SETTINGS.rules.verifyDelayMs, 200, 5000),
		},
	};
}

export function settingsProblems(settings: GlobalSettings): string[] {
	const problems: string[] = [];
	if (!settings.whispaste.token) {
		problems.push('WhisPaste-Token fehlt (WhisPaste → Einstellungen → Local Automation API).');
	}
	if (!settings.discord.clientId) {
		problems.push("Discord Client-ID fehlt.");
	}
	if (!settings.discord.clientSecret) {
		problems.push("Discord Client-Secret fehlt.");
	}
	return problems;
}
