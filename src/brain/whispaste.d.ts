export type WhisPasteResult = { ok: boolean; status?: number; data?: any; error?: string };

export class WhisPasteClient {
	constructor(
		opts: {
			host: string;
			portRangeStart: number;
			portRangeCount: number;
			token: string;
			requestTimeoutMs: number;
		},
		log: any,
	);

	port: number | null;
	readonly baseUrl: string | null;

	getStatus(): Promise<WhisPasteResult>;
	trigger(payload?: any): Promise<WhisPasteResult>;
}
