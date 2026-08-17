# CBN Fork Deploy + Vehicle Spawn Locations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make this guide serve data generated from the `Toribash67/Cataclysm-BN` fork (baked into a Docker image, auto-updating on game pushes) and deployed via GHCR + dockge, and add vehicle-page spawn-location + spawn-group info.

**Architecture:** A Node ESM generator walks a local Cataclysm-BN checkout and emits `public/builds.json` + `public/data/stable/{all.json,all_mods.json}` in the exact shape `CBNData` already consumes. `src/constants.ts` is repointed from the external `data.cataclysmbn-guide.com` host to same-origin, and the PWA runtime-cache rules follow. CI regenerates data and builds/pushes an nginx image; watchtower + dockge redeploy it on port 18082 (taking over the DDA slot). Separately, the vehicle spawn feature ports the sibling `cdda-guide` implementation (which shares this codebase's ancestry) nearly verbatim into `spawnLocations.ts` + a new `VehicleSpawns.svelte`.

**Tech Stack:** Node 24 (ESM, `node:test`), pnpm, Vite, Svelte 5 (runes), vite-plugin-pwa/workbox, vitest, Docker (node:24-slim build → nginx:alpine), GitHub Actions, dockge/watchtower.

**Spec:**
- `docs/superpowers/specs/2026-08-17-cbn-guide-fork-deploy-design.md`
- `docs/superpowers/specs/2026-08-17-cbn-guide-vehicle-spawns-design.md`

## Global Constraints

- **Package manager: pnpm** (lockfile `pnpm-lock.yaml`). Never introduce `yarn`/`npm` lockfiles.
- **Data folder is `stable`** — the runtime fetches `${BASE}/data/stable/all.json` (the literal version slug), not a build-number folder. Confirmed via `data-loader.ts` → `getDataJSONUrl("stable", ...)`.
- **cbn loads two data files:** `all.json` = `{ build_number, release, data: [...] }` (core game) and a **separate** `all_mods.json` = `{ [modId]: { info: MOD_INFO, data: [...] } }`. Every object in `data`/mod-`data` must carry `__filename = "<relpath>#L<start>-L<end>"`.
- **Fork identifiers:** game repo `Toribash67/Cataclysm-BN` (default branch **`main`**); guide repo `Toribash67/cbn-guide`; image `ghcr.io/toribash67/cbn-guide-web`; host port **`18082`**.
- **English-only:** no `lang/` output; `DEFAULT_LOCALE` stays `"en"`.
- **Build without secrets:** Sentry/Transifex are env-gated in `vite.config.ts`; the Docker build sets no tokens and must succeed.
- **Lint gate:** `pnpm lint` runs `prettier -c .` over the repo. All new `.mjs`/`.ts`/`.yml`/`.md` must be prettier-clean (SDD docs under `/docs/superpowers/` are already prettier-ignored). Dockerfile/nginx.conf/.dockerignore have no prettier parser and are skipped.
- **Branch:** all work on `cbn-fork-deploy-and-vehicle-spawns` (already created off `main`).

---

# Part A — Data pipeline, fork repoint, Docker deploy

### Task A1: Top-level JSON element splitter

Splits a CDDA/CBN JSON file into per-element inclusive line ranges so each object can be tagged with a `__filename`. Game-agnostic — ported verbatim from the DDA fork.

**Files:**
- Create: `scripts/lib/split-json.mjs`
- Test: `scripts/lib/split-json.test.mjs`

**Interfaces:**
- Produces: `topLevelElementRanges(text: string) => { startLine: number, endLine: number }[]` (1-indexed inclusive).

- [ ] **Step 1: Write the failing test** — create `scripts/lib/split-json.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { topLevelElementRanges } from "./split-json.mjs";

test("array of objects on separate lines", () => {
  const text = '[\n  {"a":1},\n  {"b":2}\n]';
  assert.deepEqual(topLevelElementRanges(text), [
    { startLine: 2, endLine: 2 },
    { startLine: 3, endLine: 3 },
  ]);
});

test("multi-line object element", () => {
  const text = '[\n{\n"a":1\n},\n{"b":2}\n]';
  assert.deepEqual(topLevelElementRanges(text), [
    { startLine: 2, endLine: 4 },
    { startLine: 5, endLine: 5 },
  ]);
});

test("single top-level object", () => {
  const text = '{\n"x":1\n}';
  assert.deepEqual(topLevelElementRanges(text), [{ startLine: 1, endLine: 3 }]);
});

test("nested brackets and braces do not create elements", () => {
  const text = '[{"a":[1,2],"b":{"c":3}}]';
  assert.deepEqual(topLevelElementRanges(text), [{ startLine: 1, endLine: 1 }]);
});

test("braces inside strings are ignored", () => {
  const text = '[\n{"a":"}{"},\n{"b":"]["}\n]';
  assert.deepEqual(topLevelElementRanges(text), [
    { startLine: 2, endLine: 2 },
    { startLine: 3, endLine: 3 },
  ]);
});

test("leading BOM is tolerated", () => {
  const text = '﻿[\n{"a":1}\n]';
  assert.deepEqual(topLevelElementRanges(text), [{ startLine: 2, endLine: 2 }]);
});

test("bare primitive numbers in array", () => {
  const text = "[1, 2, 3]";
  assert.deepEqual(topLevelElementRanges(text), [
    { startLine: 1, endLine: 1 },
    { startLine: 1, endLine: 1 },
    { startLine: 1, endLine: 1 },
  ]);
});

test("mixed objects and primitives in array", () => {
  const text = '[{"a":1},"foo",{"b":2}]';
  assert.deepEqual(topLevelElementRanges(text), [
    { startLine: 1, endLine: 1 },
    { startLine: 1, endLine: 1 },
    { startLine: 1, endLine: 1 },
  ]);
});

test("multi-line primitive array", () => {
  const text = "[\n  1,\n  2\n]";
  assert.deepEqual(topLevelElementRanges(text), [
    { startLine: 2, endLine: 2 },
    { startLine: 3, endLine: 3 },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/lib/split-json.test.mjs`
Expected: FAIL — cannot find module `./split-json.mjs`.

- [ ] **Step 3: Write the implementation** — create `scripts/lib/split-json.mjs`:

```js
// Returns the 1-indexed inclusive line range of each top-level element in a
// CBN JSON file (an array of objects, or a single object). CBN data files are
// standard JSON — "//" comment keys are ordinary strings, so no comment
// stripping is needed. Brace/bracket counting drives element boundaries;
// characters inside strings are skipped.
export function topLevelElementRanges(text) {
  const offsets = []; // [startOffset, endOffset] per top-level element
  let depth = 0;
  let started = false;
  let outerIsObject = false;
  let inStr = false;
  let esc = false;
  let elemStart = -1;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      if (started && !outerIsObject && depth === 1 && elemStart === -1) {
        elemStart = i;
      }
      continue;
    }

    if (!started) {
      if (c === "[") {
        started = true;
        depth = 1;
      } else if (c === "{") {
        started = true;
        outerIsObject = true;
        depth = 1;
        elemStart = i;
      }
      continue;
    }

    if (outerIsObject) {
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          offsets.push([elemStart, i]);
          break;
        }
      }
      continue;
    }

    // Array mode.
    if (c === "{" || c === "[") {
      if (depth === 1 && elemStart === -1) elemStart = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 1 && elemStart !== -1) {
        offsets.push([elemStart, i]);
        elemStart = -1;
      }
    } else if (c === "]") {
      if (depth === 1) {
        if (elemStart !== -1) {
          offsets.push([elemStart, i - 1]);
          elemStart = -1;
        }
        break;
      } else {
        depth--;
        if (depth === 1 && elemStart !== -1) {
          offsets.push([elemStart, i]);
          elemStart = -1;
        }
      }
    } else if (c === "," && depth === 1 && elemStart !== -1) {
      offsets.push([elemStart, i - 1]);
      elemStart = -1;
    } else if (depth === 1 && elemStart === -1 && !/[\s,]/.test(c)) {
      elemStart = i;
    }
  }

  const newlines = [];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") newlines.push(i);
  const lineOf = (off) => {
    let lo = 0;
    let hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (newlines[mid] < off) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };

  return offsets.map(([s, e]) => ({
    startLine: lineOf(s),
    endLine: lineOf(e),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/lib/split-json.test.mjs`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/split-json.mjs scripts/lib/split-json.test.mjs
git commit -m "feat(data): add top-level JSON element splitter"
```

---

### Task A2: Core `all.json` generator (`buildAllJson`)

Walks `data/json/**`, tags each object with `__filename`, and returns the `all.json` payload. Ported from the DDA fork with the fork URL changed to `Cataclysm-BN`.

**Files:**
- Create: `scripts/lib/generate.mjs`
- Create fixtures:
  - `scripts/lib/__fixtures__/game/data/json/items.json`
  - `scripts/lib/__fixtures__/game/data/json/mixed.json`
  - `scripts/lib/__fixtures__/game/data/json/nested/mon.json`
  - `scripts/lib/__fixtures__/game-malformed/data/json/malformed.json`
- Test: `scripts/lib/generate.test.mjs`

**Interfaces:**
- Consumes: `topLevelElementRanges` (Task A1).
- Produces: `buildAllJson(gameDir: string, opts: { buildNumber, createdAt?, commitSubject? }) => Promise<{ build_number, release, data: object[] }>`.

- [ ] **Step 1: Create fixtures**

`scripts/lib/__fixtures__/game/data/json/items.json`:

```json
[
  { "id": "widget", "type": "GENERIC" },
  { "id": "gadget", "type": "GENERIC" }
]
```

`scripts/lib/__fixtures__/game/data/json/mixed.json`:

```json
[
  "a string element",
  { "id": "obj1", "type": "GENERIC" },
  42,
  { "id": "obj2", "type": "GENERIC" }
]
```

`scripts/lib/__fixtures__/game/data/json/nested/mon.json`:

```json
[{ "id": "mon_test", "type": "MONSTER" }]
```

`scripts/lib/__fixtures__/game-malformed/data/json/malformed.json`:

```json
{ "id": "broken", "type": }
```

- [ ] **Step 2: Write the failing test** — create `scripts/lib/generate.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildAllJson } from "./generate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const gameDir = join(here, "__fixtures__", "game");
const gameDirMalformed = join(here, "__fixtures__", "game-malformed");

test("builds all.json payload from data/json", async () => {
  const all = await buildAllJson(gameDir, {
    buildNumber: "deadbeef",
    createdAt: "2026-08-17T00:00:00Z",
    commitSubject: "test build",
  });

  assert.equal(all.build_number, "deadbeef");
  assert.equal(all.data.length, 5);

  const widget = all.data.find((o) => o.id === "widget");
  assert.equal(widget.__filename, "data/json/items.json#L2-L2");

  const mon = all.data.find((o) => o.id === "mon_test");
  assert.equal(mon.__filename, "data/json/nested/mon.json#L1-L1");

  assert.equal(all.release.tag_name, "deadbeef");
  assert.match(
    all.release.html_url,
    /Toribash67\/Cataclysm-BN\/commit\/deadbeef/,
  );
});

test("skips non-object top-level elements (primitives, arrays)", async () => {
  const all = await buildAllJson(gameDir, { buildNumber: "test" });

  const mixed = all.data.filter((o) => o.__filename.includes("mixed.json"));
  assert.equal(mixed.length, 2);
  assert.equal(
    mixed.find((o) => o.id === "obj1").__filename,
    "data/json/mixed.json#L3-L3",
  );
  assert.equal(
    mixed.find((o) => o.id === "obj2").__filename,
    "data/json/mixed.json#L5-L5",
  );
});

test("throws on malformed JSON with file path in error", async () => {
  await assert.rejects(
    async () => buildAllJson(gameDirMalformed, { buildNumber: "test" }),
    (err) => {
      assert.match(err.message, /Failed to parse.*malformed\.json/);
      return true;
    },
  );
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test scripts/lib/generate.test.mjs`
Expected: FAIL — cannot find module `./generate.mjs`.

- [ ] **Step 4: Write the implementation** — create `scripts/lib/generate.mjs`:

```js
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { topLevelElementRanges } from "./split-json.mjs";

async function listJsonFiles(root) {
  const dirents = await readdir(root, { recursive: true, withFileTypes: true });
  return dirents
    .filter((d) => d.isFile() && d.name.endsWith(".json"))
    .map((d) => join(d.parentPath ?? d.path, d.name))
    .sort();
}

// Parse one file into { obj, __filename } records, skipping non-object
// top-level elements (bare strings/numbers/arrays). Mutates each object to add
// `__filename`. Throws (naming the file) on malformed JSON.
async function readObjects(gameDir, file) {
  const text = (await readFile(file, "utf8")).replace(/^﻿/, "");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Failed to parse ${file}: ${e.message}`);
  }
  const elements = Array.isArray(parsed) ? parsed : [parsed];
  const ranges = topLevelElementRanges(text);
  if (ranges.length !== elements.length) {
    throw new Error(
      `Line-range count ${ranges.length} != element count ${elements.length} in ${file}`,
    );
  }
  const rel = relative(gameDir, file).split(sep).join("/");
  const out = [];
  for (let i = 0; i < elements.length; i++) {
    const obj = elements[i];
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) continue;
    obj.__filename = `${rel}#L${ranges[i].startLine}-L${ranges[i].endLine}`;
    out.push(obj);
  }
  return out;
}

export async function buildAllJson(gameDir, opts) {
  const { buildNumber, createdAt, commitSubject } = opts;
  const files = await listJsonFiles(join(gameDir, "data", "json"));
  const data = [];
  for (const file of files) data.push(...(await readObjects(gameDir, file)));

  const release = {
    tag_name: buildNumber,
    name: commitSubject ?? buildNumber,
    html_url: `https://github.com/Toribash67/Cataclysm-BN/commit/${buildNumber}`,
    published_at: createdAt ?? null,
  };

  return { build_number: buildNumber, release, data };
}
```

Note: `readObjects` / `listJsonFiles` are exported-in-spirit helpers reused by Task A3 (kept in the same module).

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test scripts/lib/generate.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/generate.mjs scripts/lib/generate.test.mjs scripts/lib/__fixtures__
git commit -m "feat(data): add core all.json generator"
```

---

### Task A3: Mods generator (`buildAllMods`)

Walks `data/mods/<mod>/**`, and for every mod that has a `MOD_INFO` object emits `{ [modId]: { info, data } }` matching cbn's `all_mods.json` parser (`parseModsJSON` in `src/data.ts`, which requires `info.type === "MOD_INFO"` and `info.id === modId`).

**Files:**
- Modify: `scripts/lib/generate.mjs` (add `buildAllMods`)
- Create fixtures:
  - `scripts/lib/__fixtures__/game/data/mods/testmod/modinfo.json`
  - `scripts/lib/__fixtures__/game/data/mods/testmod/content.json`
  - `scripts/lib/__fixtures__/game/data/mods/not-a-mod/readme.json`
- Modify test: `scripts/lib/generate.test.mjs`

**Interfaces:**
- Consumes: `topLevelElementRanges` (A1), the file/object helpers from A2.
- Produces: `buildAllMods(gameDir: string) => Promise<Record<string, { info: object, data: object[] }>>`. Each object in `data` carries `__filename`; the `MOD_INFO` object is excluded from `data` (it is surfaced as `info`). Mod dirs without a `MOD_INFO` are skipped. Keys are `info.id` (not the folder name).

- [ ] **Step 1: Create fixtures**

`scripts/lib/__fixtures__/game/data/mods/testmod/modinfo.json`:

```json
[
  {
    "type": "MOD_INFO",
    "id": "testmod",
    "name": "Test Mod",
    "description": "A mod for tests.",
    "category": "content"
  }
]
```

`scripts/lib/__fixtures__/game/data/mods/testmod/content.json`:

```json
[{ "id": "mod_widget", "type": "GENERIC" }]
```

`scripts/lib/__fixtures__/game/data/mods/not-a-mod/readme.json`:

```json
[{ "id": "orphan", "type": "GENERIC" }]
```

- [ ] **Step 2: Add failing tests** — append to `scripts/lib/generate.test.mjs`:

```js
import { buildAllMods } from "./generate.mjs";

test("builds all_mods.json keyed by MOD_INFO id", async () => {
  const mods = await buildAllMods(gameDir);

  assert.deepEqual(Object.keys(mods), ["testmod"]);
  const mod = mods.testmod;
  assert.equal(mod.info.type, "MOD_INFO");
  assert.equal(mod.info.id, "testmod");
  assert.equal(
    mod.info.__filename,
    "data/mods/testmod/modinfo.json#L2-L7",
  );

  // MOD_INFO is surfaced as `info`, not repeated in `data`.
  assert.ok(!mod.data.some((o) => o.type === "MOD_INFO"));
  const widget = mod.data.find((o) => o.id === "mod_widget");
  assert.equal(widget.__filename, "data/mods/testmod/content.json#L1-L1");
});

test("skips mod dirs without a MOD_INFO object", async () => {
  const mods = await buildAllMods(gameDir);
  assert.ok(!("not-a-mod" in mods));
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test scripts/lib/generate.test.mjs`
Expected: FAIL — `buildAllMods` is not exported.

- [ ] **Step 4: Implement `buildAllMods`** — append to `scripts/lib/generate.mjs`:

```js
export async function buildAllMods(gameDir) {
  const modsRoot = join(gameDir, "data", "mods");
  let modDirs;
  try {
    modDirs = (await readdir(modsRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return {}; // no data/mods dir
  }

  const out = {};
  for (const modName of modDirs) {
    const files = await listJsonFiles(join(modsRoot, modName));
    let info = null;
    const data = [];
    for (const file of files) {
      for (const obj of await readObjects(gameDir, file)) {
        if (obj.type === "MOD_INFO") {
          info = obj;
        } else {
          data.push(obj);
        }
      }
    }
    if (!info || typeof info.id !== "string") continue; // not a real mod
    out[info.id] = { info, data };
  }
  return out;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test scripts/lib/generate.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/generate.mjs scripts/lib/generate.test.mjs scripts/lib/__fixtures__/game/data/mods
git commit -m "feat(data): add all_mods.json generator"
```

---

### Task A4: Generator CLI entry point

Ties the library together: reads git metadata from the checkout, writes `public/data/stable/{all.json,all_mods.json}` and `public/builds.json`.

**Files:**
- Create: `scripts/generate-data.mjs`

**Interfaces:**
- Consumes: `buildAllJson`, `buildAllMods` (A2/A3).
- Produces (on disk): `public/builds.json` = `[{ build_number, prerelease: false, created_at, langs: [] }]`; `public/data/stable/all.json`; `public/data/stable/all_mods.json`.
- CLI: `node scripts/generate-data.mjs [gameDir]` (default `../Cataclysm-BN`). Env overrides: `CBN_BUILD_NUMBER`, `CBN_BUILD_DATE`.

- [ ] **Step 1: Write the implementation** — create `scripts/generate-data.mjs`:

```js
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAllJson, buildAllMods } from "./lib/generate.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gameDir = resolve(process.argv[2] ?? join(repoRoot, "..", "Cataclysm-BN"));

const git = (args) =>
  execFileSync("git", ["-C", gameDir, ...args], { encoding: "utf8" }).trim();

let buildNumber = process.env.CBN_BUILD_NUMBER;
let createdAt = process.env.CBN_BUILD_DATE;
let commitSubject;
try {
  buildNumber = buildNumber || git(["rev-parse", "HEAD"]);
  createdAt = createdAt || git(["show", "-s", "--format=%cI", "HEAD"]);
  commitSubject = git(["show", "-s", "--format=%s", "HEAD"]);
} catch (e) {
  if (!buildNumber)
    throw new Error(
      `Could not determine build number via git in ${gameDir}: ${e.message}`,
    );
}

const all = await buildAllJson(gameDir, {
  buildNumber,
  createdAt,
  commitSubject,
});
const mods = await buildAllMods(gameDir);

const outDir = join(repoRoot, "public", "data", "stable");
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "all.json"), JSON.stringify(all));
await writeFile(join(outDir, "all_mods.json"), JSON.stringify(mods));

const builds = [
  {
    build_number: buildNumber,
    prerelease: false,
    created_at: createdAt ?? null,
    langs: [],
  },
];
await writeFile(join(repoRoot, "public", "builds.json"), JSON.stringify(builds));

console.log(
  `Wrote ${all.data.length} core objects + ${Object.keys(mods).length} mods for build ${buildNumber}`,
);
```

- [ ] **Step 2: Smoke-test against the real fork checkout**

Run: `node scripts/generate-data.mjs ../Cataclysm-BN`
Expected: prints `Wrote <N> core objects + <M> mods for build <sha>` with N in the tens-of-thousands and M ≥ 1; creates `public/data/stable/all.json`, `public/data/stable/all_mods.json`, `public/builds.json`.

- [ ] **Step 3: Commit** (the generated `public/` output is git-ignored in Task A6; only the script is committed here)

```bash
git add scripts/generate-data.mjs
git commit -m "feat(data): add generate-data CLI entry point"
```

---

### Task A5: Data validator

Fails CI loudly if the generated data is malformed, before the image is built.

**Files:**
- Create: `scripts/validate-data.mjs`

**Interfaces:**
- Reads `public/data/stable/all.json`, `public/data/stable/all_mods.json`, `public/builds.json`; exits non-zero with a message on any violation.

- [ ] **Step 1: Write the implementation** — create `scripts/validate-data.mjs`:

```js
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = async (p) => JSON.parse(await readFile(join(repoRoot, p), "utf8"));

const all = await read("public/data/stable/all.json");
const mods = await read("public/data/stable/all_mods.json");
const builds = await read("public/builds.json");

const fail = (msg) => {
  console.error(`validate-data: ${msg}`);
  process.exit(1);
};

if (typeof all.build_number !== "string" || all.build_number.length === 0)
  fail("build_number missing");
if (!Array.isArray(all.data) || all.data.length === 0) fail("data empty");
for (const obj of all.data) {
  if (!obj || typeof obj !== "object" || !/#L\d+-L\d+$/.test(obj.__filename ?? ""))
    fail(`object missing valid __filename: ${JSON.stringify(obj).slice(0, 120)}`);
}

if (!mods || typeof mods !== "object" || Array.isArray(mods))
  fail("all_mods.json is not an object map");
if (Object.keys(mods).length === 0) fail("all_mods.json is empty");
for (const [modId, entry] of Object.entries(mods)) {
  if (!entry || typeof entry.info !== "object" || !Array.isArray(entry.data))
    fail(`mod "${modId}" missing info/data`);
  if (entry.info.type !== "MOD_INFO" || entry.info.id !== modId)
    fail(`mod "${modId}" has invalid MOD_INFO`);
}

if (!Array.isArray(builds) || builds.length !== 1) fail("builds.json malformed");
if (builds[0].build_number !== all.build_number)
  fail("builds.json build_number mismatch");

console.log(
  `validate-data: OK (${all.data.length} objects, ${Object.keys(mods).length} mods, build ${all.build_number})`,
);
```

- [ ] **Step 2: Run it against the smoke-test output from Task A4**

Run: `node scripts/validate-data.mjs`
Expected: prints `validate-data: OK (...)` and exits 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/validate-data.mjs
git commit -m "feat(data): add generated-data validator"
```

---

### Task A6: Ignore generated data; wire generator test script

Keep the large generated blobs out of git, and make the generator unit tests runnable via pnpm.

**Files:**
- Modify: `.gitignore`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Ignore generated output** — append to `.gitignore`:

```gitignore
# Generated game data (baked into the image at build time)
/public/data/
/public/builds.json
```

- [ ] **Step 2: Add a generator-test script** — in `package.json` `scripts`, add:

```json
"test:data": "node --test scripts/lib/",
```

- [ ] **Step 3: Verify**

Run: `pnpm test:data`
Expected: PASS (all `scripts/lib/*.test.mjs`).
Run: `git status --short public/` → shows nothing (generated files ignored).

- [ ] **Step 4: Commit**

```bash
git add .gitignore package.json
git commit -m "chore(data): ignore generated data, add test:data script"
```

---

### Task A7: Repoint the app at same-origin fork data

Switch the data base from the external host to same-origin, and point GitHub links at the fork.

**Files:**
- Modify: `src/constants.ts`

**Interfaces:**
- Produces: `CBN_DATA_BASE_URL` now same-origin; `BUILDS_URL` → `${BASE}/builds.json`; `getDataJSONUrl(v, p)` → `${BASE}/data/<v>/<p>`; `GAME_REPO_PATH` → `Toribash67/Cataclysm-BN`.

- [ ] **Step 1: Edit `src/constants.ts`**

Add an import at the top:

```ts
import { BASE_URL } from "./utils/env";
```

Replace the `CBN_DATA_BASE_URL` line:

```ts
// Same-origin: game data is baked into the image under `${BASE_URL}data/...`
// and `${BASE_URL}builds.json`. Trailing slash trimmed so path concatenation
// in getDataJSONUrl / BUILDS_URL stays correct (BASE_URL is "/" in this build).
export const CBN_DATA_BASE_URL = BASE_URL.replace(/\/+$/, "");
```

Replace the `GAME_REPO_PATH` line:

```ts
export const GAME_REPO_PATH = "Toribash67/Cataclysm-BN";
```

(Leave `BUILDS_URL` and `getDataJSONUrl` as-is — they already derive from `CBN_DATA_BASE_URL`.)

- [ ] **Step 2: Typecheck**

Run: `pnpm check:types`
Expected: PASS (no type errors from the constants change).

- [ ] **Step 3: Commit**

```bash
git add src/constants.ts
git commit -m "feat: serve game data same-origin and point links at the fork"
```

---

### Task A8: Point PWA runtime caching at same-origin data

Replace the five `data.cataclysmbn-guide.com` runtime-cache rules with same-origin rules for `builds.json` and `data/stable/`.

**Files:**
- Modify: `vite.config.ts` (the `workbox.runtimeCaching` array, currently lines ~118–214)

- [ ] **Step 1: Replace the five external-host rules**

Delete the five objects whose `urlPattern` matches `data.cataclysmbn-guide.com` (the `builds.json`, `/data/nightly/`, `/data/stable/`, `/data/v`, `/data/20` rules) and replace them with these two, keeping the trailing Transifex rule untouched:

```ts
{
  // Same-origin build list — check network first, fall back to cache offline.
  urlPattern: /\/builds\.json$/,
  handler: "NetworkFirst",
  options: {
    cacheName: "builds-cache-v3",
    expiration: {
      maxEntries: 1,
      maxAgeSeconds: 60 * 15,
    },
    cacheableResponse: {
      statuses: [200],
    },
  },
},
{
  // Same-origin baked game data (all.json / all_mods.json under data/stable/).
  urlPattern: /\/data\/stable\//,
  handler: "NetworkFirst",
  options: {
    cacheName: "gamedata-cache-v3",
    expiration: {
      maxEntries: 15,
      maxAgeSeconds: 60 * 60 * 24 * 30,
    },
    cacheableResponse: {
      statuses: [200],
    },
  },
},
```

- [ ] **Step 2: Verify the build produces a service worker**

Run: `pnpm build`
Expected: build succeeds; `dist/sw.js` is emitted and `dist/data/stable/all.json` + `dist/builds.json` exist (copied from `public/` populated in Task A4). No workbox precache-size error.

- [ ] **Step 3: Commit**

```bash
git add vite.config.ts
git commit -m "feat(pwa): cache same-origin game data at runtime"
```

---

### Task A9: Container image (Dockerfile + nginx + dockerignore)

**Files:**
- Create: `Dockerfile`
- Create: `nginx.conf`
- Create: `.dockerignore`

- [ ] **Step 1: Create `nginx.conf`**

```nginx
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;

  gzip on;
  gzip_comp_level 6;
  gzip_min_length 1024;
  gzip_proxied any;
  gzip_types application/json application/javascript text/css image/svg+xml application/manifest+json;

  location = /index.html {
    add_header Cache-Control "no-cache";
  }
  location = /builds.json {
    add_header Cache-Control "no-cache";
  }
  location = /data/stable/all.json {
    add_header Cache-Control "no-cache";
  }
  location = /data/stable/all_mods.json {
    add_header Cache-Control "no-cache";
  }

  location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
    try_files $uri =404;
  }

  location / {
    try_files $uri /index.html;
  }
}
```

- [ ] **Step 2: Create `Dockerfile`** (pnpm via corepack; `node:24-slim` build stage avoids musl native-dep issues)

```dockerfile
FROM node:24-slim AS build
WORKDIR /app
# .git is not in the build context; husky's prepare script would fail without
# a git repo, so disable it.
ENV HUSKY=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
```

- [ ] **Step 3: Create `.dockerignore`** (must NOT exclude `public/`, which holds the generated data)

```dockerignore
node_modules
.git
game
Cataclysm-BN
_test
_rendered
dist
dev-dist
docs
bench-results
```

- [ ] **Step 4: Build the image locally (data already generated in Task A4)**

Run: `docker build -t cbn-guide-web:local .`
Expected: build succeeds; both stages complete.

- [ ] **Step 5: Smoke-test the container**

Run:
```bash
docker run --rm -d -p 18099:80 --name cbn-smoke cbn-guide-web:local
sleep 2
curl -sSf http://127.0.0.1:18099/ | head -c 200
curl -sSf -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18099/data/stable/all.json
curl -sSf -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18099/builds.json
docker rm -f cbn-smoke
```
Expected: index HTML prints; both JSON endpoints return `200`.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile nginx.conf .dockerignore
git commit -m "feat(deploy): add nginx container image (pnpm build)"
```

---

### Task A10: Replace the deploy workflow with GHCR build+push

Swap the Cloudflare/Transifex/Sentry deploy for one that regenerates fork data and pushes the image.

**Files:**
- Modify (overwrite): `.github/workflows/deploy.yml`

- [ ] **Step 1: Overwrite `.github/workflows/deploy.yml`**

```yaml
name: Deploy

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  repository_dispatch:
    types: [game-updated]
  workflow_dispatch:

permissions:
  contents: read
  packages: write

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout guide
        uses: actions/checkout@v4

      - name: Checkout game
        uses: actions/checkout@v4
        with:
          repository: Toribash67/Cataclysm-BN
          ref: main
          path: game

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 24

      - name: Run generator unit tests
        run: node --test scripts/lib/

      - name: Generate data
        run: node scripts/generate-data.mjs game

      - name: Validate data
        run: node scripts/validate-data.mjs

      - name: Extract game build number
        run: echo "GAME_SHA=$(jq -r '.[0].build_number' public/builds.json)" >> "$GITHUB_ENV"

      - name: Set image name
        run: echo "IMAGE_NAME=ghcr.io/${GITHUB_REPOSITORY_OWNER,,}/cbn-guide-web" >> "$GITHUB_ENV"

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        if: github.event_name != 'pull_request'
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          push: ${{ github.event_name != 'pull_request' }}
          tags: |
            ${{ env.IMAGE_NAME }}:latest
            ${{ env.IMAGE_NAME }}:${{ env.GAME_SHA }}
```

- [ ] **Step 2: Validate YAML + prettier**

Run: `pnpm exec prettier -c .github/workflows/deploy.yml`
Expected: no formatting complaints.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: replace Cloudflare deploy with GHCR image build+push"
```

---

### Task A11: Dockge stack + deploy docs + game-repo trigger

**Files:**
- Create: `deploy/dockge/compose.yml`
- Create: `docs/deploy/README.md`
- Create: `docs/deploy/notify-guide.yml`

- [ ] **Step 1: Create `deploy/dockge/compose.yml`**

```yaml
services:
  cbn-guide-web:
    image: ghcr.io/toribash67/cbn-guide-web:latest
    container_name: cbn-guide-web
    restart: unless-stopped
    labels:
      com.centurylinklabs.watchtower.enable: "true"
    ports:
      - "18082:80"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1/"]
      interval: 30s
      timeout: 5s
      retries: 3
```

- [ ] **Step 2: Create `docs/deploy/notify-guide.yml`** (applied to the game repo, not this one)

```yaml
name: Notify Guide

on:
  push:
    branches: [main]

permissions: {}

jobs:
  dispatch:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger guide rebuild
        run: |
          curl -sSf -X POST \
            -H "Authorization: Bearer ${{ secrets.GUIDE_DISPATCH_TOKEN }}" \
            -H "Accept: application/vnd.github+json" \
            https://api.github.com/repos/Toribash67/cbn-guide/dispatches \
            -d '{"event_type":"game-updated"}'
```

- [ ] **Step 3: Create `docs/deploy/README.md`**

```markdown
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
```

- [ ] **Step 4: Prettier check**

Run: `pnpm exec prettier -c deploy/dockge/compose.yml docs/deploy/README.md docs/deploy/notify-guide.yml`
Expected: no complaints. (`docs/deploy/` is NOT under the prettier-ignored `docs/superpowers/`, so it must be clean.)

- [ ] **Step 5: Commit**

```bash
git add deploy/dockge/compose.yml docs/deploy
git commit -m "docs(deploy): add dockge stack, deploy guide, game-repo trigger"
```

---

# Part B — Vehicle-page spawn locations + spawn groups

### Task B1: Vehicle spawn types

Add the mapgen/palette/vehicle_group types the spawn logic needs. Anchors verified in cbn `src/types.ts`.

**Files:**
- Modify: `src/types.ts`

**Interfaces:**
- Produces: `MapgenVehicle`, `MapgenObject.place_vehicles?`, `MapgenObject.vehicles?`, `PaletteData.vehicles?`, `VehicleGroup`, `SupportedTypes.vehicle_group`.

- [ ] **Step 1: Add `MapgenVehicle` above `interface MapgenObject`** (after `MapgenPlaceFurniture`, ~line 1195):

```ts
export type MapgenVehicle = {
  vehicle: MapgenValue;
  chance?: number;
  rotation?: number | [number, number];
  fuel?: number;
  status?: number;
};
```

- [ ] **Step 2: Replace the commented placeholders in `MapgenObject`** (lines 1221–1222):

```ts
  place_vehicles?: PlaceList<MapgenVehicle>;
  vehicles?: PlaceMapping<MapgenVehicle>;
```

- [ ] **Step 3: Add `vehicles` to `PaletteData`** (inside the `PaletteData` interface, ~line 1448, next to its other `PlaceMapping` fields):

```ts
  vehicles?: PlaceMapping<MapgenVehicle>;
```

- [ ] **Step 4: Add `VehicleGroup` just above `export type Vehicle = {`** (~line 2042):

```ts
export type VehicleGroup = {
  id: string;
  type: "vehicle_group";
  vehicles: (string | [string, number])[];
};
```

- [ ] **Step 5: Register in `SupportedTypes`** — after the `vehicle_part: VehiclePart;` line (~2293):

```ts
  vehicle_group: VehicleGroup;
```

- [ ] **Step 6: Typecheck**

Run: `pnpm check:types`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts
git commit -m "feat(vehicle): add vehicle spawn / vehicle_group types"
```

---

### Task B2: `resolveVehicleField` + `vehicleGroupMembership`

**Files:**
- Modify: `src/types/item/spawnLocations.ts`
- Modify: `src/types/item/spawnLocations.test.ts`

**Interfaces:**
- Consumes: existing `lazily`, `getMapgenValueDistribution`, `CBNData.byType`/`byIdMaybe` (all present in cbn `spawnLocations.ts`).
- Produces:
  - `resolveVehicleField(data: CBNData, field: raw.MapgenValue) => Map<string, number>`
  - `type VehicleGroupMembership = { group_id: string; weight: number; groupTotal: number }`
  - `vehicleGroupMembership(data: CBNData) => Map<string, VehicleGroupMembership[]>`

- [ ] **Step 1: Add failing tests** — in `src/types/item/spawnLocations.test.ts`, extend the existing import from `./spawnLocations` to include `resolveVehicleField` and `vehicleGroupMembership`, then append:

```ts
describe("resolveVehicleField()", () => {
  it("treats a bare id with no group as a 100% single-entry group", () => {
    expect(resolveVehicleField(emptyData, "car")).toStrictEqual(
      new Map([["car", 1]]),
    );
  });
  it("resolves an explicit group into normalized weight fractions", () => {
    const data = makeTestCBNData([
      {
        type: "vehicle_group",
        id: "g",
        vehicles: [
          ["car", 700],
          ["bike", 300],
        ],
      },
    ]);
    expect(resolveVehicleField(data, "g")).toStrictEqual(
      new Map([
        ["car", 0.7],
        ["bike", 0.3],
      ]),
    );
  });
  it("treats an unknown id as itself at 100%", () => {
    expect(resolveVehicleField(emptyData, "nonexistent")).toStrictEqual(
      new Map([["nonexistent", 1]]),
    );
  });
});

describe("vehicleGroupMembership()", () => {
  it("indexes each vehicle to its groups with weight and group total", () => {
    const data = makeTestCBNData([
      {
        type: "vehicle_group",
        id: "city_vehicles",
        vehicles: [
          ["car", 700],
          ["bike", 300],
        ],
      },
      { type: "vehicle_group", id: "road_vehicles", vehicles: [["car", 400]] },
    ]);
    const got = vehicleGroupMembership(data);
    expect(got.get("car")).toStrictEqual([
      { group_id: "city_vehicles", weight: 700, groupTotal: 1000 },
      { group_id: "road_vehicles", weight: 400, groupTotal: 400 },
    ]);
    expect(got.get("bike")).toStrictEqual([
      { group_id: "city_vehicles", weight: 300, groupTotal: 1000 },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/types/item/spawnLocations.test.ts`
Expected: FAIL — `resolveVehicleField`/`vehicleGroupMembership` not exported.

- [ ] **Step 3: Implement** — in `src/types/item/spawnLocations.ts`, add after the `terrainByOMSAppearance` export:

```ts
export type VehicleGroupMembership = {
  group_id: string;
  weight: number;
  groupTotal: number;
};
export const vehicleGroupMembership = lazily((data: CBNData) => {
  const membership = new Map<string, VehicleGroupMembership[]>();
  for (const group of data.byType("vehicle_group")) {
    if (!group.id) continue;
    const members: [string, number][] = (group.vehicles ?? []).map((v) =>
      Array.isArray(v) ? [v[0], v[1]] : [v, 1],
    );
    const groupTotal = members.reduce((m, [, w]) => m + w, 0);
    for (const [vid, weight] of members) {
      if (!membership.has(vid)) membership.set(vid, []);
      membership.get(vid)!.push({ group_id: group.id, weight, groupTotal });
    }
  }
  return membership;
});
```

And add `resolveVehicleField` right after the existing `getMapgenValueDistribution` function:

```ts
export function resolveVehicleField(
  data: CBNData,
  field: raw.MapgenValue,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const [id, prob] of getMapgenValueDistribution(field).entries()) {
    const group = data.byIdMaybe("vehicle_group", id);
    const members: [string, number][] = group
      ? (group.vehicles ?? []).map((v) =>
          Array.isArray(v) ? [v[0], v[1]] : [v, 1],
        )
      : [[id, 1]];
    const total = members.reduce((m, [, w]) => m + w, 0) || 1;
    for (const [vid, weight] of members) {
      result.set(vid, (result.get(vid) ?? 0) + prob * (weight / total));
    }
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/types/item/spawnLocations.test.ts`
Expected: PASS (new describes green; existing tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/types/item/spawnLocations.ts src/types/item/spawnLocations.test.ts
git commit -m "feat(vehicle): resolve vehicle fields and index group membership"
```

---

### Task B3: `parseVehiclePalette` + `getVehiclesForMapgen` + `vehicleByOMSAppearance`

**Files:**
- Modify: `src/types/item/spawnLocations.ts`
- Modify: `src/types/item/spawnLocations.test.ts`

**Interfaces:**
- Consumes: `resolveVehicleField` (B2); existing `parsePlaceMapping`, `mergePalettes`, `attenuatePalette`, `collection`, `repeatItemChance`, `computeLootByOMSAppearance`, `Loot`, `raw.PaletteData`, `raw.Mapgen`.
- Produces:
  - `parseVehiclePalette(data, palette) => Map<string, Loot>`
  - `getVehiclesForMapgen(data, mapgen) => Loot`
  - `vehicleByOMSAppearance(data) => Map<...>` (same shape as the other `*ByOMSAppearance`).

- [ ] **Step 1: Add a failing test** — append to `src/types/item/spawnLocations.test.ts` (add `getVehiclesForMapgen` to the `./spawnLocations` import; `Mapgen` is already imported from `../../types`):

```ts
describe("getVehiclesForMapgen()", () => {
  it("handles place_vehicles with an explicit group and a palette symbol", () => {
    const data = makeTestCBNData([
      {
        type: "vehicle_group",
        id: "g",
        vehicles: [
          ["car", 700],
          ["bike", 300],
        ],
      },
      {
        type: "mapgen",
        method: "json",
        om_terrain: "test_ter",
        object: {
          rows: ["V", "V"],
          vehicles: { V: { vehicle: "motorcycle", chance: 50 } },
          place_vehicles: [{ vehicle: "g", x: 0, y: 0, chance: 100 }],
        },
      } as Mapgen,
    ]);
    const loot = getVehiclesForMapgen(data, data.byType("mapgen")[0]);
    // place_vehicles: group "g" at 100% -> car 0.7, bike 0.3
    expect(loot.get("car")).toStrictEqual({ prob: 0.7, expected: 0.7 });
    expect(loot.get("bike")).toStrictEqual({ prob: 0.3, expected: 0.3 });
    // palette symbol "V" appears twice at 50% each:
    //   prob = 1-(1-0.5)^2 = 0.75 ; expected = 0.5+0.5 = 1
    expect(loot.get("motorcycle")).toStrictEqual({ prob: 0.75, expected: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/types/item/spawnLocations.test.ts`
Expected: FAIL — `getVehiclesForMapgen` not exported.

- [ ] **Step 3: Implement** — in `src/types/item/spawnLocations.ts`:

Add the `vehicleByOMSAppearance` export next to the other `*ByOMSAppearance` exports:

```ts
export const vehicleByOMSAppearance = lazily((data: CBNData) =>
  computeLootByOMSAppearance(data, (mg) => getVehiclesForMapgen(data, mg)),
);
```

Add `getVehiclesForMapgen` next to `getFurnitureForMapgen`:

```ts
const vehiclesForMapgenCache = new WeakMap<raw.Mapgen, Loot>();
export function getVehiclesForMapgen(data: CBNData, mapgen: raw.Mapgen): Loot {
  if (vehiclesForMapgenCache.has(mapgen))
    return vehiclesForMapgenCache.get(mapgen)!;
  const palette = parseVehiclePalette(data, mapgen.object);
  const place_vehicles: Loot[] = (mapgen.object.place_vehicles ?? []).map(
    ({ vehicle, chance = 100 }) => {
      const loot: Loot = new Map();
      for (const [vid, frac] of resolveVehicleField(data, vehicle).entries()) {
        const p = (chance / 100) * frac;
        loot.set(vid, { prob: p, expected: p });
      }
      return loot;
    },
  );
  const additional_items = collection([...place_vehicles]);
  const countByPalette = new Map<string, number>();
  for (const row of mapgen.object.rows ?? [])
    for (const char of row)
      if (palette.has(char))
        countByPalette.set(char, (countByPalette.get(char) ?? 0) + 1);
  const items: Loot[] = [];
  for (const [sym, count] of countByPalette.entries()) {
    const loot = palette.get(sym)!;
    const multipliedLoot: Loot = new Map();
    for (const [id, chance] of loot.entries()) {
      multipliedLoot.set(id, repeatItemChance(chance, [count, count]));
    }
    items.push(multipliedLoot);
  }
  items.push(additional_items);
  const loot = collection(items);
  vehiclesForMapgenCache.set(mapgen, loot);
  return loot;
}
```

Add `parseVehiclePalette` next to `parseFurniturePalette`:

```ts
const vehiclePaletteCache = new WeakMap<raw.PaletteData, Map<string, Loot>>();
export function parseVehiclePalette(
  data: CBNData,
  palette: raw.PaletteData,
): Map<string, Loot> {
  if (vehiclePaletteCache.has(palette)) return vehiclePaletteCache.get(palette)!;
  const vehicles = parsePlaceMapping(
    palette.vehicles,
    function* ({ vehicle, chance = 100 }) {
      const loot: Loot = new Map();
      for (const [vid, frac] of resolveVehicleField(data, vehicle).entries()) {
        const p = (chance / 100) * frac;
        loot.set(vid, { prob: p, expected: p });
      }
      yield loot;
    },
  );
  const palettes = (palette.palettes ?? []).flatMap((val) => {
    if (typeof val === "string") {
      return [parseVehiclePalette(data, data.byId("palette", val))];
    } else if ("distribution" in val) {
      const opts = val.distribution;
      function prob<T>(it: T | [T, number]) {
        return Array.isArray(it) ? it[1] : 1;
      }
      function id<T>(it: T | [T, number]) {
        return Array.isArray(it) ? it[0] : it;
      }
      const totalProb = opts.reduce((m, it) => m + prob(it), 0);
      return opts.map((it) =>
        attenuatePalette(
          parseVehiclePalette(data, data.byId("palette", id(it))),
          prob(it) / totalProb,
        ),
      );
    } else return [];
  });
  const ret = mergePalettes([vehicles, ...palettes]);
  vehiclePaletteCache.set(palette, ret);
  return ret;
}
```

> If `parsePlaceMapping`'s generator-callback signature in cbn differs from the DDA fork's, match cbn's existing `parseFurniturePalette` call form exactly (same file) — the vehicle version mirrors it symbol-for-symbol.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/types/item/spawnLocations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types/item/spawnLocations.ts src/types/item/spawnLocations.test.ts
git commit -m "feat(vehicle): compute vehicle spawn loot by OMS appearance"
```

---

### Task B4: `VehicleSpawns.svelte` + wire into the vehicle page

**Files:**
- Create: `src/types/vehicle/VehicleSpawns.svelte`
- Modify: `src/types/Vehicle.svelte`

**Interfaces:**
- Consumes: `vehicleByOMSAppearance`, `vehicleGroupMembership` (B2/B3); existing `src/types/item/LocationTable.svelte`.

- [ ] **Step 1: Create `src/types/vehicle/VehicleSpawns.svelte`** (Svelte 5 runes, matching cbn's `FurnitureSpawnedIn.svelte` style):

```svelte
<script lang="ts">
import { getContext } from "svelte";
import { t } from "@transifex/native";

import type { CBNData } from "../../data";
import {
  vehicleByOMSAppearance,
  vehicleGroupMembership,
} from "../item/spawnLocations";
import LocationTable from "../item/LocationTable.svelte";

interface Props {
  vehicle_id: string;
}

let { vehicle_id }: Props = $props();

const data = getContext<CBNData>("data");
const _context = "Vehicle";

const memberships = (vehicleGroupMembership(data).get(vehicle_id) ?? [])
  .slice()
  .sort((a, b) => b.weight / b.groupTotal - a.weight / a.groupTotal);
</script>

{#if memberships.length}
  <section>
    <h2>{t("Spawn groups", { _context })}</h2>
    <ul>
      {#each memberships as m}
        <li>
          {m.group_id} &mdash; {m.weight}
          ({((m.weight / m.groupTotal) * 100).toFixed(1)}%)
        </li>
      {/each}
    </ul>
  </section>
{/if}

<LocationTable
  id={vehicle_id}
  loots={vehicleByOMSAppearance(data)}
  heading={t("Where it spawns", { _context })} />
```

- [ ] **Step 2: Render it on the vehicle page** — in `src/types/Vehicle.svelte`:

Add to the imports (with the other `./...` imports):

```ts
import VehicleSpawns from "./vehicle/VehicleSpawns.svelte";
```

Add the component after the Parts `{#if partsCounted.length}...{/if}` block and before the final `<ItemTable ... />`:

```svelte
<VehicleSpawns vehicle_id={item.id} />
```

- [ ] **Step 3: Typecheck + build**

Run: `pnpm check:types`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/types/vehicle/VehicleSpawns.svelte src/types/Vehicle.svelte
git commit -m "feat(vehicle): show spawn groups and spawn locations on vehicle pages"
```

---

### Task B5: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test:data && pnpm lint && pnpm check`
Expected: all green (prettier clean, svelte-check + tsc clean, generator node tests pass).

- [ ] **Step 2: Run the vitest suite for spawn logic**

Run: `pnpm vitest run src/types/item/spawnLocations.test.ts`
Expected: PASS.

- [ ] **Step 3: Regenerate real data and production-build**

Run: `node scripts/generate-data.mjs ../Cataclysm-BN && node scripts/validate-data.mjs && pnpm build`
Expected: validator OK; `pnpm build` succeeds with `dist/data/stable/all.json`, `dist/data/stable/all_mods.json`, `dist/builds.json`, and `dist/sw.js` present.

- [ ] **Step 4: Manual smoke (optional but recommended)**

Run: `pnpm preview` and open a vehicle page (e.g. `/stable/vehicle/<some_vehicle_id>`); confirm a "Spawn groups" list (for a grouped vehicle like `car`) and a "Where it spawns" table render.

- [ ] **Step 5: No commit** (verification only). Proceed to branch finalization / PR per `superpowers:finishing-a-development-branch`.

---

## Self-Review

**Spec coverage (fork-deploy):**
- Generator (all.json) → A2; all_mods.json → A3; builds.json + CLI → A4; validation → A5 + A10. ✓
- Same-origin repoint + fork links → A7; PWA rule → A8. ✓
- Dockerfile/nginx/.dockerignore → A9; GHCR deploy workflow → A10; dockge + docs + game-repo dispatch + PAT scope → A11. ✓
- English-only (no lang output) → generator never writes `lang/` (A4). ✓
- Build without secrets → A9 Dockerfile sets no tokens; verified in A9 Step 4 / B5 Step 3. ✓
- Port 18082 / DDA cut-over → A11 compose + README. ✓

**Spec coverage (vehicle spawns):**
- Types → B1; `resolveVehicleField` + `vehicleGroupMembership` → B2; `getVehiclesForMapgen` + `parseVehiclePalette` + `vehicleByOMSAppearance` → B3; `VehicleSpawns.svelte` + page wiring → B4; tests throughout; catalog wiring intentionally omitted (already present in cbn). ✓

**Type consistency:** `VehicleGroupMembership` fields (`group_id`, `weight`, `groupTotal`) match between B2's definition, B3/B4 consumers, and the test assertions. `Loot` entry shape `{ prob, expected }` matches cbn's existing furniture path. `MapgenVehicle.vehicle: MapgenValue` matches `resolveVehicleField(data, field: raw.MapgenValue)`. ✓

**Placeholder scan:** No TBD/TODO; every code step contains full content. The two "if cbn differs, match the sibling furniture form" notes (A3 not needed; B3 Step 3) are guardrails against a signature mismatch, not missing content — the primary code is complete and mirrors the same file's furniture path. ✓
