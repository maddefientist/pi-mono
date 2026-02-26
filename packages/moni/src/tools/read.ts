import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync } from "fs";
import { extname } from "path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.js";

const IMAGE_MIME_TYPES: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
};

function isImageFile(filePath: string): string | null {
	const ext = extname(filePath).toLowerCase();
	return IMAGE_MIME_TYPES[ext] || null;
}

const readSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're reading (shown to user)" }),
	path: Type.String({ description: "Absolute path to the file to read" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export function createReadTool(): AgentTool<typeof readSchema> {
	return {
		name: "read",
		label: "read",
		description: `Read file contents. Supports text and images (jpg, png, gif, webp). Text truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. Use offset/limit for large files.`,
		parameters: readSchema,
		execute: async (
			_toolCallId: string,
			{ path, offset, limit }: { label: string; path: string; offset?: number; limit?: number },
		): Promise<{ content: (TextContent | ImageContent)[]; details: unknown }> => {
			if (!existsSync(path)) {
				throw new Error(`File not found: ${path}`);
			}

			const mimeType = isImageFile(path);
			if (mimeType) {
				const data = readFileSync(path).toString("base64");
				return {
					content: [
						{ type: "text", text: `Read image file [${mimeType}]` },
						{ type: "image", data, mimeType },
					],
					details: undefined,
				};
			}

			const fullContent = readFileSync(path, "utf-8");
			const allLines = fullContent.split("\n");
			const totalFileLines = allLines.length;

			const startLine = offset ? Math.max(1, offset) : 1;
			if (startLine > totalFileLines) {
				throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
			}

			let selectedLines = allLines.slice(startLine - 1);
			let userLimitedLines: number | undefined;

			if (limit !== undefined) {
				const endLine = Math.min(limit, selectedLines.length);
				selectedLines = selectedLines.slice(0, endLine);
				userLimitedLines = endLine;
			}

			const selectedContent = selectedLines.join("\n");
			const truncation = truncateHead(selectedContent);

			let outputText: string;

			if (truncation.firstLineExceedsLimit) {
				outputText = `[Line ${startLine} exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLine}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
			} else if (truncation.truncated) {
				const endLineDisplay = startLine + truncation.outputLines - 1;
				const nextOffset = endLineDisplay + 1;
				outputText = truncation.content;
				if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLine}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue]`;
				} else {
					outputText += `\n\n[Showing lines ${startLine}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue]`;
				}
			} else if (userLimitedLines !== undefined) {
				const linesFromStart = startLine - 1 + userLimitedLines;
				if (linesFromStart < totalFileLines) {
					const remaining = totalFileLines - linesFromStart;
					const nextOffset = startLine + userLimitedLines;
					outputText = truncation.content;
					outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue]`;
				} else {
					outputText = truncation.content;
				}
			} else {
				outputText = truncation.content;
			}

			return { content: [{ type: "text", text: outputText }], details: undefined };
		},
	};
}
