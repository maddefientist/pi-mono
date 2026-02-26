import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import {
	createQuantMoniLogsTool,
	createQuantMoniRestartTool,
	createQuantMoniStartTool,
	createQuantMoniStatusTool,
	createQuantMoniStopTool,
} from "./quantmoni-tools.js";
import { createReadTool } from "./read.js";
import {
	createCancelTaskTool,
	createListTasksTool,
	createPauseTaskTool,
	createResumeTaskTool,
	createScheduleTaskTool,
} from "./scheduler-tools.js";
import { createSendMessageTool } from "./send-message.js";
import { createWebSearchTool } from "./web-search.js";
import { createWriteTool } from "./write.js";

export { setQuantMoniManager } from "./quantmoni-tools.js";
export { setSchedulerInstance } from "./scheduler-tools.js";
export { setTelegramInstance } from "./send-message.js";

export function createMoniTools(): AgentTool<any>[] {
	return [
		// Core tools
		createBashTool(),
		createReadTool(),
		createWriteTool(),
		createEditTool(),
		// Telegram
		createSendMessageTool(),
		// QuantMoni
		createQuantMoniStartTool(),
		createQuantMoniStopTool(),
		createQuantMoniStatusTool(),
		createQuantMoniRestartTool(),
		createQuantMoniLogsTool(),
		// Scheduler
		createScheduleTaskTool(),
		createListTasksTool(),
		createPauseTaskTool(),
		createResumeTaskTool(),
		createCancelTaskTool(),
		// Web search
		createWebSearchTool(),
	];
}
