/**
 * Context management for Moni.
 *
 * Dual-file pattern:
 * - context.jsonl: Structured API messages for LLM context (SessionManager format)
 * - log.jsonl: Human-readable history for grep
 *
 * Provides:
 * - syncLogToSessionManager: Syncs messages from log.jsonl to SessionManager
 * - MoniSettingsManager: Settings for model, compaction, retry preferences
 */

import type { UserMessage } from "@mariozechner/pi-ai";
import type { SessionManager, SessionMessageEntry } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

// ============================================================================
// Sync log.jsonl to SessionManager
// ============================================================================

interface LogMessage {
	date?: string;
	ts?: string;
	user?: string;
	userName?: string;
	text?: string;
	isBot?: boolean;
}

/**
 * Sync user messages from log.jsonl to SessionManager.
 * Ensures messages logged while Moni wasn't running are added to LLM context.
 */
export function syncLogToSessionManager(sessionManager: SessionManager, dataDir: string, excludeTs?: string): number {
	const logFile = join(dataDir, "log.jsonl");
	if (!existsSync(logFile)) return 0;

	// Build set of existing message content from session
	const existingMessages = new Set<string>();
	for (const entry of sessionManager.getEntries()) {
		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			const msg = msgEntry.message as { role: string; content?: unknown };
			if (msg.role === "user" && msg.content !== undefined) {
				const content = msg.content;
				if (typeof content === "string") {
					const normalized = content.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] /, "");
					existingMessages.add(normalized);
				} else if (Array.isArray(content)) {
					for (const part of content) {
						if (
							typeof part === "object" &&
							part !== null &&
							"type" in part &&
							part.type === "text" &&
							"text" in part
						) {
							let normalized = (part as { type: "text"; text: string }).text;
							normalized = normalized.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] /, "");
							existingMessages.add(normalized);
						}
					}
				}
			}
		}
	}

	// Read log.jsonl and find user messages not in context
	const logContent = readFileSync(logFile, "utf-8");
	const logLines = logContent.trim().split("\n").filter(Boolean);

	const newMessages: Array<{ timestamp: number; message: UserMessage }> = [];

	for (const line of logLines) {
		try {
			const logMsg: LogMessage = JSON.parse(line);
			const ts = logMsg.ts;
			const date = logMsg.date;
			if (!ts || !date) continue;
			if (excludeTs && ts === excludeTs) continue;
			if (logMsg.isBot) continue;

			const messageText = `[${logMsg.userName || logMsg.user || "unknown"}]: ${logMsg.text || ""}`;
			if (existingMessages.has(messageText)) continue;

			const msgTime = new Date(date).getTime() || Date.now();
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: messageText }],
				timestamp: msgTime,
			};

			newMessages.push({ timestamp: msgTime, message: userMessage });
			existingMessages.add(messageText);
		} catch {
			// Skip malformed lines
		}
	}

	if (newMessages.length === 0) return 0;

	newMessages.sort((a, b) => a.timestamp - b.timestamp);
	for (const { message } of newMessages) {
		sessionManager.appendMessage(message);
	}

	return newMessages.length;
}

// ============================================================================
// MoniSettingsManager
// ============================================================================

export interface MoniCompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export interface MoniRetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
}

export interface MoniSettings {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
	compaction?: Partial<MoniCompactionSettings>;
	retry?: Partial<MoniRetrySettings>;
}

const DEFAULT_COMPACTION: MoniCompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

const DEFAULT_RETRY: MoniRetrySettings = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
};

export class MoniSettingsManager {
	private settingsPath: string;
	private settings: MoniSettings;

	constructor(dataDir: string) {
		this.settingsPath = join(dataDir, "settings.json");
		this.settings = this.load();
	}

	private load(): MoniSettings {
		if (!existsSync(this.settingsPath)) return {};
		try {
			return JSON.parse(readFileSync(this.settingsPath, "utf-8"));
		} catch {
			return {};
		}
	}

	private save(): void {
		try {
			const dir = dirname(this.settingsPath);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), "utf-8");
		} catch (error) {
			console.error(`Warning: Could not save settings: ${error}`);
		}
	}

	getCompactionSettings(): MoniCompactionSettings {
		return { ...DEFAULT_COMPACTION, ...this.settings.compaction };
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? DEFAULT_COMPACTION.enabled;
	}

	setCompactionEnabled(enabled: boolean): void {
		this.settings.compaction = { ...this.settings.compaction, enabled };
		this.save();
	}

	getRetrySettings(): MoniRetrySettings {
		return { ...DEFAULT_RETRY, ...this.settings.retry };
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? DEFAULT_RETRY.enabled;
	}

	setRetryEnabled(enabled: boolean): void {
		this.settings.retry = { ...this.settings.retry, enabled };
		this.save();
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.settings.defaultProvider = provider;
		this.settings.defaultModel = modelId;
		this.save();
	}

	getDefaultThinkingLevel(): string {
		return this.settings.defaultThinkingLevel || "off";
	}

	setDefaultThinkingLevel(level: string): void {
		this.settings.defaultThinkingLevel = level as MoniSettings["defaultThinkingLevel"];
		this.save();
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return "one-at-a-time";
	}

	setSteeringMode(_mode: "all" | "one-at-a-time"): void {}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return "one-at-a-time";
	}

	setFollowUpMode(_mode: "all" | "one-at-a-time"): void {}

	getHookPaths(): string[] {
		return [];
	}

	getHookTimeout(): number {
		return 30000;
	}
}
