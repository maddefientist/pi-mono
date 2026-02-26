import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { createWriteStream } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "./truncate.js";

function getTempFilePath(): string {
	return join(tmpdir(), `moni-bash-${randomBytes(8).toString("hex")}.log`);
}

const bashSchema = Type.Object({
	label: Type.String({ description: "Brief description of what this command does (shown to user)" }),
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)" })),
});

export function createBashTool(): AgentTool<typeof bashSchema> {
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command. Returns stdout and stderr. Output truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB.`,
		parameters: bashSchema,
		execute: async (
			_toolCallId: string,
			{ command, timeout }: { label: string; command: string; timeout?: number },
			signal?: AbortSignal,
		) => {
			const result = await execCommand(command, timeout, signal);
			let output = "";
			if (result.stdout) output += result.stdout;
			if (result.stderr) {
				if (output) output += "\n";
				output += result.stderr;
			}

			const totalBytes = Buffer.byteLength(output, "utf-8");
			let tempFilePath: string | undefined;
			if (totalBytes > DEFAULT_MAX_BYTES) {
				tempFilePath = getTempFilePath();
				const stream = createWriteStream(tempFilePath);
				stream.write(output);
				stream.end();
			}

			const truncation = truncateTail(output);
			let outputText = truncation.content || "(no output)";

			if (truncation.truncated && tempFilePath) {
				const startLine = truncation.totalLines - truncation.outputLines + 1;
				const endLine = truncation.totalLines;
				if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
				} else {
					outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${tempFilePath}]`;
				}
			}

			if (result.code !== 0) {
				throw new Error(`${outputText}\n\nCommand exited with code ${result.code}`.trim());
			}

			return { content: [{ type: "text", text: outputText }], details: undefined };
		},
	};
}

function execCommand(
	command: string,
	timeout?: number,
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve, reject) => {
		const child = spawn("sh", ["-c", command], {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;

		const timeoutHandle =
			timeout && timeout > 0
				? setTimeout(() => {
						timedOut = true;
						try {
							process.kill(-child.pid!, "SIGKILL");
						} catch {
							try {
								process.kill(child.pid!, "SIGKILL");
							} catch {}
						}
					}, timeout * 1000)
				: undefined;

		const onAbort = () => {
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {
				try {
					process.kill(child.pid!, "SIGKILL");
				} catch {}
			}
		};

		if (signal) {
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		child.stdout?.on("data", (data) => {
			stdout += data.toString();
			if (stdout.length > 10 * 1024 * 1024) stdout = stdout.slice(0, 10 * 1024 * 1024);
		});

		child.stderr?.on("data", (data) => {
			stderr += data.toString();
			if (stderr.length > 10 * 1024 * 1024) stderr = stderr.slice(0, 10 * 1024 * 1024);
		});

		child.on("close", (code) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (signal) signal.removeEventListener("abort", onAbort);

			if (signal?.aborted) {
				reject(new Error(`${stdout}\n${stderr}\nCommand aborted`.trim()));
				return;
			}

			if (timedOut) {
				reject(new Error(`${stdout}\n${stderr}\nCommand timed out after ${timeout} seconds`.trim()));
				return;
			}

			resolve({ stdout, stderr, code: code ?? 0 });
		});
	});
}
