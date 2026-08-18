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

// Cataclysm-BN's vehicle-part loader (src/veh_type.cpp) expands any part with a
// `shapes` array into one concrete part per shape, id `<base>_<direction>`,
// copying the base and overriding the symbol / looks_like. The web guide reads
// raw game JSON and resolves `copy-from` at runtime, so we mirror the loader by
// emitting the same variants as lightweight `copy-from` records — exactly the
// shape the upstream data set shipped before the game moved to `shapes`.
// Without this, vehicles that mount shaped parts (frames, boards, mirrors, …)
// reference ids that never resolve and render as missing parts.
export function expandVehiclePartShapes(objects) {
  const variants = [];
  for (const obj of objects) {
    if (!obj || obj.type !== "vehicle_part" || !Array.isArray(obj.shapes)) {
      continue;
    }
    // A concrete part keys off its `id`; an abstract keys off `abstract`.
    const base = typeof obj.id === "string" ? obj.id : obj.abstract;
    if (typeof base !== "string") continue;

    for (const shape of obj.shapes) {
      if (!shape || typeof shape.direction !== "string") continue;
      const variant = {
        id: `${base}_${shape.direction}`,
        "copy-from": base,
        type: "vehicle_part",
      };
      if (typeof shape.symbol === "string") variant.symbol = shape.symbol;
      // Per veh_type.cpp: an explicit per-shape looks_like wins; otherwise a
      // base looks_like is suffixed with the direction. With neither, the
      // variant inherits looks_like via copy-from.
      if (typeof shape.looks_like === "string") {
        variant.looks_like = shape.looks_like;
      } else if (typeof obj.looks_like === "string") {
        variant.looks_like = `${obj.looks_like}_${shape.direction}`;
      }
      if (typeof obj.__filename === "string") {
        variant.__filename = obj.__filename;
      }
      variants.push(variant);
    }
  }
  return variants;
}

export async function buildAllJson(gameDir, opts) {
  const { buildNumber, createdAt, commitSubject } = opts;
  const files = await listJsonFiles(join(gameDir, "data", "json"));
  const data = [];
  for (const file of files) data.push(...(await readObjects(gameDir, file)));
  data.push(...expandVehiclePartShapes(data));

  const release = {
    tag_name: buildNumber,
    name: commitSubject ?? buildNumber,
    html_url: `https://github.com/Toribash67/Cataclysm-BN/commit/${buildNumber}`,
    published_at: createdAt ?? null,
  };

  return { build_number: buildNumber, release, data };
}

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
    data.push(...expandVehiclePartShapes(data));
    out[info.id] = { info, data };
  }
  return out;
}
