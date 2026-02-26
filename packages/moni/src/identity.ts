import { formatSkillsForPrompt, type Skill } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import * as log from "./log.js";

export interface SystemPromptOpts {
	dataDir: string;
	quantmoniStatus: string;
	activeScheduledTasks: Array<{ id: string; prompt: string; schedule: string; nextRun: string | null }>;
	currentDateTime: string;
	skills: Skill[];
}

function readFileOr(filePath: string, fallback: string): string {
	if (!existsSync(filePath)) return fallback;
	try {
		return readFileSync(filePath, "utf-8").trim();
	} catch (err) {
		log.logWarning(`Failed to read ${filePath}`, err instanceof Error ? err.message : String(err));
		return fallback;
	}
}

export function buildSystemPrompt(opts: SystemPromptOpts): string {
	const { dataDir, quantmoniStatus, activeScheduledTasks, currentDateTime, skills } = opts;

	// Load memory files
	const identity = readFileOr(join(dataDir, "memory", "CLAUDE.md"), "");
	const hivecortex = readFileOr(join(dataDir, "memory", "hivecortex.md"), "");
	const bots = readFileOr(join(dataDir, "memory", "BOTS.md"), "");
	const strategy = readFileOr(join(dataDir, "memory", "STRATEGY.md"), "");

	// Format scheduled tasks
	const tasksList =
		activeScheduledTasks.length > 0
			? activeScheduledTasks
					.map((t) => `- [${t.id}] ${t.schedule}: ${t.prompt}${t.nextRun ? ` (next: ${t.nextRun})` : ""}`)
					.join("\n")
			: "(no scheduled tasks)";

	// Format skills
	const skillsSection = skills.length > 0 ? formatSkillsForPrompt(skills) : "(no skills installed)";

	return `${identity}

## Current Context
- Current date/time: ${currentDateTime}
- Platform: Telegram (persistent agent, NOT ephemeral container)
- You have access to previous conversation context including tool results from prior turns.
- For older history beyond your context, search log.jsonl.

## Telegram Formatting Rules
- Use *bold* (single asterisk), _italic_ (underscore)
- Use \`code\` for inline code, \`\`\`code\`\`\` for blocks
- Do NOT use ## headings, **double asterisks**, or [markdown](links)
- Keep messages concise. Use bullets for lists.
- For urgent/actionable info, use the send_message tool to send immediately while still processing.

## Memory (HiveCortex)
${hivecortex || "(no hivecortex loaded)"}

## Bot Registry
${bots || "(no bot registry loaded)"}

## Strategy
${strategy || "(no strategy loaded)"}

## QuantMoni Status
${quantmoniStatus}

## Scheduled Tasks
${tasksList}

## Available Skills
${skillsSection}

## Data Layout
${dataDir}/
├── memory/                    # CLAUDE.md, hivecortex.md, BOTS.md, STRATEGY.md
├── quantmoni/                 # QuantMoni bot (Python, state.json, journal.jsonl)
├── skills/                    # Trading skills (SKILL.md + scripts/)
├── scripts/                   # Polymarket .mjs scripts
├── events/                    # File-based scheduler events
├── conversations/             # Archived history
├── logs/                      # moni.log, moni.error.log
├── log.jsonl                  # Human-readable message history
├── context.jsonl              # LLM session context
├── settings.json              # Agent settings
└── tasks.json                 # Scheduled tasks

## Tools
- bash: Run shell commands (primary tool)
- read: Read files
- write: Create/overwrite files
- edit: Surgical file edits (find and replace)
- send_message: Send a Telegram message immediately (while still processing)
- quantmoni_start: Start QuantMoni bot
- quantmoni_stop: Stop QuantMoni bot
- quantmoni_status: Get QuantMoni health + state + recent logs
- quantmoni_restart: Restart QuantMoni bot
- quantmoni_logs: Tail QuantMoni runner log
- schedule_task: Create a scheduled task (cron/interval/once)
- list_tasks: List all scheduled tasks
- pause_task: Pause a scheduled task
- resume_task: Resume a paused task
- cancel_task: Delete a scheduled task
- web_search: Search the web via SearxNG

Each tool requires a "label" parameter (shown in logs).

## Silent Completion
For scheduled tasks where there's nothing to report, respond with just \`[SILENT]\` (no other text). This suppresses the Telegram message. Use this to avoid spam when periodic checks find nothing actionable.

## Memory Management
Update memory files when you learn something important:
- ${dataDir}/memory/hivecortex.md — master index (infra, wallets, endpoints, active bots)
- ${dataDir}/memory/BOTS.md — bot registry
- ${dataDir}/memory/STRATEGY.md — trading philosophy
- ${dataDir}/memory/CLAUDE.md — your identity and behavior rules
`;
}
