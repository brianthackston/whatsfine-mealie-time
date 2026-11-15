#!/usr/bin/env node
// Mealie backups: Mealie never makes them on its own. This asks Mealie for
// one (Admin → Backups does the same), saves the zip, keeps the newest few
// in both places, and with --r2 copies it to the private R2 bucket
// `whatsfine-mealie-backups` (no public URL, no Worker binding; never
// `whatsfine-media`, which the site serves by key, and a backup holds
// password hashes and Mealie's secret keys).
//
//   node deploy/backup.mjs [--dir <folder>] [--keep 14] [--r2] [--prefix <name>]
//
//   --dir     where the zips go (default ~/Backups/mealie)
//   --keep    how many to keep locally and in Mealie (default 14)
//   --r2      also upload to R2 under <prefix>/ (needs wrangler signed in,
//             or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the env)
//   --prefix  the R2 folder (default: this machine's name)
//   --site-repo  the whatsfine checkout whose wrangler uploads (default: beside this repo)
//
// Auth as for the other scripts: MEALIE_TOKEN, the token file
// (whatsfine/mealie-local.json), or MEALIE_USER + MEALIE_PASSWORD. The
// token's user must be an admin: backups are an admin action.
// Exit code 1 on any failure, for the scheduler to notice.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Mealie, cli } from "../seed/lib/mealie.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { flag, opt } = cli(process.argv.slice(2), ["--dir", "--keep", "--prefix", "--url", "--token-file", "--site-repo"]);
const config = {
	url: opt("--url", process.env.MEALIE_URL ?? "http://localhost:9925"),
	urlGiven: opt("--url") != null || Boolean(process.env.MEALIE_URL),
	tokenFile: resolve(opt("--token-file", join(here, "..", "mealie-local.json"))),
	dir: resolve(opt("--dir", join(homedir(), "Backups", "mealie"))),
	keep: Math.max(1, Number(opt("--keep", "14")) || 14),
	r2: flag("--r2"),
	prefix: opt("--prefix", hostname().toLowerCase()),
	bucket: "whatsfine-mealie-backups",
};

const api = await Mealie.login(config.url, { tokenFile: config.tokenFile, baseWins: config.urlGiven });

// 1. A new backup in Mealie, and its name.
const before = new Set(((await api.get("/admin/backups")).imports ?? []).map((b) => b.name));
await api.post("/admin/backups", {});
const all = ((await api.get("/admin/backups")).imports ?? []).sort((a, b) => String(b.date).localeCompare(String(a.date)));
const made = all.find((b) => !before.has(b.name)) ?? all[0];
if (!made) throw new Error("Mealie reported no backup after creating one");

// 2. Download it.
const { fileToken } = await api.get(`/admin/backups/${encodeURIComponent(made.name)}`);
const res = await fetch(`${api.base}/api/utils/download?token=${fileToken}`);
if (!res.ok) throw new Error(`download ${made.name} → ${res.status}`);
const bytes = Buffer.from(await res.arrayBuffer());
if (bytes.length < 1000 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error(`${made.name} is not a zip (${bytes.length} bytes)`);
mkdirSync(config.dir, { recursive: true });
const file = join(config.dir, made.name);
writeFileSync(file, bytes);
console.log(`saved ${file} (${(bytes.length / 1024).toFixed(0)} KB)`);

// 3. Off this machine.
if (config.r2) {
	const key = `${config.bucket}/${config.prefix}/${made.name}`;
	// The site repo's pinned wrangler when it sits beside this one (it does
	// on the PC and on the box); else wrangler 4 through npx.
	const site = resolve(opt("--site-repo", process.env.WHATSFINE_SITE ?? join(here, "..", "..", "..", "whatsfine")));
	const args = ["r2", "object", "put", key, "--file", file, "--remote"];
	const [cmd, pre] = existsSync(join(site, "wrangler.jsonc"))
		? [process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["--dir", site, "exec", "wrangler"]]
		: [process.platform === "win32" ? "npx.cmd" : "npx", ["--yes", "wrangler@4"]];
	// Windows runs a .cmd through the shell, which does not quote arguments.
	const win = process.platform === "win32";
	const argv = [...pre, ...args].map((a) => (win ? `"${a.replace(/"/g, '""')}"` : a));
	if (win) execSync([cmd, ...argv].join(" "), { stdio: ["ignore", "ignore", "inherit"] });
	else execFileSync(cmd, argv, { stdio: ["ignore", "ignore", "inherit"] });
	console.log(`uploaded r2://${key}`);
}

// 4. Keep the newest few, here and in Mealie (its own copies fill the box's disk).
const local = readdirSync(config.dir)
	.filter((f) => /^mealie_.*\.zip$/.test(f))
	.map((f) => ({ f, t: statSync(join(config.dir, f)).mtimeMs }))
	.sort((a, b) => b.t - a.t);
for (const { f } of local.slice(config.keep)) {
	rmSync(join(config.dir, f));
	console.log(`pruned ${f}`);
}
for (const b of all.slice(config.keep)) {
	await api.delete(`/admin/backups/${encodeURIComponent(b.name)}`);
	console.log(`pruned in Mealie: ${b.name}`);
}
