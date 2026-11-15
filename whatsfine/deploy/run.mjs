#!/usr/bin/env node
// The scheduled jobs, one entry point for cron (the box) and Task
// Scheduler (the PC with the vault):
//
//   node deploy/run.mjs obsidian   the vault ↔ Mealie sync (seed/obsidian.mjs sync)
//   node deploy/run.mjs site       Mealie → whatsfine.com (the site repo's mealie:sync --prod)
//   node deploy/run.mjs backup     a Mealie backup, copied to R2 (deploy/backup.mjs --r2)
//
// Each run appends its output to ~/Logs/whatsfine/<job>.log (rotated at
// 1 MB), writes ~/Logs/whatsfine/<job>.status.json ({ ok, code, at, took }),
// and exits with the job's code. A failure also posts the last lines of
// output to a webhook when one is configured: the URL in $WHATSFINE_ALERT_URL
// or in deploy/alert-webhook.txt (gitignored). A Discord webhook, an
// ntfy.sh topic or a Healthchecks URL all take the POST as it is sent.
//
// Settings, from the environment (or deploy/run.env, KEY=value lines,
// gitignored):
//   MEALIE_URL           Mealie's address (default http://localhost:9925)
//   MEALIE_TOKEN_FILE    { "url", "token" } JSON the jobs sign in with
//                        (default: the site repo's mealie-local.json)
//   WHATSFINE_SITE       the whatsfine checkout (default: beside this repo)
//   OBSIDIAN_VAULT       the vault, for the obsidian job (default: the one Obsidian has open)
//   OBSIDIAN_SYNC_ARGS   extra arguments for the obsidian job, e.g. "--skip brown-butter"
//   SITE_SYNC_ARGS       extra arguments for the site job, e.g. "--allow-test-mealie"
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fork = resolve(here, "..");
const job = process.argv[2];
const logs = join(homedir(), "Logs", "whatsfine");

// deploy/run.env fills in what the environment does not say.
const envFile = join(here, "run.env");
if (existsSync(envFile)) {
	for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
		const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
		if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
	}
}
const site = resolve(process.env.WHATSFINE_SITE ?? join(fork, "..", "..", "whatsfine"));
const tokenFile = resolve(process.env.MEALIE_TOKEN_FILE ?? join(site, "mealie-local.json"));
const words = (s) => (s ?? "").match(/"[^"]*"|\S+/g)?.map((w) => w.replace(/^"(.*)"$/, "$1")) ?? [];
const win = process.platform === "win32";
const pnpm = win ? "pnpm.cmd" : "pnpm";

const JOBS = {
	obsidian: () => [[process.execPath, [join(fork, "seed", "obsidian.mjs"), "sync", "--token-file", tokenFile, ...words(process.env.OBSIDIAN_SYNC_ARGS)]]],
	site: () => [
		// Pull first: the sync runs from this clone, so it must be current.
		["git", ["-C", site, "pull", "--ff-only", "--quiet"]],
		[pnpm, ["--dir", site, "run", "--silent", "mealie:sync", "--", "--prod", ...words(process.env.SITE_SYNC_ARGS)]],
	],
	backup: () => [[process.execPath, [join(here, "backup.mjs"), "--r2", "--token-file", tokenFile, "--site-repo", site]]],
};

if (!JOBS[job]) {
	console.error(`usage: node deploy/run.mjs <${Object.keys(JOBS).join("|")}>`);
	process.exit(2);
}
mkdirSync(logs, { recursive: true });
const log = join(logs, `${job}.log`);
const status = join(logs, `${job}.status.json`);
if (existsSync(log) && statSync(log).size > 1024 * 1024) renameSync(log, `${log}.1`);

// One run of a job at a time (the obsidian job also locks itself).
const lock = join(logs, `${job}.lock`);
try {
	const held = JSON.parse(readFileSync(lock, "utf8"));
	const alive = (() => {
		try {
			process.kill(held.pid, 0);
			return true;
		} catch (e) {
			return e.code === "EPERM";
		}
	})();
	if (alive && Date.now() - Date.parse(held.at) < 2 * 60 * 60 * 1000) {
		appendFileSync(log, `${new Date().toISOString()} skipped: still running (pid ${held.pid})\n`);
		process.exit(0);
	}
} catch {
	// no lock, or a stale one
}
writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));

const started = Date.now();
const out = [];
let code = 0;
process.env.MEALIE_URL ??= "http://localhost:9925";
for (const [cmd, args] of JOBS[job]()) {
	const r = spawnSync(win && cmd.endsWith(".cmd") ? `"${cmd}"` : cmd, win && cmd.endsWith(".cmd") ? args.map((a) => `"${a}"`) : args, {
		cwd: fork,
		env: process.env,
		encoding: "utf8",
		shell: win && cmd.endsWith(".cmd"),
		timeout: 30 * 60 * 1000,
	});
	out.push(`$ ${[cmd, ...args].join(" ")}`, r.stdout ?? "", r.stderr ?? "", r.error ? `error: ${r.error.message}` : "");
	code = r.status ?? 1;
	if (code !== 0) break;
}
const text = out.filter(Boolean).join("\n").trimEnd();
appendFileSync(log, `\n=== ${new Date().toISOString()} ${job} on ${hostname()} → exit ${code} (${((Date.now() - started) / 1000).toFixed(1)} s)\n${text}\n`);
writeFileSync(status, JSON.stringify({ job, ok: code === 0, code, at: new Date().toISOString(), took: Date.now() - started }, null, 1));
rmSync(lock, { force: true });

if (code !== 0) {
	const hookFile = join(here, "alert-webhook.txt");
	const url = process.env.WHATSFINE_ALERT_URL ?? (existsSync(hookFile) ? readFileSync(hookFile, "utf8").trim() : "");
	if (url) {
		const tail = text.split("\n").slice(-15).join("\n");
		const message = `WhatsFine ${job} failed on ${hostname()} (exit ${code}):\n${tail}`.slice(0, 1900);
		// Discord wants { content }; ntfy and Healthchecks take a plain body.
		const discord = /discord(?:app)?\.com\/api\/webhooks\//.test(url);
		await fetch(url, {
			method: "POST",
			headers: { "Content-Type": discord ? "application/json" : "text/plain" },
			body: discord ? JSON.stringify({ content: `\`\`\`\n${message}\n\`\`\`` }) : message,
		}).catch((e) => appendFileSync(log, `alert failed: ${e.message}\n`));
	}
}
process.exit(code);
