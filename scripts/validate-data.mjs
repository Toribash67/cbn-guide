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
  if (
    !obj ||
    typeof obj !== "object" ||
    !/#L\d+-L\d+$/.test(obj.__filename ?? "")
  )
    fail(
      `object missing valid __filename: ${JSON.stringify(obj).slice(0, 120)}`,
    );
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

if (!Array.isArray(builds) || builds.length !== 1)
  fail("builds.json malformed");
if (builds[0].build_number !== all.build_number)
  fail("builds.json build_number mismatch");

console.log(
  `validate-data: OK (${all.data.length} objects, ${Object.keys(mods).length} mods, build ${all.build_number})`,
);
