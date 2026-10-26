#!/usr/bin/env node
// Obsidian ↔ Mealie. Recipes are drafted as notes in the vault's recipe
// folder, using the "Recipe - BT" template; this script pushes them into
// Mealie through its API, writes Mealie's id back into the note's
// `mealie id` property (which the "Not in Mealie" Base view keys on), and can
// pull recipes that exist only in Mealie back into the vault as new notes.
//
// The note format it reads and writes (Templates/Recipe - BT.md):
//
//   ---
//   base type: [Recipe]        marks the note as a recipe
//   recipe type: [Breakfast]   → Mealie category
//   status: [Draft]            → extras.obsidian_status
//   source: <url>              → Mealie's source link (orgURL); a whatsfine.com
//                                article URL also sets extras.whatsfine_article
//   yield / servings           → recipeYield (Mealie reads the first number as servings)
//   prep time / cook time / total time   "20 minutes", "1 hr 15 min" → Mealie times
//   cuisine: [..]              → tags
//   tools: [..]                → Mealie tools
//   mealie id:                 written by this script after a push
//   ---
//   ## Immediate Thoughts      stays in the vault (drafting scratch; Mealie notes get published)
//   ## Ingredients             - one per line → ingredients (parsed to qty/unit/food)
//   ## Instructions            1. one per line → steps
//   ## Notes                   - bullets → one Mealie note
//   ## Image and Tagline       first paragraph → description
//
// Usage (Node 22+, no dependencies):
//   node obsidian.mjs push [--dry-run] [--replace] [--no-parse] [--no-write-back]
//   node obsidian.mjs pull [--dry-run]
//
// Options:
//   --vault <path>     the vault; default: the vault Obsidian has open (%APPDATA%\obsidian\obsidian.json), or $OBSIDIAN_VAULT
//   --folder <name>    recipe folder inside the vault (default "010 - Recipes", or $OBSIDIAN_RECIPES)
//   --url <base>       Mealie base URL (default http://localhost:9925, or $MEALIE_URL)
//   --replace          push: delete and re-import a recipe Mealie already has, instead of updating it in place
//   --no-parse         push: leave ingredients as plain lines
//   --no-write-back    push: do not write `mealie id` into the notes
//   --dry-run          push: write payloads to seed/out/obsidian/; pull: print what would be created
//
// Auth as for seed.mjs: MEALIE_TOKEN, or MEALIE_USER + MEALIE_PASSWORD.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Mealie, cli, compact, durationSeconds, isoDuration, slugify } from "./lib/mealie.mjs";
import { SOURCE_TAG } from "./seed.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { flag, opt, positional } = cli();
const command = positional[0];
const config = {
	url: opt("--url", process.env.MEALIE_URL ?? "http://localhost:9925"),
	vault: opt("--vault", process.env.OBSIDIAN_VAULT),
	folder: opt("--folder", process.env.OBSIDIAN_RECIPES ?? "010 - Recipes"),
	template: "Templates/Recipe - BT.md",
	replace: flag("--replace"),
	parse: !flag("--no-parse"),
	writeBack: !flag("--no-write-back"),
	dryRun: flag("--dry-run"),
	outDir: join(here, "out", "obsidian"),
};

// ── Vault discovery ─────────────────────────────────────────────────────
async function findVault() {
	if (config.vault) return resolve(config.vault);
	const appData = process.env.APPDATA ?? join(process.env.HOME ?? "", "AppData/Roaming");
	try {
		const cfg = JSON.parse(await readFile(join(appData, "obsidian", "obsidian.json"), "utf8"));
		const vaults = Object.values(cfg.vaults ?? {});
		const open = vaults.find((v) => v.open) ?? vaults[0];
		if (open?.path) return open.path;
	} catch {
		// fall through
	}
	throw new Error("No vault found: pass --vault <path> or set OBSIDIAN_VAULT.");
}

// ── Note parsing ────────────────────────────────────────────────────────
// A deliberately small YAML reader for the template's frontmatter: scalars,
// block lists (`- item`), inline lists (`[a, b]`), empty values. Keys may
// contain spaces and emoji (the template has a ⭐ property).
export function parseFrontmatter(text) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!m) return { data: {}, body: text, raw: "" };
	const data = {};
	let key = null;
	for (const line of m[1].split(/\r?\n/)) {
		const item = /^\s+-\s*(.*)$/.exec(line);
		if (item && key) {
			if (!Array.isArray(data[key])) data[key] = [];
			if (item[1] !== "") data[key].push(unquote(item[1]));
			continue;
		}
		const kv = /^([^:]+?):\s*(.*)$/.exec(line);
		if (!kv) continue;
		key = kv[1].trim();
		const v = kv[2].trim();
		if (v === "") data[key] = null;
		else if (v.startsWith("[") && v.endsWith("]")) data[key] = v.slice(1, -1).split(",").map((s) => unquote(s.trim())).filter(Boolean);
		else data[key] = unquote(v);
	}
	return { data, body: text.slice(m[0].length), raw: m[0] };
}

const unquote = (s) => s.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const first = (v) => list(v)[0] ?? null;

/** `## Heading` sections → { heading: text }, with the text before the first heading under "". */
export function parseSections(body) {
	const sections = {};
	let current = "";
	for (const line of body.split(/\r?\n/)) {
		const h = /^##\s+(.+?)\s*$/.exec(line);
		if (h) {
			current = h[1].toLowerCase();
			sections[current] = sections[current] ?? [];
			continue;
		}
		(sections[current] = sections[current] ?? []).push(line);
	}
	for (const k of Object.keys(sections)) sections[k] = sections[k].join("\n").trim();
	return sections;
}

const bullets = (text) =>
	(text ?? "")
		.split(/\r?\n/)
		.map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim())
		.filter((l) => l && l !== "-");

export async function readNote(path) {
	const text = await readFile(path, "utf8");
	const { data, body, raw } = parseFrontmatter(text);
	const sections = parseSections(body);
	const h1 = /^#\s+(.+?)\s*$/m.exec(body)?.[1];
	return {
		path,
		text,
		raw,
		data,
		sections,
		name: h1 ?? basename(path, ".md"),
		isRecipe: list(data["base type"]).some((t) => /recipe/i.test(t)),
	};
}

// ── Note → Mealie ───────────────────────────────────────────────────────
export function noteToJsonLd(note) {
	const d = note.data;
	const source = d.source ?? undefined;
	// The site's sync reads the first tag that isn't WhatsFine as the page's
	// kicker chip, so "Recipe" goes first and cuisines follow.
	const keywords = ["Recipe", ...list(d.cuisine)];
	if (source && /whatsfine\.com/i.test(source)) keywords.unshift(SOURCE_TAG);
	return compact({
		"@context": "https://schema.org",
		"@type": "Recipe",
		name: note.name,
		description: tagline(note),
		url: source,
		recipeYield: d.yield ?? (d.servings ? `Serves ${d.servings}` : undefined),
		prepTime: isoDuration(d["prep time"]),
		cookTime: isoDuration(d["cook time"]),
		totalTime: isoDuration(d["total time"]),
		recipeIngredient: bullets(note.sections.ingredients),
		recipeInstructions: bullets(note.sections.instructions).map((text) => ({ "@type": "HowToStep", text })),
		recipeCategory: list(d["recipe type"]),
		keywords: keywords.join(", "),
	});
}

const tagline = (note) => (note.sections["image and tagline"] ?? "").split(/\n\s*\n/)[0]?.replace(/^!\[\[.*?\]\]\s*/, "").trim();

/** Everything schema.org has no slot for; organizers are resolved to objects by the caller. */
export function noteToPatch(note, { tools = [], categories = [], tags = [] } = {}) {
	const d = note.data;
	// "Immediate Thoughts" stays in the vault: it is drafting scratch, and
	// every Mealie note on a WhatsFine recipe is published to /food by the
	// site's sync (whatsfine/docs/mealie-sync.md).
	const notes = [];
	const noteLines = bullets(note.sections.notes);
	if (noteLines.length) notes.push({ title: "Notes", text: noteLines.map((l) => `- ${l}`).join("\n") });

	const article = /whatsfine\.com\/articles\/([^/?#]+)/i.exec(d.source ?? "")?.[1];
	return compact({
		notes,
		tools,
		recipeCategory: categories,
		tags,
		extras: compact({
			obsidian_note: basename(note.path),
			obsidian_status: first(d.status) ?? undefined,
			obsidian_rating: first(d["⭐"]) ?? undefined,
			recommended_by: list(d["recommended by"]).join(", "),
			...(article ? { whatsfine_article: article } : {}),
		}),
	});
}

/** For updating a recipe Mealie already has, without re-importing it. */
export function noteToUpdate(note, organizers) {
	const d = note.data;
	const patch = noteToPatch(note, organizers);
	return compact({
		...patch,
		description: tagline(note),
		recipeYield: d.yield ?? "",
		prepTimeSeconds: durationSeconds(d["prep time"]),
		cookTimeSeconds: durationSeconds(d["cook time"]),
		totalTimeSeconds: durationSeconds(d["total time"]),
		orgURL: d.source ?? undefined,
		recipeInstructions: bullets(note.sections.instructions).map((text) => ({ text })),
		recipeIngredient: bullets(note.sections.ingredients).map((line) => ({ note: line, originalText: line })),
	});
}

/** Replace (or add) the `mealie id` line in the note's frontmatter, leaving everything else as it is. */
export function withMealieId(text, id) {
	if (/^mealie id:.*$/m.test(text)) return text.replace(/^mealie id:.*$/m, `mealie id: ${id}`);
	return text.replace(/^---\r?\n([\s\S]*?)(\r?\n---)/, (m, fm, end) => `---\n${fm}\nmealie id: ${id}${end}`);
}

// ── Mealie → note ───────────────────────────────────────────────────────
export function recipeToNote(recipe, template) {
	const fm = {
		"recipe type": (recipe.recipeCategory ?? []).map((c) => c.name),
		status: ["Draft"],
		created: new Date().toISOString().slice(0, 10),
		source: recipe.orgURL ?? "",
		yield: recipe.recipeYield || (recipe.recipeServings ? `Serves ${trimNum(recipe.recipeServings)}` : ""),
		servings: recipe.recipeServings ? trimNum(recipe.recipeServings) : "",
		"prep time": minutes(recipe.prepTimeSeconds),
		"cook time": minutes(recipe.cookTimeSeconds),
		"total time": minutes(recipe.totalTimeSeconds),
		cuisine: (recipe.tags ?? []).map((t) => t.name).filter((n) => n !== SOURCE_TAG),
		tools: (recipe.tools ?? []).map((t) => t.name),
		"mealie id": recipe.id,
	};
	// Fill the template's frontmatter line by line so the property order and
	// the ones we don't touch (tags, base type, ⭐, recommended by) survive.
	let text = template.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (m, body) => {
		const lines = body.split(/\r?\n/);
		const out = [];
		let skipList = false;
		for (const line of lines) {
			if (skipList && /^\s+-/.test(line)) continue;
			skipList = false;
			const kv = /^([^:]+?):\s*(.*)$/.exec(line);
			const key = kv?.[1].trim();
			if (key && key in fm) {
				const v = fm[key];
				if (Array.isArray(v)) {
					out.push(`${key}:`);
					for (const item of v) out.push(`  - ${item}`);
					skipList = true;
				} else out.push(`${key}: ${v ?? ""}`);
				continue;
			}
			out.push(line);
		}
		return `---\n${out.join("\n")}\n---`;
	});

	const ingredients = (recipe.recipeIngredient ?? []).map((i) => `- ${ingredientText(i)}`).join("\n");
	const steps = (recipe.recipeInstructions ?? []).map((s, n) => `${n + 1}. ${s.text}`).join("\n");
	const notes = (recipe.notes ?? []).map((n) => `- **${n.title}**: ${n.text.replace(/\n/g, " ")}`).join("\n");
	text = text
		.replace(/## Ingredients\r?\n-\s*\r?\n?/, `## Ingredients\n${ingredients}\n`)
		.replace(/## Instructions\r?\n1\.\s*\r?\n?/, `## Instructions\n${steps}\n`)
		.replace(/## Notes\r?\n/, `## Notes\n${notes}${notes ? "\n" : ""}`)
		.replace(/## Image and Tagline\r?\n?/, `## Image and Tagline\n${recipe.description ?? ""}\n`);
	return text;
}

const trimNum = (n) => String(Number(n)).replace(/\.0+$/, "");
const minutes = (s) => (s ? `${Math.round(s / 60)} minutes` : "");
function ingredientText(i) {
	if (i.display) return i.display;
	if (i.food?.name) return [trimNum(i.quantity || ""), i.unit?.name, i.food.name, i.note].filter(Boolean).join(" ");
	return i.note ?? i.originalText ?? "";
}

// ── Commands ────────────────────────────────────────────────────────────
async function loadNotes(folder) {
	const files = (await readdir(folder)).filter((f) => f.endsWith(".md"));
	const notes = await Promise.all(files.map((f) => readNote(join(folder, f))));
	return notes.filter((n) => n.isRecipe);
}

async function push(folder) {
	const notes = await loadNotes(folder);
	console.log(`${notes.length} recipe note(s) in ${folder}`);
	if (config.dryRun) {
		await mkdir(config.outDir, { recursive: true });
		for (const n of notes) {
			const base = join(config.outDir, slugify(n.name));
			await writeFile(`${base}.jsonld.json`, JSON.stringify(noteToJsonLd(n), null, 2));
			await writeFile(`${base}.patch.json`, JSON.stringify(noteToPatch(n), null, 2));
			console.log(`  ${basename(n.path)} → ${base}.{jsonld,patch}.json`);
		}
		return;
	}

	const api = await Mealie.login(config.url);
	const me = await api.get("/users/self");
	console.log(`signed in as ${me.email} (group ${me.groupSlug ?? me.group}, household ${me.household})`);
	const byName = await api.recipesByName();

	for (const note of notes) {
		const d = note.data;
		const ld = noteToJsonLd(note);
		const organizers = {
			tools: await api.ensureTools(list(d.tools)),
			categories: await api.ensureCategories(list(d["recipe type"])),
			tags: await api.ensureTags(ld.keywords ? ld.keywords.split(", ") : []),
		};

		let existing = d["mealie id"] ? await api.recipe(d["mealie id"]) : null;
		existing ??= byName.get(note.name.toLowerCase()) ?? null;
		if (existing && config.replace) {
			await api.delete(`/recipes/${existing.slug}`);
			existing = null;
		}

		let slug;
		let action;
		if (existing) {
			// The note owns the recipe text; Mealie keeps what the note has no
			// section for (seed.mjs's "Printable card" note, other extras).
			const full = await api.recipe(existing.slug);
			const update = noteToUpdate(note, organizers);
			const ours = new Set((update.notes ?? []).map((n) => n.title));
			update.notes = [...(update.notes ?? []), ...(full.notes ?? []).filter((n) => !ours.has(n.title))];
			update.extras = { ...(full.extras ?? {}), ...(update.extras ?? {}) };
			if (config.parse) update.recipeIngredient = await api.parseIngredients(ld.recipeIngredient);
			await api.patch(`/recipes/${existing.slug}`, update);
			slug = existing.slug;
			action = "updated";
		} else {
			slug = await api.importJsonLd(ld);
			const patch = noteToPatch(note, organizers);
			if (config.parse) patch.recipeIngredient = await api.parseIngredients(ld.recipeIngredient);
			await api.patch(`/recipes/${slug}`, patch);
			action = "created";
		}

		const recipe = await api.recipe(slug);
		if (config.writeBack && d["mealie id"] !== recipe.id) {
			await writeFile(note.path, withMealieId(note.text, recipe.id));
			action += ", id written back";
		}
		console.log(`  ${action.padEnd(22)} ${slug}  (${basename(note.path)})`);
	}
}

async function pull(vault, folder) {
	const api = await Mealie.login(config.url);
	const template = await readFile(join(vault, config.template), "utf8");
	const notes = await loadNotes(folder);
	const known = new Set(notes.map((n) => n.data["mealie id"]).filter(Boolean));
	const knownNames = new Set(notes.map((n) => n.name.toLowerCase()));
	const page = await api.get("/recipes?perPage=-1");
	let created = 0;
	for (const summary of page.items ?? []) {
		if (known.has(summary.id) || knownNames.has(String(summary.name).toLowerCase())) continue;
		const recipe = await api.recipe(summary.slug);
		const file = join(folder, `${recipe.name.replace(/[\\/:*?"<>|]/g, "-")}.md`);
		if (config.dryRun) {
			console.log(`  would create ${basename(file)}`);
		} else {
			await writeFile(file, recipeToNote(recipe, template), { flag: "wx" });
			console.log(`  created ${basename(file)}`);
		}
		created++;
	}
	console.log(`${created} note(s) ${config.dryRun ? "would be " : ""}created in ${folder}`);
}

async function main() {
	if (!["push", "pull"].includes(command)) {
		console.error("usage: node obsidian.mjs <push|pull> [options]");
		process.exit(2);
	}
	const vault = await findVault();
	const folder = join(vault, config.folder);
	console.log(`vault: ${vault}`);
	if (command === "push") await push(folder);
	else await pull(vault, folder);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((e) => {
		console.error(e.message ?? e);
		process.exit(1);
	});
}
