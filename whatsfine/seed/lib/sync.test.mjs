// Tests for the Obsidian ↔ Mealie sync, against real data: the vault's
// recipe notes and the matching Mealie recipes as they stood on 2026-11-15,
// after the first production sync (__fixtures__/). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { FIELDS, applyValues, fp, ingredientLine, mergeIngredients, mergeSteps, readBase, readSync, reconcile, yieldText } from "./contract.mjs";
import { CALLOUT, bullets, duplicateSections, parseSections, readNoteText, setFrontmatter, setList, setSection, setTagline, splitNote, tagline, withCallout } from "./note.mjs";
import { cli, durationSeconds, isoDuration } from "./mealie.mjs";

const dir = new URL("./__fixtures__/", import.meta.url);
const mealie = JSON.parse(readFileSync(new URL("mealie-recipes.json", dir), "utf8"));
const note = (file) => readNoteText(readFileSync(new URL(`notes/${file}`, dir), "utf8"), file);
const template = readFileSync(new URL("Recipe - BT.md", dir), "utf8");
const PAIRS = [
	["Chipped Beef & Gravy.md", "chipped-beef-gravy"],
	["Fruity Rice Krispy Treats.md", "fruity-rice-krispy-treats"],
	["Sausage Gravy & Crackers.md", "sausage-gravy-crackers"],
];
const by = (decisions) => Object.fromEntries(decisions.map((d) => [d.key, d]));

// ── The real vault against the real Mealie ───────────────────────────────

test("after Stage 2 the vault and Mealie agree on every field but the new publish flag", () => {
	for (const [file, slug] of PAIRS) {
		const d = reconcile(note(file), mealie[slug], null);
		const off = d.filter((x) => x.action !== "same" && x.key !== "whatsfine");
		assert.deepEqual(off.map((x) => `${x.key}: vault ${JSON.stringify(x.vault)} mealie ${JSON.stringify(x.mealie)}`), [], file);
		// The note has no `whatsfine:` yet, so Mealie's tag is taken.
		assert.equal(by(d).whatsfine.action, "pull");
		assert.equal(by(d).whatsfine.mealie, true);
	}
});

test("Fruity's prep row and tools read the same on both sides", () => {
	const d = by(reconcile(note("Fruity Rice Krispy Treats.md"), mealie["fruity-rice-krispy-treats"], null));
	assert.equal(d.steps.vault[0], "Before you start: Butter a 9×13-in pan");
	assert.deepEqual(d.tools.vault, ["9×13-inch pan", "Large pot"]);
	assert.equal(d.tools.action, "same", "tools are a set: Mealie lists them in another order");
});

test("Sausage gravy's servings range equals Mealie's first number", () => {
	const d = by(reconcile(note("Sausage Gravy & Crackers.md"), mealie["sausage-gravy-crackers"], null));
	assert.equal(d.servings.vault, 4);
	assert.equal(d.servings.action, "same");
	assert.equal(d.yield.vault, "Serves 4–6");
});

// ── The three-way rule ───────────────────────────────────────────────────

const agreedBase = (n, r) => Object.fromEntries(FIELDS.map((f) => [f.key, fp(f.key, f.mealie(r))]));

test("a change in the vault pushes, a change in Mealie pulls, both is a conflict", () => {
	const n = note("Chipped Beef & Gravy.md");
	const r = mealie["chipped-beef-gravy"];
	const base = agreedBase(n, r);

	const vaultEdit = readNoteText(n.text.replace("- Black pepper\n", "- Black pepper, plenty\n"), n.fileName);
	assert.equal(by(reconcile(vaultEdit, r, base)).ingredients.action, "push");

	const mealieEdit = structuredClone(r);
	mealieEdit.description = "A new tagline from Mealie.";
	assert.equal(by(reconcile(n, mealieEdit, base)).description.action, "pull");

	const both = by(reconcile(vaultEdit, { ...mealieEdit, recipeIngredient: [...r.recipeIngredient, { note: "Hot sauce", display: "Hot sauce" }] }, base));
	assert.equal(both.ingredients.action, "conflict");
	assert.equal(both.description.action, "pull", "fields that changed on one side still flow");
});

test("--prefer settles conflicts and an unrecorded first sync", () => {
	const n = readNoteText(note("Chipped Beef & Gravy.md").text.replace("total time: 15 minutes", "total time: 25 minutes"), "x.md");
	const r = mealie["chipped-beef-gravy"];
	assert.equal(by(reconcile(n, r, null)).totalTime.action, "conflict");
	assert.equal(by(reconcile(n, r, null, { prefer: "vault" })).totalTime.action, "push");
	assert.equal(by(reconcile(n, r, null, { prefer: "mealie" })).totalTime.action, "pull");
});

test("emptying a field in the vault pushes the empty value", () => {
	const n = note("Fruity Rice Krispy Treats.md");
	const r = mealie["fruity-rice-krispy-treats"];
	const base = agreedBase(n, r);
	const cleared = readNoteText(setFrontmatter(n.text, "tools", []), n.fileName);
	const d = by(reconcile(cleared, r, base)).tools;
	assert.equal(d.action, "push");
	assert.deepEqual(d.vault, []);
});

test("the base round-trips through extras", () => {
	const r = { extras: { obsidian_sync: JSON.stringify({ v: 1, fields: { name: "abc" } }) } };
	assert.deepEqual(readBase(r), { name: "abc" });
	assert.equal(readBase({ extras: {} }), null);
	assert.equal(readBase({ extras: { obsidian_sync: "not json" } }), null);
});

// ── Writing Mealie's values into a note ─────────────────────────────────

test("every field written into a note reads back as the same value", () => {
	for (const [file, slug] of PAIRS) {
		const r = structuredClone(mealie[slug]);
		r.name = `${r.name} (renamed)`;
		r.description = "Changed in Mealie.";
		r.recipeIngredient = [...r.recipeIngredient, { note: "Hot sauce, to serve", display: "Hot sauce, to serve" }];
		r.recipeInstructions = [...r.recipeInstructions, { text: "Serve at once." }];
		r.notes = [{ title: "WhatsFine tip", text: "tip" }, { title: "Notes", text: "- one\n- two" }];
		r.prepTimeSeconds = 300;
		r.performTimeSeconds = 5400;
		r.recipeServings = 6;
		r.rating = 4;
		r.tags = [{ name: "WhatsFine" }, { name: "Recipe" }, { name: "Southern" }];
		r.extras = { ...r.extras, obsidian_status: "Tested", recommended_by: "Mom, Dad" };
		const values = Object.fromEntries(FIELDS.map((f) => [f.key, f.mealie(r)]));
		const written = readNoteText(applyValues(note(file).text, values), file);
		const d = reconcile(written, r, null);
		assert.deepEqual(d.filter((x) => x.action !== "same").map((x) => x.key), [], file);
	}
});

test("writing a note keeps everything the sync does not own", () => {
	const n = note("Sausage Gravy & Crackers.md");
	const text = n.text
		.replace("## Immediate Thoughts\n", "## Immediate Thoughts\nTry it with sage next time.\n")
		.replace("## Image and Tagline\n", "## Image and Tagline\n![[sausage.jpg]]\n\n");
	const r = structuredClone(mealie["sausage-gravy-crackers"]);
	r.description = "New tagline.";
	r.recipeInstructions = [{ text: "One step only." }];
	const out = applyValues(text, { description: "New tagline.", steps: ["One step only."] });
	assert.match(out, /## Immediate Thoughts\nTry it with sage next time\./);
	assert.match(out, /!\[\[sausage\.jpg\]\]/);
	assert.match(out, /^tags:\n {2}- sustenance$/m);
	assert.match(out, /## Instructions\n1\. One step only\.\n/);
	const back = readNoteText(out, n.fileName);
	assert.equal(tagline(back.sections), "New tagline.");
	assert.deepEqual(back.sections.ingredients.split("\n").length, 6, "other sections untouched");
});

test("a note Mealie creates from the template reads back as Mealie's recipe", () => {
	const r = mealie["brown-butter"];
	const values = Object.fromEntries(FIELDS.map((f) => [f.key, f.mealie(r)]));
	const text = setFrontmatter(applyValues(template, values), "mealie id", r.id);
	const n = readNoteText(text, "Brown butter.md");
	assert.equal(n.isRecipe, true);
	const d = reconcile(n, r, null);
	assert.deepEqual(d.filter((x) => x.action !== "same").map((x) => `${x.key}: ${JSON.stringify(x.vault)} vs ${JSON.stringify(x.mealie)}`), []);
	assert.match(text, /^## Immediate Thoughts$/m);
});

test("the conflict callout comes and goes without residue", () => {
	const { head, body } = splitNote(note("Chipped Beef & Gravy.md").text);
	const withIt = withCallout(body, "2026-11-15", [{ field: "ingredients", vault: "a", mealie: "b" }]);
	assert.ok(withIt.startsWith(CALLOUT));
	assert.equal(withCallout(withIt, "2026-11-16", [{ field: "steps", vault: "a", mealie: "b" }]).split(CALLOUT).length, 2, "one callout, replaced");
	assert.equal(withCallout(withIt, "2026-11-16", []), body, "gone once resolved, body as before");
	assert.equal(head + withCallout(body, "2026-11-15", []), note("Chipped Beef & Gravy.md").text);
});

test("frontmatter edits keep the template's keys, order and the ⭐ key", () => {
	const t = note("Kielbasa Stuffing.md").text;
	const out = setFrontmatter(setFrontmatter(t, "tools", ["Skillet"]), "whatsfine", "false");
	const keys = (s) => [...splitNote(s).head.matchAll(/^([^\s-][^:]*):/gm)].map((m) => m[1]);
	assert.deepEqual(keys(out), [...keys(t), "whatsfine"]);
	assert.match(out, /^tools:\n {2}- Skillet\nmealie id:/m);
	assert.match(out, /^⭐:$/m);
	assert.equal(setFrontmatter(t, "yield", "Serves 4–6").includes("yield: Serves 4–6"), true);
	assert.equal(setFrontmatter(t, "source", "https://x.y/z").includes("source: https://x.y/z"), true);
});

test("a section edit at the end of the note keeps one trailing newline", () => {
	const body = "## Ingredients\n- a\n\n## Image and Tagline\nOld.\n";
	assert.equal(setTagline(body, "New."), "## Ingredients\n- a\n\n## Image and Tagline\nNew.\n");
	assert.equal(setList(body, "Ingredients", ["b", "c"]), "## Ingredients\n- b\n- c\n\n## Image and Tagline\nOld.\n");
	assert.equal(setSection("## A\nx\n", "Notes", "- n"), "## A\nx\n\n## Notes\n- n\n");
	assert.deepEqual(parseSections(setList(body, "Ingredients", [])).ingredients, "");
});

// ── Small parts ─────────────────────────────────────────────────────────

test("durations: 1h30m, words, and zero", () => {
	assert.equal(durationSeconds("1h30m"), 5400);
	assert.equal(durationSeconds("1 hour 30 minutes"), 5400);
	assert.equal(durationSeconds("45 min"), 2700);
	assert.equal(durationSeconds("2 hrs"), 7200);
	assert.equal(isoDuration("0 minutes"), undefined);
	assert.equal(isoDuration("1h30m"), "PT1H30M");
});

test("the command survives a flag before it; option values are not commands", () => {
	assert.deepEqual(cli(["--dry-run", "sync"], ["--vault"]).positional, ["sync"]);
	assert.deepEqual(cli(["sync", "--vault", "C:/v", "--dry-run"], ["--vault"]).positional, ["sync"]);
	assert.deepEqual(cli(["--skip", "a", "--skip", "b"], ["--skip"]).all("--skip"), ["a", "b"]);
});

test("ingredient lines: the original while it agrees, Mealie's display after an edit", () => {
	const tbsp = { name: "tablespoon", pluralName: "tablespoons", abbreviation: "tbsp" };
	const i = { quantity: 3, unit: tbsp, food: { name: "butter" }, note: "", display: "3 tablespoons butter", originalText: "3 tbsp butter" };
	assert.equal(ingredientLine(i), "3 tbsp butter");
	assert.equal(ingredientLine({ ...i, quantity: 4, display: "4 tablespoons butter" }), "4 tablespoons butter");
	assert.equal(ingredientLine({ ...i, food: { name: "oil" }, display: "3 tablespoons oil" }), "3 tablespoons oil");
});

test("yield text from Mealie's three shapes", () => {
	assert.equal(yieldText({ recipeYield: "Makes 12", recipeYieldQuantity: 12 }), "Makes 12");
	assert.equal(yieldText({ recipeYield: "cup", recipeYieldQuantity: 0.5 }), "0.5 cup");
	assert.equal(yieldText({ recipeYield: "" }), "");
});

test("no fixture note is shadowed by an H1 inside a section", () => {
	const text = note("Chipped Beef & Gravy.md").text.replace("## Notes\n", "## Notes\n# Not the name\n");
	assert.equal(readNoteText(text, "Chipped Beef & Gravy.md").name, "Chipped Beef & Gravy");
});

test("every fixture note parses as a recipe", () => {
	const files = readdirSync(new URL("notes/", dir));
	assert.equal(files.length, 4);
	for (const f of files) assert.equal(note(f).isRecipe, true, f);
});

// ── Review findings, 2026-11-15 ─────────────────────────────────────────

const chipped = () => note("Chipped Beef & Gravy.md");
const roundTrip = (n, r) => {
	// Pull every field from r into n, read it back, and reconcile again.
	const values = Object.fromEntries(FIELDS.map((f) => [f.key, f.mealie(r)]));
	const back = readNoteText(applyValues(n.text, values), n.fileName);
	return reconcile(back, r, null).filter((d) => d.action !== "same").map((d) => `${d.key}: ${JSON.stringify(d.vault)} vs ${JSON.stringify(d.mealie)}`);
};

test("a multi-paragraph description and multi-line steps read back equal", () => {
	const r = structuredClone(mealie["chipped-beef-gravy"]);
	r.description = "First paragraph.\n\nSecond paragraph,\nwith a line break.";
	r.recipeInstructions = [{ text: "Melt the butter.\n\nWhisk in flour." }, { text: "Serve." }];
	assert.deepEqual(roundTrip(chipped(), r), []);
});

test("a missing key or section takes Mealie's value instead of wiping it", () => {
	const n = chipped();
	const r = mealie["chipped-beef-gravy"];
	const noYield = readNoteText(n.text.replace(/^yield:.*\n/m, ""), n.fileName);
	const noNotes = readNoteText(n.text.replace(/## Notes[\s\S]*?(?=## Image)/, ""), n.fileName);
	const base = agreedBase(n, r);
	assert.equal(by(reconcile(noYield, r, base)).yield.action, "pull");
	assert.equal(by(reconcile(noNotes, r, base)).notes.action, "pull");
	// An empty key, by contrast, means "none" and is pushed.
	const emptyYield = readNoteText(n.text.replace(/^yield:.*$/m, "yield:"), n.fileName);
	assert.equal(by(reconcile(emptyYield, r, base)).yield.action, "push");
});

test("only top-level items are recipe data; comments, embeds, sub-headings and nesting stay in the vault", () => {
	const section = "### Sauce\n- 2 cups flour\n  - sifted twice\n- %% private %%\n![[diagram.png]]\n- 1 egg\n  beaten\n%% a comment %%";
	assert.deepEqual(bullets(section), ["2 cups flour", "1 egg beaten"]);
	const body = `## Ingredients\n${section}\n\n## Notes\n- n\n`;
	const out = setList(body, "Ingredients", ["3 cups flour", "1 egg", "salt"]);
	for (const kept of ["### Sauce", "  - sifted twice", "- %% private %%", "![[diagram.png]]", "%% a comment %%"]) assert.ok(out.includes(kept), kept);
	assert.deepEqual(bullets(parseSections(out).ingredients), ["3 cups flour", "1 egg", "salt"]);
	assert.match(out, /## Notes\n- n\n$/);
});

test("a repeated owned section is reported, not merged", () => {
	assert.deepEqual(duplicateSections("## Ingredients\n- a\n## Notes\n## Ingredients\n- b\n", ["Ingredients", "Notes"]), ["ingredients"]);
});

test("an embed on the tagline's own line survives a new tagline", () => {
	const body = "## Image and Tagline\n![[photo.jpg]] Old tagline.\n";
	const out = setTagline(body, "New tagline.");
	assert.match(out, /!\[\[photo\.jpg\]\]/);
	assert.equal(tagline(parseSections(out)), "New tagline.");
});

test("quotes, colons and backslashes in frontmatter values read back as written", () => {
	for (const name of ['"Best" Chipped Beef', 'Chipped Beef: "SOS"', "Back\\slash", "It's done", "- leading dash", "true"]) {
		const out = setFrontmatter(chipped().text, "name", name);
		assert.equal(readNoteText(out, "x.md").name, name, name);
	}
});

test("times compare in whole minutes on both sides", () => {
	const r = { ...mealie["chipped-beef-gravy"], prepTimeSeconds: 90, performTimeSeconds: 20, totalTimeSeconds: 3599 };
	assert.deepEqual(roundTrip(chipped(), r), []);
});

test("recommended by compares the same however Mealie spaced it", () => {
	const r = { ...mealie["chipped-beef-gravy"], extras: { ...mealie["chipped-beef-gravy"].extras, recommended_by: "Mom,Dad" } };
	assert.deepEqual(roundTrip(chipped(), r), []);
});

test("a cuisine that names a kicker tag settles instead of bouncing", () => {
	const n = readNoteText(setFrontmatter(chipped().text, "cuisine", ["Southern", "Technique"]), "x.md");
	const r = { ...mealie["chipped-beef-gravy"], tags: [{ name: "WhatsFine" }, { name: "Recipe" }, { name: "Southern" }] };
	assert.equal(by(reconcile(n, r, null)).cuisine.action, "same");
});

test("tools and categories compare without case", () => {
	const n = readNoteText(setFrontmatter(note("Fruity Rice Krispy Treats.md").text, "tools", ["large pot", "9×13-inch pan"]), "x.md");
	assert.equal(by(reconcile(n, mealie["fruity-rice-krispy-treats"], null)).tools.action, "same");
});

test("a standing conflict leaves the note byte for byte, date included", () => {
	const { body } = splitNote(chipped().text);
	const items = [{ field: "ingredients", vault: "a", mealie: "b" }];
	const day1 = withCallout(body, "2026-11-15", items);
	assert.equal(withCallout(day1, "2026-11-16", items), day1);
});

test("unchanged ingredients keep their Mealie objects; only changed lines are parsed", () => {
	const r = mealie["chipped-beef-gravy"];
	const lines = r.recipeIngredient.map(ingredientLine);
	lines[1] = "4 tbsp all-purpose flour";
	const merged = mergeIngredients(r.recipeIngredient, lines);
	assert.deepEqual(merged.map((m) => (m.keep ? "keep" : m.parse)), ["keep", "4 tbsp all-purpose flour", "keep", "keep", "keep", "keep"]);
	assert.equal(merged[0].keep, r.recipeIngredient[0], "the very same object, food and unit included");
});

test("steps keep their objects, a reworded step keeps its links, and dead links go", () => {
	const existing = [
		{ text: "Melt the butter.", title: "Roux", ingredientReferences: [{ referenceId: "a" }] },
		{ text: "Add milk.", ingredientReferences: [{ referenceId: "b" }, { referenceId: "gone" }] },
	];
	const out = mergeSteps(existing, ["Melt the butter.", "Add the milk slowly.", "Serve."], ["a", "b"]);
	assert.equal(out[0].title, "Roux");
	assert.equal(out[1].text, "Add the milk slowly.");
	assert.deepEqual(out[1].ingredientReferences, [{ referenceId: "b" }]);
	assert.deepEqual(out[2].ingredientReferences, []);
});

test("a recipe the sync is still creating is recognized", () => {
	assert.equal(readSync({ extras: { obsidian_sync: JSON.stringify({ v: 1, creating: true, fields: {} }) } }).creating, true);
	assert.equal(readBase({ extras: { obsidian_sync: JSON.stringify({ v: 1, creating: true, fields: {} }) } }), null);
});

// ── Re-check findings, 2026-11-15 ───────────────────────────────────────

test("a new item lands beside its neighbours; sub-headings and nested notes stay with their items", () => {
	const body = "## Ingredients\n### Dry\n- 1 cup flour\n  - sifted, ideally\n### Wet\n- 1 egg\n- 1 cup milk\n\n## Instructions\n1. Mix.\n";
	const out = setList(body, "Ingredients", ["1 tsp baking powder", "1 cup flour", "1 egg", "1 cup milk"]);
	assert.match(out, /### Dry\n- 1 tsp baking powder\n- 1 cup flour\n {2}- sifted, ideally\n### Wet\n- 1 egg\n- 1 cup milk\n/);
	assert.deepEqual(bullets(parseSections(out).ingredients), ["1 tsp baking powder", "1 cup flour", "1 egg", "1 cup milk"]);
	const removed = setList(out, "Ingredients", ["1 cup flour", "1 cup milk"]);
	assert.match(removed, /### Dry\n- 1 cup flour\n {2}- sifted, ideally\n### Wet\n- 1 cup milk\n/);
	const numbered = setList("## Instructions\n1. Mix.\n2. Bake.\n", "Instructions", ["Preheat.", "Mix.", "Bake."], { numbered: true });
	assert.equal(numbered, "## Instructions\n1. Preheat.\n2. Mix.\n3. Bake.\n");
});

test("comments and embeds are never recipe data, inline or across lines", () => {
	const section = "- 1 tsp salt %%Diamond Crystal%%\n%%\n- 1 tbsp malt powder\n%%\n- Mix.\n  ![[batter.jpg]]\n- 2 eggs";
	assert.deepEqual(bullets(section), ["1 tsp salt", "Mix.", "2 eggs"]);
});

test("the tagline is prose only; headings, lists and quotes in the section stay in the vault", () => {
	const body = "## Image and Tagline\n![[eggs.jpg]]\nFluffy.\n\n### Credit\nPhoto by Brian\n- a nested aside\n";
	assert.equal(tagline(parseSections(body)), "Fluffy.\n\nPhoto by Brian");
	const out = setTagline(body, "Light and fluffy.");
	for (const kept of ["![[eggs.jpg]]", "### Credit", "- a nested aside"]) assert.ok(out.includes(kept), kept);
	assert.equal(tagline(parseSections(out)), "Light and fluffy.");
});

test("an embed or comment in Mealie's text does not bounce back as a vault edit", () => {
	const r = structuredClone(mealie["chipped-beef-gravy"]);
	r.description = "Look ![photo](https://x.y/p.jpg) here. %%draft%%";
	r.recipeInstructions = [...r.recipeInstructions, { text: "![](https://x.y/step.png)" }];
	assert.deepEqual(roundTrip(chipped(), r), []);
	const merged = mergeSteps(r.recipeInstructions, r.recipeInstructions.map((s) => s.text).filter((t) => !t.startsWith("!")), []);
	assert.equal(merged.at(-1).text, "![](https://x.y/step.png)", "a step the vault cannot see stays in Mealie");
});

test("a Mealie Notes note mixing prose and bullets is all visible to the vault", () => {
	const r = { ...mealie["chipped-beef-gravy"], notes: [{ title: "Notes", text: "Use less salt.\n- or none" }] };
	assert.deepEqual(by(reconcile(chipped(), r, null)).notes.mealie, ["Use less salt.", "or none"]);
	assert.deepEqual(roundTrip(chipped(), r), []);
});

test("a bare number is minutes; text that is not a time leaves Mealie's alone", () => {
	const n20 = readNoteText(setFrontmatter(chipped().text, "prep time", "20"), "x.md");
	assert.equal(by(reconcile(n20, mealie["chipped-beef-gravy"], null)).prepTime.vault, 1200);
	const odd = readNoteText(setFrontmatter(chipped().text, "prep time", "a while"), "x.md");
	assert.equal(by(reconcile(odd, { ...mealie["chipped-beef-gravy"], prepTimeSeconds: 600 }, null)).prepTime.action, "pull");
});

test("a recipe being created takes nothing from Mealie's placeholder text", () => {
	const n = readNoteText(chipped().text.replace(/## Instructions[\s\S]*?(?=## Notes)/, ""), "x.md");
	const stub = { ...mealie["chipped-beef-gravy"], recipeInstructions: [{ text: "Recipe steps as well as other fields support markdown." }] };
	const d = by(reconcile(n, stub, null, { prefer: "vault", creating: true }));
	assert.equal(d.steps.action, "push");
	assert.deepEqual(d.steps.vault, []);
});

test("a section the note lacks, with nothing in Mealie either, is simply in sync", () => {
	const n = readNoteText(chipped().text.replace(/## Notes[\s\S]*?(?=## Image)/, ""), "x.md");
	const r = { ...mealie["chipped-beef-gravy"], notes: [] };
	assert.equal(by(reconcile(n, r, null)).notes.action, "same");
});

test("a value with ' #' is quoted, so YAML does not cut it at a comment", () => {
	const out = setFrontmatter(chipped().text, "name", "Grandma's Chili #2");
	assert.match(out, /^name: "Grandma's Chili #2"$/m);
	assert.equal(readNoteText(out, "x.md").name, "Grandma's Chili #2");
});

test("an edited ingredient keeps its row's title and reference id; title-only rows stay", () => {
	const existing = [
		{ title: "For the roux", originalText: "3 tbsp butter", display: "3 tbsp butter", referenceId: "r1" },
		{ originalText: "3 tbsp flour", display: "3 tbsp flour", referenceId: "r2" },
		{ title: "To finish", display: "", referenceId: "r3" },
		{ originalText: "Toast", display: "Toast", referenceId: "r4" },
	];
	const merged = mergeIngredients(existing, ["4 tbsp butter", "3 tbsp flour", "Toast"]);
	assert.deepEqual(merged.map((m) => (m.keep ? `keep:${m.keep.referenceId}` : `parse:${m.parse}<-${m.reuse?.referenceId}`)), ["parse:4 tbsp butter<-r1", "keep:r2", "keep:r3", "keep:r4"]);
	assert.equal(merged[0].reuse.title, "For the roux");
});

test("recommended by compares the same however either side spaced it", () => {
	const n = readNoteText(setFrontmatter(chipped().text, "recommended by", "Mom,Dad"), "x.md");
	const r = { ...mealie["chipped-beef-gravy"], extras: { ...mealie["chipped-beef-gravy"].extras, recommended_by: "Mom, Dad" } };
	assert.equal(by(reconcile(n, r, null)).recommendedBy.action, "same");
});
