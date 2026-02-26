import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import * as log from "./log.js";

export interface QuantMoniStatus {
	running: boolean;
	pid: number | null;
	uptime: string | null;
	state: QuantMoniState | null;
	journalStats: { buys: number; sells: number; skips: number; errors: number; total: number };
	recentLogs: string;
}

export interface QuantMoniState {
	positions: Record<string, unknown>;
	blacklist: Record<string, unknown>;
	daily: { date: string; trade_count: number; sol_deployed: number };
	stop_counts: Record<string, number>;
	peak_sol: number;
}

export class QuantMoniManager {
	private quantmoniDir: string;

	constructor(quantmoniDir: string) {
		this.quantmoniDir = quantmoniDir;
	}

	private getPidFile(): string {
		return join(this.quantmoniDir, "quantmoni.pid");
	}

	private readPid(): number | null {
		const pidFile = this.getPidFile();
		if (!existsSync(pidFile)) return null;
		try {
			const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
			if (Number.isNaN(pid)) return null;
			return pid;
		} catch {
			return null;
		}
	}

	isRunning(): boolean {
		const pid = this.readPid();
		if (pid === null) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	async start(): Promise<{ pid: number; status: string }> {
		if (this.isRunning()) {
			const pid = this.readPid()!;
			return { pid, status: "already running" };
		}

		const startupScript = join(this.quantmoniDir, "startup.sh");
		if (!existsSync(startupScript)) {
			throw new Error(`startup.sh not found at ${startupScript}`);
		}

		return new Promise((resolve, reject) => {
			const child = spawn("bash", [startupScript], {
				cwd: this.quantmoniDir,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					QUANTMONI_DIR: this.quantmoniDir,
				},
			});

			let stdout = "";
			let stderr = "";

			child.stdout?.on("data", (d) => {
				stdout += d.toString();
			});
			child.stderr?.on("data", (d) => {
				stderr += d.toString();
			});

			child.on("close", (code) => {
				if (code === 0) {
					// Wait a moment for the PID file to be written
					setTimeout(() => {
						const pid = this.readPid();
						if (pid && this.isRunning()) {
							log.logInfo(`QuantMoni started with PID ${pid}`);
							resolve({ pid, status: "started" });
						} else {
							resolve({ pid: pid || 0, status: `started (startup exit 0, pid=${pid})` });
						}
					}, 1000);
				} else {
					reject(new Error(`startup.sh exited with code ${code}: ${stderr || stdout}`));
				}
			});

			child.unref();
		});
	}

	async stop(): Promise<void> {
		const pid = this.readPid();
		if (pid === null || !this.isRunning()) {
			log.logInfo("QuantMoni is not running");
			return;
		}

		log.logInfo(`Stopping QuantMoni (PID ${pid})...`);

		// Send SIGTERM first
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			return;
		}

		// Wait up to 10s for graceful shutdown
		for (let i = 0; i < 20; i++) {
			await new Promise((r) => setTimeout(r, 500));
			try {
				process.kill(pid, 0);
			} catch {
				log.logInfo("QuantMoni stopped gracefully");
				return;
			}
		}

		// Force kill
		log.logWarning("QuantMoni did not stop gracefully, sending SIGKILL");
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* already dead */
		}
	}

	async restart(): Promise<{ pid: number; status: string }> {
		await this.stop();
		await new Promise((r) => setTimeout(r, 2000));
		return this.start();
	}

	getState(): QuantMoniState | null {
		const statePath = join(this.quantmoniDir, "state.json");
		if (!existsSync(statePath)) return null;
		try {
			return JSON.parse(readFileSync(statePath, "utf-8"));
		} catch {
			return null;
		}
	}

	getJournalStats(): { buys: number; sells: number; skips: number; errors: number; total: number } {
		const journalPath = join(this.quantmoniDir, "journal.jsonl");
		if (!existsSync(journalPath)) {
			return { buys: 0, sells: 0, skips: 0, errors: 0, total: 0 };
		}

		try {
			const content = readFileSync(journalPath, "utf-8");
			const lines = content.trim().split("\n").filter(Boolean);
			let buys = 0;
			let sells = 0;
			let skips = 0;
			let errors = 0;

			for (const line of lines) {
				try {
					const entry = JSON.parse(line);
					switch (entry.event) {
						case "BUY":
							buys++;
							break;
						case "SELL":
						case "STOP_LOSS":
						case "HARVEST":
							sells++;
							break;
						case "SKIP":
							skips++;
							break;
						case "ERROR":
							errors++;
							break;
					}
				} catch {
					/* skip malformed */
				}
			}

			return { buys, sells, skips, errors, total: lines.length };
		} catch {
			return { buys: 0, sells: 0, skips: 0, errors: 0, total: 0 };
		}
	}

	getRecentLogs(lines = 50): string {
		const logsDir = join(this.quantmoniDir, "logs");
		if (!existsSync(logsDir)) return "(no logs directory)";

		// Find the most recent log file
		try {
			const { execSync } = require("child_process");
			const result = execSync(`ls -t "${logsDir}"/quantmoni_runner*.log 2>/dev/null | head -1`, {
				encoding: "utf-8",
			}).trim();
			if (!result) return "(no log files found)";

			const tailResult = execSync(`tail -${lines} "${result}"`, { encoding: "utf-8" });
			return tailResult;
		} catch {
			return "(failed to read logs)";
		}
	}

	async getStatus(): Promise<QuantMoniStatus> {
		const running = this.isRunning();
		const pid = this.readPid();
		const state = this.getState();
		const journalStats = this.getJournalStats();
		const recentLogs = this.getRecentLogs(20);

		let uptime: string | null = null;
		if (running && pid) {
			try {
				const { execSync } = require("child_process");
				const elapsed = execSync(`ps -p ${pid} -o etime= 2>/dev/null`, { encoding: "utf-8" }).trim();
				uptime = elapsed;
			} catch {
				/* ignore */
			}
		}

		return {
			running,
			pid,
			uptime,
			state,
			journalStats,
			recentLogs,
		};
	}

	formatStatusString(status: QuantMoniStatus): string {
		const parts: string[] = [];
		parts.push(`*QuantMoni*: ${status.running ? "RUNNING" : "STOPPED"}`);
		if (status.pid) parts.push(`PID: ${status.pid}`);
		if (status.uptime) parts.push(`Uptime: ${status.uptime}`);

		if (status.state) {
			const positions = Object.keys(status.state.positions).length;
			parts.push(`Positions: ${positions}`);
			parts.push(`Daily trades: ${status.state.daily.trade_count}`);
			parts.push(`SOL deployed: ${status.state.daily.sol_deployed}`);
			parts.push(`Peak SOL: ${status.state.peak_sol}`);
		}

		const js = status.journalStats;
		parts.push(
			`Journal: ${js.total} entries (${js.buys} buys, ${js.sells} sells, ${js.skips} skips, ${js.errors} errors)`,
		);

		return parts.join("\n");
	}
}
