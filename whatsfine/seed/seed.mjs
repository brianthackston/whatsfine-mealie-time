#!/usr/bin/env node
// Seed a Mealie instance with WhatsFine's published recipes, through Mealie's
// API only: nothing here touches Mealie's code or database.
//
// Source: the whatsfine repo's seed/seed.json (EmDash seed). Every published
// `articles` entry with a `recipe` field becomes a Mealie recipe, built as a
// schema.org/Recipe object and sent to POST /api/recipes/create/html-or-json,
// the same path a URL import takes. That mapping is the one whatsfine.com
// should eventually emit as JSON-LD (Twenty task cap-20261022-recipe-jsonld);
// once it does, this script can import by URL instead and the mapping can go.
//
// For recipes drafted in Obsidian, see obsidian.mjs; both scripts converge on
// the same Mealie recipe when a draft and an article describe the same dish.
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
//   --no-parse          leave ingredients as plain lines instead of parsing qty/unit/food
//   --seed-foods        also run Mealie's own en-US foods and units seeders for the group
//   --dry-run           no network calls to Mealie; payloads go to seed/out/
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Mealie, cli, compact, isoDuration, slugify } from "./lib/mealie.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { flag, opt } = cli();
const config = {
	url: opt("--url", process.env.MEALIE_URL ?? "http://localhost:9925"),
	source: resolve(opt("--source", process.env.WHATSFINE_SEED ?? join(here, "../../../whatsfine/seed/seed.json"))),
	site: opt("--site", "https://whatsfine.com").replace(/\/+$/, ""),
	replace: flag("--replace"),
	images: !flag("--no-images"),
	parse: !flag("--no-parse"),
	seedFoods: flag("--seed-foods"),
	dryRun: flag("--dry-run"),
	outDir: join(here, "out"),
};

// ── WhatsFine conventions in Mealie ─────────────────────────────────────
// Tags: the source tag (what the cookbook filters on) plus the article's
// kicker, which is the site's own sub-type. Categories are left to the
// Obsidian drafts (`recipe type`: Breakfast, Dessert, Snack …); the pillar
// is always Food, so it carries no information inside Mealie.
export const SOURCE_TAG = "WhatsFine";
export const COOKBOOK = {
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

	return compact({
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
		keywords: [SOURCE_TAG, d.kicker].filter(Boolean).join(", "),
	});
}

// Things schema.org has no slot for, applied with PATCH after the import.
export function toRecipePatch(article, ctx) {
	const r = article.data.recipe;
	const notes = [];
	if (r.note) notes.push({ title: "WhatsFine tip", text: r.note });
	const product = r.product ? ctx.products.get(r.product) : null;
	if (product) {
		notes.push({ title: "Printable card", text: `${product.title}: ${ctx.site}/shop/${product.slug}` });
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

// ── Import ───────────────────────────────────────────────────────────────
async function importRecipe(api, article, ctx, existingByName) {
	const ld = toRecipeJsonLd(article, ctx);
	const name = ld.name;
	const prior = existingByName.get(name.toLowerCase());
	if (prior) {
		if (!config.replace) return { name, slug: prior.slug, action: "skipped (exists; --replace to redo)" };
		await api.delete(`/recipes/${prior.slug}`);
	}

	const slug = await api.importJsonLd(ld);
	const patch = toRecipePatch(article, ctx);
	if (config.parse) patch.recipeIngredient = await api.parseIngredients(ld.recipeIngredient);
	await api.patch(`/recipes/${slug}`, patch);

	let image = "none";
	if (config.images) {
		try {
			await api.uploadImageFromUrl(slug, ogImageUrl(article, ctx));
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
		await api.seedFoodsAndUnits("en-US");
		console.log("seeded foods and units (en-US)");
	}

	await api.ensureTags([SOURCE_TAG]);
	const existingByName = await api.recipesByName();

	for (const a of articles) {
		const result = await importRecipe(api, a, ctx, existingByName);
		console.log(`  ${result.action.padEnd(10)} ${result.slug}  (${result.name})${result.image ? `  image: ${result.image}` : ""}`);
	}

	const cookbook = await api.ensureCookbook(COOKBOOK);
	console.log(`cookbook "${cookbook.name}" → ${config.url}/g/${me.groupSlug ?? "home"}/cookbooks/${cookbook.slug}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((e) => {
		console.error(e.message ?? e);
		process.exit(1);
	});
}
