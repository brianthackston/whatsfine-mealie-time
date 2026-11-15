# Mealie, Obsidian and whatsfine.com: where they stand (2026-11-14)

An assessment of the three places a WhatsFine recipe lives, and the plan to
make them agree. It came from a read-only audit: five auditors (site sync,
Mealie data, Obsidian round trip, SEO and display, platform and docs). A
skeptic re-checked each auditor's findings, then a critic looked for gaps.
Nothing was written to Mealie, the vault or production. Raw findings, with
evidence for each: the session scratchpad's `assessment.json`.

## The short version

**The three systems have never been in sync, and the first real sync would
make the site worse.**

- **Production has never been written by `mealie:sync`.** All three live
  recipe articles have `mealie_sync = null` and no featured image. Their
  recipe text comes from the site's old seed scripts (`update-recipe-grids.mjs`,
  `gen-recipe-sql.mjs`) and later hand edits, not from Mealie.
- **Mealie and the vault agree with each other**, except on name casing. Both
  disagree with the live site's wording.
- **The only Mealie is the local test container** (`mealie-local`, v3.29.0,
  default admin password, listening on all interfaces), and its data has no
  backup. `mealie-local.json` points the site sync at it, and the sync targets
  production by default.
- **Nothing runs unattended.** There is no home box, no cron and no scheduled
  Obsidian run. `recipes.whatsfine.com` does not resolve.

What a real `pnpm run mealie:sync` would do today (dry run plus a simulated
mapping against live data):

| Page | Change | Good? |
|---|---|---|
| new `/recipes/brown-butter` | publishes a test fixture. Its "video" is a Steve Ballmer "Developers" clip, and its one photo is the site's own OG title card | no |
| fruity-rice-krispy-treats | serves becomes "Makes 12 Makes 12". The hand-drawn grid and the "Butter a 9×13 pan" prep row are replaced by a derived grid with clipped labels | no |
| sausage-gravy-and-crackers | "Serves 4–6" becomes "Serves 4" | no |
| all three | ingredient lines become parser output: "4 ounces dried chipped beef torn", "black pepper plenty", "¹/₄ cup", and "bulk" is lost | no |
| all three | step wording reverts to the vault's version of the text ("big pot" becomes "large pot", and so on) | needs a decision |
| chipped beef, sausage gravy | hand grids kept; titles, deks, stories and kickers untouched | yes |

The good news: the pillar rename on 2026-11-14 did not break the sync. The
SEO plumbing is sound. Every page has a canonical, OG tags, a resolving
`@graph` with a Recipe, a BreadcrumbList and an ItemList, and `verify-jsonld`
passes against production. What holds the pages back is the data going in.

## Decisions only Brian can make

1. **Which recipe wording is canonical.** The live pages carry the newest hand
   edits. Mealie and the vault carry the older vault rewrite. Recommendation:
   take the live text into the vault once, then push it to Mealie, so the
   first sync is a no-op on wording.
2. **Name casing.** The site seed stored `recipe.title` in sentence case
   ("Chipped beef & gravy") and the article title in Title Case. `seed.mjs`
   preferred the former, so Mealie has sentence case while the vault, the h1
   and the OG cards have Title Case. Recommendation: Title Case everywhere,
   with the article title used for the JSON-LD `name`.
3. **Brown butter.** Delete it, or keep it out of the cookbook until it has a
   real photo, a real video and a vault note. It was created on 2026-11-06 as
   a demo for the /food preview.
4. **Does "Draft" stop publishing?** Every vault note says `status: Draft`,
   including the three live recipes, and nothing reads that status. Either
   make an explicit publish flag (recommended: `whatsfine: true` in the note,
   which adds or removes the WhatsFine tag), or drop the status from the
   pipeline.
5. **Where the real Mealie lives, and how it gets there.** Migrate the local
   database with a Mealie backup and restore, not by re-seeding. Re-seeding
   changes every id the vault and site already hold.

## The plan

### Stage 0: protect what exists (done 2026-11-14)

- **Backed up.** A Mealie backup zip (`mealie_v3.29.0_2026.11.15.02.32.54.zip`)
  and a tarball of the raw `whatsfine_mealie-local-data` volume are in
  `C:\Users\brian\Backups\mealie\` and in the private R2 bucket
  `whatsfine-mealie-backups` under `local/`. The bucket has no public URL,
  no custom domain and no Worker binding; the zip's checksum matches. The
  deploy README's claim that Mealie backs itself up daily is corrected.
- **Off the network.** `whatsfine/docker-compose.yml` now publishes
  `127.0.0.1:9925` only; the LAN address refuses connections. The default
  admin password is unchanged: change it in Mealie's profile page when
  convenient (the site sync uses an API token, which survives that).
- **Brown butter is out of the cookbook.** Its WhatsFine tag is removed; the
  recipe, its asset and extras are untouched. The production dry run now
  shows 0 created, 3 updated.
- Still true until Stage 2: run `mealie:sync` only with `--dry-run`.

### Stage 1: make the site sync safe and faithful (site repo)

**Done 2026-11-14:** whatsfine commit `dd84ee7`, live as Worker version
`f90f20fc`. Everything below shipped except the VideoObject markup, which
needs a thumbnail and upload date, and showing `recipe.notes` on the page.
It also guards against things the list didn't foresee, found by two review
rounds: a Mealie duplicate taking the original's page, a deleted article
being re-created, failed publishes going quiet, and cleanup deleting
shared media. The details are in `docs/mealie-sync.md` there. The dry run
now shows wording differences only.

In `scripts/mealie-sync.mjs` and `scripts/lib/mealie-map.mjs`:

- Make writes to production explicit: require `--prod` (or `--site`). Refuse
  when the Mealie URL is localhost unless told otherwise.
- `formatServes`: use the yield text when it is already a sentence ("Makes
  12", "Serves 4–6"). Only build "Makes N unit" when the text is a bare unit.
  Never let `recipeServings` override a range.
- Ingredients: render `originalText` (what the cook wrote), not the parser's
  `display`.
- Keep a hand grid when its rows still match. Keep prep rows. Fix the prefix
  match ("salt" must not match "saltine").
- Run the OG-card check on gallery assets, not only on the featured image.
- Don't publish a pending admin draft. If the article has unpublished
  changes, skip it and say so.
- Make the dry run print a field-level diff.
- Set `featured_image` on existing articles when it is empty and Mealie has a
  real photo.
- JSON-LD: take `recipeCategory` from Mealie's categories, not the hardcoded
  "Food". Use the article title for `name`. Set the WebPage `mainEntity` to
  the Recipe. Emit `prepTime`/`cookTime` when present and a VideoObject for
  video. Drop the internal tags from `keywords`.
- Retire the other writers of the recipe field: `gen-recipe-sql.mjs` and the
  reseed scripts still treat `seed.json` as the source of truth and write
  production by raw SQL.

### Stage 2: reconcile the content once, then run the first real sync

**Done 2026-11-15.** Brian chose live wording and Title Case names. The
vault notes now carry the live text. The three WhatsFine notes were pushed
to Mealie and the names set. The first production sync ran at 06:31 UTC,
with D1 bookmark `000038e0-000008d4-00005124-49d50a12ccb019baa93338895de6aa97`
taken beforehand. It changed only each recipe's title casing, category and
notes. A second run reported all three unchanged, and the live checks pass.
Since then, whatsfine.com, Mealie and the vault agree on these recipes.

1. Bring the live wording (Decision 1) into the vault notes. Fix the names
   (Decision 2). Fruity's hand grid and prep row now survive the sync
   either way. The sync keeps the article's prep row and folds Mealie's
   "Butter, for greasing the pan" into it.
2. Push the vault to Mealie, after the Stage 3 fixes below that touch push.
3. Snapshot production (the repo's pre-prod-write bookmark), run
   `pnpm run mealie:sync:dry`, and read the field-level diff. It should
   show only the new fields (category, notes). Then run
   `pnpm run mealie:sync -- --prod --allow-test-mealie`, since the only
   Mealie is still the test instance. Then run `verify-jsonld`.

### Stage 3: an Obsidian ↔ Mealie sync that can stay in sync (this fork)

**Done 2026-11-15.** `pnpm obsidian:sync` (`seed/obsidian.mjs`, with
`seed/lib/contract.mjs` and `seed/lib/note.mjs`) replaces push and pull. It
is built as planned below, and two independent review rounds pushed it
further:

- **Write order and dry runs.** Writes go note first, then Mealie, with the
  agreed hashes last, and `--dry-run` writes nothing anywhere.
- **Merged lists.** An edited ingredient keeps its section title and the ID
  steps link to, and new lines get a stable ID. Mealie invents a fresh ID on
  every read for a row stored without one.
- **Obsidian-only content stays put.** Comments, embeds, sub-headings and
  nested items never reach Mealie, and keep their place when lists change.
- **Ratings.** ⭐ is your own Mealie rating, not the all-users average.
- **Guards.** A run against the wrong Mealie stops without writing. A crash
  during a create is finished by the next run. A stale lock is taken over.

On the real vault, the first run added `whatsfine: true` to the three
WhatsFine notes and created Kielbasa Stuffing in Mealie, off the site. The
second run found all four in sync. Brown butter was skipped (Decision 3).
There are 44 tests (`pnpm test`). The site sync now leaves an article alone
when Mealie changed nothing it shows, so this sync's bookkeeping causes no
article rewrites.

The plan as written before the work:

`seed/obsidian.mjs` today pushes unconditionally and pulls only new notes.
Replace push and pull with one `sync` command built on a contract:

- **Owners.** The vault owns the recipe text: ingredient lines (stored as
  Mealie's `originalText`), steps, a new `## Prep` section, tagline, `## Notes`,
  categories, cuisine tags, tools, times, yield, source, status, ⭐ → rating.
  Mealie owns the id, slug, photos, assets, parsed quantities, the
  "WhatsFine tip" and "Printable card" notes, and `extras.whatsfine_*`. The
  vault never sends "Immediate Thoughts" or unknown sections.
- **Conflicts.** Use a three-way hash, not timestamps. Mealie's `updatedAt`
  moves on every write, including the site's write-back, and file mtimes move
  with Obsidian Sync. Store the hash of the last reconciled fields in the note
  (`mealie sync:`). The side that changed wins. When both sides changed, the
  rule is: disjoint fields merge, overlapping fields get a warning callout in
  the note and are not written.
- **Pull updates in place.** It rewrites only the owned frontmatter keys and
  section bodies, keeps everything else, and writes only when the bytes
  differ.
- **Deletes.** A recipe deleted in Mealie becomes `status: Archived` in the
  note. It is never re-created. Remove `--replace`, or put it behind a backup.

Bugs to fix along the way:

- `cookTimeSeconds` is not a Mealie field. The field is `performTimeSeconds`.
- The `/articles/` regex misses `/recipes/` sources, which would create
  duplicate articles.
- Push writes the yield text but leaves `recipeYieldQuantity` and
  `recipeServings` stale.
- A pulled note pushed back loses the WhatsFine tag.
- Pull flattens all notes into one list.
- `1h30m` parses as 30 minutes.
- Emptied fields never clear in Mealie.
- `ensureOrganizers` renames global tags on a case mismatch.
- Auth: push and pull read only environment variables, not a local token
  file, so the documented cron line cannot authenticate.

### Stage 4: run it unattended

**Partly done 2026-11-15.** Done:

- **Upgrade.** Merged upstream v3.31.0 (merge `491cc783`, which brings the
  security fixes), bumped both compose files, and pinned `cloudflared` to
  2026.10.7. Backed up, then upgraded the local Mealie: its migration ran,
  and all three syncs still agree.
- **Backups.** `deploy/backup.mjs` makes a Mealie backup, keeps 14, and
  copies each zip to the private R2 bucket.
- **The runner.** `deploy/run.mjs` gives each job a lock, a log, a status
  file and a failure webhook.
- **Schedules on PORTABLETEXT.** The Obsidian sync runs every 15 minutes and
  the backup daily, from Task Scheduler. Both are tested.
- **One runbook.** `deploy/README.md` is it, and the site doc points there.
- **The site's `RUNBOOK.md`** turned out to be brianthackston.com's. It now
  carries a warning and the right D1 backup method; a full rewrite is a
  follow-up.

Left, mostly Brian's:

- the box itself, restored from a backup (steps in `deploy/README.md`)
- an alert webhook URL
- the R2 lifecycle rule
- Tunnel and Access, only for using Mealie away from home

Until the box exists, the site sync stays manual.

The plan as written before the work:


- Merge upstream **v3.31.0** into `whatsfine`. The merge is clean, and it
  carries cross-group write, stored-HTML-injection and asset-permission fixes.
  Back up first, because migration `127804c19431` drops `cook_time`. Then
  bump both compose files and pin `cloudflared`.
- Stand up the home box from the Stage 0 backup. Change the password, add a
  non-admin sync user and token, and back up to R2.
- Schedule two jobs. The Obsidian sync runs on the **PC that has the vault**
  (Task Scheduler), a few minutes before `mealie:sync` runs on the box (cron),
  each with a lockfile and a failure alert. The documented single cron line
  that runs `obsidian:pull` on the box cannot work, because the box has no
  vault.
- Reconcile the three docs that describe this (fork deploy README,
  ORIENTATION §9, site `docs/mealie-sync.md`) into one runbook, and fix the
  stale /food references.

### Stage 5: elegant pages and rich results

**Partly done 2026-11-15:** whatsfine commit `5ed0560`, live as Worker
version `6edf7827`; `verify-jsonld` and `check:live` (195 pages) pass.
The prod sync then wrote the tools (2 updated, 1 unchanged; a second dry
run says 3 unchanged), and they are live on the cards and in the JSON-LD.
Done:

- **Images ready for real photos.** The recipe page's hero is a responsive
  16:9 `srcset` with `fetchpriority="high"`. The Recipe JSON-LD lists
  16:9, 4:3 and 1:1 crops of the dish photo, falling back to the first
  gallery image and then the OG card. `og:image` is a 1200×630 crop of
  the photo when there is one.
- **The card reads better.** On phones a plain Ingredients list comes
  before the grid. The card has real headings: the recipe name (h2), then
  Ingredients, At a glance and The method (h3). Mealie's tools show as a
  "You'll need" line and as schema.org `HowToTool` (`MAP_VERSION` 5).
- **`/recipes` cards** show time and servings instead of read time. A
  card without a photo no longer shows "Recipe photo" text. The lead
  card's image loads eagerly.
- **Canonicals** on `/recipes` and the home page (`og:url` follows).
- **Links.** The free recipe-card product page links back to its recipe.
  Site search links recipe results to `/recipes/`, not through the
  `/articles/` 301.

Still open:

- **Real dish photos** (Brian). Upload one in Mealie; the next sync puts
  it on the page, the JSON-LD and the share card.
- **`www` → apex redirect.** It needs a Cloudflare Redirect Rule on the
  zone, which is Brian's to approve.
- Site search indexing recipe text (an emdash search-field change),
  rendering `recipe.notes`, and VideoObject markup. The site's
  `docs/mealie-sync.md` "Not done" keeps this list.

The plan as written:

- **Real dish photos.** This is the biggest single gain. Google's recipe rich
  result needs a real image, ideally in 16:9, 4:3 and 1:1. Today every image
  in Mealie is a text card, and every recipe card on the site shows a "RECIPE
  PHOTO" placeholder.
- On phones, show a plain ingredient list before the operation grid. Add
  Ingredients and Method headings.
- Recipe cards on `/recipes`: show time and servings instead of read time.
  Eager-load the lead image.
- Add a canonical and `og:url` to `/recipes` and the home page. Redirect
  `www.whatsfine.com` to the apex; today it answers 200.
- Link the free recipe-card product page back to its recipe. Make site search
  index recipe text and link `/recipes/`, not `/articles/`.
