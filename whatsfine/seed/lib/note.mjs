// Reading and editing the vault's recipe notes ("Recipe - BT" template),
// without disturbing anything the sync does not own. Pure functions: no
// filesystem, no network. Used by seed/obsidian.mjs.
//
//   ---
//   base type: [Recipe]  recipe type: [..]  status: [..]  ⭐:  recommended by:
//   source:  yield:  servings:  prep time:  cook time:  total time:
//   cuisine: [..]  tools: [..]  whatsfine: true  name:  mealie id:
//   ---
//   ## Immediate Thoughts     never leaves the vault
//   ## Ingredients            - one per line
//   ## Instructions           1. one per line ("Before you start: …" = a prep row)
//   ## Notes                  - bullets
//   ## Image and Tagline      embeds kept; the rest of the section is the tagline
//
// Inside the list sections only top-level list items are recipe data. A
// sub-heading, an embed, a %% comment %% or a nested item stays in the
// vault, and stays where it is when the sync rewrites the items; an indented
// line with no list marker continues the item above it.

// ── Frontmatter ─────────────────────────────────────────────────────────

const FM = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** A deliberately small YAML reader for the template: scalars (plain,
 *  "double-quoted" with JSON escapes, 'single-quoted' with '' for '), block
 *  lists (`- item`), inline lists (`[a, b]`), empty values. Keys may contain
 *  spaces and emoji (the template has a ⭐ property). */
export function parseFrontmatter(text) {
	const m = FM.exec(text);
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
		const kv = /^([^:\s][^:]*?):\s*(.*)$/.exec(line);
		if (!kv) continue;
		key = kv[1].trim();
		const v = kv[2].trim();
		if (v === "") data[key] = null;
		else if (v.startsWith("[") && v.endsWith("]"))
			data[key] = v
				.slice(1, -1)
				.split(",")
				.map((s) => unquote(s.trim()))
				.filter(Boolean);
		else data[key] = unquote(v);
	}
	return { data, body: text.slice(m[0].length), raw: m[0] };
}

function unquote(s) {
	if (/^".*"$/.test(s)) {
		try {
			return JSON.parse(s);
		} catch {
			return s.slice(1, -1);
		}
	}
	if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
	return s;
}
export const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean);
export const first = (v) => list(v)[0] ?? null;

/** A YAML scalar that reads back as itself ("Serves 4–6", a URL, a name
 *  with quotes or a colon). Booleans and numbers are written bare. */
function scalar(v) {
	if (v == null || v === "") return "";
	if (typeof v === "boolean" || typeof v === "number") return String(v);
	const s = String(v);
	return /^[\s"'[{>|*&!%@`#,?-]|[:#]\s|\s#|\s$|["\\]|^(?:true|false|null|~|yes|no)$/i.test(s) ? JSON.stringify(s) : s;
}

/** Set one frontmatter key in place, keeping every other line, its order and
 *  its formatting. A list is written as a block list; null/"" leaves the key
 *  present but empty (the template's convention). A missing key is added at
 *  the end. */
export function setFrontmatter(text, key, value) {
	const m = FM.exec(text);
	if (!m) return text;
	const lines = m[1].split(/\r?\n/);
	const render = Array.isArray(value)
		? [`${key}:`, ...value.map((v) => `  - ${scalar(v)}`)]
		: [value == null || value === "" ? `${key}:` : `${key}: ${scalar(value)}`];
	const out = [];
	let done = false;
	for (let i = 0; i < lines.length; i++) {
		const kv = /^([^:\s][^:]*?):\s*(.*)$/.exec(lines[i]);
		if (kv && kv[1].trim() === key && !done) {
			while (i + 1 < lines.length && /^\s+-/.test(lines[i + 1])) i++;
			out.push(...render);
			done = true;
			continue;
		}
		out.push(lines[i]);
	}
	if (!done) out.push(...render);
	return text.replace(FM, (whole) => `---\n${out.join("\n")}\n---${whole.endsWith("\n") ? "\n" : ""}`);
}

export const hasKey = (data, key) => Object.prototype.hasOwnProperty.call(data, key);

// ── Body sections ───────────────────────────────────────────────────────

const HEADING = /^##\s+(.+?)\s*$/;

/** `## Heading` sections → { "heading": text } (lower-cased keys); text
 *  before the first heading is under "". A repeated heading's text is
 *  joined (and duplicateSections() reports it). */
export function parseSections(body) {
	const sections = {};
	let current = "";
	for (const line of body.split(/\r?\n/)) {
		const h = HEADING.exec(line);
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

/** Headings (of those named) that occur more than once in the body. */
export function duplicateSections(body, names) {
	const want = new Set(names.map((n) => n.toLowerCase()));
	const seen = new Map();
	for (const line of body.split(/\r?\n/)) {
		const h = HEADING.exec(line)?.[1]?.toLowerCase();
		if (h && want.has(h)) seen.set(h, (seen.get(h) ?? 0) + 1);
	}
	return [...seen].filter(([, n]) => n > 1).map(([h]) => h);
}

const ITEM = /^(?:[-*+]|\d+[.)])\s+(.*)$/;
const COMMENT_ONLY = /^%%[\s\S]*%%$/;
const EMBED_ONLY = /^!\[\[.*?\]\]$|^!\[[^\]]*\]\([^)]*\)$/;
const EMBED_TOKEN = /!\[\[.*?\]\]|!\[[^\]]*\]\([^)]*\)/g;

/** Text with Obsidian-only parts taken out: %% comments %% (also across
 *  lines) and image embeds. Both sides read their text through this, so an
 *  embed or a comment is never recipe data, and never a difference. */
export function visible(text) {
	return String(text ?? "")
		.replace(/%%[\s\S]*?%%/g, "")
		.replace(EMBED_TOKEN, "");
}

/** The recipe data in a list section: each top-level item's text, with
 *  indented plain continuation lines joined on. Nested items, sub-headings,
 *  embeds, %% comments %% and loose text are left out. */
export function bullets(text) {
	const items = [];
	let open = false;
	for (const raw of visibleLines(text)) {
		const top = ITEM.exec(raw.line);
		if (top) {
			const t = raw.clean.replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/\s+/g, " ").trim();
			if (t) {
				items.push(t);
				open = true;
			} else open = false;
			continue;
		}
		const cont = raw.clean.trim();
		if (open && /^\s+\S/.test(raw.line) && !ITEM.test(raw.line.trim()) && cont) {
			items[items.length - 1] = `${items[items.length - 1]} ${cont.replace(/\s+/g, " ")}`;
			continue;
		}
		if (cont || !/^\s/.test(raw.line)) open = false;
	}
	return items;
}

/** Each line with its visible text (comments and embeds out); a line wholly
 *  inside a %% block has none. */
function visibleLines(text) {
	const out = [];
	let inComment = false;
	for (const line of String(text ?? "").split(/\r?\n/)) {
		let clean = "";
		let rest = line;
		while (rest.length) {
			if (inComment) {
				const end = rest.indexOf("%%");
				if (end < 0) {
					rest = "";
					break;
				}
				rest = rest.slice(end + 2);
				inComment = false;
			} else {
				const start = rest.indexOf("%%");
				if (start < 0) {
					clean += rest;
					break;
				}
				clean += rest.slice(0, start);
				rest = rest.slice(start + 2);
				inComment = true;
			}
		}
		out.push({ line, clean: clean.replace(EMBED_TOKEN, "") });
	}
	return out;
}

/** The lines of one section: [start, end) of its body, or null. */
function sectionRange(lines, heading) {
	const re = new RegExp(`^##\\s+${escapeRe(heading)}\\s*$`, "i");
	const start = lines.findIndex((l) => re.test(l));
	if (start < 0) return null;
	let end = lines.findIndex((l, i) => i > start && HEADING.test(l));
	if (end < 0) end = lines.length;
	return { start, end };
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function appendSection(body, heading, content) {
	return `${body.replace(/\s*$/, "")}\n\n## ${heading}\n${content ? `${content}\n` : ""}`;
}

/**
 * Rewrite the list items of `## heading` to `items` (in that order), keeping
 * everything else in the section where it is. An old item whose text is a
 * new item keeps its place and its nested children; a new item that was
 * not there goes in just before the next kept one (so it lands beside its
 * neighbours, not under another sub-heading); an old item that changed is
 * edited in place; an old item that went is removed with its children.
 * `numbered` writes "1." … instead of "-".
 */
export function setList(body, heading, items, { numbered = false } = {}) {
	const lines = body.split(/\r?\n/);
	const r = sectionRange(lines, heading);
	if (!r) return items.length ? appendSection(body, heading, items.map((t, i) => `${numbered ? `${i + 1}.` : "-"} ${t}`).join("\n")) : body;
	// The section as entries: item blocks (an item and its indented lines)
	// and everything else, line by line.
	const entries = [];
	const vis = visibleLines(lines.slice(r.start + 1, r.end).join("\n"));
	for (const { line, clean } of vis) {
		const isItem = ITEM.test(line) && clean.replace(/^(?:[-*+]|\d+[.)])\s+/, "").trim();
		if (isItem) entries.push({ item: true, text: clean.replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/\s+/g, " ").trim(), lines: [line] });
		else if (/^\s+\S/.test(line) && entries.length && entries[entries.length - 1].item) entries[entries.length - 1].lines.push(line);
		else entries.push({ item: false, lines: [line] });
	}
	const blocks = entries.filter((e) => e.item);
	// Which new item each old block keeps (same text, in order).
	let from = 0;
	for (const b of blocks) {
		const j = items.findIndex((t, i) => i >= from && t === b.text);
		if (j >= 0) {
			b.keep = j;
			from = j + 1;
		}
	}
	const kept = new Set(blocks.filter((b) => b.keep !== undefined).map((b) => b.keep));
	let n = 0; // next new item to place
	let count = 0;
	const out = [];
	const write = (text, children = []) => out.push(`${numbered ? `${++count}.` : "-"} ${text}`, ...children);
	const children = (b) => b.lines.slice(1).filter((l) => ITEM.test(l.trim()) || !visibleLines(l)[0].clean.trim());
	let lastItemAt = -1;
	for (const e of entries) {
		if (!e.item) {
			out.push(...e.lines);
			continue;
		}
		if (e.keep !== undefined) {
			while (n < e.keep) if (!kept.has(n)) write(items[n++]);
			else n++;
			write(items[n++], children(e));
		} else if (n < items.length && !kept.has(n)) {
			write(items[n++], children(e));
		} else continue;
		lastItemAt = out.length;
	}
	const rest = [];
	for (; n < items.length; n++) if (!kept.has(n)) rest.push(items[n]);
	if (rest.length) {
		const at = lastItemAt >= 0 ? lastItemAt : out.findIndex((l) => l.trim() !== "") < 0 ? 0 : out.length;
		const extra = [];
		for (const t of rest) extra.push(`${numbered ? `${++count}.` : "-"} ${t}`);
		out.splice(at < 0 ? out.length : at, 0, ...extra);
	}
	if (numbered) {
		let k = 0;
		for (let i = 0; i < out.length; i++) if (/^\d+[.)]\s/.test(out[i])) out[i] = out[i].replace(/^\d+[.)]/, `${++k}.`);
	}
	while (out.length && out[out.length - 1].trim() === "") out.pop();
	const next = [...lines.slice(0, r.start + 1), ...out, "", ...lines.slice(r.end)];
	return next.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n");
}

/** Replace a section's whole body (kept for callers that own all of it). */
export function setSection(body, heading, content) {
	const lines = body.split(/\r?\n/);
	const r = sectionRange(lines, heading);
	if (!r) return appendSection(body, heading, content);
	const next = [...lines.slice(0, r.start + 1), ...(content ? [content] : []), "", ...lines.slice(r.end)];
	return next.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n");
}

// ── The tagline ─────────────────────────────────────────────────────────

/** Lines that are structure, not tagline prose: headings, list items,
 *  callouts and quotes. They stay in the vault. */
const STRUCTURE = /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/;

/** Text the way both sides compare it: comments and embeds out, structure
 *  lines out, paragraphs (split on blank lines) with their whitespace
 *  collapsed to single spaces. */
export function normText(s) {
	return visibleLines(s)
		.map(({ line, clean }) => (STRUCTURE.test(line) ? "" : clean))
		.join("\n")
		.split(/\n\s*\n/)
		.map((p) => p.replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.join("\n\n");
}

/** The tagline: everything in "Image and Tagline" except image embeds and
 *  %% comments %%, normalized. Undefined when the note has no such section. */
export function tagline(sections) {
	if (!("image and tagline" in sections)) return undefined;
	return normText(sections["image and tagline"]);
}

/** Set the tagline: the section's embeds (on their own line or leading the
 *  old text) and comments stay, at the top; the text becomes `value`. */
export function setTagline(body, value) {
	const sections = parseSections(body);
	const old = sections["image and tagline"] ?? "";
	// Everything that is not tagline prose stays: embeds (also one that led
	// the old text), comments, and structure lines (headings, lists, quotes).
	const keptLines = [];
	for (const { line } of visibleLines(old)) {
		if (STRUCTURE.test(line) || EMBED_ONLY.test(line.trim()) || COMMENT_ONLY.test(line.trim())) keptLines.push(line);
		else for (const tok of line.match(EMBED_TOKEN) ?? []) keptLines.push(tok);
	}
	for (const c of old.match(/%%[\s\S]*?%%/g) ?? []) if (!keptLines.some((l) => l.includes(c))) keptLines.push(c);
	const embeds = keptLines.filter((l) => !STRUCTURE.test(l));
	const structure = keptLines.filter((l) => STRUCTURE.test(l));
	return setSection(body, "Image and Tagline", [...embeds, value, ...(structure.length ? ["", ...structure] : [])].filter((x, i, a) => x !== "" || (i > 0 && i < a.length - 1)).join("\n"));
}

// ── A whole note ────────────────────────────────────────────────────────

/** The recipe's name: a `name:` property (set when Mealie renamed it), else
 *  an H1 above the first section, else the file name. */
export function noteName(data, body, fileName) {
	if (data.name) return String(data.name).trim();
	const beforeSections = body.split(/^##\s/m)[0];
	const h1 = /^#\s+(.+?)\s*$/m.exec(beforeSections)?.[1];
	return (h1 ?? fileName.replace(/\.md$/i, "")).trim();
}

export function readNoteText(text, fileName) {
	const { data, body } = parseFrontmatter(text);
	const sections = parseSections(body);
	return {
		text,
		data,
		body,
		sections,
		fileName,
		name: noteName(data, body, fileName),
		isRecipe: list(data["base type"]).some((t) => /recipe/i.test(t)),
	};
}

/** Body of the note with the frontmatter, for section edits. */
export function splitNote(text) {
	const m = FM.exec(text);
	return m ? { head: m[0], body: text.slice(m[0].length) } : { head: "", body: text };
}

// ── The conflict callout ────────────────────────────────────────────────

export const CALLOUT = "> [!warning] Mealie sync conflict";

function calloutRange(lines) {
	const i = lines.findIndex((l) => l.startsWith(CALLOUT));
	if (i < 0) return null;
	let j = i;
	while (j < lines.length && lines[j].startsWith(">")) j++;
	const end = j;
	while (j < lines.length && lines[j].trim() === "") j++;
	return { i, end, j };
}

/** Remove a previous conflict callout (it sits at the top of the body). */
export function withoutCallout(body) {
	const lines = body.split(/\r?\n/);
	const r = calloutRange(lines);
	return r ? [...lines.slice(0, r.i), ...lines.slice(r.j)].join("\n") : body;
}

/** Put a conflict callout at the top of the body. The same conflicts as last
 *  time leave the note byte for byte as it is (date included), so a conflict
 *  that stands for a week does not rewrite the note every day. */
export function withCallout(body, date, items) {
	const lines = body.split(/\r?\n/);
	const r = calloutRange(lines);
	const itemLines = items.map((it) => `> - **${it.field}**: vault ${it.vault} · Mealie ${it.mealie}`);
	if (r && items.length) {
		const old = lines.slice(r.i, r.end).filter((l) => l.startsWith("> - **"));
		if (old.join("\n") === itemLines.join("\n")) return body;
	}
	const clean = withoutCallout(body);
	if (!items.length) return clean;
	const block = [
		`${CALLOUT} (${date})`,
		"> Changed in both the vault and Mealie since the last sync, so neither was written:",
		...itemLines,
		"> Make them match (edit either side), or run the sync with `--prefer vault` or `--prefer mealie`.",
		"",
	];
	return `${block.join("\n")}\n${clean.replace(/^\s*\n/, "")}`;
}
