import { createHash } from "node:crypto";
import type { CatalogPort } from "../catalog/port.js";
import { candidateFromSummary } from "../catalog/port.js";
import { assertCellLimit, flattenJsonStat } from "../pxweb/jsonstat.js";
import { pxwebClient } from "../pxweb/client.js";
import type { ProviderSchema, SourceCandidate } from "../contracts/retrieval.js";
import type { StatisticalProvider } from "./types.js";
import { mapPxWebDimensions, type PxWebSchemaVariable } from "./pxweb-schema.js";

const apiBase = "https://trafi2.stat.fi/PXWeb/api/v1";
const webBase = "https://trafi2.stat.fi/PXWeb/pxweb/fi/TraFi";
const apiUrl = (resourceId: string) => `${apiBase}/fi/TraFi/${resourceId.split("/").map(encodeURIComponent).join("/")}`;
const sourceUrl = (resourceId: string) => `${webBase}/${resourceId.split("/").map(encodeURIComponent).join("/")}`;

/** Traficom publishes its official statistical tables through a PxWeb API.
 * Roles are retained only when the provider declares them (`time`); all
 * other semantic selections remain model-authored source bindings. */
export class TraficomPxWebProvider implements StatisticalProvider {
  readonly id = "traficom";
  readonly label = "Traficom PxWeb";
  constructor(private readonly catalog: CatalogPort, private readonly maxCells = 25_000) {}

  async discover({ query, limit, embedding }: { query: string; limit: number; embedding?: { model: string; values: number[] } }): Promise<SourceCandidate[]> {
    return (await this.catalog.searchProvider(this.id, query, limit, embedding)).map(candidateFromSummary);
  }

  async getSchema({ resource_id }: { resource_id: string }): Promise<ProviderSchema> {
    const raw = await pxwebClient().schema<{ variables?: PxWebSchemaVariable[] }>(`${this.id}:${resource_id}:fi`, apiUrl(resource_id));
    return {
      provider_id: this.id, dataset_id: resource_id.split("/").at(-1) ?? resource_id, resource_id,
      dimensions: mapPxWebDimensions(raw.variables ?? []),
      provenance: { source_url: sourceUrl(resource_id), retrieved_at: new Date().toISOString(), schema_hash: createHash("sha256").update(JSON.stringify(raw.variables ?? [])).digest("hex") },
    };
  }

  async query({ resource_id, selections }: { resource_id: string; selections: Array<{ dimension_id: string; value_ids: string[] }> }) {
    assertCellLimit(selections.map((selection) => ({ code: selection.dimension_id, values: selection.value_ids })), this.maxCells);
    const response = await pxwebClient().request(apiUrl(resource_id), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: selections.map((selection) => ({ code: selection.dimension_id, selection: { filter: "item", values: selection.value_ids } })), response: { format: "json-stat2" } }) });
    if (!response.ok) throw new Error(`Traficom PxWeb query failed (${response.status}): ${await response.text()}`);
    return { provider_id: this.id, resource_id, rows: flattenJsonStat(await response.json() as Parameters<typeof flattenJsonStat>[0]), retrieved_at: new Date().toISOString(), source_url: sourceUrl(resource_id) };
  }
}
