import { execFile } from "child_process";
import fs from "fs";
import { Bot } from "grammy";
import os from "os";
import path from "path";
import { promisify } from "util";
import * as log from "./log.js";

const execFileAsync = promisify(execFile);

export interface TelegramMessage {
	id: string;
	sender: string;
	senderName: string;
	content: string;
	timestamp: string;
}

export type OnTelegramMessage = (message: TelegramMessage) => void;

export class TelegramChannel {
	private bot: Bot | null = null;
	private botToken: string;
	private chatId: string;
	private debugChatId: string | null;
	private whisperUrl: string | null;
	private whisperModel: string;
	private onMessage: OnTelegramMessage;
	private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
	private dataDir: string;

	constructor(opts: {
		botToken: string;
		chatId: string;
		debugChatId?: string;
		whisperUrl?: string;
		whisperModel?: string;
		dataDir: string;
		onMessage: OnTelegramMessage;
	}) {
		this.botToken = opts.botToken;
		this.chatId = opts.chatId;
		this.debugChatId = opts.debugChatId || null;
		this.whisperUrl = opts.whisperUrl || null;
		this.whisperModel = opts.whisperModel || "Systran/faster-whisper-tiny";
		this.onMessage = opts.onMessage;
		this.dataDir = opts.dataDir;
	}

	async connect(): Promise<void> {
		this.bot = new Bot(this.botToken);
		this.setupHandlers();
		await this.startPolling();
	}

	private isAllowedChat(chatId: number): boolean {
		const id = chatId.toString();
		return id === this.chatId || id === this.debugChatId;
	}

	private setupHandlers(): void {
		if (!this.bot) return;

		this.bot.command("ping", (ctx) => {
			if (!this.isAllowedChat(ctx.chat.id)) return;
			ctx.reply("Moni is online.");
		});

		this.bot.command("chatid", (ctx) => {
			const chatId = ctx.chat.id;
			const chatType = ctx.chat.type;
			const chatName =
				chatType === "private" ? ctx.from?.first_name || "Private" : (ctx.chat as any).title || "Unknown";
			ctx.reply(`Chat ID: \`${chatId}\`\nName: ${chatName}\nType: ${chatType}`, { parse_mode: "Markdown" });
		});

		this.bot.on("message:text", async (ctx) => {
			if (ctx.message.text.startsWith("/")) return;
			if (!this.isAllowedChat(ctx.chat.id)) return;

			const senderName = ctx.from?.first_name || ctx.from?.username || ctx.from?.id.toString() || "Unknown";
			const sender = ctx.from?.id.toString() || "";
			const timestamp = new Date(ctx.message.date * 1000).toISOString();
			const msgId = ctx.message.message_id.toString();

			this.onMessage({
				id: msgId,
				sender,
				senderName,
				content: ctx.message.text,
				timestamp,
			});
		});

		// Non-text message handlers
		const handleNonText = (ctx: any, placeholder: string) => {
			if (!this.isAllowedChat(ctx.chat.id)) return;
			const senderName = ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || "Unknown";
			const sender = ctx.from?.id?.toString() || "";
			const caption = ctx.message.caption ? ` ${ctx.message.caption}` : "";
			const timestamp = new Date(ctx.message.date * 1000).toISOString();

			this.onMessage({
				id: ctx.message.message_id.toString(),
				sender,
				senderName,
				content: `${placeholder}${caption}`,
				timestamp,
			});
		};

		this.bot.on("message:photo", (ctx) => handleNonText(ctx, "[Photo]"));
		this.bot.on("message:video", (ctx) => handleNonText(ctx, "[Video]"));
		this.bot.on("message:audio", (ctx) => handleNonText(ctx, "[Audio]"));
		this.bot.on("message:sticker", (ctx) => {
			const emoji = (ctx.message as any).sticker?.emoji || "";
			handleNonText(ctx, `[Sticker ${emoji}]`);
		});
		this.bot.on("message:location", (ctx) => handleNonText(ctx, "[Location]"));
		this.bot.on("message:contact", (ctx) => handleNonText(ctx, "[Contact]"));

		this.bot.on("message:voice", async (ctx) => {
			if (!this.isAllowedChat(ctx.chat.id)) return;
			let placeholder = "[Voice message]";
			if (this.whisperUrl) {
				try {
					const transcription = await this.transcribeVoice(ctx);
					if (transcription) {
						placeholder = `[Voice: ${transcription}]`;
					}
				} catch (err) {
					log.logWarning("Voice transcription failed", err instanceof Error ? err.message : String(err));
				}
			}
			handleNonText(ctx, placeholder);
		});

		this.bot.on("message:document", async (ctx) => {
			if (!this.isAllowedChat(ctx.chat.id)) return;
			const fileName = ctx.message.document?.file_name || "file";
			let contentMsg = `[Document: ${fileName}]`;

			try {
				const file = await ctx.getFile();
				const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
				const response = await fetch(fileUrl);
				if (response.ok) {
					const buffer = Buffer.from(await response.arrayBuffer());
					const destDir = path.join(this.dataDir, "attachments");
					fs.mkdirSync(destDir, { recursive: true });
					const destPath = path.join(destDir, fileName);
					fs.writeFileSync(destPath, buffer);
					contentMsg = `[Document: ${fileName}] (saved to ${destPath})`;
					log.logInfo(`Downloaded document: ${fileName}`);
				}
			} catch (err) {
				log.logWarning("Failed to download document", err instanceof Error ? err.message : String(err));
			}

			handleNonText(ctx, contentMsg);
		});

		this.bot.catch((err) => {
			log.logWarning("Telegram bot error", err.message);
		});
	}

	private pollingActive = false;

	private async startPolling(): Promise<void> {
		if (!this.bot || this.pollingActive) return;
		this.pollingActive = true;

		try {
			await this.bot.api.deleteWebhook({ drop_pending_updates: true });
		} catch (err) {
			log.logWarning("Failed to drop pending updates", err instanceof Error ? err.message : String(err));
		}

		return new Promise<void>((resolve) => {
			let resolved = false;
			this.bot!.start({
				drop_pending_updates: true,
				onStart: (botInfo) => {
					log.logInfo(`Telegram bot connected: @${botInfo.username} (ID: ${botInfo.id})`);
					if (!resolved) {
						resolved = true;
						resolve();
					}
				},
			}).catch((err) => {
				this.pollingActive = false;
				const is409 = err?.error_code === 409 || err?.message?.includes("409");
				if (is409) {
					log.logWarning("Telegram 409 conflict, waiting 35s for old session to expire...");
				} else {
					log.logWarning("Telegram bot polling crashed, retrying in 10s...", err?.message);
				}
				if (!resolved) {
					resolved = true;
					resolve();
				}
				setTimeout(() => this.restartPolling(), is409 ? 35000 : 10000);
			});
		});
	}

	private async restartPolling(): Promise<void> {
		if (!this.bot) return;

		// Stop current bot
		this.pollingActive = false;
		try {
			this.bot.stop();
		} catch {
			/* already stopped */
		}

		// Create fresh bot instance
		this.bot = new Bot(this.botToken);
		this.setupHandlers();

		try {
			await this.bot.api.deleteWebhook({ drop_pending_updates: true });
		} catch {
			/* ignore */
		}

		this.pollingActive = true;
		this.bot
			.start({
				drop_pending_updates: true,
				onStart: (botInfo) => {
					log.logInfo(`Telegram bot reconnected: @${botInfo.username}`);
				},
			})
			.catch((err) => {
				this.pollingActive = false;
				const is409 = err?.error_code === 409 || err?.message?.includes("409");
				if (is409) {
					log.logWarning("Telegram 409 on reconnect, waiting 35s...");
					setTimeout(() => this.restartPolling(), 35000);
				} else {
					log.logWarning("Telegram bot polling crashed, retrying in 10s...", err?.message);
					setTimeout(() => this.restartPolling(), 10000);
				}
			});
	}

	private async transcribeVoice(ctx: any): Promise<string | null> {
		const file = await ctx.getFile();
		const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;

		const response = await fetch(fileUrl);
		if (!response.ok) throw new Error(`Download failed: ${response.status}`);
		const buffer = Buffer.from(await response.arrayBuffer());

		const tmpDir = os.tmpdir();
		const id = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const oggPath = path.join(tmpDir, `${id}.ogg`);
		const wavPath = path.join(tmpDir, `${id}.wav`);

		try {
			fs.writeFileSync(oggPath, buffer);

			await execFileAsync("ffmpeg", ["-i", oggPath, "-ar", "16000", "-ac", "1", "-f", "wav", wavPath], {
				timeout: 30000,
			});

			const formData = new FormData();
			formData.append("file", new Blob([fs.readFileSync(wavPath)], { type: "audio/wav" }), "voice.wav");
			formData.append("model", this.whisperModel);

			const whisperResponse = await fetch(`${this.whisperUrl}/v1/audio/transcriptions`, {
				method: "POST",
				body: formData,
			});

			if (!whisperResponse.ok) {
				throw new Error(`Whisper API error: ${whisperResponse.status}`);
			}

			const result = (await whisperResponse.json()) as { text?: string };
			return result.text?.trim() || null;
		} finally {
			try {
				fs.unlinkSync(oggPath);
			} catch {
				/* ignore */
			}
			try {
				fs.unlinkSync(wavPath);
			} catch {
				/* ignore */
			}
		}
	}

	async sendMessage(text: string, chatId?: string): Promise<void> {
		if (!this.bot) {
			log.logWarning("Telegram bot not initialized");
			return;
		}

		const targetChatId = chatId || this.chatId;
		const MAX_LENGTH = 4096;

		try {
			if (text.length <= MAX_LENGTH) {
				await this.bot.api.sendMessage(targetChatId, text);
			} else {
				for (let i = 0; i < text.length; i += MAX_LENGTH) {
					await this.bot.api.sendMessage(targetChatId, text.slice(i, i + MAX_LENGTH));
				}
			}
		} catch (err) {
			log.logWarning("Failed to send Telegram message", err instanceof Error ? err.message : String(err));
		}
	}

	async sendDebugMessage(text: string): Promise<void> {
		if (this.debugChatId) {
			await this.sendMessage(text, this.debugChatId);
		}
	}

	startTypingLoop(chatId?: string): void {
		const targetChatId = chatId || this.chatId;
		if (this.typingIntervals.has(targetChatId)) return;

		const sendTyping = async () => {
			if (!this.bot) return;
			try {
				await this.bot.api.sendChatAction(targetChatId, "typing");
			} catch {
				/* ignore */
			}
		};

		sendTyping();
		const interval = setInterval(sendTyping, 4000);
		this.typingIntervals.set(targetChatId, interval);
	}

	stopTypingLoop(chatId?: string): void {
		const targetChatId = chatId || this.chatId;
		const interval = this.typingIntervals.get(targetChatId);
		if (interval) {
			clearInterval(interval);
			this.typingIntervals.delete(targetChatId);
		}
	}

	async disconnect(): Promise<void> {
		for (const interval of this.typingIntervals.values()) {
			clearInterval(interval);
		}
		this.typingIntervals.clear();

		if (this.bot) {
			this.bot.stop();
			this.bot = null;
			log.logInfo("Telegram bot stopped");
		}
	}

	isConnected(): boolean {
		return this.bot !== null;
	}
}
