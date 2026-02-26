#!/usr/bin/env node

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { type AgentRunner, createAgentRunner } from "./agent.js";
import * as log from "./log.js";
import { QuantMoniManager } from "./quantmoni.js";
import { type ScheduledTask, TaskScheduler } from "./scheduler.js";
import { MessageStore } from "./store.js";
import { TelegramChannel, type TelegramMessage } from "./telegram.js";

// ============================================================================
// Config
// ============================================================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_DEBUG_CHAT_ID = process.env.TELEGRAM_DEBUG_CHAT_ID;
const WHISPER_URL = process.env.WHISPER_URL;
const WHISPER_MODEL = process.env.WHISPER_MODEL;

const DATA_DIR = process.env.MONI_DATA_DIR || join(process.cwd(), "data");

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
	console.error("Missing required env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID");
	process.exit(1);
}

// Ensure data directories exist
for (const dir of ["memory", "quantmoni", "conversations", "skills", "scripts", "events", "logs"]) {
	mkdirSync(join(DATA_DIR, dir), { recursive: true });
}

log.logStartup(DATA_DIR);

// ============================================================================
// Message Queue (sequential processing, user messages prioritized)
// ============================================================================

interface QueuedMessage {
	text: string;
	userName: string;
	ts: string;
	isTask: boolean;
	task?: ScheduledTask;
}

const messageQueue: QueuedMessage[] = [];
let processing = false;

function enqueueMessage(msg: QueuedMessage): void {
	if (msg.isTask) {
		// Tasks go to the end
		messageQueue.push(msg);
	} else {
		// User messages go before tasks but after other user messages
		const firstTaskIdx = messageQueue.findIndex((m) => m.isTask);
		if (firstTaskIdx === -1) {
			messageQueue.push(msg);
		} else {
			messageQueue.splice(firstTaskIdx, 0, msg);
		}
	}
	processQueue();
}

async function processQueue(): Promise<void> {
	if (processing) return;
	processing = true;

	while (messageQueue.length > 0) {
		const msg = messageQueue.shift()!;
		try {
			await handleMessage(msg);
		} catch (err) {
			log.logWarning(
				`Error processing message from ${msg.userName}`,
				err instanceof Error ? err.message : String(err),
			);
			try {
				await telegram.sendMessage(
					`Error processing your message: ${err instanceof Error ? err.message : "Unknown error"}`,
				);
			} catch {
				/* ignore send error */
			}
		}
	}

	processing = false;
}

// ============================================================================
// Initialize components
// ============================================================================

const store = new MessageStore(DATA_DIR);
const quantmoni = new QuantMoniManager(join(DATA_DIR, "quantmoni"));
const scheduler = new TaskScheduler(DATA_DIR, onTaskDue);

const telegram = new TelegramChannel({
	botToken: TELEGRAM_BOT_TOKEN,
	chatId: TELEGRAM_CHAT_ID,
	debugChatId: TELEGRAM_DEBUG_CHAT_ID,
	whisperUrl: WHISPER_URL,
	whisperModel: WHISPER_MODEL,
	dataDir: DATA_DIR,
	onMessage: onTelegramMessage,
});

let runner: AgentRunner;

// ============================================================================
// Handlers
// ============================================================================

function onTelegramMessage(msg: TelegramMessage): void {
	log.logUserMessage({ chatId: "telegram", userName: msg.senderName }, msg.content);

	// Log to store
	store.logUserMessage(msg.content, msg.senderName, msg.id);

	// Enqueue for agent processing
	enqueueMessage({
		text: msg.content,
		userName: msg.senderName,
		ts: msg.id,
		isTask: false,
	});
}

function onTaskDue(task: ScheduledTask): void {
	log.logInfo(`Task due: ${task.id} - "${task.prompt.substring(0, 50)}..."`);

	enqueueMessage({
		text: `[SCHEDULED_TASK:${task.id}:${task.scheduleType}:${task.scheduleValue}] ${task.prompt}`,
		userName: "scheduler",
		ts: Date.now().toString(),
		isTask: true,
		task,
	});
}

async function handleMessage(msg: QueuedMessage): Promise<void> {
	const startTime = Date.now();

	const result = await runner.run(msg.text, msg.userName, msg.ts);

	const duration = ((Date.now() - startTime) / 1000).toFixed(1);
	log.logInfo(`Run complete in ${duration}s (stopReason: ${result.stopReason})`);

	// Send response via Telegram unless silent
	if (result.silent) {
		log.logInfo("Silent response - no Telegram message sent");
	} else if (result.finalText.trim()) {
		await telegram.sendMessage(result.finalText);
		await store.logBotResponse(result.finalText, Date.now().toString());
	}
}

// ============================================================================
// Startup
// ============================================================================

async function main(): Promise<void> {
	// Connect Telegram first
	await telegram.connect();
	log.logInfo("Telegram connected");

	// Create agent runner (needs telegram for tool wiring)
	runner = createAgentRunner({
		dataDir: DATA_DIR,
		telegram,
		quantmoni,
		scheduler,
	});
	log.logInfo("Agent runner created");

	// Start scheduler
	scheduler.start();
	log.logInfo("Scheduler started");

	// Auto-start QuantMoni if not running
	if (!quantmoni.isRunning()) {
		const startupScript = join(DATA_DIR, "quantmoni", "startup.sh");
		if (existsSync(startupScript)) {
			log.logInfo("QuantMoni not running, auto-starting...");
			try {
				const result = await quantmoni.start();
				log.logInfo(`QuantMoni auto-started: ${result.status} (PID: ${result.pid})`);
			} catch (err) {
				log.logWarning("Failed to auto-start QuantMoni", err instanceof Error ? err.message : String(err));
			}
		} else {
			log.logInfo("QuantMoni startup.sh not found, skipping auto-start");
		}
	} else {
		log.logInfo(`QuantMoni already running (PID: ${quantmoni.isRunning()})`);
	}

	// Send startup notification
	await telegram.sendMessage("Moni is online.");

	log.logInfo("Moni agent fully initialized and ready");
}

// ============================================================================
// Graceful Shutdown
// ============================================================================

function shutdown(signal: string): void {
	log.logInfo(`Received ${signal}, shutting down...`);

	// Stop scheduler
	scheduler.stop();

	// Disconnect telegram
	telegram.disconnect();

	// Do NOT stop QuantMoni - it runs independently
	log.logInfo("Shutdown complete (QuantMoni left running)");
	process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Start
main().catch((err) => {
	console.error("Fatal startup error:", err);
	process.exit(1);
});
