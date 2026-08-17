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
