import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildAllJson, buildAllMods } from "./generate.mjs";

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

test("builds all_mods.json keyed by MOD_INFO id", async () => {
  const mods = await buildAllMods(gameDir);

  assert.deepEqual(Object.keys(mods), ["testmod"]);
  const mod = mods.testmod;
  assert.equal(mod.info.type, "MOD_INFO");
  assert.equal(mod.info.id, "testmod");
  assert.equal(mod.info.__filename, "data/mods/testmod/modinfo.json#L2-L8");

  // MOD_INFO is surfaced as `info`, not repeated in `data`.
  assert.ok(!mod.data.some((o) => o.type === "MOD_INFO"));
  const widget = mod.data.find((o) => o.id === "mod_widget");
  assert.equal(widget.__filename, "data/mods/testmod/content.json#L1-L1");
});

test("skips mod dirs without a MOD_INFO object", async () => {
  const mods = await buildAllMods(gameDir);
  assert.ok(!("not-a-mod" in mods));
});
