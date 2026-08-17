# Deploying the CBN Guide (fork)

The guide is a static SPA served by nginx. Game data (`all.json`,
`all_mods.json`, `builds.json`) is generated in CI from
`Toribash67/Cataclysm-BN@main` and baked into the image
`ghcr.io/toribash67/cbn-guide-web`. Watchtower + dockge redeploy it.

## Auto-update on game changes

`Toribash67/Cataclysm-BN/.github/workflows/notify-guide.yml` sends a
`repository_dispatch` (`game-updated`) to this repo on every push to `main`,
which runs `.github/workflows/deploy.yml` (regenerate data → build → push image).

### Required secret (user action)

Create a **fine-grained PAT** scoped to repository `Toribash67/cbn-guide`:

- **Contents: write** (the "Create a repository dispatch event" endpoint requires it)
- **Metadata: read** (mandatory on all fine-grained PATs)

(Classic-token equivalent: `repo` scope.)

Add it to the **game** repo (`Toribash67/Cataclysm-BN`) as a secret named
`GUIDE_DISPATCH_TOKEN` (Settings → Secrets and variables → Actions).

## Applying the game-repo trigger

This repo cannot commit into `Toribash67/Cataclysm-BN`, so the workflow that
triggers the dispatch is checked in here as a ready-to-apply artifact:

1. Copy [`docs/deploy/notify-guide.yml`](./notify-guide.yml) to
   `Toribash67/Cataclysm-BN/.github/workflows/notify-guide.yml`.
2. Commit and push it to the game repo (on `main`).
3. Add the `GUIDE_DISPATCH_TOKEN` secret described above.

## GHCR image visibility

After the first successful push, make the `cbn-guide-web` package **public**
(GHCR package settings) so the host can pull without auth, or `docker login
ghcr.io` on the host.

## Deploying via dockge (takes over the DDA slot on port 18082)

The compose stack is defined in
[`deploy/dockge/compose.yml`](../../deploy/dockge/compose.yml): service
`cbn-guide-web`, watchtower auto-update, port `18082`.

**Cut-over from the DDA wiki:** the existing `cdda-guide` stack currently owns
port `18082`. Stop it in dockge before (or as part of) deploying this stack so
the port is free.

**Option 1: dockge UI** — create a stack named `cbn-guide`, paste
`deploy/dockge/compose.yml`, click **Deploy**.

**Option 2: CLI**

```bash
sudo mkdir -p /mnt/.ix-apps/app_mounts/dockge/stacks/cbn-guide
sudo cp deploy/dockge/compose.yml /mnt/.ix-apps/app_mounts/dockge/stacks/cbn-guide/compose.yaml
```

Then click **Deploy** on the `cbn-guide` stack. The guide is then reachable on
`http://<host>:18082`. Watchtower redeploys when a new image is pushed.

## Local data regeneration (manual)

```bash
node scripts/generate-data.mjs ../Cataclysm-BN && node scripts/validate-data.mjs
```

## Rollback

Images are tagged with the **game** commit SHA (`build_number` from
`public/builds.json`, the version shown in the guide UI). Deploy a previous
image by tag: `ghcr.io/toribash67/cbn-guide-web:<game-commit-sha>`.
