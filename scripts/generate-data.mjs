import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAllJson, buildAllMods } from "./lib/generate.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gameDir = resolve(
  process.argv[2] ?? join(repoRoot, "..", "Cataclysm-BN"),
);

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
await writeFile(
  join(repoRoot, "public", "builds.json"),
  JSON.stringify(builds),
);

console.log(
  `Wrote ${all.data.length} core objects + ${Object.keys(mods).length} mods for build ${buildNumber}`,
);
