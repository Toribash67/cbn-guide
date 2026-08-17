# Vehicle-page spawn locations + spawn groups — design

**Date:** 2026-08-17
**Branch:** `cbn-fork-deploy-and-vehicle-spawns` (off `main`)

## Goal

On each vehicle's page, show **where it spawns** in the world (overmap specials)
and **which spawn groups** it belongs to.

This ports the sibling `cdda-guide` "vehicle-catalog-spawns" feature, adapted to
cbn-guide. Vehicle detail (`Vehicle.svelte` / `VehicleView.svelte`), routing,
search, and the catalog grid are already generic over `vehicle`, so the only real
work is the green-field spawn parsing plus one presentation component.

### What already exists in cbn-guide (verified)

- Vehicles are already in the front-page catalog (`CategoryGrid.svelte`, `href:
  "vehicle"`) — **no catalog wiring needed** (this differs from cdda-guide, where
  the catalog entry had to be added).
- `Thing.svelte` maps `vehicle` → `Vehicle.svelte` (the detail wrapper that
  renders `<h1>`, `<VehicleView>`, a Parts section, and an item-table).
- `src/types/item/SpawnedInVehicle.svelte` shows the **inverse** relation ("which
  vehicles does this item spawn in") on item pages — unrelated to this feature.
- `spawnLocations.ts` already has `lootByOMSAppearance`, `furnitureByOMSAppearance`,
  `terrainByOMSAppearance` and the memoized OMS-appearance machinery, but **no**
  `vehicleByOMSAppearance` and **no** vehicle-group handling.

## Game JSON shapes (verified against the `Toribash67/Cataclysm-BN` checkout)

Identical in shape to DDA:

- `place_vehicles` (explicit placement, ~214 mapgen files):
  `{ vehicle, x, y, chance: 0-100, rotation?, status?, fuel? }`. `chance` is a
  scalar percent. Example: `{ "vehicle": "warehouse_vehicles", "x": 5, "y": 17,
  "chance": 40 }`.
- Object-level `vehicles` symbol map and palette `vehicles` (~49 files):
  `{ <sym>: { vehicle, chance?, rotation? } }` — structurally identical to the
  `furniture` symbol maps.
- `vehicle_group` (`vehicle_groups.json`): `{ type: "vehicle_group", id,
  vehicles: [[vehicle_id, weight], ...] }`.

**Critical quirk (same as DDA):** the `vehicle` field in `place_vehicles` /
palette is a `mapgen_value<vgroup_id>` that ALWAYS resolves through the
vehicle_group table. In C++, every vehicle prototype auto-registers as its own
single-entry group (weight 100). So resolution must: look up
`byIdMaybe("vehicle_group", field)` — if found, use its weighted `vehicles`
array; else treat `field` as a direct vehicle id (an implicit 100% single-entry
group). There is no such auto-group fallback in item_group parsing, so this
differs from the item path.

## Types (`src/types.ts`)

- On the mapgen object type: add/uncomment `place_vehicles?: MapgenPlaceVehicle[]`
  and `vehicles?` (symbol map). Add/uncomment the palette `vehicles?` symbol map.
- New types:
  - `MapgenPlaceVehicle = { vehicle: MapgenValue; x; y; chance?: number;
    rotation?; status?; fuel? }` (mirror the furniture place type).
  - Palette/object symbol-map value: `{ vehicle: MapgenValue; chance?: number;
    rotation? }` (mirror the furniture `PlaceMapping` value; symbol map keyed like
    the furniture alternative form).
  - `export type VehicleGroup = { id: string; type: "vehicle_group"; vehicles:
    (string | [string, number])[] }` near `Vehicle`.
- Add `vehicle_group: VehicleGroup` to `SupportedTypes`.
- No `CBNData` constructor changes: it is generic over `obj.type`, so
  `data.byType("vehicle_group")` / `byIdMaybe` work once the type exists in loaded
  JSON.

The exact names of the existing furniture mirror types / mapgen-value helpers
will be matched to cbn-guide's current `spawnLocations.ts` during implementation
(cbn-guide's file is larger and may name them differently than cdda-guide).

## Spawn logic (`src/types/item/spawnLocations.ts`)

Mirror the **furniture** path (not the item path — vehicle placement is
symbol-keyed / explicit-coordinate, never inline in the ASCII `rows` grid).
Produce a `Loot` = `Map<vehicle_id, { prob, expected }>`.

- `resolveVehicleField(data, field) -> Map<vehicle_id, weightFraction>`: run
  `field` through the existing mapgen-value distribution helper (handles plain
  string, `distribution`, `param`); for each resulting id,
  `byIdMaybe("vehicle_group", id)` — if found, normalize its weighted `vehicles`
  array into fractions summing to 1; else `Map([[id, 1]])` (implicit single-entry
  group). Combine with the mapgen-value distribution weights.
- `parseVehiclePalette(data, palette) -> Map<sym, Loot>`: like the furniture
  palette parser. For each `palette.vehicles[sym] = { vehicle, chance }`, resolve
  the field and emit, per resolved vehicle, `{ prob: (chance ?? 100)/100 * frac,
  expected: same }`. Recurse into referenced `palettes` (string, `distribution`)
  the same way furniture does.
- `getVehiclesForMapgen(data, mapgen) -> Loot` (WeakMap-cached like the others):
  - `const palette = parseVehiclePalette(data, mapgen.object)` — handles the
    object-level `vehicles` symbol map plus referenced palettes.
  - Count symbol occurrences in `mapgen.object.rows`, multiply each symbol's
    `Loot` by its count, like furniture.
  - `place_vehicles`: each entry → resolve `vehicle` field → `{ prob: (chance ??
    100)/100 * frac, expected: same }` per resolved vehicle.
  - Combine everything; delete any null/empty ids.
- `vehicleByOMSAppearance = lazily(data => computeLootByOMSAppearance(data, mg =>
  getVehiclesForMapgen(data, mg)))` — reuses the existing memoized
  OMS-appearance machinery (as loot/furniture/terrain do).
- `vehicleGroupMembership = lazily(data => ...)`: reverse index
  `vehicle_id -> Array<{ group_id, weight, groupTotal }>`, built by walking all
  `vehicle_group`s and summing each group's total weight. Only explicit JSON
  groups (not the implicit self-groups).

## Presentation

- New `src/types/vehicle/VehicleSpawns.svelte`, prop `vehicle_id: string`:
  1. **Spawn groups** section: for each membership entry, show `group_id`,
     `weight`, and `weight / groupTotal` as a percentage. Group names are plain
     text (vehicle_group has no detail page to link to). Omit the section if the
     vehicle is in no explicit groups.
  2. Delegate to the existing location-table component (used by loot / furniture /
     terrain) unchanged: `id={vehicle_id}`, `loots={vehicleByOMSAppearance(data)}`,
     `heading={t("Where it spawns")}`. Keep both existing columns (Avg. Count +
     Chance).
- `Vehicle.svelte`: render `<VehicleSpawns vehicle_id={item.id} />` after the
  Parts section.

The exact name of the location-table component in cbn-guide will be confirmed
during implementation (cdda-guide's was `LocationTable.svelte`).

## Testing

Follow the existing `spawnLocations.test.ts` vitest pattern:

- `resolveVehicleField`: bare prototype → `{id: 1}`; explicit group → weighted
  fractions summing to 1; missing/unknown id → that id at 100% (implicit group),
  matching game behavior.
- `getVehiclesForMapgen`: a small synthetic mapgen exercising both a
  `place_vehicles` entry and a palette/object symbol map; assert the resulting
  `Loot` probabilities.
- Verify the app typechecks and builds.

## Scope

**In scope:** `place_vehicles` + object/palette `vehicles` symbol maps +
`vehicle_group` resolution, the two vehicle-page sections.

**Out of scope:**

- Catalog wiring (already present in cbn-guide).
- Legacy `vehicle_spawn` / `vehicle_placement` (rare; C++ consumer path appears
  unreferenced by current mapgen).
- Displaying `fuel` / `status` / `rotation`.
- A `vehicle_group` detail page or browsable catalog.
- Reverse "which vehicles spawn here" on overmap_special pages.
