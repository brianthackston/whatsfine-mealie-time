# Running WhatsFine Mealie: the runbook

The one place for how Mealie, the Obsidian vault and whatsfine.com are run
and kept in step. How the pieces work: `../ORIENTATION.md` (Mealie, the
Obsidian sync), the site repo's `docs/mealie-sync.md` (the site sync). The
plan this came out of: `../RECONCILE.md`.

Mealie is a long-lived Python process with a local database and image
folder, which is exactly what a box at home is good at and Cloudflare Workers
are not. whatsfine.com never depends on it being up: the site keeps its own
copy of each recipe on its articles, and Mealie is the editor and the
family's kitchen app.

## What runs where

| Job | Command | Where | When |
|---|---|---|---|
| Mealie | `docker compose up -d` (this folder) | the home box | always |
| Site sync: Mealie → whatsfine.com | `node deploy/run.mjs site` | the home box (cron) | every 15 min |
| Mealie backup → R2 | `node deploy/run.mjs backup` | the home box (cron) | daily 03:30 |
| Obsidian sync: vault ↔ Mealie | `node deploy/run.mjs obsidian` | **one** PC that has the vault (Task Scheduler) | every 15 min |

Only one PC runs the Obsidian sync. The vault is on both machines through
Obsidian Sync, and two PCs syncing it at once would each see the other's
edits as new.

**Today (2026-11-15) there is no box yet.** Mealie is the local test
container on PORTABLETEXT (`../docker-compose.yml`, upstream's default admin,
bound to `127.0.0.1:9925`). That PC runs the Obsidian sync and the backup
from Task Scheduler (below). The site sync runs by hand:
`pnpm run mealie:sync -- --prod --allow-test-mealie` in the site repo, after
`pnpm run mealie:sync:dry`.

## The runner

`deploy/run.mjs <obsidian|site|backup>` is what both schedulers call. Each run:

- appends its output to `~/Logs/whatsfine/<job>.log` (rotated at 1 MB);
- writes `~/Logs/whatsfine/<job>.status.json` (`ok`, `code`, `at`, `took`):
  the quickest way to see that a job is alive;
- skips itself if the previous run of the same job is still going;
- on failure, posts the last 15 lines of output to a webhook, when one is
  set: the URL in `$WHATSFINE_ALERT_URL` or in `deploy/alert-webhook.txt`
  (gitignored). A Discord channel webhook, an ntfy.sh topic or a
  Healthchecks.io check all take it as sent. None is set yet: make one and
  put its URL in that file on each machine that runs jobs.

Settings come from the environment or `deploy/run.env` (gitignored,
`KEY=value` lines):

| Key | Meaning | Default |
|---|---|---|
| `MEALIE_URL` | Mealie's address | `http://localhost:9925` |
| `MEALIE_TOKEN_FILE` | `{ "url", "token" }` the jobs sign in with | the site repo's `mealie-local.json` |
| `WHATSFINE_SITE` | the whatsfine checkout | beside this repo |
| `OBSIDIAN_VAULT` | the vault | the one Obsidian has open |
| `OBSIDIAN_SYNC_ARGS` | extra arguments, e.g. `--skip brown-butter` | none |
| `SITE_SYNC_ARGS` | extra arguments, e.g. `--allow-test-mealie` | none |

The token's user must be an admin for the backup job (backups are an
admin action). The sync jobs need only a user who can edit the household's
recipes.

## The PC: Task Scheduler

Registered on PORTABLETEXT on 2026-11-15, under `\WhatsFine\`:

- **Obsidian sync**: every 15 minutes, `conhost.exe --headless node
  deploy/run.mjs obsidian` (headless, so no window flashes), only while
  Brian is signed in (no stored password), never two at once.
- **Mealie backup**: daily at 03:30, `deploy/run.mjs backup`. It moves to
  the box with Mealie.

`deploy/run.env` on that PC says `MEALIE_URL=http://localhost:9925` and
`OBSIDIAN_SYNC_ARGS=--skip brown-butter`. To see, run or remove them
(PowerShell):

```powershell
Get-ScheduledTask -TaskPath '\WhatsFine\' | Get-ScheduledTaskInfo
Start-ScheduledTask -TaskPath '\WhatsFine\' -TaskName 'Obsidian sync'
Unregister-ScheduledTask -TaskPath '\WhatsFine\' -TaskName 'Mealie backup' -Confirm:$false
```

Node for these is the real install behind `C:\Users\brian\.node-current`,
not one inside the Claude app's private storage (which Task Scheduler cannot
see): check with the payload test in the global CLAUDE.md before relying on
a new machine.

## Standing up the box

Anything that runs Docker and stays on: a NAS with Container Manager, a mini
PC, a Raspberry Pi 4/5 (upstream publishes arm64 images). Mealie idles at
~200 MB and the NLP ingredient parser peaks higher on first use; the compose
file caps it at 1 GB. SQLite is fine for a household.

1. **Bring the data, don't re-seed.** Re-seeding makes new recipes with new
   ids, and the vault's `mealie id`s and the site's articles point at the
   old ones. On the PC, make a fresh backup (`node deploy/run.mjs backup`)
   and stop the local container (`docker compose -f whatsfine/docker-compose.yml down`,
   which keeps its volume).
2. On the box, clone this repo and the site repo side by side, then:

   ```bash
   cd whatsfine-mealie-time/whatsfine/deploy
   cp .env.example .env     # BASE_URL, TZ, TUNNEL_TOKEN (only if remote use)
   docker compose up -d
   ```

3. Open `http://<box>:9925`, sign in with upstream's default admin
   (`changeme@example.com` / `MyPassword`), **Admin → Backups → upload the
   zip → restore**. The restore brings back every recipe, id, user and
   setting, the old admin included: **change its password now**.
4. Make a user API token (profile → API tokens) and put it on the box in the
   site repo's `mealie-local.json` (`{ "url": "http://localhost:9925",
   "token": "…" }`) and an `emdash-local.json` with a site PAT. Both are
   gitignored. Install Node 22+ and pnpm, `pnpm install` in the site repo.
5. Check before scheduling: `pnpm run mealie:sync:dry` in the site repo
   should say `3 unchanged`.
6. Schedule (crontab -e):

   ```cron
   */15 * * * *  node ~/whatsfine-mealie-time/whatsfine/deploy/run.mjs site
   30 3 * * *    node ~/whatsfine-mealie-time/whatsfine/deploy/run.mjs backup
   ```

   The backup job uploads with the site repo's wrangler, so the box needs
   `npx wrangler login`, or `CLOUDFLARE_API_TOKEN` (R2 write) and
   `CLOUDFLARE_ACCOUNT_ID` in `deploy/run.env`.
7. Repoint the PC: in its `deploy/run.env`, `MEALIE_URL=http://<box>:9925`,
   and put the box's token in a token file (`MEALIE_TOKEN_FILE`). Remove the
   PC's backup task. Run `node deploy/run.mjs obsidian` once by hand: it
   should say everything is in sync. If most notes look deleted, it is
   pointed at the wrong Mealie, and it stops without writing.

## Reaching it from outside: Cloudflare Tunnel + Access

Only needed to use Mealie away from home; the site doesn't need it. No port
is opened at home. In Zero Trust:

1. **Networks → Tunnels → Create a tunnel.** Pick the Docker connector; copy
   the token into `.env` as `TUNNEL_TOKEN`. Add a public hostname, e.g.
   `recipes.whatsfine.com` → service `http://mealie:9000`.
2. **Access → Applications → Add → Self-hosted**, same hostname. A policy
   that allows the family's emails (one-time PIN, or a Google login) is enough.
   Cover the whole hostname, `/api/media/*` included: recipe images there
   answer without a Mealie sign-in.
3. `docker compose --profile tunnel up -d`.

That gives two sign-ins (Access, then Mealie). Two ways to make it one:

- **Access as the identity provider.** Add an *Access for SaaS* application
  of type OIDC, then set Mealie's `OIDC_AUTH_ENABLED=true`,
  `OIDC_CONFIGURATION_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`,
  `OIDC_PROVIDER_NAME=WhatsFine`, `OIDC_AUTO_REDIRECT=true` in `.env`. Mealie
  then trusts Access's login and creates users on first sign-in
  (`OIDC_SIGNUP_ENABLED`). This is the clean option.
- **Trust Access's header.** `REVERSE_PROXY_AUTH_ENABLED=true` with
  `REVERSE_PROXY_AUTH_HEADER=Cf-Access-Authenticated-User-Email` works, but
  anyone on the home LAN could send that header to port 9925 directly, so only
  do it if the port is firewalled to the tunnel container.

## Backups and restore

- Mealie does **not** make backups on its own. `deploy/backup.mjs` (the
  backup job) asks it for one, saves the zip to `~/Backups/mealie`, keeps the
  newest 14 there and in Mealie's own `data/backups`, and with `--r2` copies
  it to the private R2 bucket `whatsfine-mealie-backups` under the machine's
  name. Never `whatsfine-media`: the site serves files from that bucket by
  key, and a backup holds password hashes and Mealie's secret keys. The R2
  copies are not pruned yet; an R2 lifecycle rule (expire after 90 days)
  would do it: `pnpm exec wrangler r2 bucket lifecycle add
  whatsfine-mealie-backups` in the site repo.
- `./data` holds everything else too (SQLite DB, images, the auto-generated
  secrets); a snapshot of the folder is a second copy.
- **Restore**: Admin → Backups → upload → restore, as when standing the box
  up. Fetch a copy from R2 with `pnpm exec wrangler r2 object get
  whatsfine-mealie-backups/<machine>/<zip> --remote --file <zip>`.

## Updating

Merge the upstream release tag into the `whatsfine` branch (a merge
commit; `git merge v3.x.y`), bump the image tag in `../docker-compose.yml`
and `docker-compose.yml` here, back up, then `docker compose pull && docker
compose up -d`. Mealie runs its own migrations on start. Then check the
three syncs still agree: `pnpm test` and `pnpm obsidian:sync:dry` here,
`pnpm run mealie:sync:dry` in the site repo. Done for v3.31.0 on 2026-11-15
(merge `491cc783`). `cloudflared` is pinned too (2026.10.7); bump it after
reading its release notes. The brand env and logo are read from `../brand`,
so the deploy folder follows the fork.
