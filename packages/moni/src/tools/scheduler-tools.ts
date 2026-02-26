import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { TaskScheduler } from "../scheduler.js";

let schedulerInstance: TaskScheduler | null = null;

export function setSchedulerInstance(scheduler: TaskScheduler): void {
	schedulerInstance = scheduler;
}

function getScheduler(): TaskScheduler {
	if (!schedulerInstance) throw new Error("Scheduler not initialized");
	return schedulerInstance;
}

const scheduleTaskSchema = Type.Object({
	label: Type.String({ description: "Brief description (shown to user)" }),
	prompt: Type.String({ description: "The prompt/instruction to execute when the task fires" }),
	scheduleType: Type.Union([Type.Literal("cron"), Type.Literal("interval"), Type.Literal("once")], {
		description: "Schedule type: cron (cron expression), interval (milliseconds), once (ISO datetime)",
	}),
	scheduleValue: Type.String({
		description:
			"Schedule value: cron expression (e.g. '*/15 * * * *'), interval in ms (e.g. '900000'), or ISO datetime",
	}),
	silent: Type.Optional(
		Type.Boolean({ description: "If true, suppress Telegram output unless actionable (default false)" }),
	),
});

const taskIdSchema = Type.Object({
	label: Type.String({ description: "Brief description (shown to user)" }),
	id: Type.String({ description: "Task ID to operate on" }),
});

const listSchema = Type.Object({
	label: Type.String({ description: "Brief description (shown to user)" }),
});

export function createScheduleTaskTool(): AgentTool<typeof scheduleTaskSchema> {
	return {
		name: "schedule_task",
		label: "schedule_task",
		description:
			"Create a scheduled task. Types: cron (cron expression), interval (ms between runs, min 10000), once (ISO datetime for one-time execution).",
		parameters: scheduleTaskSchema,
		execute: async (
			_toolCallId: string,
			{
				prompt,
				scheduleType,
				scheduleValue,
				silent,
			}: {
				label: string;
				prompt: string;
				scheduleType: "cron" | "interval" | "once";
				scheduleValue: string;
				silent?: boolean;
			},
		) => {
			const task = getScheduler().createTask({ prompt, scheduleType, scheduleValue, silent });
			return {
				content: [
					{
						type: "text",
						text: `Created task ${task.id}\nType: ${task.scheduleType}\nSchedule: ${task.scheduleValue}\nNext run: ${task.nextRun || "pending"}\nSilent: ${task.silent}`,
					},
				],
				details: { task },
			};
		},
	};
}

export function createListTasksTool(): AgentTool<typeof listSchema> {
	return {
		name: "list_tasks",
		label: "list_tasks",
		description: "List all scheduled tasks with status, schedule, and next run time.",
		parameters: listSchema,
		execute: async () => {
			const tasks = getScheduler().listTasks();
			if (tasks.length === 0) {
				return { content: [{ type: "text", text: "No scheduled tasks." }], details: undefined };
			}

			const lines = tasks.map(
				(t) =>
					`[${t.id}] ${t.status} | ${t.scheduleType}: ${t.scheduleValue} | next: ${t.nextRun || "n/a"} | last: ${t.lastRun || "never"}\n  "${t.prompt}"${t.silent ? " (silent)" : ""}`,
			);
			return {
				content: [{ type: "text", text: lines.join("\n\n") }],
				details: { tasks },
			};
		},
	};
}

export function createPauseTaskTool(): AgentTool<typeof taskIdSchema> {
	return {
		name: "pause_task",
		label: "pause_task",
		description: "Pause a scheduled task by ID.",
		parameters: taskIdSchema,
		execute: async (_toolCallId: string, { id }: { label: string; id: string }) => {
			const task = getScheduler().pauseTask(id);
			if (!task) throw new Error(`Task not found: ${id}`);
			return { content: [{ type: "text", text: `Paused task ${id}` }], details: undefined };
		},
	};
}

export function createResumeTaskTool(): AgentTool<typeof taskIdSchema> {
	return {
		name: "resume_task",
		label: "resume_task",
		description: "Resume a paused scheduled task by ID.",
		parameters: taskIdSchema,
		execute: async (_toolCallId: string, { id }: { label: string; id: string }) => {
			const task = getScheduler().resumeTask(id);
			if (!task) throw new Error(`Task not found or not paused: ${id}`);
			return { content: [{ type: "text", text: `Resumed task ${id}` }], details: undefined };
		},
	};
}

export function createCancelTaskTool(): AgentTool<typeof taskIdSchema> {
	return {
		name: "cancel_task",
		label: "cancel_task",
		description: "Delete a scheduled task by ID.",
		parameters: taskIdSchema,
		execute: async (_toolCallId: string, { id }: { label: string; id: string }) => {
			const success = getScheduler().cancelTask(id);
			if (!success) throw new Error(`Task not found: ${id}`);
			return { content: [{ type: "text", text: `Cancelled task ${id}` }], details: undefined };
		},
	};
}
