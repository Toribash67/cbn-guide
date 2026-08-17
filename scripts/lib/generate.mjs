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
