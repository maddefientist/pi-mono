import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import {
	AgentSession,
	AuthStorage,
	convertToLlm,
	createExtensionRuntime,
	loadSkillsFromDir,
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { syncLogToSessionManager } from "./context.js";
import { buildSystemPrompt } from "./identity.js";
import * as log from "./log.js";
import type { QuantMoniManager } from "./quantmoni.js";
import type { TaskScheduler } from "./scheduler.js";
import type { TelegramChannel } from "./telegram.js";
import { createMoniTools, setQuantMoniManager, setSchedulerInstance, setTelegramInstance } from "./tools/index.js";

const DEFAULT_MODEL_PROVIDER = process.env.MONI_MODEL_PROVIDER || "anthropic";
const DEFAULT_MODEL_ID = process.env.MONI_MODEL || "claude-sonnet-4-6";

async function getAnthropicApiKey(authStorage: AuthStorage): Promise<string> {
	const key = await authStorage.getApiKey("anthropic");
	if (!key) {
		// Fall back to env var
		const envKey = process.env.ANTHROPIC_API_KEY;
		if (envKey) return envKey;
		throw new Error(
			"No API key found.\n\nSet ANTHROPIC_API_KEY env var, or use pi-coding-agent auth: " +
				join(homedir(), ".pi", "moni", "auth.json"),
		);
	}
	return key;
}

function loadMoniSkills(dataDir: string): Skill[] {
	const skillMap = new Map<string, Skill>();
	const skillsDir = join(dataDir, "skills");

	if (existsSync(skillsDir)) {
		for (const skill of loadSkillsFromDir({ dir: skillsDir, source: "workspace" }).skills) {
			skillMap.set(skill.name, skill);
		}
	}

	return Array.from(skillMap.values());
}

export interface AgentRunner {
	run(
		userMessage: string,
		userName: string,
		messageTs: string,
	): Promise<{ stopReason: string; finalText: string; silent: boolean }>;
	abort(): void;
}

export function createAgentRunner(opts: {
	dataDir: string;
	telegram: TelegramChannel;
	quantmoni: QuantMoniManager;
	scheduler: TaskScheduler;
}): AgentRunner {
	const { dataDir, telegram, quantmoni, scheduler } = opts;

	// Wire tool dependencies
	setTelegramInstance(telegram);
	setQuantMoniManager(quantmoni);
	setSchedulerInstance(scheduler);

	// Create tools
	const tools = createMoniTools();

	// Create model
	const model = getModel(DEFAULT_MODEL_PROVIDER as any, DEFAULT_MODEL_ID);

	// Create session manager
	const contextFile = join(dataDir, "context.jsonl");
	const sessionManager = SessionManager.open(contextFile, dataDir);
	const settingsManager = SettingsManager.inMemory();

	// Create auth storage and model registry
	const authDir = join(homedir(), ".pi", "moni");
	const authPath = join(authDir, "auth.json");
	const authStorage = AuthStorage.create(authPath);
	const modelRegistry = new ModelRegistry(authStorage);

	// Build initial system prompt
	const skills = loadMoniSkills(dataDir);
	const systemPrompt = buildSystemPrompt({
		dataDir,
		quantmoniStatus: quantmoni.isRunning() ? "Running" : "Stopped",
		activeScheduledTasks: scheduler.getActiveTasks().map((t) => ({
			id: t.id,
			prompt: t.prompt,
			schedule: `${t.scheduleType}: ${t.scheduleValue}`,
			nextRun: t.nextRun,
		})),
		currentDateTime: new Date().toISOString(),
		skills,
	});

	// Create agent
	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: "off",
			tools,
		},
		convertToLlm,
		getApiKey: async () => getAnthropicApiKey(authStorage),
	});

	// Load existing session
	const loadedSession = sessionManager.buildSessionContext();
	if (loadedSession.messages.length > 0) {
		agent.replaceMessages(loadedSession.messages);
		log.logInfo(`Loaded ${loadedSession.messages.length} messages from context.jsonl`);
	}

	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		getPathMetadata: () => new Map(),
		extendResources: () => {},
		reload: async () => {},
	};

	const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

	// Create AgentSession
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRegistry,
		resourceLoader,
		baseToolsOverride,
	});

	// Mutable per-run state
	const runState = {
		onResponseText: null as ((text: string) => void) | null,
		logCtx: null as log.LogContext | null,
		pendingTools: new Map<string, { toolName: string; args: unknown; startTime: number }>(),
		totalUsage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		finalText: "",
	};

	// Subscribe to events ONCE
	session.subscribe(async (event) => {
		if (!runState.logCtx) return;
		const { logCtx, pendingTools } = runState;

		if (event.type === "tool_execution_start") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_start" };
			const args = agentEvent.args as { label?: string };
			const label = args.label || agentEvent.toolName;

			pendingTools.set(agentEvent.toolCallId, {
				toolName: agentEvent.toolName,
				args: agentEvent.args,
				startTime: Date.now(),
			});

			log.logToolStart(logCtx, agentEvent.toolName, label, agentEvent.args as Record<string, unknown>);
			telegram.startTypingLoop();
		} else if (event.type === "tool_execution_end") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_end" };
			const resultStr = extractToolResultText(agentEvent.result);
			const pending = pendingTools.get(agentEvent.toolCallId);
			pendingTools.delete(agentEvent.toolCallId);

			const durationMs = pending ? Date.now() - pending.startTime : 0;

			if (agentEvent.isError) {
				log.logToolError(logCtx, agentEvent.toolName, durationMs, resultStr);
			} else {
				log.logToolSuccess(logCtx, agentEvent.toolName, durationMs, resultStr);
			}
		} else if (event.type === "message_start") {
			const agentEvent = event as AgentEvent & { type: "message_start" };
			if (agentEvent.message.role === "assistant") {
				log.logResponseStart(logCtx);
			}
		} else if (event.type === "message_end") {
			const agentEvent = event as AgentEvent & { type: "message_end" };
			if (agentEvent.message.role === "assistant") {
				const assistantMsg = agentEvent.message as any;

				if (assistantMsg.stopReason) runState.stopReason = assistantMsg.stopReason;

				if (assistantMsg.usage) {
					runState.totalUsage.input += assistantMsg.usage.input;
					runState.totalUsage.output += assistantMsg.usage.output;
					runState.totalUsage.cacheRead += assistantMsg.usage.cacheRead;
					runState.totalUsage.cacheWrite += assistantMsg.usage.cacheWrite;
					runState.totalUsage.cost.input += assistantMsg.usage.cost.input;
					runState.totalUsage.cost.output += assistantMsg.usage.cost.output;
					runState.totalUsage.cost.cacheRead += assistantMsg.usage.cost.cacheRead;
					runState.totalUsage.cost.cacheWrite += assistantMsg.usage.cost.cacheWrite;
					runState.totalUsage.cost.total += assistantMsg.usage.cost.total;
				}

				const textParts: string[] = [];
				for (const part of agentEvent.message.content) {
					if (part.type === "text") {
						textParts.push((part as any).text);
					}
				}

				const text = textParts.join("\n");
				if (text.trim()) {
					log.logResponse(logCtx, text);
					runState.finalText = text;
				}
			}
		} else if (event.type === "auto_compaction_start") {
			log.logInfo(`Auto-compaction started (reason: ${(event as any).reason})`);
		} else if (event.type === "auto_compaction_end") {
			const compEvent = event as any;
			if (compEvent.result) {
				log.logInfo(`Auto-compaction complete: ${compEvent.result.tokensBefore} tokens compacted`);
			}
		} else if (event.type === "auto_retry_start") {
			const retryEvent = event as any;
			log.logWarning(`Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})`, retryEvent.errorMessage);
		}
	});

	return {
		async run(
			userMessage: string,
			userName: string,
			messageTs: string,
		): Promise<{ stopReason: string; finalText: string; silent: boolean }> {
			await mkdir(dataDir, { recursive: true });

			// Sync offline messages
			const syncedCount = syncLogToSessionManager(sessionManager, dataDir, messageTs);
			if (syncedCount > 0) {
				log.logInfo(`Synced ${syncedCount} messages from log.jsonl`);
			}

			// Reload messages
			const reloadedSession = sessionManager.buildSessionContext();
			if (reloadedSession.messages.length > 0) {
				agent.replaceMessages(reloadedSession.messages);
			}

			// Update system prompt with fresh state
			const skills = loadMoniSkills(dataDir);
			const quantmoniStatus = await quantmoni.getStatus();
			const freshPrompt = buildSystemPrompt({
				dataDir,
				quantmoniStatus: quantmoni.formatStatusString(quantmoniStatus),
				activeScheduledTasks: scheduler.getActiveTasks().map((t) => ({
					id: t.id,
					prompt: t.prompt,
					schedule: `${t.scheduleType}: ${t.scheduleValue}`,
					nextRun: t.nextRun,
				})),
				currentDateTime: new Date().toISOString(),
				skills,
			});
			session.agent.setSystemPrompt(freshPrompt);

			// Reset run state
			runState.logCtx = { chatId: "telegram", userName };
			runState.pendingTools.clear();
			runState.totalUsage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			runState.stopReason = "stop";
			runState.finalText = "";

			// Build timestamped user message
			const now = new Date();
			const pad = (n: number) => n.toString().padStart(2, "0");
			const offset = -now.getTimezoneOffset();
			const offsetSign = offset >= 0 ? "+" : "-";
			const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
			const offsetMins = pad(Math.abs(offset) % 60);
			const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;
			const formattedMessage = `[${timestamp}] [${userName}]: ${userMessage}`;

			// Start typing
			telegram.startTypingLoop();

			try {
				await session.prompt(formattedMessage);
			} finally {
				telegram.stopTypingLoop();
			}

			// Log usage
			if (runState.totalUsage.cost.total > 0) {
				log.logUsageSummary(runState.logCtx, runState.totalUsage);
			}

			const finalText = runState.finalText;
			const silent = finalText.trim() === "[SILENT]" || finalText.trim().startsWith("[SILENT]");

			runState.logCtx = null;

			return { stopReason: runState.stopReason, finalText, silent };
		},

		abort(): void {
			session.abort();
		},
	};
}

function extractToolResultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) textParts.push(part.text);
		}
		if (textParts.length > 0) return textParts.join("\n");
	}
	return JSON.stringify(result);
}
