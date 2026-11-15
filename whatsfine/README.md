# whatsfine/

Everything the WhatsFine fork adds to Mealie lives in this folder. Upstream
has no `whatsfine/`, so nothing here can conflict with an upstream merge, and
nothing here changes how Mealie itself runs: it is configuration, assets and
scripts that talk to Mealie's API.

| | |
|---|---|
| [ORIENTATION.md](ORIENTATION.md) | Map of the Mealie codebase, its extension points, how it meets whatsfine.com, how this fork stays aligned, and the brand-fit notes |
| [docker-compose.yml](docker-compose.yml) | Runs upstream's published image with the WhatsFine look: `docker compose -f whatsfine/docker-compose.yml up -d`, then <http://localhost:9925> |
| [brand/mealie.env](brand/mealie.env) | Name, logo path and the 14 theme colours, as Mealie's own `BRANDING_*` / `THEME_*` settings |
| [brand/mark.svg](brand/mark.svg), `mark.png` | The "WF?" tile Mealie shows in the app bar, on the login page and as favicon; `mark-q` is the question mark alone |
| [brand/build-logo.mjs](brand/build-logo.mjs) | Renders the SVGs to PNG with the real Bricolage Grotesque (`pnpm logo`) |
| [seed/seed.mjs](seed/seed.mjs) | Imports whatsfine.com's published recipes, tags and cookbook through the API, parsing ingredients into quantities (`pnpm seed:dry` to preview, `pnpm seed` to run) |
| [seed/obsidian.mjs](seed/obsidian.mjs) | Obsidian ↔ Mealie, both ways: `pnpm obsidian:sync` (`:dry` to preview) keeps each note and its recipe in agreement field by field, the side that changed winning |
| [seed/lib/contract.mjs](seed/lib/contract.mjs), [note.mjs](seed/lib/note.mjs) | The sync's field contract and three-way rule, and the in-place note editing; tests in `sync.test.mjs` (`pnpm test`) |
| [seed/lib/mealie.mjs](seed/lib/mealie.mjs) | The API client both scripts share |
| [deploy/](deploy/README.md) | Running it on hardware at home: compose with a bind-mounted data folder, Cloudflare Tunnel + Access, backups |

Tooling here is Node 22+ and pnpm (`package.json` in this folder; `pnpm install`
once for the logo renderer). The seed script has no dependencies. Upstream's
`.gitignore` drops any file matching `*.local.*`, so don't name things that way.
