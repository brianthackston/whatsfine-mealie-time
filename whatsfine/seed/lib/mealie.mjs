// A small client for Mealie's REST API, shared by seed.mjs and obsidian.mjs.
// Node 22+, no dependencies. Everything goes through the public API so it
// keeps working across upstream releases; nothing touches Mealie's code or DB.
import { existsSync, readFileSync } from "node:fs";

export class Mealie {
	constructor(base, token) {
		this.base = base.replace(/\/+$/, "");
		this.token = token;
	}

	/** MEALIE_TOKEN (a user API token); else a token file (`{ "url", "token" }`,
	 *  the shape of the site's mealie-local.json), which a scheduled run needs
	 *  because it has no environment to read; else MEALIE_USER +
	 *  MEALIE_PASSWORD for a one-off login. */
	static async login(base, { tokenFile, baseWins = false } = {}) {
		if (process.env.MEALIE_TOKEN) return new Mealie(base, process.env.MEALIE_TOKEN);
		if (tokenFile && existsSync(tokenFile)) {
			const j = JSON.parse(readFileSync(tokenFile, "utf8"));
			// An address given on purpose (--url, MEALIE_URL) beats the file's.
			if (j.token) return new Mealie(baseWins ? base : j.url || base, j.token);
		}
		const { MEALIE_USER: username, MEALIE_PASSWORD: password } = process.env;
		if (!username || !password) {
			throw new Error("Set MEALIE_TOKEN, or MEALIE_USER and MEALIE_PASSWORD (or pass --dry-run).");
		}
		const res = await fetch(`${base.replace(/\/+$/, "")}/api/auth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ username, password }),
		});
		if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
		return new Mealie(base, (await res.json()).access_token);
	}

	async call(method, path, body, { form = false } = {}) {
		const headers = { Authorization: `Bearer ${this.token}` };
		if (body && !form) headers["Content-Type"] = "application/json";
		const res = await fetch(`${this.base}/api${path}`, {
			method,
			headers,
			body: body == null ? undefined : form ? body : JSON.stringify(body),
		});
		const text = await res.text();
		if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}

	get = (p) => this.call("GET", p);
	post = (p, b) => this.call("POST", p, b);
	put = (p, b) => this.call("PUT", p, b);
	patch = (p, b) => this.call("PATCH", p, b);
	delete = (p) => this.call("DELETE", p);

	// ── Recipes ────────────────────────────────────────────────────────────

	/** Every recipe the user can see, keyed by lower-cased name. */
	async recipesByName() {
		const page = await this.get("/recipes?perPage=-1");
		return new Map((page.items ?? []).map((r) => [String(r.name).toLowerCase(), r]));
	}

	/** Full recipe by slug or id; null when it doesn't exist. */
	async recipe(slugOrId) {
		try {
			return await this.get(`/recipes/${slugOrId}`);
		} catch (e) {
			if (/→ 404/.test(e.message)) return null;
			throw e;
		}
	}

	/** Import a schema.org/Recipe object the way a URL import would; returns the new slug. */
	async importJsonLd(ld, { url = ld.url, includeTags = true, includeCategories = true } = {}) {
		return this.post("/recipes/create/html-or-json", { data: JSON.stringify(ld), url, includeTags, includeCategories });
	}

	async uploadImage(slug, bytes, extension = "png") {
		const form = new FormData();
		form.set("image", new Blob([bytes], { type: `image/${extension}` }), `${slug}.${extension}`);
		form.set("extension", extension);
		return this.call("PUT", `/recipes/${slug}/image`, form, { form: true });
	}

	async uploadImageFromUrl(slug, imageUrl) {
		const res = await fetch(imageUrl);
		if (!res.ok) throw new Error(`image ${imageUrl} → ${res.status}`);
		const type = res.headers.get("content-type") ?? "";
		const extension = /jpe?g/.test(type) ? "jpg" : /webp/.test(type) ? "webp" : "png";
		return this.uploadImage(slug, await res.arrayBuffer(), extension);
	}

	// ── Organizers ─────────────────────────────────────────────────────────
	// Mealie title-cases keywords it meets during an import ("Whatsfine") but
	// keeps the name of an organizer that already exists with the same slug.
	// So create them first, with our casing. An existing organizer is used as
	// it is: tags, categories and tools are shared by every recipe in the
	// group, so a note spelling one differently must not rename it for all.
	// Only the names in `repair` (the WhatsFine tag) have their casing fixed.

	async ensureOrganizers(kind, names, { repair = [] } = {}) {
		const fix = new Set(repair.map((n) => n.toLowerCase()));
		// kind: "tags" | "categories" | "tools"
		// Tags and categories page their results; tools answer with a bare list.
		const page = await this.get(`/organizers/${kind}?perPage=-1`);
		const items = Array.isArray(page) ? page : (page.items ?? []);
		// Match by slug, then by name: python-slugify transliterates ("9×13-inch
		// pan" → 9x13-inch-pan) where our slugify does not.
		const bySlug = new Map(items.map((t) => [t.slug, t]));
		const byName = new Map(items.map((t) => [t.name.toLowerCase(), t]));
		const out = [];
		for (const name of names.filter(Boolean)) {
			let found = bySlug.get(slugify(name)) ?? byName.get(name.toLowerCase());
			if (!found) {
				try {
					found = await this.post(`/organizers/${kind}`, { name });
				} catch (e) {
					if (!/→ 409/.test(e.message)) throw e;
					const hits = await this.get(`/organizers/${kind}?search=${encodeURIComponent(name)}&perPage=10`);
					found = (Array.isArray(hits) ? hits : hits.items ?? []).find((t) => t.name.toLowerCase() === name.toLowerCase());
					if (!found) throw e;
				}
			} else if (found.name !== name && fix.has(name.toLowerCase())) {
				found = await this.put(`/organizers/${kind}/${found.id}`, { ...found, name });
			}
			bySlug.set(found.slug, found);
			byName.set(found.name.toLowerCase(), found);
			out.push({ id: found.id, name: found.name, slug: found.slug });
		}
		return out;
	}

	ensureTags = (names, opts) => this.ensureOrganizers("tags", names, opts);
	ensureCategories = (names, opts) => this.ensureOrganizers("categories", names, opts);
	ensureTools = (names, opts) => this.ensureOrganizers("tools", names, opts);

	async ensureCookbook(spec) {
		const page = await this.get("/households/cookbooks?perPage=-1");
		const existing = (page.items ?? []).find((c) => c.name === spec.name);
		if (existing) return existing;
		return this.post("/households/cookbooks", spec);
	}

	/** Mealie's own foods and units seeders, which a fresh group doesn't get on its own. */
	async seedFoodsAndUnits(locale = "en-US") {
		for (const kind of ["foods", "units"]) await this.post(`/groups/seeders/${kind}`, { locale });
	}

	// ── Ingredient parsing (the "polish" pass) ─────────────────────────────
	// Mealie's NLP parser turns "2 1/2 cups whole milk" into quantity 2.5, unit
	// cup, food whole milk. Structured ingredients are what make scaling and
	// shopping lists work; a bare note can't scale. Low-confidence lines stay
	// as notes so a bad parse never rewrites a recipe.

	async parseIngredients(lines, { minConfidence = 0.7 } = {}) {
		if (lines.length === 0) return [];
		const parsed = await this.post("/parser/ingredients", { parser: "nlp", ingredients: lines });
		const out = [];
		for (const p of parsed) {
			const ing = p.ingredient ?? {};
			// "Lots of black pepper" comes back at 0.73 with the whole line as the
			// food: nothing was actually extracted, so it stays a note.
			const extracted = ing.food?.name && (ing.quantity > 0 || ing.food.name.length < p.input.length);
			const confident = (p.confidence?.average ?? 0) >= minConfidence && extracted;
			if (!confident) {
				out.push({ note: p.input, originalText: p.input });
				continue;
			}
			const unit = ing.unit?.name ? await this.ensureUnit(ing.unit) : null;
			const food = await this.ensureFood(ing.food);
			out.push({
				quantity: ing.quantity ?? 0,
				unit,
				food,
				note: ing.note ?? "",
				originalText: p.input,
			});
		}
		return out;
	}

	async ensureFood(food) {
		if (food.id) return food;
		const page = await this.get(`/foods?search=${encodeURIComponent(food.name)}&perPage=10`);
		const hit = (page.items ?? []).find((f) => f.name.toLowerCase() === food.name.toLowerCase());
		return hit ?? this.post("/foods", { name: food.name });
	}

	async ensureUnit(unit) {
		if (unit.id) return unit;
		const page = await this.get(`/units?search=${encodeURIComponent(unit.name)}&perPage=10`);
		const hit = (page.items ?? []).find(
			(u) => u.name.toLowerCase() === unit.name.toLowerCase() || u.abbreviation?.toLowerCase() === unit.name.toLowerCase(),
		);
		return hit ?? this.post("/units", { name: unit.name, abbreviation: unit.abbreviation ?? "" });
	}
}

// Mealie slugs are python-slugify output; for the names we ship this matches.
export const slugify = (s) =>
	String(s)
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

/** "20 min", "1 hr 15 min", "1h30m", "45 minutes" → ISO 8601 duration, else
 *  undefined (also for zero, which "PT" alone would not express). */
export function isoDuration(text) {
	const s = durationSeconds(text);
	if (!s) return undefined;
	const h = Math.floor(s / 3600);
	const m = Math.round((s % 3600) / 60);
	return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}`;
}

/** Same inputs → seconds (Mealie's `*TimeSeconds` fields), else undefined.
 *  A unit ends at a non-letter, not a word boundary, so "1h30m" reads as
 *  90 minutes (in "1h30m" there is no boundary between "h" and "3"). */
export function durationSeconds(text) {
	if (!text) return undefined;
	const h = /(\d+(?:\.\d+)?)\s*(?:hours|hour|hrs|hr|h)(?![a-z])/i.exec(text)?.[1];
	const m = /(\d+)\s*(?:minutes|minute|mins|min|m)(?![a-z])/i.exec(text)?.[1];
	if (!h && !m) return undefined;
	return Math.round((Number(h ?? 0) * 60 + Number(m ?? 0)) * 60);
}

/** Drop empty strings, undefined and empty arrays so the payload stays small. */
export function compact(obj) {
	for (const k of Object.keys(obj)) {
		const v = obj[k];
		if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) delete obj[k];
	}
	return obj;
}

/** Small CLI helpers shared by the scripts. `valued` names the options that
 *  take a value (`--vault <path>`), so the word after any other flag is still
 *  a positional: `--dry-run sync` keeps its command. */
export function cli(argv = process.argv.slice(2), valued = []) {
	const takes = new Set(valued);
	const flag = (name) => argv.includes(name);
	const opt = (name, fallback) => {
		const i = argv.indexOf(name);
		return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
	};
	const all = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] && !argv[i + 1].startsWith("--") ? [argv[i + 1]] : []));
	const positional = argv.filter((a, i) => a !== "--" && !a.startsWith("--") && !(i > 0 && takes.has(argv[i - 1])));
	return { flag, opt, all, positional };
}
