import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildAllJson,
  buildAllMods,
  expandVehiclePartShapes,
} from "./generate.mjs";

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
  // 5 plain fixture objects + 2 vehicle_part bases (frame abstract, wing_mirror)
  // + 4 expanded shape variants (frame_vertical, frame_nw, wing_mirror_left,
  // wing_mirror_right).
  assert.equal(all.data.length, 11);

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

test("buildAllJson expands vehicle_part shapes into copy-from variants", async () => {
  const all = await buildAllJson(gameDir, { buildNumber: "test" });

  const frameVertical = all.data.find((o) => o.id === "frame_vertical");
  const { __filename, ...frameVerticalFields } = frameVertical;
  assert.deepEqual(frameVerticalFields, {
    id: "frame_vertical",
    "copy-from": "frame",
    type: "vehicle_part",
    symbol: "j",
  });
  // Expanded variants inherit the base part's provenance.
  assert.match(__filename, /^data\/json\/vehicleparts\.json#L/);

  // Base abstract is preserved untouched.
  assert.ok(all.data.some((o) => o.abstract === "frame"));
});

test("expandVehiclePartShapes derives ids from the abstract name", () => {
  const variants = expandVehiclePartShapes([
    {
      abstract: "frame",
      type: "vehicle_part",
      shapes: [
        { direction: "vertical", symbol: "j" },
        { direction: "nw", symbol: "y" },
      ],
    },
  ]);

  assert.deepEqual(variants, [
    {
      id: "frame_vertical",
      "copy-from": "frame",
      type: "vehicle_part",
      symbol: "j",
    },
    { id: "frame_nw", "copy-from": "frame", type: "vehicle_part", symbol: "y" },
  ]);
});

test("expandVehiclePartShapes derives ids from a concrete id and suffixes looks_like", () => {
  const variants = expandVehiclePartShapes([
    {
      id: "wing_mirror",
      type: "vehicle_part",
      looks_like: "mirror",
      shapes: [{ direction: "left" }, { direction: "right" }],
    },
  ]);

  assert.deepEqual(variants, [
    {
      id: "wing_mirror_left",
      "copy-from": "wing_mirror",
      type: "vehicle_part",
      looks_like: "mirror_left",
    },
    {
      id: "wing_mirror_right",
      "copy-from": "wing_mirror",
      type: "vehicle_part",
      looks_like: "mirror_right",
    },
  ]);
});

test("expandVehiclePartShapes honors an explicit per-shape looks_like and carries __filename", () => {
  const variants = expandVehiclePartShapes([
    {
      id: "box",
      type: "vehicle_part",
      looks_like: "box",
      __filename: "data/json/vehicleparts/boxes.json#L1-L9",
      shapes: [{ direction: "left", symbol: "[", looks_like: "custom_box" }],
    },
  ]);

  assert.deepEqual(variants, [
    {
      id: "box_left",
      "copy-from": "box",
      type: "vehicle_part",
      symbol: "[",
      looks_like: "custom_box",
      __filename: "data/json/vehicleparts/boxes.json#L1-L9",
    },
  ]);
});

test("expandVehiclePartShapes ignores non-vehicle_part and shapeless objects", () => {
  assert.deepEqual(
    expandVehiclePartShapes([
      { id: "widget", type: "GENERIC", shapes: [{ direction: "x" }] },
      { id: "frame", type: "vehicle_part" },
    ]),
    [],
  );
});
