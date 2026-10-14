/**
 * Rendering der Tastenbilder. Die SVGs werden als Data-URL an setImage
 * übergeben (Stream Deck skaliert selbst auf die Tastengröße).
 */

export type RenderState = {
	configured: boolean;
	whispasteAvailable: boolean;
	phase: string | null;
	busy: boolean;
	recording: boolean;
	discordAvailable: boolean;
	discordAuthenticated: boolean;
	discordReady: boolean;
	inVoice: boolean | null;
	mute: boolean | null;
	syncActive: boolean;
	problems: string[];
	lastMessage: string | null;
};

const MIC_GLYPH = `
	<rect x="29.5" y="11" width="13" height="25" rx="6.5" fill="ACCCENT"></rect>
	<path d="M22.5 31.5 a13.5 13.5 0 0 0 27 0" fill="none" stroke="ACCCENT" stroke-width="3.6" stroke-linecap="round"></path>
	<line x1="36" y1="45.5" x2="36" y2="53" stroke="ACCCENT" stroke-width="3.6" stroke-linecap="round"></line>
	<line x1="27.5" y1="54.5" x2="44.5" y2="54.5" stroke="ACCCENT" stroke-width="3.6" stroke-linecap="round"></line>`;

function svg(body: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">${body}</svg>`;
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function label(state: RenderState): string {
	if (!state.configured) return "Setup";
	if (state.recording) return state.mute ? "REC" : "REC?";
	if (state.busy) return "…";
	return "Diktat";
}

function colors(state: RenderState): { bg: string; accent: string } {
	if (!state.configured) return { bg: "#12151a", accent: "#6b7280" };
	if (state.recording) return { bg: "#2a0b0b", accent: "#ff4b4b" };
	if (state.busy) return { bg: "#241a07", accent: "#ffb020" };
	if (!state.whispasteAvailable) return { bg: "#12151a", accent: "#8b5cf6" };
	if (!state.discordReady) return { bg: "#101418", accent: "#4aa3ff" };
	return { bg: "#0f1a14", accent: "#3ddc84" };
}

export function renderDictateSvg(state: RenderState): string {
	const { bg, accent } = colors(state);
	const text = label(state);
	const glyph = MIC_GLYPH.replace(/ACCCENT/g, accent);
	const dot = state.recording ? `<circle cx="60" cy="12" r="4.5" fill="${accent}"></circle>` : "";
	const warn =
		state.configured && !state.discordReady
			? `<circle cx="12" cy="12" r="4.5" fill="#ffb020"></circle>`
			: "";

	return svg(`
		<rect width="72" height="72" rx="11" fill="${bg}"></rect>
		<rect x="1.5" y="1.5" width="69" height="69" rx="9.5" fill="none" stroke="${accent}" stroke-opacity="0.55" stroke-width="2"></rect>
		${glyph}
		${dot}
		${warn}
		<text x="36" y="68.5" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="11" font-weight="600" fill="${accent}">${escapeXml(text)}</text>
	`);
}

export function renderStatusSvg(state: RenderState): string {
	const ok = state.whispasteAvailable && state.discordReady;
	const warn = state.whispasteAvailable || state.discordReady;
	const accent = !state.configured ? "#6b7280" : ok ? "#3ddc84" : warn ? "#ffb020" : "#ff4b4b";

	return svg(`
		<rect width="72" height="72" rx="11" fill="#101418"></rect>
		<rect x="1.5" y="1.5" width="69" height="69" rx="9.5" fill="none" stroke="${accent}" stroke-opacity="0.7" stroke-width="2"></rect>
		<text x="36" y="34" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="22" font-weight="700" fill="${accent}">STATUS</text>
		<text x="36" y="52" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="11" fill="#9aa4b2">Druck = Diagnose</text>
		<text x="36" y="66" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="10" fill="#6b7280">${escapeXml(state.phase ?? "-")}</text>
	`);
}

export function dictateTitle(): string {
	return "";
}

export function statusLines(state: RenderState): string {
	const wp = state.whispasteAvailable ? `ok · ${state.phase ?? "-"}` : "nicht erreichbar";
	const dc = !state.discordAvailable
		? "nicht verbunden"
		: state.discordAuthenticated
			? `ok · ${state.mute ? "MUTED" : "mic"}${state.inVoice === false ? " · kein Call" : ""}`
			: "nicht angemeldet";

	const lines = [`WhisPaste: ${wp}`, `Discord: ${dc}`, `Sync: ${state.syncActive ? "für Mute zuständig" : "bereit"}`];

	if (state.problems.length > 0) lines.push(`⚠ ${state.problems[0]}`);
	if (state.lastMessage) lines.push(state.lastMessage.slice(0, 120));
	return lines.join("\n");
}

export function svgDataUrl(markup: string): string {
	return `data:image/svg+xml,${encodeURIComponent(markup)}`;
}
