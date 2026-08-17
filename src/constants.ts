import { BASE_URL } from "./utils/env";

export const GUIDE_NAME =
  "The Hitchhiker's Guide to the Cataclysm: Bright Nights";

export const UI_GUIDE_NAME = "Cataclysm: Bright Nights Guide";

export const CANONICAL_URL = "https://cataclysmbn-guide.com";

// Same-origin: game data is baked into the image under `${BASE_URL}data/...`
// and `${BASE_URL}builds.json`. Trailing slash trimmed so path concatenation
// in getDataJSONUrl / BUILDS_URL stays correct (BASE_URL is "/" in this build).
export const CBN_DATA_BASE_URL = BASE_URL.replace(/\/+$/, "");

export const BUILDS_URL = `${CBN_DATA_BASE_URL}/builds.json`;

/**
 * @param {string} version
 * @param {string} path
 * @returns {string}
 */
export const getDataJSONUrl = (version: string, path: string): string =>
  `${CBN_DATA_BASE_URL}/data/${version}/${path}`;

// Upstream public data host. Used by the dev/test fixture-fetch scripts
// (scripts/fetch-*.ts) to pull render-test fixtures, and at runtime as the
// source for tileset graphics (see CBN_TILES_BASE_URL below). The JSON game
// data (all.json / all_mods.json / builds.json) is served same-origin via
// CBN_DATA_BASE_URL above.
export const UPSTREAM_DATA_BASE_URL = "https://data.cataclysmbn-guide.com";

// Tileset graphics (`gfx/**/tile_config.json` and the `.webp` sprite sheets)
// are large binary assets that are NOT baked into the same-origin image, so
// same-origin requests for them 404. They are fetched cross-origin from the
// upstream public data host, which serves the full `gfx/` tree. Only the JSON
// game data stays same-origin.
export const CBN_TILES_BASE_URL = UPSTREAM_DATA_BASE_URL;
export const UPSTREAM_BUILDS_URL = `${UPSTREAM_DATA_BASE_URL}/builds.json`;
export const getUpstreamDataJSONUrl = (version: string, path: string): string =>
  `${UPSTREAM_DATA_BASE_URL}/data/${version}/${path}`;

export const GAME_REPO_PATH = "Toribash67/Cataclysm-BN";

export const GAME_REPO_URL = `https://github.com/${GAME_REPO_PATH}`;
export const DEFAULT_LOCALE = "en";
