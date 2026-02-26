#!/usr/bin/env node
/**
 * Moni OAuth Login Script
 *
 * Run this once to authenticate Moni with Anthropic OAuth (Claude Pro/Max).
 * It will:
 * 1. Print an authorization URL to visit in your browser
 * 2. Wait for you to paste the authorization code
 * 3. Save the credentials to ~/.pi/moni/auth.json
 *
 * Usage: node scripts/login.mjs
 */

import { loginAnthropic } from "@mariozechner/pi-ai";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createInterface } from "readline";

const AUTH_DIR = join(homedir(), ".pi", "moni");
const AUTH_PATH = join(AUTH_DIR, "auth.json");

function prompt(question) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

async function main() {
	console.log("\n=== Moni OAuth Login (Anthropic) ===\n");

	// Check for existing credentials
	if (existsSync(AUTH_PATH)) {
		const existing = JSON.parse(readFileSync(AUTH_PATH, "utf-8"));
		if (existing.anthropic) {
			const answer = await prompt("Existing Anthropic credentials found. Overwrite? (y/N): ");
			if (answer.toLowerCase() !== "y") {
				console.log("Cancelled.");
				process.exit(0);
			}
		}
	}

	console.log("Starting OAuth flow...\n");

	try {
		const credentials = await loginAnthropic(
			// onAuthUrl - show URL to user
			(url) => {
				console.log("Open this URL in your browser to authorize Moni:\n");
				console.log(`  ${url}\n`);
				console.log("After authorizing, you'll be redirected to a page with a code.");
				console.log("Copy the FULL URL or the code#state from the page.\n");
			},
			// onPromptCode - get the code from user
			async () => {
				const code = await prompt("Paste the authorization code here: ");
				return code;
			},
		);

		// Save to auth.json
		mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });

		let authData = {};
		if (existsSync(AUTH_PATH)) {
			try {
				authData = JSON.parse(readFileSync(AUTH_PATH, "utf-8"));
			} catch {
				// Start fresh if corrupted
			}
		}

		authData.anthropic = {
			type: "oauth",
			...credentials,
		};

		writeFileSync(AUTH_PATH, JSON.stringify(authData, null, 2), "utf-8");
		chmodSync(AUTH_PATH, 0o600);

		console.log(`\nCredentials saved to ${AUTH_PATH}`);
		console.log(`Token expires at: ${new Date(credentials.expires).toISOString()}`);
		console.log("\nMoni is now authenticated. You can start the service:");
		console.log("  systemctl --user start moni\n");
	} catch (err) {
		console.error("\nLogin failed:", err.message);
		process.exit(1);
	}
}

main();
