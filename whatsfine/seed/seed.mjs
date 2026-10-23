#!/usr/bin/env node
// Seed a Mealie instance with WhatsFine's recipes, through Mealie's public API
// only: nothing here touches Mealie's code or database, so it keeps working
// across upstream releases.
//
// Source: the whatsfine repo's seed/seed.json (EmDash seed). Every published
// `articles` entry with a `recipe` field becomes a Mealie recipe, built as a
// schema.org/Recipe object and sent to POST /api/recipes/create/html-or-json,
// the same path a URL import takes. That mapping is the one whatsfine.com
// should eventually emit as JSON-LD (Twenty task cap-20261022-recipe-jsonld);
// once it does, this script can import by URL instead and the mapping can go.
//
// Usage (Node 22+, no dependencies):
//   node seed.mjs --dry-run                  write the payloads to seed/out/, touch nothing
//   MEALIE_TOKEN=... node seed.mjs           seed http://localhost:9925
//   MEALIE_USER=... MEALIE_PASSWORD=... node seed.mjs --url https://recipes.example
//
// Options:
//   --url <base>        Mealie base URL           (default http://localhost:9925, or $MEALIE_URL)
//   --source <path>     whatsfine seed.json       (default ../../../whatsfine/seed/seed.json, or $WHATSFINE_SEED)
//   --site <origin>     whatsfine.com origin for links and images (default https://whatsfine.com)
//   --replace           delete a recipe of the same name before importing it (default: skip it)
//   --no-images         do not fetch the site's OG card as the recipe image
//   --seed-foods        also run Mealie's own en-US foods and units seeders for the group
//   --dry-run           no network calls to Mealie; payloads go to seed/out/
//
// Auth: MEALIE_TOKEN (a user API token from /user/profile/api-tokens), or
// MEALIE_USER + MEALIE_PASSWORD for a one-off login. The user's household
// receives the recipes; the group receives tags, categories and the cookbook.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// ── CLI ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const config = {
	url: opt("--url", process.env.MEALIE_URL ?? "http://localhost:9925").replace(/\/+$/, ""),
	source: resolve(opt("--source", process.env.WHATSFINE_SEED ?? join(here, "../../../whatsfine/seed/seed.json"))),
	site: opt("--site", "https://whatsfine.com").replace(/\/+$/, ""),
	replace: flag("--replace"),
	images: !flag("--no-images"),
	seedFoods: flag("--seed-foods"),
	dryRun: flag("--dry-run"),
	outDir: join(here, "out"),
};

// ── WhatsFine conventions ───────────────────────────────────────────────
// Pillar values from the articles collection's `pillar` select, and the
// bylines list; both live in seed.json. The tag every imported recipe gets
// is also what the cookbook filters on.
const PILLAR_LABEL = { food: "Food", play: "Play", tech: "Tech", takes: "Takes" };
const SOURCE_TAG = "WhatsFine";
const COOKBOOK = {
	name: "WhatsFine",
	description: "Every recipe published on whatsfine.com.",
	// Mealie's query-filter language (docs: "Advanced Query Filters").
	query_filter_string: `tags.name CONTAINS ALL ["${SOURCE_TAG}"]`,
	public: true,
};

// ── Mapping: EmDash article → schema.org/Recipe ─────────────────────────
// WhatsFine recipe field: title, serves, time, prep[], ingredients[],
// grid (visual card only; ignored), steps[], note, product (shop slug).
export function toRecipeJsonLd(article, ctx) {
	const d = article.data;
	const r = d.recipe;
	const url = `${ctx.site}/articles/${article.slug}`;
	const steps = [...(r.prep ?? []).map((p) => `Before you start: ${p}`), ...(r.steps ?? [])];
	const authors = (article.bylines ?? [])
		.map((b) => ctx.bylines.get(b.byline))
		.filter(Boolean)
		.map((name) => ({ "@type": "Person", name }));

	const ld = {
		"@context": "https://schema.org",
		"@type": "Recipe",
		name: r.title ?? d.title,
		description: d.dek ?? "",
		url,
		mainEntityOfPage: url,
		author: authors.length === 1 ? authors[0] : authors,
		publisher: { "@type": "Organization", name: "WhatsFine", url: ctx.site },
		recipeYield: r.serves,
		totalTime: isoDuration(r.time),
		recipeIngredient: r.ingredients ?? [],
		recipeInstructions: steps.map((text) => ({ "@type": "HowToStep", text })),
		recipeCategory: [PILLAR_LABEL[d.pillar] ?? d.pillar].filter(Boolean),
		keywords: [SOURCE_TAG, d.kicker].filter(Boolean).join(", "),
	};
	// Mealie reads `image` as a URL to download. The site's OG route renders a
	// branded 1200x630 card per article; the seed uploads it separately so a
	// slow fetch cannot fail the import (see uploadImage).
	for (const k of Object.keys(ld)) if (ld[k] === undefined || ld[k] === "") delete ld[k];
	return ld;
}

// Things schema.org has no slot for, applied with PATCH after the import.
export function toRecipePatch(article, ctx) {
	const r = article.data.recipe;
	const notes = [];
	if (r.note) notes.push({ title: "WhatsFine tip", text: r.note });
	const product = r.product ? ctx.products.get(r.product) : null;
	if (product) {
		notes.push({
			title: "Printable card",
			text: `${product.title}: ${ctx.site}/shop/${product.slug}`,
		});
	}
	return {
		notes,
		extras: {
			whatsfine_article: article.slug,
			...(r.product ? { whatsfine_product: r.product } : {}),
		},
	};
}

export function ogImageUrl(article, ctx) {
	const d = article.data;
	const q = new URLSearchParams({ title: d.title, kicker: d.kicker ?? "Recipe", pillar: d.pillar ?? "" });
	return `${ctx.site}/og.png?${q}`;
}

// "20 min", "1 hr 15 min", "1h30m", "45 minutes" → ISO 8601 duration, else undefined.
export function isoDuration(text) {
	if (!text) return undefined;
	const h = /(\d+)\s*(?:h|hr|hrs|hour|hours)\b/i.exec(text)?.[1];
	const m = /(\d+)\s*(?:m|min|mins|minute|minutes)\b/i.exec(text)?.[1];
	if (!h && !m) return undefined;
	return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}`;
}

// ── Source ───────────────────────────────────────────────────────────────
async function loadSource(path) {
	const seed = JSON.parse(await readFile(path, "utf8"));
	const bylines = new Map((seed.bylines ?? []).map((b) => [b.id, b.displayName]));
	const products = new Map(
		(seed.content?.products ?? []).map((p) => [p.slug, { slug: p.slug, title: p.data?.title ?? p.slug }]),
	);
	const articles = (seed.content?.articles ?? []).filter((a) => a.status === "published" && a.data?.recipe);
	return { articles, bylines, products };
}

// ── Mealie client ───────────────────────────────────────────────────────
class Mealie {
	constructor(base, token) {
		this.base = base;
		this.token = token;
	}

	static async login(base) {
		if (process.env.MEALIE_TOKEN) return new Mealie(base, process.env.MEALIE_TOKEN);
		const { MEALIE_USER: username, MEALIE_PASSWORD: password } = process.env;
		if (!username || !password) {
			throw new Error("Set MEALIE_TOKEN, or MEALIE_USER and MEALIE_PASSWORD (or pass --dry-run).");
		}
		const res = await fetch(`${base}/api/auth/token`, {
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
	patch = (p, b) => this.call("PATCH", p, b);
	delete = (p) => this.call("DELETE", p);
}

// Mealie slugs are python-slugify output; for the names we ship this matches.
const slugify = (s) =>
	s
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

async function ensureCookbook(api) {
	const page = await api.get("/households/cookbooks?perPage=-1");
	const existing = (page.items ?? []).find((c) => c.name === COOKBOOK.name);
	if (existing) return existing;
	return api.post("/households/cookbooks", COOKBOOK);
}

async function uploadImage(api, slug, imageUrl) {
	const res = await fetch(imageUrl);
	if (!res.ok) throw new Error(`image ${imageUrl} → ${res.status}`);
	const form = new FormData();
	form.set("image", new Blob([await res.arrayBuffer()], { type: "image/png" }), `${slug}.png`);
	form.set("extension", "png");
	return api.call("PUT", `/recipes/${slug}/image`, form, { form: true });
}

async function importRecipe(api, article, ctx, existingByName) {
	const ld = toRecipeJsonLd(article, ctx);
	const name = ld.name;
	const prior = existingByName.get(name.toLowerCase());
	if (prior) {
		if (!config.replace) return { name, slug: prior.slug, action: "skipped (exists; --replace to redo)" };
		await api.delete(`/recipes/${prior.slug}`);
	}

	const slug = await api.post("/recipes/create/html-or-json", {
		data: JSON.stringify(ld),
		url: ld.url,
		includeTags: true,
		includeCategories: true,
	});
	await api.patch(`/recipes/${slug}`, toRecipePatch(article, ctx));

	let image = "none";
	if (config.images) {
		try {
			await uploadImage(api, slug, ogImageUrl(article, ctx));
			image = "og card";
		} catch (e) {
			image = `failed: ${e.message}`;
		}
	}
	return { name, slug, action: prior ? "replaced" : "created", image };
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
	const { articles, bylines, products } = await loadSource(config.source);
	const ctx = { site: config.site, bylines, products };
	console.log(`${articles.length} recipe article(s) in ${config.source}`);
	if (articles.length === 0) return;

	if (config.dryRun) {
		await mkdir(config.outDir, { recursive: true });
		for (const a of articles) {
			const base = join(config.outDir, slugify(a.data.recipe.title ?? a.data.title));
			await writeFile(`${base}.jsonld.json`, JSON.stringify(toRecipeJsonLd(a, ctx), null, 2));
			await writeFile(`${base}.patch.json`, JSON.stringify(toRecipePatch(a, ctx), null, 2));
			console.log(`  ${a.slug} → ${base}.{jsonld,patch}.json  image: ${ogImageUrl(a, ctx)}`);
		}
		await writeFile(join(config.outDir, "cookbook.json"), JSON.stringify(COOKBOOK, null, 2));
		console.log(`cookbook → ${join(config.outDir, "cookbook.json")}`);
		return;
	}

	const api = await Mealie.login(config.url);
	const me = await api.get("/users/self");
	console.log(`signed in as ${me.email} (group ${me.groupSlug ?? me.group}, household ${me.household})`);

	if (config.seedFoods) {
		for (const kind of ["foods", "units"]) {
			await api.post(`/groups/seeders/${kind}`, { locale: "en-US" });
			console.log(`seeded ${kind} (en-US)`);
		}
	}

	const existing = await api.get("/recipes?perPage=-1");
	const existingByName = new Map((existing.items ?? []).map((r) => [String(r.name).toLowerCase(), r]));

	for (const a of articles) {
		const result = await importRecipe(api, a, ctx, existingByName);
		console.log(`  ${result.action.padEnd(10)} ${result.slug}  (${result.name})${result.image ? `  image: ${result.image}` : ""}`);
	}

	const cookbook = await ensureCookbook(api);
	console.log(`cookbook "${cookbook.name}" → ${config.url}/g/${me.groupSlug ?? "home"}/cookbooks/${cookbook.slug}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((e) => {
		console.error(e.message ?? e);
		process.exit(1);
	});
}
