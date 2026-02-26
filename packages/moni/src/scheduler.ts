import { Cron } from "croner";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import * as log from "./log.js";

export interface ScheduledTask {
	id: string;
	prompt: string;
	scheduleType: "cron" | "interval" | "once";
	scheduleValue: string;
	status: "active" | "paused" | "completed";
	nextRun: string | null;
	lastRun: string | null;
	lastResult: string | null;
	silent: boolean;
	createdAt: string;
}

export type OnTaskDue = (task: ScheduledTask) => void;

export class TaskScheduler {
	private tasks: ScheduledTask[] = [];
	private crons = new Map<string, Cron>();
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private intervals = new Map<string, ReturnType<typeof setInterval>>();
	private tasksFile: string;
	private onTaskDue: OnTaskDue;
	private running = false;

	constructor(dataDir: string, onTaskDue: OnTaskDue) {
		this.tasksFile = join(dataDir, "tasks.json");
		this.onTaskDue = onTaskDue;
	}

	loadTasks(): void {
		if (!existsSync(this.tasksFile)) {
			this.tasks = [];
			return;
		}
		try {
			this.tasks = JSON.parse(readFileSync(this.tasksFile, "utf-8"));
		} catch {
			log.logWarning("Failed to load tasks.json, starting fresh");
			this.tasks = [];
		}
	}

	saveTasks(): void {
		try {
			const dir = this.tasksFile.substring(0, this.tasksFile.lastIndexOf("/"));
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			writeFileSync(this.tasksFile, JSON.stringify(this.tasks, null, 2), "utf-8");
		} catch (err) {
			log.logWarning("Failed to save tasks.json", err instanceof Error ? err.message : String(err));
		}
	}

	createTask(opts: {
		prompt: string;
		scheduleType: "cron" | "interval" | "once";
		scheduleValue: string;
		silent?: boolean;
	}): ScheduledTask {
		const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
		const task: ScheduledTask = {
			id,
			prompt: opts.prompt,
			scheduleType: opts.scheduleType,
			scheduleValue: opts.scheduleValue,
			status: "active",
			nextRun: null,
			lastRun: null,
			lastResult: null,
			silent: opts.silent ?? false,
			createdAt: new Date().toISOString(),
		};

		this.tasks.push(task);
		this.saveTasks();

		if (this.running) {
			this.scheduleTask(task);
		}

		log.logInfo(`Created task ${id}: ${opts.scheduleType} "${opts.prompt.substring(0, 50)}..."`);
		return task;
	}

	pauseTask(id: string): ScheduledTask | null {
		const task = this.tasks.find((t) => t.id === id);
		if (!task) return null;

		task.status = "paused";
		this.cancelScheduled(id);
		this.saveTasks();
		log.logInfo(`Paused task ${id}`);
		return task;
	}

	resumeTask(id: string): ScheduledTask | null {
		const task = this.tasks.find((t) => t.id === id);
		if (!task || task.status !== "paused") return null;

		task.status = "active";
		this.saveTasks();

		if (this.running) {
			this.scheduleTask(task);
		}

		log.logInfo(`Resumed task ${id}`);
		return task;
	}

	cancelTask(id: string): boolean {
		const idx = this.tasks.findIndex((t) => t.id === id);
		if (idx === -1) return false;

		this.cancelScheduled(id);
		this.tasks.splice(idx, 1);
		this.saveTasks();
		log.logInfo(`Cancelled task ${id}`);
		return true;
	}

	listTasks(): ScheduledTask[] {
		return [...this.tasks];
	}

	getActiveTasks(): ScheduledTask[] {
		return this.tasks.filter((t) => t.status === "active");
	}

	start(): void {
		this.running = true;
		this.loadTasks();

		for (const task of this.tasks) {
			if (task.status === "active") {
				this.scheduleTask(task);
			}
		}

		log.logInfo(`Task scheduler started with ${this.tasks.length} tasks (${this.getActiveTasks().length} active)`);
	}

	stop(): void {
		this.running = false;

		for (const cron of this.crons.values()) {
			cron.stop();
		}
		this.crons.clear();

		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}
		this.timers.clear();

		for (const interval of this.intervals.values()) {
			clearInterval(interval);
		}
		this.intervals.clear();

		log.logInfo("Task scheduler stopped");
	}

	private scheduleTask(task: ScheduledTask): void {
		this.cancelScheduled(task.id);

		switch (task.scheduleType) {
			case "cron":
				this.scheduleCron(task);
				break;
			case "interval":
				this.scheduleInterval(task);
				break;
			case "once":
				this.scheduleOnce(task);
				break;
		}
	}

	private scheduleCron(task: ScheduledTask): void {
		try {
			const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
			const cron = new Cron(task.scheduleValue, { timezone }, () => {
				this.executeTask(task);
			});

			this.crons.set(task.id, cron);
			const next = cron.nextRun();
			task.nextRun = next?.toISOString() ?? null;
			this.saveTasks();

			log.logInfo(`Scheduled cron task ${task.id}, next run: ${task.nextRun}`);
		} catch (err) {
			log.logWarning(`Invalid cron schedule for task ${task.id}: ${task.scheduleValue}`, String(err));
		}
	}

	private scheduleInterval(task: ScheduledTask): void {
		const ms = parseInt(task.scheduleValue, 10);
		if (Number.isNaN(ms) || ms < 10000) {
			log.logWarning(`Invalid interval for task ${task.id}: ${task.scheduleValue} (min 10s)`);
			return;
		}

		task.nextRun = new Date(Date.now() + ms).toISOString();
		this.saveTasks();

		const interval = setInterval(() => {
			this.executeTask(task);
			task.nextRun = new Date(Date.now() + ms).toISOString();
			this.saveTasks();
		}, ms);

		this.intervals.set(task.id, interval);
		log.logInfo(`Scheduled interval task ${task.id} every ${ms / 1000}s`);
	}

	private scheduleOnce(task: ScheduledTask): void {
		const atTime = new Date(task.scheduleValue).getTime();
		const now = Date.now();

		if (atTime <= now) {
			log.logInfo(`One-shot task ${task.id} is in the past, executing now`);
			this.executeTask(task);
			return;
		}

		const delay = atTime - now;
		task.nextRun = task.scheduleValue;
		this.saveTasks();

		const timer = setTimeout(() => {
			this.timers.delete(task.id);
			this.executeTask(task);
		}, delay);

		this.timers.set(task.id, timer);
		log.logInfo(`Scheduled one-shot task ${task.id} in ${Math.round(delay / 1000)}s`);
	}

	private executeTask(task: ScheduledTask): void {
		// Re-check status (may have been paused since scheduling)
		const currentTask = this.tasks.find((t) => t.id === task.id);
		if (!currentTask || currentTask.status !== "active") return;

		task.lastRun = new Date().toISOString();

		if (task.scheduleType === "once") {
			task.status = "completed";
			task.nextRun = null;
		}

		// Update next run for cron tasks
		if (task.scheduleType === "cron") {
			const cron = this.crons.get(task.id);
			if (cron) {
				const next = cron.nextRun();
				task.nextRun = next?.toISOString() ?? null;
			}
		}

		this.saveTasks();

		log.logInfo(`Executing task ${task.id}: "${task.prompt.substring(0, 50)}..."`);
		this.onTaskDue(task);
	}

	private cancelScheduled(id: string): void {
		const cron = this.crons.get(id);
		if (cron) {
			cron.stop();
			this.crons.delete(id);
		}

		const timer = this.timers.get(id);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(id);
		}

		const interval = this.intervals.get(id);
		if (interval) {
			clearInterval(interval);
			this.intervals.delete(id);
		}
	}
}
