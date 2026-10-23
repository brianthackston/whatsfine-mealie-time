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
  created 2026-10-22 with `--default-branch-only`.
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
