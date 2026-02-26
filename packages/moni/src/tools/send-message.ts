import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { TelegramChannel } from "../telegram.js";

const sendMessageSchema = Type.Object({
	label: Type.String({ description: "Brief description of why you're sending this message" }),
	text: Type.String({ description: "Message text to send via Telegram" }),
});

let telegramInstance: TelegramChannel | null = null;

export function setTelegramInstance(telegram: TelegramChannel): void {
	telegramInstance = telegram;
}

export function createSendMessageTool(): AgentTool<typeof sendMessageSchema> {
	return {
		name: "send_message",
		label: "send_message",
		description:
			"Send a Telegram message immediately while still processing. Use for urgent alerts, progress updates, or when you want to send a message before your response is complete.",
		parameters: sendMessageSchema,
		execute: async (_toolCallId: string, { text }: { label: string; text: string }) => {
			if (!telegramInstance) {
				throw new Error("Telegram not initialized");
			}

			await telegramInstance.sendMessage(text);

			return {
				content: [
					{ type: "text", text: `Message sent: "${text.substring(0, 100)}${text.length > 100 ? "..." : ""}"` },
				],
				details: undefined,
			};
		},
	};
}
