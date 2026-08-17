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

// Upstream public data host — used ONLY by the dev/test fixture-fetch scripts
// (scripts/fetch-*.ts) to pull render-test fixtures. The app runtime serves
// same-origin fork data via CBN_DATA_BASE_URL above.
export const UPSTREAM_DATA_BASE_URL = "https://data.cataclysmbn-guide.com";
export const UPSTREAM_BUILDS_URL = `${UPSTREAM_DATA_BASE_URL}/builds.json`;
export const getUpstreamDataJSONUrl = (version: string, path: string): string =>
  `${UPSTREAM_DATA_BASE_URL}/data/${version}/${path}`;

export const GAME_REPO_PATH = "Toribash67/Cataclysm-BN";

export const GAME_REPO_URL = `https://github.com/${GAME_REPO_PATH}`;
export const DEFAULT_LOCALE = "en";
