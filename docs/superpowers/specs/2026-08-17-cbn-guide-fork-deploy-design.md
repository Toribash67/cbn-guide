# Design: self-hosted CBN Guide tied to our modified game

Date: 2026-08-17

## Goal

Turn this fork of the Hitchhiker's Guide to Cataclysm: Bright Nights into a guide
for **our modified game** (`Toribash67/Cataclysm-BN`, checked out at
`../Cataclysm-BN`), and host it on this machine via **dockge** (GHCR image +
watchtower + dockge stack), **replacing** the currently-hosted CDDA wiki on port
`18082`.

The guide must **auto-update when the game changes**.

This mirrors the change set already applied to the sibling `cdda-guide` fork,
adapted to cbn-guide's more evolved architecture.

## Background: how the guide gets its data today

The guide is a client-side Svelte SPA. At runtime it fetches, from the external
host `https://data.cataclysmbn-guide.com` (configured in `src/constants.ts`):

- `builds.json` — the list of available versions, each
  `{ build_number, prerelease, created_at, langs? }`. The `"stable"` slug
  resolves (in `src/builds.svelte.ts`) to the latest non-prerelease build.
- `data/<version>/all.json` — every core-game JSON object, each tagged with a
  `__filename` (`<relpath>#L<start>-L<end>`), wrapped as
  `{ build_number, release, data: [...] }`.
- `data/<version>/all_mods.json` — a **separate** mod index, a top-level object
  map `{ <modId>: { info: <modinfo>, data: [...] } }` (parsed in `src/data.ts`).
- `data/<version>/lang/<locale>.json` — optional translations (fetched only for
  non-English locales; failures are swallowed).

All copy-from / inheritance / migration / abstract resolution happens
**client-side** in `CBNData` (`src/data.ts`). So `all.json` / `all_mods.json` are
essentially raw concatenations of the game's JSON plus build metadata — no
compiled game binary is needed to produce them.

### Verified fetch contract (grounds the generator)

- The runtime data path uses the **literal version slug** as the folder:
  `loadDataForVersion(navigation.buildRequestedVersion=...)` →
  `data.loadData("stable", ...)` → `getDataJSONUrl("stable", "all.json")` =
  `${BASE}/data/stable/all.json`. Therefore the generated data lives under
  `data/stable/`, **not** under the build-number folder.
- The `buildResolvedVersion` (= `resolveBuildVersion("stable")` =
  `latestStableBuild.build_number`) is used only to find `currentBuild` in
  `builds.json` and to build tileset/asset URLs. Tilesets are opt-in (off by
  default), so a missing `data/<build_number>/gfx/...` is a non-blocking
  nice-to-have.

Config lives centrally in `src/constants.ts`:
`CBN_DATA_BASE_URL`, `BUILDS_URL`, `getDataJSONUrl`, `GAME_REPO_PATH`
(`cataclysmbn/Cataclysm-BN`), `GAME_REPO_URL`.

## Decisions (locked with the user)

| Decision | Choice |
| --- | --- |
| Where data generation runs | **In CI, baked into the image** |
| Version selector | **Only the modified game** (single dataset) |
| Auto-update trigger | **On push to the game repo** (`repository_dispatch`) |
| Translations | **English-only** (no lang JSONs) |
| Deploy pipeline | **Replace** Cloudflare/Transifex/Sentry deploy with GHCR + dockge |
| Image / stack name | `ghcr.io/toribash67/cbn-guide-web` |
| Host port / slot | **`18082`, taking over the DDA slot** |
| Cross-repo dispatch token | PAT-based; **user creates the PAT**, spec documents the scope |

## Architecture

```
push to Toribash67/Cataclysm-BN@main
        │  (workflow in the game repo)
        ▼
repository_dispatch: game-updated  ──►  cbn-guide CI (deploy.yml)
                                          │ 1. checkout guide + game@main
                                          │ 2. node scripts/generate-data.mjs ../Cataclysm-BN
                                          │    → public/builds.json,
                                          │      public/data/stable/all.json,
                                          │      public/data/stable/all_mods.json
                                          │ 3. pnpm install && pnpm build  (Docker)
                                          │ 4. push ghcr.io/toribash67/cbn-guide-web:{latest,sha}
                                          ▼
                                   watchtower on host  ──►  dockge stack redeploys
                                          ▼
                          users' service worker (NetworkFirst) pulls fresh all.json
```

## Components

### 1. Data generator — `scripts/generate-data.mjs` (new)

Node ESM script, run in CI (and locally for testing). Reuses the upstream
`cbn-data` / `cdda-data` `pull-data.mjs` parsing approach so output semantics
match what `CBNData` expects.

- **Input:** path to a Cataclysm-BN checkout (default `../Cataclysm-BN`).
- **Walk:** `data/json/**/*.json` (base game) and, for each mod under
  `data/mods/<mod>/`, its `modinfo.json` plus `**/*.json` content.
- **Object splitting + line tracking:** each file's top-level array is broken
  into individual objects while tracking newline positions, so every object gets
  `__filename = <relpath-in-game-repo>#L<start>-L<end>`. Bare non-object
  primitives at the top level are handled without crashing.
- **Build metadata:** synthesize `build_number = toribash-<git-short-sha>` and a
  minimal `release` object (name, `published_at`/date, `html_url` pointing at the
  game repo commit) from `git` in the checkout — we build from a checkout, not a
  GitHub release.
- **Output (into `public/`, git-ignored):**
  - `public/builds.json` = single-entry list:
    `[{ build_number, prerelease: false, created_at, langs: [] }]`.
  - `public/data/stable/all.json` = `{ build_number, release, data: [...] }`
    (core game objects only).
  - `public/data/stable/all_mods.json` = `{ <modId>: { info, data: [...] } }`
    (one entry per bundled mod), matching the `all_mods.json` parser in
    `src/data.ts`.
- **English-only:** no `lang/` output.
- **Error handling:** malformed JSON fails loudly naming the file (never silently
  dropped); a missing/invalid game path is a clear fatal error.

Using the `stable` folder + a single non-prerelease build means the app's default
`"stable"` slug resolves and fetches without any version-selection code changes.

### 2. Repoint the app at same-origin data (`src/constants.ts`, small change)

- Change `CBN_DATA_BASE_URL` from `https://data.cataclysmbn-guide.com` to a
  same-origin base derived from `BASE_URL` (`src/utils/env.ts`), so
  `BUILDS_URL` → `${BASE_URL}builds.json` and `getDataJSONUrl` →
  `${BASE_URL}data/<version>/<path>`.
- Repoint `GAME_REPO_PATH` from `cataclysmbn/Cataclysm-BN` to
  `Toribash67/Cataclysm-BN`, so "view source" / GitHub links reference the fork.
  (Tileset base URLs in `tile-data.ts` derive from `CBN_DATA_BASE_URL`, so they
  follow automatically; tilesets remain opt-in.)
- **PWA (`vite.config.ts`):** the existing `runtimeCaching` rule that matches the
  cross-origin `data.cataclysmbn-guide.com` host is replaced by a NetworkFirst
  rule matching the same-origin `.../data/stable/all.json` (+ `all_mods.json` /
  `builds.json`). `globPatterns` already exclude JSON, so the large `all.json`
  is **not** precached — sidestepping the workbox precache size limit. Data JSON
  + `index.html` are served `no-cache` by nginx; hashed assets `immutable`.

### 3. Container image — `Dockerfile` (new)

- **Build stage** (`node:22-alpine`): enable pnpm (corepack), `pnpm install
  --frozen-lockfile`, then `pnpm build`. The generator has already populated
  `public/builds.json` + `public/data/stable/**` in the CI step, so they are part
  of the Docker build context and copied by Vite into `dist/`. Sentry/Transifex
  are env-gated (undefined without tokens), so the build runs cleanly with **no
  secrets**.
- **Runtime stage** (`nginx:alpine`): serve `dist/` with SPA fallback
  (`try_files $uri /index.html;`), gzip, and cache headers as above. `EXPOSE 80`.
- `.dockerignore` keeps `node_modules`, `.git`, the game checkout, and local
  `public/data` out of the non-generator build context.

Rationale for generating in CI rather than inside the Dockerfile: keeps the huge
game checkout out of the Docker build, and mirrors the "CI builds, Docker
packages" split used by the sibling deploys on this host.

### 4. CI/CD

**cbn-guide** — `.github/workflows/deploy.yml` (**replaces** the existing
Cloudflare/Transifex/Sentry deploy), triggered by: `push` to `main`,
`workflow_dispatch`, and `repository_dispatch` (`types: [game-updated]`).

Steps: checkout guide → checkout `Toribash67/Cataclysm-BN@main` into a sibling
path → `node scripts/generate-data.mjs <gamepath>` → validate output (see
Testing) → `docker/build-push-action` building + pushing
`ghcr.io/toribash67/cbn-guide-web:{latest,<sha>}` (push only on `main` /
dispatch). The existing `ci.yml` (tests against upstream fixtures) is left as-is.

**Toribash67/Cataclysm-BN** — small workflow (documented here, applied to the
game repo) on `push` to `main` that sends a `repository_dispatch`
(`game-updated`) to `Toribash67/cbn-guide` using a PAT stored as a secret.
Committed here as `docs/deploy/notify-guide.yml`.

**PAT the user creates:** a token authorized to send a repository_dispatch to
`Toribash67/cbn-guide`. The "Create a repository dispatch event" REST endpoint
requires **Contents: write**. Fine-grained: repository `Toribash67/cbn-guide`,
**Contents: write** + **Metadata: read** (Metadata is mandatory on all
fine-grained PATs). Classic equivalent: `repo` scope. Stored in the **game** repo
as secret `GUIDE_DISPATCH_TOKEN`. The spec documents this; the user provisions
it.

### 5. Deployment (dockge)

- `deploy/dockge/compose.yml` committed in the repo, live copy placed at
  `/mnt/.ix-apps/app_mounts/dockge/stacks/cbn-guide/compose.yaml`.
- Service `cbn-guide-web`: image `ghcr.io/toribash67/cbn-guide-web:latest`,
  `restart: unless-stopped`, watchtower label
  `com.centurylinklabs.watchtower.enable: "true"`, `ports: ["18082:80"]`,
  healthcheck `wget -qO- http://127.0.0.1/`. **No volume** (data baked into
  image).
- Taking over port `18082` means the existing `cdda-guide` stack is stopped as
  part of cut-over (operational step, documented in `docs/deploy/README.md`).

## Data flow / freshness

Because the data is regenerated per game commit and always written under
`data/stable/`, the client always requests the same URL; freshness comes from the
new image + the NetworkFirst service-worker rule. The `build_number` changes each
build, which the guide surfaces as the version label in the selector.

## Testing

- **Keep** the guide's existing `pnpm test` (lint, typecheck, and the render
  tests that fetch upstream fixtures via `scripts/fetch-*.ts`; still valid for the
  UI code).
- **Add** a generator validation (run in CI before building): execute
  `generate-data.mjs` against `../Cataclysm-BN` and assert:
  - `build_number` is a non-empty string;
  - `all.json.data` is a non-empty array and **every** element has a
    `__filename`;
  - `all_mods.json` is a populated object whose entries each have `info` + a
    `data` array;
  - `new CBNData(all.data, all.build_number, all.release)` constructs without
    throwing, and a couple of known ids (e.g. an item and a monster) resolve.

## Edge cases

- Malformed game JSON → fail the build, naming the file.
- Large `all.json` → excluded from precache; NetworkFirst at runtime; `no-cache`
  from nginx.
- First hard-load of a deep route → nginx `try_files` fallback to `index.html`
  (SW `navigateFallback` covers subsequent client navigation).
- Game repo has many bundled mods → all emitted into `all_mods.json`; the guide's
  existing mod handling covers filtering.
- English default locale → no `lang/` fetch is issued for `en`; if one were, the
  loader swallows the failure.

## Out of scope

- Translations of custom content (Transifex push/download removed from deploy).
- Keeping upstream cataclysmbn-guide.com versions selectable.
- Any change to the game itself (only the documented dispatch workflow).
- Tileset previews against the fork (opt-in; may 404 until a data host serves
  `gfx/`).

## Open items (defaults chosen; changeable at deploy time)

- Exact `build_number` format (`toribash-<sha>` assumed).
- Whether to also proxy the service through nginx-proxy-manager for a hostname.
- Whether to also emit data under the `data/<build_number>/` folder to make
  tileset previews work (currently out of scope).
