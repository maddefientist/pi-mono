import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync, writeFileSync } from "fs";

const editSchema = Type.Object({
	label: Type.String({ description: "Brief description of the edit (shown to user)" }),
	path: Type.String({ description: "Absolute path to the file to edit" }),
	oldText: Type.String({ description: "Exact text to find and replace (must match exactly)" }),
	newText: Type.String({ description: "New text to replace the old text with" }),
});

export function createEditTool(): AgentTool<typeof editSchema> {
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use for precise, surgical edits.",
		parameters: editSchema,
		execute: async (
			_toolCallId: string,
			{ path, oldText, newText }: { label: string; path: string; oldText: string; newText: string },
		) => {
			if (!existsSync(path)) {
				throw new Error(`File not found: ${path}`);
			}

			const content = readFileSync(path, "utf-8");

			if (!content.includes(oldText)) {
				throw new Error(
					`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
				);
			}

			const occurrences = content.split(oldText).length - 1;
			if (occurrences > 1) {
				throw new Error(
					`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Provide more context.`,
				);
			}

			const index = content.indexOf(oldText);
			const newContent = content.substring(0, index) + newText + content.substring(index + oldText.length);

			if (content === newContent) {
				throw new Error(`No changes made to ${path}. Replacement produced identical content.`);
			}

			writeFileSync(path, newContent, "utf-8");

			return {
				content: [
					{
						type: "text",
						text: `Successfully replaced text in ${path}. Changed ${oldText.length} chars to ${newText.length} chars.`,
					},
				],
				details: undefined,
			};
		},
	};
}
