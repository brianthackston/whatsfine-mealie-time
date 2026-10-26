# Running WhatsFine Mealie at home

Mealie is a long-lived Python process with a local database and image
folder, which is exactly what a box at home is good at and Cloudflare Workers
are not. whatsfine.com never depends on this machine being up: the site keeps
its own copy of the recipes (see the site's sync), and this instance is the
editor and the family's kitchen app.

## The box

Anything that runs Docker and stays on: a NAS with Container Manager, a mini
PC, a Raspberry Pi 4/5 (upstream publishes arm64 images). Mealie idles at
~200 MB and the NLP ingredient parser peaks higher on first use; the compose
file caps it at 1 GB. SQLite is fine for a household; switch `DB_ENGINE` to
`postgres` only if several people are editing at once.

```bash
cd whatsfine/deploy
cp .env.example .env     # BASE_URL, TZ, TUNNEL_TOKEN
docker compose up -d
```

Then open `http://<box>:9925`, sign in with upstream's default admin
(`changeme@example.com` / `MyPassword`, from `mealie/core/settings/settings.py`),
**change that password first**, and seed:

```bash
cd ../            # whatsfine/
MEALIE_URL=http://<box>:9925 MEALIE_USER=... MEALIE_PASSWORD=... pnpm seed -- --seed-foods
MEALIE_URL=http://<box>:9925 MEALIE_USER=... MEALIE_PASSWORD=... pnpm obsidian:push
```

(`--seed-foods` once per group; it loads Mealie's en-US foods and units so
the ingredient parser has something to match.) Make a user API token
afterwards (profile → API tokens) and use `MEALIE_TOKEN` instead of the
password for anything scheduled.

## Reaching it from outside: Cloudflare Tunnel + Access

No port is opened at home. In Zero Trust:

1. **Networks → Tunnels → Create a tunnel.** Pick the Docker connector; copy
   the token into `.env` as `TUNNEL_TOKEN`. Add a public hostname, e.g.
   `recipes.whatsfine.com` → service `http://mealie:9000`.
2. **Access → Applications → Add → Self-hosted**, same hostname. A policy
   that allows the family's emails (one-time PIN, or a Google login) is enough.
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

## Backups

- `./data` holds everything (SQLite DB, images, the auto-generated secrets).
  Snapshot or rsync it.
- Mealie writes its own backup zips to `./data/backups` daily; Admin →
  Backups restores one. Copy that folder off the box; `rclone` to the
  `whatsfine-media` R2 bucket under `mealie-backups/` is the natural home.

## Updating

Bump the image tag in `docker-compose.yml` after merging a new upstream
release into the `whatsfine` branch, then `docker compose pull && docker
compose up -d`. Mealie runs its own migrations on start. The brand env and
logo are read from `../brand`, so the deploy folder follows the fork.
