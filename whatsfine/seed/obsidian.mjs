#!/usr/bin/env node
// Obsidian ↔ Mealie, both ways. Recipes are drafted as notes in the vault's
// recipe folder ("Recipe - BT" template) and kept in Mealie; this keeps the
// two in agreement, field by field, with a rule for who wins:
//
//   - each shared field (seed/lib/contract.mjs lists them) is compared three
//     ways: the vault's value, Mealie's, and the value both agreed on at the
//     last sync (a short hash per field, kept in the recipe's
//     extras.obsidian_sync). The side that changed wins; when both changed,
//     nothing is written for that field and the note gets a conflict callout.
//   - a note is edited in place: only the frontmatter keys and list items the
//     contract owns are rewritten ("Immediate Thoughts", embeds, comments,
//     sub-headings, Obsidian tags and any other section stay as they are),
//     and only when the bytes actually change.
//   - Mealie's lists are merged, not rebuilt: an unchanged ingredient keeps
//     its parsed food, unit and the reference steps link to; only new or
//     changed lines go through the parser.
//   - writes go note first, then Mealie, with the agreed hashes last: a run
//     that fails halfway leaves the next run to finish it, never to undo it.
//   - a note with no `mealie id` creates its recipe in Mealie; a Mealie
//     recipe no note knows (and never knew) gets a new note; a recipe
//     deleted in Mealie marks its note `status: Archived` and is never
//     re-created.
//   - a run with nothing to do writes nothing, to the vault or to Mealie, and
//     --dry-run writes nothing at all.
//
// Usage (Node 22+, no dependencies):
//   node obsidian.mjs sync [--dry-run] [options]
//
// Options:
//   --vault <path>       the vault; default: the vault Obsidian has open (%APPDATA%\obsidian\obsidian.json), or $OBSIDIAN_VAULT
//   --folder <name>      recipe folder inside the vault, read with its subfolders (default "010 - Recipes", or $OBSIDIAN_RECIPES)
//   --url <base>         Mealie base URL (default http://localhost:9925, or $MEALIE_URL); beats the token file's url
//   --token-file <path>  { "url", "token" } JSON (default whatsfine/mealie-local.json, gitignored)
//   --prefer vault|mealie  settle every conflict (and a first sync that disagrees) for one side
//   --skip <x>           leave one recipe out (note name, Mealie slug or id); repeatable
//   --no-create          don't create Mealie recipes for notes without a `mealie id`
//   --no-new-notes       don't create notes for Mealie recipes the vault lacks
//   --restore-notes      do write a note for a recipe whose note has gone missing from the vault
//   --allow-archive      archive notes even when many of their recipes are missing (a wrong Mealie looks like that)
//   --no-parse           send new ingredient lines as plain notes, not through Mealie's parser
//   --dry-run            say what would change; write nothing anywhere
//
// Auth: MEALIE_TOKEN, or the token file, or MEALIE_USER + MEALIE_PASSWORD.
// Exit code 1 on an error or an unresolved conflict, so a scheduled run is
// noticed.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Mealie, cli } from "./lib/mealie.mjs";
import {
	FIELDS,
	KICKER_TAGS,
	SOURCE_TAG,
	SYNC_EXTRA,
	applyValues,
	articleFromSource,
	fp,
	isNotesNote,
	mergeIngredients,
	mergeSteps,
	readBase,
	readSync,
	reconcile,
	show,
} from "./lib/contract.mjs";
import { duplicateSections, readNoteText, setFrontmatter, splitNote, withCallout } from "./lib/note.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const VALUED = ["--vault", "--folder", "--url", "--token-file", "--prefer", "--skip"];
const { flag, opt, all, positional } = cli(process.argv.slice(2), VALUED);
const command = positional[0] ?? "sync";
const config = {
	url: opt("--url", process.env.MEALIE_URL ?? "http://localhost:9925"),
	urlGiven: opt("--url") != null || Boolean(process.env.MEALIE_URL),
	vault: opt("--vault", process.env.OBSIDIAN_VAULT),
	folder: opt("--folder", process.env.OBSIDIAN_RECIPES ?? "010 - Recipes"),
	template: "Templates/Recipe - BT.md",
	tokenFile: resolve(opt("--token-file", join(here, "..", "mealie-local.json"))),
	prefer: opt("--prefer"),
	skip: new Set(all("--skip").map((s) => s.toLowerCase())),
	create: !flag("--no-create"),
	newNotes: !flag("--no-new-notes"),
	restoreNotes: flag("--restore-notes"),
	allowArchive: flag("--allow-archive"),
	parse: !flag("--no-parse"),
	dryRun: flag("--dry-run"),
};
const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local
const OWNED_SECTIONS = ["Ingredients", "Instructions", "Notes", "Image and Tagline"];

// ── Vault ───────────────────────────────────────────────────────────────
function findVault() {
	if (config.vault) return resolve(config.vault);
	const appData = process.env.APPDATA ?? join(process.env.HOME ?? "", "AppData/Roaming");
	try {
		const cfg = JSON.parse(readFileSync(join(appData, "obsidian", "obsidian.json"), "utf8"));
		const vaults = Object.values(cfg.vaults ?? {});
		const open = vaults.find((v) => v.open) ?? vaults[0];
		if (open?.path) return open.path;
	} catch {
		// fall through
	}
	throw new Error("No vault found: pass --vault <path> or set OBSIDIAN_VAULT.");
}

/** Recipe notes in the folder and its subfolders (an "Archive" subfolder is
 *  still the vault knowing the recipe). */
function loadNotes(folder) {
	const out = [];
	const walk = (dir) => {
		for (const f of readdirSync(dir)) {
			if (f.startsWith(".")) continue;
			const p = join(dir, f);
			if (statSync(p).isDirectory()) walk(p);
			else if (f.endsWith(".md")) out.push({ path: p, ...readNoteText(readFileSync(p, "utf8"), f) });
		}
	};
	walk(folder);
	return out.filter((n) => n.isRecipe);
}

/** Write a note only when its bytes change, through a temp file, so a
 *  crash or Obsidian Sync never sees half a note. */
function writeNote(path, text, { create = false } = {}) {
	if (!create && existsSync(path) && readFileSync(path, "utf8") === text) return false;
	if (config.dryRun) return true;
	const tmp = `${path}.sync-tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
	return true;
}

// ── Mealie writes ───────────────────────────────────────────────────────
/** The PATCH body for the fields the vault won, and the extras to merge.
 *  In a dry run nothing is looked up or created, so the body is a sketch. */
async function patchFor(api, recipe, pushed, { isNew = false } = {}) {
	const p = {};
	const extras = {};
	const v = (k) => pushed[k];
	const has = (k) => k in pushed;
	const dry = config.dryRun;
	if (has("name")) p.name = v("name");
	if (has("description")) p.description = v("description");

	let ingredients = recipe.recipeIngredient ?? [];
	if (has("ingredients")) {
		const merged = mergeIngredients(ingredients, v("ingredients"));
		const fresh = merged.filter((m) => m.parse).map((m) => m.parse);
		const parsed =
			dry || !fresh.length ? [] : config.parse ? await api.parseIngredients(fresh) : fresh.map((line) => ({ note: line, originalText: line }));
		// A new line gets its own reference id: Mealie stores a row sent
		// without one as null and invents a fresh id on every read, so a step
		// could never stay linked to it.
		let k = 0;
		ingredients = merged.map((m) => {
			if (m.keep) return m.keep;
			if (dry) return { note: m.parse, originalText: m.parse };
			// A changed line keeps the old row's title and reference id (steps
			// link to it); only the parse is new.
			return { ...parsed[k++], title: m.reuse?.title ?? "", referenceId: m.reuse?.referenceId ?? randomUUID() };
		});
		p.recipeIngredient = ingredients;
	}
	const live = ingredients.map((i) => i.referenceId).filter(Boolean);
	if (has("steps")) p.recipeInstructions = mergeSteps(recipe.recipeInstructions, v("steps"), live);
	else if (has("ingredients")) {
		// Same steps, but none may point at an ingredient that is gone.
		const same = (recipe.recipeInstructions ?? []).map((s) => String(s.text ?? "").replace(/\s+/g, " ").trim());
		const cleaned = mergeSteps(recipe.recipeInstructions, same, live);
		const before = (recipe.recipeInstructions ?? []).flatMap((s) => s.ingredientReferences ?? []).length;
		if (cleaned.flatMap((s) => s.ingredientReferences).length !== before) p.recipeInstructions = cleaned;
	}
	if (has("notes")) {
		// Only the first note titled "Notes" is the vault's; others stay.
		const notes = [...(recipe.notes ?? [])];
		const at = notes.findIndex(isNotesNote);
		const text = v("notes").map((l) => `- ${l}`).join("\n");
		const mine = v("notes").length ? { ...(at >= 0 ? notes[at] : {}), title: at >= 0 ? notes[at].title : "Notes", text } : null;
		if (at >= 0) notes.splice(at, 1, ...(mine ? [mine] : []));
		else if (mine) notes.push(mine);
		p.notes = notes;
	}
	const organizers = (kind, names) => (dry ? names.map((name) => ({ name })) : api.ensureOrganizers(kind, names, { repair: [SOURCE_TAG] }));
	if (has("categories")) p.recipeCategory = await organizers("categories", v("categories"));
	if (has("tools")) p.tools = await organizers("tools", v("tools"));
	if (has("cuisine") || has("whatsfine") || isNew) {
		// Tags carry three things: the kicker (Mealie's), WhatsFine (the
		// publish flag) and the cuisines (the vault's). Rebuild all three.
		const current = (recipe.tags ?? []).map((t) => t.name);
		const kickers = current.filter((t) => KICKER_TAGS.has(t.toLowerCase()));
		if (!kickers.length && isNew) kickers.push("Recipe");
		const on = has("whatsfine") ? v("whatsfine") : current.some((t) => t.toLowerCase() === SOURCE_TAG.toLowerCase());
		const cuisine = has("cuisine") ? v("cuisine") : current.filter((t) => !KICKER_TAGS.has(t.toLowerCase()) && t.toLowerCase() !== SOURCE_TAG.toLowerCase());
		p.tags = await organizers("tags", [...(on ? [SOURCE_TAG] : []), ...kickers, ...cuisine]);
	}
	if (has("prepTime")) p.prepTimeSeconds = v("prepTime") || null;
	if (has("cookTime")) p.performTimeSeconds = v("cookTime") || null;
	if (has("totalTime")) {
		p.totalTimeSeconds = v("totalTime") || null;
		if (!v("totalTime")) p.totalTime = null;
	}
	if (has("yield")) {
		// The phrase is the yield; a stale quantity from an import would make
		// the site print "Makes 12 Makes 12".
		p.recipeYield = v("yield");
		p.recipeYieldQuantity = 0;
	}
	if (has("servings")) p.recipeServings = v("servings") ?? 0;
	if (has("source")) {
		p.orgURL = v("source") || null;
		const article = articleFromSource(v("source"));
		if (article && !recipe.extras?.whatsfine_article) extras.whatsfine_article = article;
	}
	if (has("status")) extras.obsidian_status = v("status");
	if (has("recommendedBy")) extras.recommended_by = v("recommendedBy");
	return { patch: p, extras };
}

const syncExtra = (fields) => JSON.stringify({ v: 1, fields });

// ── One note ↔ one recipe ───────────────────────────────────────────────
const report = { pushed: 0, pulled: 0, inSync: 0, created: 0, newNotes: 0, archived: 0, conflicts: 0, errors: 0 };
const say = (name, msg) => console.log(`  ${name.padEnd(32)} ${msg}`);
let self;
const me = async (api) => (self ??= await api.get("/users/self"));
let myRatings;
/** The signed-in user's own rating of a recipe. A recipe's `rating` is the
 *  average over every user, so ⭐ (one person's) is read from here. */
async function ownRating(api, recipeId) {
	if (!myRatings) {
		const res = await api.get("/users/self/ratings");
		myRatings = new Map((res.ratings ?? []).map((x) => [x.recipeId, x.rating]));
	}
	const r = myRatings.get(recipeId);
	return r > 0 ? r : null;
}

async function syncPair(api, note, recipe, { creatingNote = false } = {}) {
	const dup = duplicateSections(note.body, OWNED_SECTIONS);
	if (dup.length) throw new Error(`the note has more than one "## ${dup.join('", "## ')}" section; merge them before it can sync`);

	recipe = { ...recipe, rating: await ownRating(api, recipe.id) };
	const meta = readSync(recipe);
	// Being created: marked so in Mealie, or (if the run that created it died
	// before it could mark it) the note says `mealie id: creating`.
	const isNew = meta?.creating === true || (creatingNote && !meta);
	// A new recipe drafted from a whatsfine.com article is meant for the site,
	// unless the note says otherwise; the note is told so too.
	const defaults = {};
	if (isNew && note.data.whatsfine == null && articleFromSource(note.data.source)) {
		note = { ...note, data: { ...note.data, whatsfine: "true" } };
		defaults.whatsfine = true;
	}
	const base = isNew ? null : readBase(recipe);
	const decisions = reconcile(note, recipe, base, { prefer: isNew ? "vault" : config.prefer, creating: isNew });
	const pushed = {};
	const pulled = {};
	const conflicts = [];
	const nextBase = { ...(base ?? {}) };
	for (const d of decisions) {
		if (d.action === "push") pushed[d.key] = d.vault;
		if (d.action === "pull") pulled[d.key] = d.mealie;
		if (d.action === "conflict") conflicts.push({ field: d.key, vault: show(d.vault), mealie: show(d.mealie) });
		else nextBase[d.key] = d.agreed;
	}
	const fileName = basename(note.path);
	const { patch, extras } = await patchFor(api, recipe, pushed, { isNew });

	// 1. The note: Mealie's winners, the id, the conflict callout.
	let text = applyValues(note.text, { ...pulled, ...defaults });
	if (String(note.data["mealie id"] ?? "") !== recipe.id) text = setFrontmatter(text, "mealie id", recipe.id);
	{
		const { head, body } = splitNote(text);
		text = head + withCallout(body, today, conflicts);
	}
	writeNote(note.path, text);

	// 2. The rating: Mealie keeps ratings per user (a recipe PATCH ignores
	// `rating`; a recipe reads back with the signed-in user's own), so ⭐ is
	// that user's rating, 0 clearing it. Only the rating is sent, so a
	// favorite marked in Mealie stays.
	if ("rating" in pushed && !config.dryRun) {
		await api.post(`/users/${(await me(api)).id}/ratings/${recipe.id}`, { rating: pushed.rating ?? 0 });
		myRatings?.set(recipe.id, pushed.rating ?? 0);
	}

	// 3. Mealie: the vault's winners, with the agreed hashes last of all.
	const baseChanged = fp("_", nextBase) !== fp("_", base ?? {});
	const bookkeeping = baseChanged || isNew || recipe.extras?.obsidian_note !== fileName || Object.keys(extras).length > 0;
	let after = recipe;
	if (Object.keys(patch).length || bookkeeping) {
		patch.extras = { ...(recipe.extras ?? {}), ...extras, obsidian_note: fileName, [SYNC_EXTRA]: syncExtra(nextBase) };
		if (!config.dryRun) after = await api.patch(`/recipes/${recipe.slug}`, patch);
	}

	// 4. Whatever Mealie stored differently from what was sent (a unit it
	// spells its own way, a name it trims) comes back into the note now and
	// is what both agree on, so the next run has nothing to do.
	const normalized = {};
	if (!config.dryRun && Object.keys(pushed).length) {
		// Read it back fresh (a PATCH answer carries the all-users rating
		// and may leave fields out). The rating is posted on its own and is
		// per user, so it is not compared here.
		after = await api.recipe(recipe.id);
		for (const f of FIELDS) {
			if (!(f.key in pushed) || f.key === "rating") continue;
			const stored = f.mealie(after);
			if (fp(f.key, stored) !== fp(f.key, pushed[f.key])) normalized[f.key] = stored;
		}
		if (Object.keys(normalized).length) {
			writeNote(note.path, applyValues(text, normalized));
			for (const [k, val] of Object.entries(normalized)) nextBase[k] = fp(k, val);
			await api.patch(`/recipes/${after.slug}`, { extras: { ...(after.extras ?? recipe.extras ?? {}), [SYNC_EXTRA]: syncExtra(nextBase) } });
		}
	}

	const parts = [];
	if (Object.keys(pushed).length) parts.push(`→ Mealie: ${Object.keys(pushed).join(", ")}`);
	if (Object.keys(pulled).length) parts.push(`→ vault: ${Object.keys(pulled).join(", ")}`);
	if (Object.keys(normalized).length) parts.push(`(Mealie's spelling kept: ${Object.keys(normalized).join(", ")})`);
	if (conflicts.length) parts.push(`CONFLICT: ${conflicts.map((c) => c.field).join(", ")}`);
	if (!parts.length) parts.push(baseChanged ? "in sync (first sync recorded)" : "in sync");
	say(note.name, `${config.dryRun ? "[dry] " : ""}${parts.join("; ")}`);
	for (const c of conflicts) console.log(`      ${c.field}: vault ${c.vault} · Mealie ${c.mealie}`);
	if (Object.keys(pushed).length) report.pushed++;
	if (Object.keys(pulled).length) report.pulled++;
	if (!Object.keys(pushed).length && !Object.keys(pulled).length && !conflicts.length) report.inSync++;
	if (conflicts.length) report.conflicts++;
}

// ── The run ─────────────────────────────────────────────────────────────
async function sync(vault, folder) {
	const notes = loadNotes(folder);
	const api = await Mealie.login(config.url, { tokenFile: config.tokenFile, baseWins: config.urlGiven });
	const summaries = (await api.get("/recipes?perPage=-1")).items ?? [];
	const skipped = (...keys) => keys.some((k) => k && config.skip.has(String(k).toLowerCase()));
	console.log(`${notes.length} recipe note(s) in ${folder}; ${summaries.length} recipe(s) in Mealie (${api.base})${config.dryRun ? "  [dry run]" : ""}`);

	// Pair notes with recipes: by `mealie id`, then (for a note with none) by name.
	const byId = new Map(summaries.map((s) => [s.id, s]));
	const byName = new Map(summaries.map((s) => [String(s.name).toLowerCase(), s]));
	const idCount = new Map();
	const idOf = (n) => {
		const id = String(n.data["mealie id"] ?? "").trim();
		return id === "creating" ? "" : id;
	};
	for (const n of notes) {
		const id = idOf(n);
		if (id) idCount.set(id, (idCount.get(id) ?? 0) + 1);
	}
	const claimed = new Set();
	const pairs = [];
	const fresh = [];
	for (const n of notes) {
		const id = idOf(n);
		// A skipped note still claims its recipe (by id, or by name for a note
		// without one): skipping means "leave this pair alone", not "this
		// recipe has no note".
		const rel = relative(folder, n.path).replace(/\\/g, "/");
		if (skipped(n.name, id, rel, rel.replace(/\.md$/i, ""), n.fileName, n.fileName.replace(/\.md$/i, ""))) {
			if (id) claimed.add(id);
			else if (byName.has(n.name.toLowerCase())) claimed.add(byName.get(n.name.toLowerCase()).id);
			continue;
		}
		if (id) claimed.add(id);
		if (id && idCount.get(id) > 1) {
			say(n.name, `ERROR: ${idCount.get(id)} notes share mealie id ${id}; give one of them another id or none`);
			report.errors++;
			continue;
		}
		if (id) {
			pairs.push({ note: n, id, gone: !byId.has(id) });
			continue;
		}
		const match = byName.get(n.name.toLowerCase());
		const creatingNote = String(n.data["mealie id"] ?? "").trim() === "creating";
		if (match && !claimed.has(match.id) && !idCount.has(match.id)) {
			claimed.add(match.id);
			pairs.push({ note: n, id: match.id, linked: true, creatingNote });
		} else fresh.push(n);
	}

	// Recipes the vault's ids point at but Mealie does not have. A few is a
	// deletion; most of them means the wrong Mealie (another instance, or a
	// token for another group), and archiving would be wrong.
	// A note already marked Archived is settled and does not count.
	const isArchived = (n) => /archived/i.test(String(n.data.status ?? ""));
	const gone = [];
	for (const p of pairs.filter((x) => x.gone)) {
		if (await api.recipe(p.id)) p.gone = false;
		else if (!isArchived(p.note)) gone.push(p);
	}
	const withIds = pairs.filter((p) => !p.linked && !(p.gone && isArchived(p.note))).length;
	// Most of the vault's recipes missing, or every one of them: that is not
	// deletions, it is the wrong Mealie (another instance, a token for
	// another group). Writing anything there would be wrong, so stop.
	const suspicious = gone.length > 0 && (gone.length === withIds || (gone.length > 1 && gone.length * 2 >= withIds));
	if (suspicious && !config.allowArchive) {
		console.error(
			`  ! ${gone.length} of ${withIds} notes point at recipes ${api.base} does not have: the wrong Mealie? Nothing written (pass --allow-archive if they really were deleted).`,
		);
		report.errors++;
		return 1;
	}

	for (const p of pairs) {
		try {
			if (p.gone) {
				// Deleted in Mealie: the note says so (its other statuses kept),
				// and nothing is re-created.
				if (isArchived(p.note)) continue;
				const statuses = (Array.isArray(p.note.data.status) ? p.note.data.status : [p.note.data.status]).filter(Boolean);
				writeNote(p.note.path, setFrontmatter(p.note.text, "status", [...statuses, "Archived"]));
				report.archived++;
				say(p.note.name, `${config.dryRun ? "[dry] " : ""}deleted in Mealie: note marked Archived, not re-created`);
				continue;
			}
			const recipe = await api.recipe(p.id);
			if (skipped(recipe.slug)) continue;
			if (p.linked) say(p.note.name, `linked by name to Mealie recipe ${recipe.slug}`);
			await syncPair(api, p.note, recipe, { creatingNote: p.creatingNote });
		} catch (e) {
			report.errors++;
			say(p.note.name, `ERROR: ${e.message}`);
		}
	}

	// Notes with no recipe yet: create it in Mealie, the vault's version wins.
	// The recipe is marked as being created and the note gets its id first,
	// so a run that fails halfway is finished, not misread, by the next one.
	for (const n of fresh) {
		if (!config.create) {
			say(n.name, "no Mealie recipe (left alone: --no-create)");
			continue;
		}
		try {
			if (config.dryRun) {
				say(n.name, "[dry] would create the recipe in Mealie");
				report.created++;
				continue;
			}
			// The note says "creating" before the recipe exists, so a run that
			// dies between the two leaves a trail the next run follows.
			writeNote(n.path, setFrontmatter(n.text, "mealie id", "creating"));
			const slug = await api.post("/recipes", { name: n.name });
			let recipe = await api.recipe(slug);
			recipe = await api.patch(`/recipes/${slug}`, {
				extras: { ...(recipe.extras ?? {}), obsidian_note: basename(n.path), [SYNC_EXTRA]: JSON.stringify({ v: 1, creating: true, fields: {} }) },
			});
			const text = setFrontmatter(n.text, "mealie id", recipe.id);
			writeNote(n.path, text);
			say(n.name, `created in Mealie as ${slug}`);
			report.created++;
			await syncPair(api, { ...readNoteText(text, n.fileName), path: n.path }, recipe);
		} catch (e) {
			report.errors++;
			say(n.name, `ERROR: ${e.message}`);
		}
	}

	// Recipes no note knows: write a note for each, Mealie's version. One whose
	// note existed (extras.obsidian_note) but is not in the folder any more is
	// reported instead: re-creating it would undo a delete or a move.
	let template;
	for (const s of summaries) {
		if (claimed.has(s.id) || skipped(s.slug, s.id, s.name) || !config.newNotes) continue;
		try {
			const recipe = await api.recipe(s.slug);
			const had = recipe.extras?.obsidian_note;
			if (had && !config.restoreNotes) {
				say(recipe.name, `note "${had}" is not in ${basename(folder)} (moved out, renamed or deleted?); not re-created (--restore-notes writes it again)`);
				continue;
			}
			template ??= readFileSync(join(vault, config.template), "utf8");
			const path = join(folder, `${recipe.name.replace(/[\\/:*?"<>|#^[\]]/g, "-").trim()}.md`);
			if (existsSync(path)) {
				say(recipe.name, `ERROR: ${basename(path)} exists but is not linked to ${recipe.slug}; set its mealie id`);
				report.errors++;
				continue;
			}
			const values = Object.fromEntries(FIELDS.map((f) => [f.key, f.mealie(recipe)]));
			let text = applyValues(setFrontmatter(template, "created", today), values);
			text = setFrontmatter(text, "mealie id", recipe.id);
			writeNote(path, text, { create: true });
			if (!config.dryRun) {
				const fields = Object.fromEntries(FIELDS.map((f) => [f.key, fp(f.key, f.mealie(recipe))]));
				await api.patch(`/recipes/${recipe.slug}`, { extras: { ...(recipe.extras ?? {}), obsidian_note: basename(path), [SYNC_EXTRA]: syncExtra(fields) } });
			}
			say(recipe.name, `${config.dryRun ? "[dry] would write" : "wrote"} a new note, ${basename(path)}`);
			report.newNotes++;
		} catch (e) {
			report.errors++;
			say(s.name, `ERROR: ${e.message}`);
		}
	}

	const r = report;
	console.log(
		`done${config.dryRun ? " (dry run)" : ""}: ${r.inSync} in sync, ${r.pushed} to Mealie, ${r.pulled} to the vault, ${r.created} created in Mealie, ${r.newNotes} new note(s), ${r.archived} archived, ${r.conflicts} conflict(s), ${r.errors} error(s)`,
	);
	return r.errors || r.conflicts ? 1 : 0;
}

/** One run at a time: a scheduled sync must not overlap a manual one. The
 *  lock records its process and start; a lock whose process is gone, or that
 *  is over an hour old, was left by a crash and is taken over. */
async function withLock(fn) {
	const lock = join(tmpdir(), "whatsfine-obsidian-sync.lock");
	const alive = (pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch (e) {
			return e.code === "EPERM";
		}
	};
	if (existsSync(lock)) {
		let held = null;
		try {
			held = JSON.parse(readFileSync(lock, "utf8"));
		} catch {
			// unreadable (or the old directory lock): stale
		}
		const live = held && Date.now() - Date.parse(held.at) < 60 * 60 * 1000 && alive(held.pid);
		if (live) {
			console.error(`Another sync is running (pid ${held.pid}, since ${held.at}).`);
			return 1;
		}
		// Take the stale lock over by renaming it away: only one run's rename
		// can succeed, so two runs cannot both take it.
		const away = `${lock}.stale-${process.pid}`;
		try {
			renameSync(lock, away);
		} catch {
			console.error("Another sync took the lock just now.");
			return 1;
		}
		rmSync(away, { recursive: true, force: true });
	}
	try {
		writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: "wx" });
	} catch {
		console.error("Another sync started at the same moment.");
		return 1;
	}
	const release = () => rmSync(lock, { force: true });
	const onSignal = (sig) => {
		release();
		process.exit(sig === "SIGINT" ? 130 : 143);
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	try {
		return await fn();
	} finally {
		release();
	}
}

async function main() {
	if (command === "push" || command === "pull") {
		console.error(`"${command}" is now "sync": one command that goes both ways. See the header of seed/obsidian.mjs.`);
		return 2;
	}
	if (command !== "sync") {
		console.error("usage: node obsidian.mjs sync [--dry-run] [options]");
		return 2;
	}
	if (config.prefer && !["vault", "mealie"].includes(config.prefer)) {
		console.error("--prefer takes vault or mealie");
		return 2;
	}
	const vault = findVault();
	const folder = join(vault, config.folder);
	console.log(`vault: ${vault}`);
	return withLock(() => sync(vault, folder));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().then(
		(code) => (process.exitCode = code),
		(e) => {
			console.error(e.message ?? e);
			process.exitCode = 1;
		},
	);
}
