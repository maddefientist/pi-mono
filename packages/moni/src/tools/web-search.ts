import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

const SEARXNG_URL = process.env.SEARXNG_URL || "http://192.168.1.225:8080";

const webSearchSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're searching for" }),
	query: Type.String({ description: "Search query" }),
	maxResults: Type.Optional(Type.Number({ description: "Maximum results to return (default 5)" })),
});

export function createWebSearchTool(): AgentTool<typeof webSearchSchema> {
	return {
		name: "web_search",
		label: "web_search",
		description: "Search the web using SearxNG. Returns titles, URLs, and snippets.",
		parameters: webSearchSchema,
		execute: async (
			_toolCallId: string,
			{ query, maxResults }: { label: string; query: string; maxResults?: number },
		) => {
			const limit = maxResults || 5;
			const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`;

			const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
			if (!response.ok) {
				throw new Error(`SearxNG error: ${response.status} ${response.statusText}`);
			}

			const data = (await response.json()) as { results?: Array<{ title: string; url: string; content: string }> };
			const results = (data.results || []).slice(0, limit);

			if (results.length === 0) {
				return { content: [{ type: "text", text: `No results for: ${query}` }], details: undefined };
			}

			const formatted = results
				.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content || "(no snippet)"}`)
				.join("\n\n");

			return {
				content: [{ type: "text", text: `Search results for "${query}":\n\n${formatted}` }],
				details: { results },
			};
		},
	};
}
