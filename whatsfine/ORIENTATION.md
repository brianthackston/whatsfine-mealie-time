# Mealie, for WhatsFine: an orientation

Written 2026-10-22 against upstream `mealie-next` at `7f099c91` (latest release
**v3.29.0**, 2026-10-17). This is a map of the codebase and of the places it
can meet our stack. It is not a plan: no creative or strategic direction has
been set yet.

This file lives in `whatsfine/` on purpose. Upstream has no such folder, so
nothing in it can ever conflict with an upstream merge. See "Staying aligned"
below.

---

## 1. What Mealie is

A self-hosted recipe manager, meal planner and shopping list. Users import a
recipe by pasting a URL (Mealie scrapes it), or type one in. Recipes are then
organised into cookbooks, tags, categories and tools, and fed into meal plans
and shopping lists.

| | |
|---|---|
| Backend | Python **3.14**, FastAPI, SQLAlchemy 2, Alembic, Pydantic 2 |
| Frontend | Nuxt 4 (Vue 3, TypeScript), Vuetify; statically generated in prod |
| Database | SQLite (default) or PostgreSQL |
| Files | Local disk under `/app/data` (images, backups, user assets) |
| Shipping | One Docker image, port 9000. FastAPI serves the API **and** the built SPA |
| Tooling | `uv` for Python, `pnpm` for the frontend, `task` (Taskfile.yml) for everything |
| License | **AGPL-3.0-only** (see section 6) |
| Pace | ~227 commits in the last 30 days; a minor release every 1-3 weeks |

The repo's own [AGENTS.md](../AGENTS.md) (which `CLAUDE.md` links to) is good
and current. Read it before changing anything; this file does not repeat it.

## 2. Architecture map

```
mealie/
  app.py, main.py      FastAPI app + uvicorn entrypoint
  core/settings/       All config: env vars -> pydantic-settings (see section 3)
  routes/              Controllers, by domain. The HTTP layer only.
    explore/           PUBLIC, unauthenticated read API (cookbooks, recipes, foods)
    recipe/            Recipe CRUD + the create/* importers (url, html-or-json, ai, zip)
    groups/ households/ users/ admin/ auth/ media/ spa/
  services/            Business logic. The interesting ones:
    scraper/           URL import: recipe-scrapers + schema.org extraction (extruct)
    openai/            AI import, ingredient parsing, translation, video transcription
    event_bus_service/ Every create/update/delete becomes an Event -> Apprise / webhooks
    scheduler/         In-process cron (daily tasks, scheduled webhooks)
    parser_services/   Ingredient parsing (NLP model, or AI)
    exporter/ backups_v2/ migrations/   Data in and out (incl. imports from other apps)
  repos/               Data access. Every repo is scoped to group + household
  db/models/           SQLAlchemy models;  alembic/ holds the migrations
  schema/              Pydantic In/Out/Create/Update models -> TS types (codegen)
frontend/app/
  pages/ components/ composables/ lib/api/   Nuxt app; lib/api/types is GENERATED
```

Three things that shape everything else:

1. **Repository -> Service -> Controller.** Controllers stay thin, services own
   logic, repos own SQL. A fork change usually touches one service, and
   rarely a controller.
2. **Multi-tenancy.** A *group* holds *households*; households hold recipes,
   meal plans and shopping lists. Repos filter by both automatically. Anything
   we build that talks to the API needs a group slug (and often a household).
3. **Codegen is the source of truth.** Pydantic schemas generate the frontend's
   TypeScript types and the `schema/*/__init__.py` exports
   (`task dev:generate`). Changing a schema without regenerating breaks the
   frontend, and makes our diffs noisier against upstream.

## 3. Extension points that need no fork at all

Most of what we would want is reachable with **configuration and the API**,
which costs nothing to keep in step with upstream. Check this list before
patching anything.

| Want | Upstream mechanism | Where |
|---|---|---|
| Our name, logo, favicon, title | `BRANDING_NAME`, `BRANDING_LOGO_PATH` (landed 2026-10-14, #8078) | `core/settings/branding.py` |
| Our colours | `THEME_LIGHT_PRIMARY` ... `THEME_DARK_ERROR` (14 vars) | `core/settings/themes.py` |
| Sign-in through our identity | `OIDC_*` (any OIDC provider), `LDAP_*`, or `REVERSE_PROXY_AUTH_*` (trust a header from a proxy, guarded by a shared secret header) | `core/settings/settings.py` |
| AI on our account | AI providers are stored **per group in the DB** (since 2026-05), each with a `base_url`. Any OpenAI-compatible endpoint works | `services/openai/openai.py:171`, `routes/groups/controller_group_ai_providers.py` |
| React to changes | Event notifiers: Apprise URLs per event type (recipe created/updated/deleted, meal plan, shopping list, cookbook, tag, category, label). Apprise's `json://` / `jsons://` posts the event to any URL | `services/event_bus_service/` |
| Daily push of the meal plan | Group webhooks: POST the day's meal plan at a set time of day | `event_bus_listeners.py` (`WebhookEventListener`) |
| Read recipes publicly | `GET /api/explore/groups/{group_slug}/recipes`, `/{recipe_slug}`, plus cookbooks and organizers. No auth, for public groups and recipes | `routes/explore/` |
| Script it | Long-lived API tokens per user; full OpenAPI docs at `/docs` (`API_DOCS`) | `routes/users/api_tokens.py` |
| Push recipes in | `POST /api/recipes/create/url`, `/create/html-or-json` (paste schema.org JSON-LD), `/create/url/bulk`, `/create/ai`, `/create/zip` | `routes/recipe/recipe_crud_routes.py:213-541` |
| Scrape sites that block bots | `SCRAPER_PROXY_URL`, `SCRAPER_FLARESOLVERR_URL` | settings |
| Email | `SMTP_*` (no HTTP-API mailer; Resend works via its SMTP relay) | settings |

## 4. How it fits our stack

### It cannot run on Workers

Mealie is a long-lived Python process with native dependencies (lxml, Pillow,
an NLP ingredient model, yt-dlp, python-ldap), a local filesystem and an
in-process scheduler. None of that is Workers-shaped, so a port would be a
rewrite, not a fork. Treat Mealie as **a container that our Workers talk to**.

### Hosting options, roughly in order of effort

| Option | How | Catch |
|---|---|---|
| **A. A small always-on box + Cloudflare Tunnel** | Run the stock image (VPS, NAS, or a home machine). `cloudflared` publishes it on e.g. `recipes.whatsfine.com`; Cloudflare Access gates it | A machine to keep alive and back up. Simplest, and exactly how upstream expects to be run |
| **B. Cloudflare Containers** | A Worker fronts a `Container` running the image | Container disk is **ephemeral**: it resets whenever the instance sleeps. You'd need external Postgres (`DB_ENGINE=postgres`, `POSTGRES_URL_OVERRIDE`) plus `/app/data` on R2 through a FUSE mount, or snapshots. The scheduler only runs while awake. Doable, but experimental for an app this stateful |
| C. Managed container hosts (Fly, Railway...) | Image + a persistent volume | Off-stack; a second bill and a second dashboard |

Either way, put **Cloudflare Access** in front. Mealie's `REVERSE_PROXY_AUTH_*`
can trust the Access header `Cf-Access-Authenticated-User-Email`. Its secret
header has to be injected by something Mealie trusts: a Transform Rule, or the
fronting Worker in option B. The other route is `OIDC_*` against Access acting
as an OIDC provider.

### Places WhatsFine and Mealie can meet

WhatsFine is EmDash on Astro, on Workers (D1, R2, Images, Browser Rendering,
Resend). A recipe there is a `recipe` JSON field on an `articles` entry. Per
the seed, its shape is `title, serves, time, ingredients[], steps[], product`
(`whatsfine/seed/seed.json:88`, rendered by `src/components/RecipeCard.astro`).

1. **WhatsFine -> Mealie: emit schema.org `Recipe` JSON-LD.** WhatsFine
   currently emits Organization, Person, Product and ItemList, but **no
   `Recipe`** (`whatsfine/src/lib/seo.ts`). Adding it means anyone running
   Mealie, Paprika and the like can import a WhatsFine recipe by URL, and it
   makes those pages eligible for Google recipe rich results. This is the
   smallest change with the widest reach, it lives in the WhatsFine repo alone,
   and it needs no fork at all.
2. **Mealie -> WhatsFine: Mealie as the recipe source.** Recipes get written
   and tested in Mealie, then Astro reads them from the public explore API at
   request time, cached at the edge like everything else. Or a sync job copies
   them into the EmDash `recipe` field. This decides which system "owns" a
   recipe, so it is a strategic choice, not a technical one.
3. **Mealie events -> a Worker.** An Apprise `jsons://` notifier on
   `recipe_created` / `recipe_updated` calls a WhatsFine endpoint. That could
   purge the edge cache, re-render the PDF the site already builds to R2, or
   queue a newsletter draft.
4. **AI through our gateway.** Point a Mealie AI provider's `base_url` at
   Cloudflare AI Gateway (`https://api.cloudflare.com/client/v4/accounts/{id}/ai/v1`
   or `gateway.ai.cloudflare.com/.../compat`). That gives us logging, caching
   and spend limits, and lets the model be OpenAI, Anthropic or Workers AI
   without touching Mealie.
5. **Shared look.** `BRANDING_*` and `THEME_*` get Mealie most of the way to
   WhatsFine colours with zero code. Forest, cream and sun live in
   `whatsfine/src/styles/theme.css`.

Field mapping, if (1) or (2) happens:

| WhatsFine `recipe` | Mealie `Recipe` | schema.org `Recipe` |
|---|---|---|
| `title` | `name` | `name` |
| `serves` | `recipe_servings` / `recipe_yield` | `recipeYield` |
| `time` | `total_time` (+ prep/cook/perform) | `totalTime` (ISO 8601 duration) |
| `ingredients[]` | `recipe_ingredient[]` (note, or parsed qty/unit/food) | `recipeIngredient[]` |
| `steps[]` | `recipe_instructions[]` (`text`) | `recipeInstructions[]` (`HowToStep`) |
| article `featured_image` | `image` | `image` |
| `product` | (no slot; an extra or a tag) | (none) |

## 5. Staying aligned with upstream

Upstream moves fast (~50 commits a week, many of them Crowdin locale syncs), so
the fork's cost is the size of our diff. Keep that diff as small as possible:

- **Remotes:** `upstream` is `mealie-recipes/mealie` (default branch
  `mealie-next`); `origin` is our fork, `brianthackston/whatsfine-mealie-time`,
  created 2026-10-22 with `--default-branch-only`. Its default branch is
  `whatsfine`.
- **Branches:** leave `mealie-next` as a pure mirror of upstream. Our work is on
  the `whatsfine` branch, which merges (not rebases) upstream after each release
  tag, so the merge history records which release we're on.
- **Prefer, in this order:** env/config -> API from our own Workers -> files in
  `whatsfine/` (docs, compose, deploy) -> small upstream-shaped patches.
  Anything that would help other Mealie users is better sent upstream as a PR
  than carried here forever.
- **Never edit** non-`en-US` locale files (Crowdin owns them),
  `frontend/app/lib/api/types/`, or the generated `schema/*/__init__.py`.
  Regenerate them instead.
- **Ship our image** from a GitHub Action that builds `docker/Dockerfile` off
  the `whatsfine` branch and pushes to GHCR. Upstream's image is
  `ghcr.io/mealie-recipes/mealie` until we have a reason to diverge.

## 6. Things to know before going further

- **AGPL-3.0.** If we run a *modified* Mealie where other people use it over
  the network, we must offer those users its source: a public fork on GitHub
  plus a link in the UI covers this. Stock Mealie, configured, carries no extra
  obligation, and neither does WhatsFine's own code calling Mealie's API over
  HTTP. This is the usual reading, not legal advice. It is one more reason to
  keep changes in config.
- **Local dev on this machine:** Docker Desktop is installed but was not
  running; `uv` and `task` are not installed. The quickest way to try it is
  `docker compose -f whatsfine/docker-compose.yml up -d`, which runs upstream's
  published v3.29.0 image on :9925 (no build). Note upstream's `.gitignore`
  has `*.local.*`, so don't name fork files that way. For real backend work,
  use the repo's dev container, since `python-ldap` is painful on native
  Windows.
- **Not yet decided:** whether Mealie is for the household, for the WhatsFine
  crew's recipe development, or something public-facing. That choice decides
  which recipe "owns" which, the hosting option, and whether we ever need to
  patch the code at all.

## 7. Brand fit: what is done, and how

Added 2026-10-22. Everything in this section is configuration and API calls;
Mealie's code is untouched.

### Look (`brand/`)

`brand/mealie.env` sets `BRANDING_NAME=WhatsFine`, the logo, and all fourteen
`THEME_*` colours from the site's tokens (`whatsfine/src/styles/tokens.css`).
The compose file loads it and mounts the logo. Where each colour lands:

| Mealie key | Light | Dark | Reaches |
|---|---|---|---|
| `primary` | forest `#113939` | forest-600 `#1b4f4c` | app bar, primary buttons, active nav, the logo avatar |
| `accent` | tomato `#f0432b` | tomato | links, highlights, secondary buttons |
| `secondary` | sun `#ffc22e` | sun | a few chips and toggles (Vuetify puts ink text on it) |
| `success` / `info` / `warning` / `error` | the site's functional set | brighter pop variants | alerts, status chips |

`brand/mark.svg` is the "WF?" wordmark (`.mk` on the site, question mark in
sun) on a forest tile with the site's `--r-xl`-ish radius. Mealie shows the
logo at 40px in the app bar, 75px on the login page, and as the favicon; the
tile vanishes into the forest bar and leaves the glyphs. `mark-q` is the
question mark alone, if three glyphs prove too small at 40px. Because Mealie
serves the logo through `<img>`, the font can't be loaded at display time, so
`build-logo.mjs` fetches Bricolage Grotesque (the same way the site's OG route
does) and renders the committed PNGs. Edit the SVG, run `pnpm logo`, commit
both.

### Content (`seed/`)

`seed/seed.mjs` turns every published article with a `recipe` field into a
Mealie recipe through the API. It establishes the conventions Mealie will
carry for WhatsFine content:

| In Mealie | From WhatsFine | Why |
|---|---|---|
| Category **Food** | the article's `pillar` | pillars are the site's top-level sections |
| Tags **WhatsFine**, **Recipe** | fixed source tag + the article's `kicker` | the source tag is what the cookbook filters on; the kicker is the site's own sub-type |
| Cookbook **WhatsFine** (public) | `tags.name CONTAINS ALL ["WhatsFine"]` | one shareable page listing everything from the site |
| Note "WhatsFine tip" | `recipe.note` | the card's one-line advice, kept as a note so it survives Mealie's step editing |
| Note "Printable card" | `recipe.product` → `/shop/{slug}` | links the recipe to the shop item it came from |
| `extras.whatsfine_article`, `extras.whatsfine_product` | slugs | machine-readable back-references for any later sync |
| Recipe image | `/og.png?title=…&kicker=…&pillar=food` | the site already renders a branded card per article; real photos can replace it later via the recipe page |
| `orgURL` | `/articles/{slug}` | Mealie shows it as the source link |

Re-running is safe: existing recipes (matched by name) are skipped unless
`--replace`. `--seed-foods` also runs Mealie's own en-US foods and units
seeders, which a fresh group doesn't get on its own; do that once per group.
The mapping in `toRecipeJsonLd()` is the schema.org shape the site should emit
itself (task `cap-20261022-recipe-jsonld`); once it does, the script can
import by URL and that function retires.

**Verified live 2026-10-25** against the compose stack (v3.29.0): foods and
units seeded, three recipes created with the OG card stored as the image, the
cookbook filter returns all three, notes and extras land, `orgURL` is set. Two
things to know about how Mealie reads the payload:

- Keywords are title-cased on import ("Whatsfine"), but a tag that already
  exists with the same slug keeps its name, so the script creates **WhatsFine**
  first (`ensureTags`) and repairs the casing if an earlier run got there.
- `recipeYield` "Serves 4–6" becomes `recipeServings: 4` with an empty yield
  text; "Makes 12" becomes 12 servings. That's Mealie's `clean_yield` reading
  the first number, and it is the behaviour the site's own JSON-LD will get
  from any importer, so keep the site's `serves` strings number-first.
- `totalTime` "PT20M" lands as `totalTimeSeconds: 1200` and shows as
  "20 minutes"; the legacy `totalTime` text stays null, which is fine.
- The public explore API (`/api/explore/groups/home/...`) answers 404 until
  the group, household and recipes are marked public in Mealie's settings;
  the seed doesn't do that.

### Small patches worth carrying, if we want them

Each is a few lines, and the first two are plausible upstream PRs, which is
the cheapest way to carry a change.

1. **Background colour.** `frontend/app/plugins/theme.ts` already lists
   `background` among the theme variations, but `core/settings/themes.py` has
   no `THEME_LIGHT_BACKGROUND` / `THEME_DARK_BACKGROUND`. Adding them (settings,
   the `AppTheme` schema, codegen, theme.ts) would put Mealie on cream
   `#fbf4e6` and forest-800 instead of Vuetify's white and near-black. That's
   the single biggest visual step after the colours above.
2. **Fonts.** Mealie uses Vuetify's Roboto. Bricolage Grotesque for headings
   and Hanken Grotesk for body is a `nuxt.config.ts` font entry plus a short
   CSS file. Not upstreamable as-is (upstream would want it configurable), so
   this one is a fork-only patch, kept tiny.
3. **"Mealie" where `BRANDING_NAME` should be.** The app bar uses the
   branding name, but four places still hardcode the product name: the
   toolbar title on `pages/login.vue:59`, `pages/register/index.vue:23` and
   `pages/admin/setup.vue:17`, and the copyright line in
   `components/Layout/LayoutParts/AppFooter.vue:27`. Seen on the live login
   page under the WF? logo. A four-line change to use `$appInfo.brandingName`,
   and a natural upstream PR, since #8078 introduced the setting and missed
   these.
4. **Nothing else in the UI.** Copy lives in `frontend/app/lang/messages/`;
   upstream permits edits to `en-US.json` only, and a voice pass there would be
   a large, conflict-prone diff. Keep the copy stock.

## 9. The shape it's taking (decided 2026-10-25)

Brian's direction: recipes live as a section of whatsfine.com (`/food`), and
Mealie is a WhatsFine-branded app on hardware at home, fed from Obsidian.
That settles the open questions in section 6 like this:

```
Obsidian vault ──push──▶ Mealie at home ──sync──▶ whatsfine.com/food
010 - Recipes/            recipes.whatsfine.com     (site keeps its own copy;
(drafts, Recipe - BT      via Tunnel + Access        serves when the box is off)
 template)                the family's kitchen app
```

- **Obsidian is where a recipe starts.** `seed/obsidian.mjs push` reads
  `010 - Recipes`, creates or updates the Mealie recipe, parses ingredients,
  and writes `mealie id` back into the note so the vault's "Not in Mealie"
  Base view empties as drafts land. `recipe type` becomes the Mealie
  category, `tools` become tools, `cuisine` becomes tags, the Notes section
  becomes a note, `source` becomes the source link (a whatsfine.com article
  URL also tags it WhatsFine, which is what the cookbook filters on). A
  second push updates in place and keeps anything Mealie has that the note
  has no section for. `pull` goes the other way for recipes typed straight
  into Mealie, creating notes from the template. Verified live on all three
  drafts, twice.
- **Mealie owns the structured recipe.** Both scripts now run Mealie's NLP
  ingredient parser (`/api/parser/ingredients`) and store quantity, unit and
  food, which is what makes the servings control, shopping lists and meal
  plans work; lines it can't parse with confidence stay as plain notes.
  Categories are the drafts' `recipe type` (Breakfast, Dessert, Snack); the
  pillar is always Food, so `seed.mjs` no longer sets a category.
- **The site is the published copy.** Built 2026-10-25 in the whatsfine repo
  (commit `1926c48`, `docs/mealie-sync.md` there): a Worker cron pulls the
  WhatsFine cookbook hourly (or on demand, `POST /api/mealie/sync`) into a
  `recipes` collection in D1 with images copied to R2, and `/food` renders
  only from that copy, so whatsfine.com never depends on the home box being
  up. What that sync reads, and so what our scripts must keep true:
  - the cookbook slug `whatsfine` (tag **WhatsFine**);
  - the first tag that isn't WhatsFine is the page's kicker chip, so
    `obsidian.mjs` tags **Recipe** before any cuisine;
  - `recipeIngredient[].display` (Mealie fills it for parsed ingredients);
  - the note titled **WhatsFine tip** is the card's one line, **Printable
    card** is dropped, every other note is published under the card, which
    is why "Immediate Thoughts" never leaves the vault;
  - `extras.whatsfine_article` makes `/food/<slug>` redirect to the article,
    so a recipe never has two pages; `extras.whatsfine_product` links the
    shop card; `orgURL` shows as "Adapted from" when it isn't ours.
  Article pages now emit Recipe JSON-LD, so once the site is deployed
  `seed.mjs` can import by URL and its `toRecipeJsonLd()` can go.
- **Hosting is settled:** section 4's option A. `deploy/` has the compose
  file (bind-mounted `./data`, memory cap, Cloudflare Tunnel sidecar behind
  a profile), an env example, and the Access setup, including Access as the
  OIDC provider so there's one sign-in.

## 8. Ways to fold Mealie into the brand

Suggestions only. Each is independent, and none is started.

- **What to call it.** `BRANDING_NAME` is the app-bar title, so the instance
  can carry a name of its own rather than the site's: *WhatsFine Kitchen*,
  *The Fine Kitchen*, or plain *WhatsFine* (what `mealie.env` sets today).
  The hostname is decided: **`recipes.whatsfine.com`** (2026-10-25); the
  deploy env and Tunnel notes use it.
- **Let the site point at it.** The cookbook is public, so the Food pillar page
  (`/food`) can link "Cook along in the kitchen" to
  `/g/home/cookbooks/whatsfine`, and each recipe article's card can link to its
  Mealie page for the scaled-servings, shopping-list and meal-plan features the
  site doesn't have. That is the cheapest two-way tie and needs no code in
  Mealie.
- **Make the OG card the house style for recipe images.** Mealie's recipe grid
  is image-led; with the OG cards every WhatsFine recipe already reads as one
  set. When real photography arrives, the forest/cream card can become the
  fallback rather than the default.
- **Cookbooks as capsules.** The site's `capsule` collection groups picks by
  room; Mealie cookbooks are saved filters, so a cookbook per series (a
  "Poor-kid food" book for the three gravies-and-treats, say) mirrors how the
  site already curates.
- **Tags that match the site's vocabulary.** Keep `kicker` values as Mealie
  tags (`Recipe`, later `Snack`, `Breakfast`, whatever the site adopts) so a
  tag on one side means the same on the other. Resist inventing a second
  taxonomy in Mealie.
- **Events back to the site.** An Apprise `jsons://` notifier on
  `recipe_created` / `recipe_updated` hitting a whatsfine.com Worker endpoint
  (section 4, item 3) lets a recipe written in Mealie's editor show up on the
  site, or at least in the newsletter draft, without a second copy being typed.
- **The question mark as the icon.** The brand's hook is the `?`; `mark-q`
  makes a stronger favicon and phone home-screen icon than three glyphs.
  Worth a side-by-side once it's running.
- **Keep the palette closed.** Forest, cream, sun and tomato, with the pop
  accents only where the site uses them. Don't add Vuetify's blues or greens
  back for "contrast"; the functional colours in `mealie.env` already cover
  success/info/warning/error in the site's own values.
