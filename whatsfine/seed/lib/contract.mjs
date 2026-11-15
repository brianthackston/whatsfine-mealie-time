// The Obsidian ↔ Mealie contract: which fields the two sides share, how each
// reads from a note and from a Mealie recipe, and the three-way rule that
// decides which way a change flows. Pure functions; seed/obsidian.mjs does
// the reading and writing.
//
// Shared fields (the vault and Mealie both hold them; the side that changed
// since the last sync wins):
//
//   name           note `name:` / H1 / file name   ↔ name
//   description    Image and Tagline text           ↔ description
//   ingredients    ## Ingredients items             ↔ the lines as written (originalText while it agrees with Mealie's parse)
//   steps          ## Instructions items            ↔ recipeInstructions[].text ("Before you start: …" = a prep row)
//   notes          ## Notes items                   ↔ the Mealie note titled "Notes"
//   categories     recipe type                      ↔ recipeCategory
//   cuisine        cuisine                          ↔ tags, except WhatsFine and the kicker tags
//   whatsfine      whatsfine: true|false            ↔ the WhatsFine tag (publishes to whatsfine.com)
//   tools          tools                            ↔ tools
//   prepTime/cookTime/totalTime   prep/cook/total time   ↔ prep/perform/totalTimeSeconds
//   yield          yield                            ↔ recipeYield
//   servings       servings (first number)          ↔ recipeServings
//   source         source                           ↔ orgURL
//   status         status                           ↔ extras.obsidian_status
//   rating         ⭐                               ↔ the signed-in user's rating
//   recommendedBy  recommended by                   ↔ extras.recommended_by
//
// A note that lacks a field's key or section says nothing about it: Mealie's
// value is taken (and written in). An empty key or section means "none".
//
// Mealie only (never written from the vault, never pulled into it): id,
// slug, photos and assets, parsed quantities/units/foods (kept for every line
// that did not change), ingredient and step titles and links, the kicker tag,
// every note but "Notes" ("WhatsFine tip", "Printable card"…), and
// extras.whatsfine_* (article, product, video, grid). Vault only: Immediate
// Thoughts, Obsidian tags, base type, created, any other section, and inside
// the list sections anything that is not a top-level item.
//
// Each value is compared the way the note will read it back (one-line steps,
// normalized paragraphs, whole minutes), so what the sync writes into a note
// reads back equal and never bounces back as a change.
//
// The last agreed value of each field is remembered as a short hash in the
// Mealie recipe's extras.obsidian_sync. Timestamps can't do this job:
// Mealie's updatedAt moves on every write (the site's own bookkeeping
// included), and file times move whenever Obsidian Sync touches a note.

import { createHash } from "node:crypto";
import { bullets, first, hasKey, list, normText, setFrontmatter, setList, setTagline, splitNote, tagline, visible } from "./note.mjs";
import { durationSeconds } from "./mealie.mjs";

export const SOURCE_TAG = "WhatsFine";
/** Tags that pick the site's kicker chip: Mealie's to keep, not cuisines.
 *  The site's scripts/lib/mealie-map.mjs keeps the same list. */
export const KICKER_TAGS = new Set(["recipe", "technique"]);
export const SYNC_EXTRA = "obsidian_sync";

// ── Values ──────────────────────────────────────────────────────────────

export function stableJson(v) {
	if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
	if (v && typeof v === "object")
		return `{${Object.keys(v)
			.sort()
			.filter((k) => v[k] !== undefined)
			.map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`)
			.join(",")}}`;
	return JSON.stringify(v ?? null);
}
export const fingerprint = (v) => createHash("sha256").update(stableJson(v)).digest("hex").slice(0, 12);

const str = (v) => (v == null ? "" : String(v).trim());
const oneLine = (v) => str(v).replace(/\s+/g, " ");
const firstNumber = (v) => {
	const m = /(\d+(?:\.\d+)?)/.exec(str(v));
	return m ? Number(m[1]) : null;
};
/** ⭐ as a number: "4", 4, or "⭐⭐⭐⭐". */
const stars = (v) => {
	const s = str(first(v) ?? v);
	if (!s) return null;
	const n = firstNumber(s);
	if (n != null) return n;
	const count = [...s].filter((c) => c === "⭐").length;
	return count || null;
};
/** The vault holds whole minutes, so both sides compare that way. */
const minutes = (s) => (s > 0 ? Math.round(s / 60) * 60 : 0);
/** A vault time: "20 minutes", "1h30m", or a bare number of minutes. Text
 *  that is not a time says nothing (undefined), so Mealie's value stays. */
const seconds = (v) => {
	const t = str(v);
	if (!t) return 0;
	if (/^\d+(?:\.\d+)?$/.test(t)) return minutes(Number(t) * 60);
	const s = durationSeconds(t);
	return s === undefined ? undefined : minutes(s);
};
const commaList = (v) =>
	list(v)
		.flatMap((x) => x.split(/\s*,\s*/))
		.filter(Boolean)
		.join(", ");

/** Seconds → the vault's wording: "20 minutes", "1 hour 30 minutes". */
export function formatDuration(s) {
	if (!(s > 0)) return "";
	const h = Math.floor(s / 3600);
	const m = Math.round((s % 3600) / 60);
	return [h && `${h} hour${h === 1 ? "" : "s"}`, m && `${m} minute${m === 1 ? "" : "s"}`].filter(Boolean).join(" ");
}

// ── Ingredient lines (the same rule as the site's scripts/lib/mealie-map.mjs) ──

const FILLER = new Set(["a", "an", "and", "or", "of", "the", "to", "for", "with", "in", "on", "at", "into", "per", "as"]);
const words = (t) =>
	String(t ?? "")
		.toLowerCase()
		.split(/[^a-z]+/)
		.filter((w) => w && !FILLER.has(w));
function forms(w) {
	const f = new Set([w]);
	if (w.endsWith("ies") && w.length > 4) f.add(`${w.slice(0, -3)}y`);
	if (w.endsWith("es") && w.length > 3) f.add(w.slice(0, -2));
	if (w.endsWith("s") && w.length > 2) f.add(w.slice(0, -1));
	return f;
}
const sameStem = (a, b) => a === b || [...forms(a)].some((x) => forms(b).has(x));
const allIn = (needles, hay) => needles.every((n) => hay.some((h) => sameStem(n, h)));
const UNICODE_FRACTIONS = { "¼": 0.25, "½": 0.5, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125 };
export function leadingQuantity(line) {
	const m = /^(\d+(?:\.\d+)?(?![\d/]))?\s*(?:(\d+)\/(\d+)|([¼½¾⅓⅔⅛]))?/.exec(String(line).trim());
	if (!m || (!m[1] && !m[2] && !m[4])) return undefined;
	let n = m[1] ? Number(m[1]) : 0;
	if (m[2]) n += Number(m[2]) / Number(m[3]);
	if (m[4]) n += UNICODE_FRACTIONS[m[4]];
	return n;
}

// How cooks write units that Mealie's unit records may not list.
const UNIT_ALIASES = {
	tablespoon: ["t", "tb", "tbs", "tbl", "tbsp", "tblsp"],
	teaspoon: ["t", "ts", "tsp"],
	cup: ["c"],
	ounce: ["oz"],
	pound: ["lb", "lbs"],
	gram: ["g", "gr"],
	kilogram: ["kg", "kilo", "kilos"],
	milliliter: ["ml"],
	liter: ["l"],
	quart: ["qt"],
	pint: ["pt"],
	gallon: ["gal"],
};

/** The line as the cook wrote it (Mealie's originalText), while it still
 *  agrees with Mealie's parse; after an edit in Mealie's editor, which never
 *  rewrites originalText, the parse's display text. One line either way. */
export function ingredientLine(i) {
	const shown = oneLine(i.display ?? i.note);
	const original = oneLine(i.originalText);
	if (!original) return shown;
	const have = words(original);
	if (!allIn(words(i.food?.name), have) || !allIn(words(i.note), have)) return shown;
	if (i.unit) {
		const u = i.unit;
		const names = [u.name, u.pluralName, u.abbreviation, u.pluralAbbreviation, ...(u.aliases ?? []).map((a) => a?.name), ...(UNIT_ALIASES[String(u.name ?? "").toLowerCase()] ?? [])]
			.map(words)
			.filter((w) => w.length);
		if (names.length && !names.some((n) => allIn(n, have))) return shown;
	}
	const lead = leadingQuantity(original);
	const qty = i.quantity ?? 0;
	if (lead !== undefined && ((qty > 0 && Math.abs(lead - qty) > 0.01) || (!(qty > 0) && i.food))) return shown;
	return original;
}

/** Mealie's yield as one line: a phrase the cook typed, or quantity + unit. */
export function yieldText(r) {
	const text = oneLine(r.recipeYield);
	const qty = r.recipeYieldQuantity ?? 0;
	if (text && /\d/.test(text)) return text;
	if (text && qty > 0) return `${+qty.toFixed(2)} ${text}`;
	return text;
}

const tagNames = (r) => (r.tags ?? []).map((t) => str(t.name)).filter(Boolean);
const isReservedTag = (n) => n.toLowerCase() === SOURCE_TAG.toLowerCase() || KICKER_TAGS.has(n.toLowerCase());
export const isNotesNote = (n) => str(n.title).toLowerCase() === "notes";

/** A Mealie note's text as the vault's list items: every non-empty line,
 *  list marker or not, so prose typed in Mealie is never hidden from the
 *  vault (and never lost when the vault edits the list). */
function noteItems(text) {
	return visible(text)
		.split(/\r?\n/)
		.map((l) => oneLine(l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")))
		.filter(Boolean);
}
/** Step text the way the note reads it back: comments and embeds out, one line. */
const stepText = (s) => oneLine(visible(s?.text));

/** Categories, cuisines and tools are sets: order and case carry no meaning,
 *  so both sides compare (and the vault is written) sorted. */
const asSet = (xs) =>
	[...new Map(xs.map((x) => [x.toLowerCase(), x])).values()].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));

// Section and key presence: a note without them says nothing.
const sec = (n, name, read) => (name in n.sections ? read(n.sections[name]) : undefined);
const key = (n, k, read) => (hasKey(n.data, k) ? read(n.data[k]) : undefined);

// ── The fields ──────────────────────────────────────────────────────────
// note(n)    → the value as the vault holds it (undefined: the note does not
//              say, so Mealie's value is taken)
// mealie(r)  → the same value as Mealie holds it, read the way the note
//              would read it back
// fold       → compared without case (sets of names Mealie may capitalize)

export const FIELDS = [
	{ key: "name", note: (n) => n.name, mealie: (r) => oneLine(r.name) },
	{ key: "description", note: (n) => tagline(n.sections), mealie: (r) => normText(r.description) },
	{ key: "ingredients", note: (n) => sec(n, "ingredients", bullets), mealie: (r) => (r.recipeIngredient ?? []).map(ingredientLine).filter(Boolean) },
	{ key: "steps", note: (n) => sec(n, "instructions", bullets), mealie: (r) => (r.recipeInstructions ?? []).map(stepText).filter(Boolean) },
	{ key: "notes", note: (n) => sec(n, "notes", bullets), mealie: (r) => noteItems((r.notes ?? []).find(isNotesNote)?.text) },
	{ key: "categories", fold: true, note: (n) => key(n, "recipe type", (v) => asSet(list(v))), mealie: (r) => asSet((r.recipeCategory ?? []).map((c) => str(c.name)).filter(Boolean)) },
	{
		key: "cuisine",
		fold: true,
		note: (n) => key(n, "cuisine", (v) => asSet(list(v).filter((t) => !isReservedTag(t)))),
		mealie: (r) => asSet(tagNames(r).filter((t) => !isReservedTag(t))),
	},
	{
		key: "whatsfine",
		note: (n) => key(n, "whatsfine", (v) => (v == null || str(v) === "" ? undefined : /^(true|yes|1)$/i.test(str(v)))),
		mealie: (r) => tagNames(r).some((t) => t.toLowerCase() === SOURCE_TAG.toLowerCase()),
	},
	{ key: "tools", fold: true, note: (n) => key(n, "tools", (v) => asSet(list(v))), mealie: (r) => asSet((r.tools ?? []).map((t) => str(t.name)).filter(Boolean)) },
	{ key: "prepTime", note: (n) => key(n, "prep time", seconds), mealie: (r) => minutes(r.prepTimeSeconds) },
	{ key: "cookTime", note: (n) => key(n, "cook time", seconds), mealie: (r) => minutes(r.performTimeSeconds) },
	{ key: "totalTime", note: (n) => key(n, "total time", seconds), mealie: (r) => minutes(r.totalTimeSeconds) },
	{ key: "yield", note: (n) => key(n, "yield", oneLine), mealie: yieldText },
	{ key: "servings", note: (n) => key(n, "servings", firstNumber), mealie: (r) => (r.recipeServings > 0 ? r.recipeServings : null) },
	{ key: "source", note: (n) => key(n, "source", str), mealie: (r) => str(r.orgURL) },
	{ key: "status", note: (n) => key(n, "status", (v) => str(first(v))), mealie: (r) => str(r.extras?.obsidian_status) },
	{ key: "rating", note: (n) => key(n, "⭐", stars), mealie: (r) => (r.rating > 0 ? r.rating : null) },
	{ key: "recommendedBy", note: (n) => key(n, "recommended by", commaList), mealie: (r) => commaList(r.extras?.recommended_by) },
];
export const FIELD_KEYS = FIELDS.map((f) => f.key);

/** "Nothing" for a field: what a note that leaves it out means for a recipe
 *  the sync is still creating (Mealie's own placeholder text must not win). */
const EMPTY = { name: "", description: "", ingredients: [], steps: [], notes: [], categories: [], cuisine: [], whatsfine: false, tools: [], prepTime: 0, cookTime: 0, totalTime: 0, yield: "", servings: null, source: "", status: "", rating: null, recommendedBy: "" };
const isEmpty = (v) => v == null || v === "" || v === 0 || v === false || (Array.isArray(v) && v.length === 0);
const byKey = new Map(FIELDS.map((f) => [f.key, f]));

/** A field's fingerprint, folded where case carries no meaning. */
export function fp(field, value) {
	const f = byKey.get(field);
	return fingerprint(f?.fold && Array.isArray(value) ? value.map((x) => x.toLowerCase()) : value);
}

/** The sync's bookkeeping on a recipe: the agreed hashes, and whether the
 *  sync created the recipe and has not finished filling it in. */
export function readSync(r) {
	try {
		const raw = r.extras?.[SYNC_EXTRA];
		const v = typeof raw === "string" ? JSON.parse(raw) : raw;
		if (!v || typeof v !== "object") return null;
		return { fields: v.fields && typeof v.fields === "object" ? v.fields : {}, creating: v.creating === true };
	} catch {
		return null;
	}
}
export const readBase = (r) => {
	const s = readSync(r);
	return s && Object.keys(s.fields).length ? s.fields : null;
};

/**
 * The three-way rule, per field. V = the vault's value, M = Mealie's, B =
 * the hash both agreed on last time.
 *
 *   V says nothing            → pull (take Mealie's)
 *   V = M                     → in sync
 *   V changed, M did not      → push
 *   M changed, V did not      → pull
 *   both changed (or no base) → conflict, unless --prefer picks a side
 *
 * @returns {{key, action: "same"|"push"|"pull"|"conflict", vault, mealie, agreed?: string}[]}
 */
export function reconcile(note, recipe, base, { prefer, creating = false } = {}) {
	return FIELDS.map((f) => {
		let vault = note ? f.note(note) : undefined;
		if (vault === undefined && creating && f.key !== "whatsfine") vault = EMPTY[f.key];
		const mealie = f.mealie(recipe);
		const hm = fp(f.key, mealie);
		const hb = base?.[f.key];
		if (vault === undefined) return { key: f.key, action: isEmpty(mealie) ? "same" : "pull", vault, mealie, agreed: hm };
		const hv = fp(f.key, vault);
		if (hv === hm) return { key: f.key, action: "same", vault, mealie, agreed: hm };
		if (hb !== undefined && hv !== hb && hm === hb) return { key: f.key, action: "push", vault, mealie, agreed: hv };
		if (hb !== undefined && hm !== hb && hv === hb) return { key: f.key, action: "pull", vault, mealie, agreed: hm };
		if (prefer === "vault") return { key: f.key, action: "push", vault, mealie, agreed: hv };
		if (prefer === "mealie") return { key: f.key, action: "pull", vault, mealie, agreed: hm };
		return { key: f.key, action: "conflict", vault, mealie };
	});
}

/** For log lines and the conflict callout: one line, short. */
export function show(v) {
	const s = Array.isArray(v) ? (v.length ? v.join(" / ") : "(none)") : v === "" || v == null ? "(none)" : String(v);
	const one = s.replace(/\s+/g, " ");
	return one.length > 80 ? `${one.slice(0, 77)}…` : one;
}

// ── Mealie lists, merged rather than rebuilt ────────────────────────────

/**
 * The vault's ingredient lines against Mealie's ingredient objects. A line
 * that reads exactly as an existing ingredient keeps that object whole (its
 * parsed food and unit, a food fixed by hand, its reference id that steps
 * link to, its section title). A changed line takes over a leftover object
 * in order, keeping its title and reference id, and only its parse is new.
 * Rows with no text (a section title alone) stay where they were.
 * @returns {Array<{keep: object} | {parse: string, reuse?: object}>}
 */
export function mergeIngredients(existing, lines) {
	const rows = existing ?? [];
	const pool = rows.map((obj, at) => ({ obj, at, line: ingredientLine(obj), used: false })).filter((p) => p.line);
	const out = lines.map((line) => {
		const hit = pool.find((p) => !p.used && p.line === line);
		if (!hit) return { parse: line };
		hit.used = true;
		return { keep: hit.obj, at: hit.at };
	});
	const leftovers = pool.filter((p) => !p.used);
	for (const m of out) {
		if (m.keep) continue;
		const reuse = leftovers.shift();
		if (reuse) {
			m.reuse = reuse.obj;
			m.at = reuse.at;
		}
	}
	// Title-only rows go back in before the item that followed them.
	rows.forEach((obj, at) => {
		if (ingredientLine(obj) || !String(obj.title ?? "").trim()) return;
		const before = out.findIndex((m) => m.at !== undefined && m.at > at);
		out.splice(before < 0 ? out.length : before, 0, { keep: obj, at });
	});
	return out.map(({ at, ...m }) => m);
}

/**
 * The vault's steps against Mealie's step objects. A step with the same text
 * is kept whole; the rest reuse Mealie's leftover steps in order with their
 * text replaced (so a reworded step keeps its title, timer and ingredient
 * links); any more are new. Links to ingredients that no longer exist are
 * dropped.
 */
export function mergeSteps(existing, lines, liveReferenceIds) {
	const rows = existing ?? [];
	const pool = rows.map((obj, at) => ({ obj, at, text: stepText(obj), used: false })).filter((p) => p.text);
	const out = lines.map((text) => {
		const hit = pool.find((p) => !p.used && p.text === text);
		if (!hit) return null;
		hit.used = true;
		return { ...hit.obj, _at: hit.at };
	});
	const leftovers = pool.filter((p) => !p.used);
	for (let i = 0; i < out.length; i++) {
		if (out[i]) continue;
		const reuse = leftovers.shift();
		out[i] = reuse ? { ...reuse.obj, text: lines[i], _at: reuse.at } : { text: lines[i], title: "", summary: "", ingredientReferences: [] };
	}
	// A step the vault cannot see (an image alone, a comment) stays in place.
	rows.forEach((obj, at) => {
		if (stepText(obj)) return;
		const before = out.findIndex((m) => m._at !== undefined && m._at > at);
		out.splice(before < 0 ? out.length : before, 0, { ...obj, _at: at });
	});
	for (const m of out) delete m._at;
	const live = new Set(liveReferenceIds ?? []);
	return out.map((s) => ({
		...s,
		ingredientReferences: (s.ingredientReferences ?? []).filter((ref) => !ref.referenceId || live.has(ref.referenceId)),
	}));
}

// ── Writing a value into the note ───────────────────────────────────────

export function noteEdit(field, value) {
	switch (field) {
		case "name":
			return { frontmatter: "name", value };
		case "description":
			return { tagline: value };
		case "ingredients":
			return { list: "Ingredients", items: value };
		case "steps":
			return { list: "Instructions", items: value, numbered: true };
		case "notes":
			return { list: "Notes", items: value };
		case "categories":
			return { frontmatter: "recipe type", value };
		case "cuisine":
			return { frontmatter: "cuisine", value };
		case "whatsfine":
			return { frontmatter: "whatsfine", value: Boolean(value) };
		case "tools":
			return { frontmatter: "tools", value };
		case "prepTime":
			return { frontmatter: "prep time", value: formatDuration(value) };
		case "cookTime":
			return { frontmatter: "cook time", value: formatDuration(value) };
		case "totalTime":
			return { frontmatter: "total time", value: formatDuration(value) };
		case "yield":
			return { frontmatter: "yield", value };
		case "servings":
			return { frontmatter: "servings", value: value == null ? "" : String(value) };
		case "source":
			return { frontmatter: "source", value };
		case "status":
			return { frontmatter: "status", value: value ? [value] : [] };
		case "rating":
			return { frontmatter: "⭐", value: value == null ? "" : String(value) };
		case "recommendedBy":
			return { frontmatter: "recommended by", value: value ? value.split(/\s*,\s*/) : [] };
	}
	throw new Error(`no note edit for ${field}`);
}

/** Write values (Mealie's winners) into a note's text, field by field. */
export function applyValues(text, values) {
	let out = text;
	for (const [field, value] of Object.entries(values)) {
		const e = noteEdit(field, value);
		if (e.frontmatter) out = setFrontmatter(out, e.frontmatter, e.value);
		else {
			const { head, body } = splitNote(out);
			out = head + (e.list ? setList(body, e.list, e.items, { numbered: e.numbered }) : setTagline(body, e.tagline));
		}
	}
	return out;
}

/** The whatsfine.com article a source URL names, for extras.whatsfine_article. */
export function articleFromSource(source) {
	return /whatsfine\.com\/(?:articles|recipes)\/([^/?#\s]+)/i.exec(source ?? "")?.[1];
}
