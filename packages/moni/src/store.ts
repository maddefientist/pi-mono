import { existsSync, mkdirSync, readFileSync } from "fs";
import { appendFile } from "fs/promises";
import { join } from "path";

export interface LoggedMessage {
	date: string;
	ts: string;
	user: string;
	userName?: string;
	text: string;
	isBot: boolean;
}

export class MessageStore {
	private dataDir: string;
	private recentlyLogged = new Map<string, number>();

	constructor(dataDir: string) {
		this.dataDir = dataDir;
		if (!existsSync(this.dataDir)) {
			mkdirSync(this.dataDir, { recursive: true });
		}
	}

	async logMessage(message: LoggedMessage): Promise<boolean> {
		const dedupeKey = `${message.ts}`;
		if (this.recentlyLogged.has(dedupeKey)) {
			return false;
		}

		this.recentlyLogged.set(dedupeKey, Date.now());
		setTimeout(() => this.recentlyLogged.delete(dedupeKey), 60000);

		const logPath = join(this.dataDir, "log.jsonl");
		const line = `${JSON.stringify(message)}\n`;
		await appendFile(logPath, line, "utf-8");
		return true;
	}

	async logUserMessage(text: string, userName: string, ts: string): Promise<void> {
		await this.logMessage({
			date: new Date().toISOString(),
			ts,
			user: userName,
			userName,
			text,
			isBot: false,
		});
	}

	async logBotResponse(text: string, ts: string): Promise<void> {
		await this.logMessage({
			date: new Date().toISOString(),
			ts,
			user: "bot",
			userName: "Moni",
			text,
			isBot: true,
		});
	}

	getLastTimestamp(): string | null {
		const logPath = join(this.dataDir, "log.jsonl");
		if (!existsSync(logPath)) return null;

		try {
			const content = readFileSync(logPath, "utf-8");
			const lines = content.trim().split("\n");
			if (lines.length === 0 || lines[0] === "") return null;
			const lastLine = lines[lines.length - 1];
			const message = JSON.parse(lastLine) as LoggedMessage;
			return message.ts;
		} catch {
			return null;
		}
	}
}
