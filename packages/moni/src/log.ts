import chalk from "chalk";

export interface LogContext {
	chatId: string;
	userName?: string;
}

function timestamp(): string {
	const now = new Date();
	const hh = String(now.getHours()).padStart(2, "0");
	const mm = String(now.getMinutes()).padStart(2, "0");
	const ss = String(now.getSeconds()).padStart(2, "0");
	return `[${hh}:${mm}:${ss}]`;
}

function formatContext(ctx: LogContext): string {
	const user = ctx.userName || "unknown";
	return `[${ctx.chatId}:${user}]`;
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.substring(0, maxLen)}\n(truncated at ${maxLen} chars)`;
}

function formatToolArgs(args: Record<string, unknown>): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		if (key === "label") continue;
		if (key === "path" && typeof value === "string") {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined && limit !== undefined) {
				lines.push(`${value}:${offset}-${offset + limit}`);
			} else {
				lines.push(value);
			}
			continue;
		}
		if (key === "offset" || key === "limit") continue;
		if (typeof value === "string") {
			lines.push(value);
		} else {
			lines.push(JSON.stringify(value));
		}
	}
	return lines.join("\n");
}

export function logUserMessage(ctx: LogContext, text: string): void {
	console.log(chalk.green(`${timestamp()} ${formatContext(ctx)} ${text}`));
}

export function logToolStart(ctx: LogContext, toolName: string, label: string, args: Record<string, unknown>): void {
	const formattedArgs = formatToolArgs(args);
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} -> ${toolName}: ${label}`));
	if (formattedArgs) {
		const indented = formattedArgs
			.split("\n")
			.map((line) => `           ${line}`)
			.join("\n");
		console.log(chalk.dim(indented));
	}
}

export function logToolSuccess(ctx: LogContext, toolName: string, durationMs: number, result: string): void {
	const duration = (durationMs / 1000).toFixed(1);
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} OK ${toolName} (${duration}s)`));
	const truncated = truncate(result, 1000);
	if (truncated) {
		const indented = truncated
			.split("\n")
			.map((line) => `           ${line}`)
			.join("\n");
		console.log(chalk.dim(indented));
	}
}

export function logToolError(ctx: LogContext, toolName: string, durationMs: number, error: string): void {
	const duration = (durationMs / 1000).toFixed(1);
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} FAIL ${toolName} (${duration}s)`));
	const truncated = truncate(error, 1000);
	const indented = truncated
		.split("\n")
		.map((line) => `           ${line}`)
		.join("\n");
	console.log(chalk.dim(indented));
}

export function logResponseStart(ctx: LogContext): void {
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} -> Streaming response...`));
}

export function logThinking(ctx: LogContext, thinking: string): void {
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} Thinking`));
	const truncated = truncate(thinking, 1000);
	const indented = truncated
		.split("\n")
		.map((line) => `           ${line}`)
		.join("\n");
	console.log(chalk.dim(indented));
}

export function logResponse(ctx: LogContext, text: string): void {
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} Response`));
	const truncated = truncate(text, 1000);
	const indented = truncated
		.split("\n")
		.map((line) => `           ${line}`)
		.join("\n");
	console.log(chalk.dim(indented));
}

export function logInfo(message: string): void {
	console.log(chalk.blue(`${timestamp()} [system] ${message}`));
}

export function logWarning(message: string, details?: string): void {
	console.log(chalk.yellow(`${timestamp()} [system] WARNING ${message}`));
	if (details) {
		const indented = details
			.split("\n")
			.map((line) => `           ${line}`)
			.join("\n");
		console.log(chalk.dim(indented));
	}
}

export function logUsageSummary(
	_ctx: LogContext,
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	},
	contextTokens?: number,
	contextWindow?: number,
): string {
	const formatTokens = (count: number): string => {
		if (count < 1000) return count.toString();
		if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
		if (count < 1000000) return `${Math.round(count / 1000)}k`;
		return `${(count / 1000000).toFixed(1)}M`;
	};

	const lines: string[] = [];
	lines.push("*Usage*");
	lines.push(`Tokens: ${usage.input.toLocaleString()} in, ${usage.output.toLocaleString()} out`);
	if (usage.cacheRead > 0 || usage.cacheWrite > 0) {
		lines.push(`Cache: ${usage.cacheRead.toLocaleString()} read, ${usage.cacheWrite.toLocaleString()} write`);
	}
	if (contextTokens && contextWindow) {
		const contextPercent = ((contextTokens / contextWindow) * 100).toFixed(1);
		lines.push(`Context: ${formatTokens(contextTokens)} / ${formatTokens(contextWindow)} (${contextPercent}%)`);
	}
	lines.push(`Cost: $${usage.cost.total.toFixed(4)}`);

	const summary = lines.join("\n");

	console.log(
		chalk.dim(
			`           ${usage.input.toLocaleString()} in + ${usage.output.toLocaleString()} out = $${usage.cost.total.toFixed(4)}`,
		),
	);

	return summary;
}

export function logStartup(dataDir: string): void {
	console.log("Starting Moni agent...");
	console.log(`  Data directory: ${dataDir}`);
}
