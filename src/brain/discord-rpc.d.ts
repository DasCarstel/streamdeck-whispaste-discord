import { EventEmitter } from "node:events";

export class DiscordRpc extends EventEmitter {
	constructor(
		opts: {
			clientId: string;
			clientSecret: string;
			redirectUri: string;
			scopes: string[];
			tokenFile: string;
			commandTimeoutMs: number;
			authorizeTimeoutMs: number;
		},
		log: any,
	);

	available: boolean;
	authenticated: boolean;
	user: any;
	authorizeAttempted: boolean;
	pipePath: string | null;

	connect(): Promise<string>;
	destroy(): void;
	authenticate(options?: { allowAuthorize?: boolean }): Promise<string>;
	subscribe(evt: string, args?: any): Promise<any>;
	getVoiceSettings(): Promise<any>;
	setMute(mute: boolean): Promise<any>;
	getSelectedVoiceChannel(): Promise<any>;
	clearToken(): void;
}
