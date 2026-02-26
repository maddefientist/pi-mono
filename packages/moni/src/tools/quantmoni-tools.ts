import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { QuantMoniManager } from "../quantmoni.js";

let managerInstance: QuantMoniManager | null = null;

export function setQuantMoniManager(manager: QuantMoniManager): void {
	managerInstance = manager;
}

function getManager(): QuantMoniManager {
	if (!managerInstance) throw new Error("QuantMoni manager not initialized");
	return managerInstance;
}

const labelOnly = Type.Object({
	label: Type.String({ description: "Brief description (shown to user)" }),
});

const logsSchema = Type.Object({
	label: Type.String({ description: "Brief description (shown to user)" }),
	lines: Type.Optional(Type.Number({ description: "Number of log lines to tail (default 50)" })),
});

export function createQuantMoniStartTool(): AgentTool<typeof labelOnly> {
	return {
		name: "quantmoni_start",
		label: "quantmoni_start",
		description: "Start the QuantMoni trading bot. Returns PID and status.",
		parameters: labelOnly,
		execute: async () => {
			const result = await getManager().start();
			return {
				content: [{ type: "text", text: `QuantMoni ${result.status} (PID: ${result.pid})` }],
				details: undefined,
			};
		},
	};
}

export function createQuantMoniStopTool(): AgentTool<typeof labelOnly> {
	return {
		name: "quantmoni_stop",
		label: "quantmoni_stop",
		description: "Stop the QuantMoni trading bot gracefully (SIGTERM, then SIGKILL after 10s).",
		parameters: labelOnly,
		execute: async () => {
			await getManager().stop();
			return {
				content: [{ type: "text", text: "QuantMoni stopped" }],
				details: undefined,
			};
		},
	};
}

export function createQuantMoniStatusTool(): AgentTool<typeof labelOnly> {
	return {
		name: "quantmoni_status",
		label: "quantmoni_status",
		description: "Get QuantMoni status: running state, PID, uptime, positions, journal stats, recent logs.",
		parameters: labelOnly,
		execute: async () => {
			const status = await getManager().getStatus();
			const formatted = getManager().formatStatusString(status);
			return {
				content: [{ type: "text", text: formatted }],
				details: { status },
			};
		},
	};
}

export function createQuantMoniRestartTool(): AgentTool<typeof labelOnly> {
	return {
		name: "quantmoni_restart",
		label: "quantmoni_restart",
		description: "Restart the QuantMoni trading bot (stop then start).",
		parameters: labelOnly,
		execute: async () => {
			const result = await getManager().restart();
			return {
				content: [{ type: "text", text: `QuantMoni restarted (PID: ${result.pid})` }],
				details: undefined,
			};
		},
	};
}

export function createQuantMoniLogsTool(): AgentTool<typeof logsSchema> {
	return {
		name: "quantmoni_logs",
		label: "quantmoni_logs",
		description: "Tail QuantMoni runner log.",
		parameters: logsSchema,
		execute: async (_toolCallId: string, { lines }: { label: string; lines?: number }) => {
			const logs = getManager().getRecentLogs(lines || 50);
			return {
				content: [{ type: "text", text: logs }],
				details: undefined,
			};
		},
	};
}
