export class SyncEngine {
	constructor(deps: { whispaste: any; discord: any; config: any; log: any });

	config: any;
	state: any;

	tick(): Promise<void>;
	beginDictation(reason: string): Promise<void>;
	endDictation(reason: string): Promise<void>;
	refreshVoiceChannel(): Promise<void>;
	applyVoiceSettings(data: any, source: string): void;
	onVoiceChannelSelect(data: any): void;
	onDiscordDisconnected(reason: string): Promise<void>;
	getState(): any;
	getStateText(): string;
	handleToggle(): Promise<{ status: number; body: any }>;
}
