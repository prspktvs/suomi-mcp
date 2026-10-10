import type { CatalogPort } from "../catalog/port.js";
import { candidateFromSummary } from "../catalog/port.js";
import { executeLegacyPxWebQuery, getLegacyTableSchema } from "../legacy-pxweb.js";
import type { ProviderSchema, SourceCandidate } from "../contracts/retrieval.js";
import type { StatisticalProvider } from "./types.js";
import { createHash } from "node:crypto";
import { mapPxWebDimensions } from "./pxweb-schema.js";
import { pxwebClient } from "../pxweb/client.js";

/** Adapter for Helsinki's official ASP.NET PxWeb forms. The host's API-v1
 * endpoint returns 500, so schemas and bounded selections use the provider's
 * documented form transport instead of pretending it is an API-v1 source. */
export class HelsinkiLegacyPxWebProvider implements StatisticalProvider {
  readonly id = "helsinki";
  readonly label = "City of Helsinki PxWeb";
  constructor(private readonly catalog: CatalogPort, private readonly maxCells = 25_000) {}
  async discover({ query, limit, embedding }: { query: string; limit: number; embedding?: { model: string; values: number[] } }): Promise<SourceCandidate[]> {
    return (await this.catalog.searchProvider(this.id, query, limit, embedding)).map(candidateFromSummary);
  }
  async getSchema({ resource_id }: { resource_id: string }): Promise<ProviderSchema> {
    const request = (url: string, init?: RequestInit) => pxwebClient().request(url, init, 30_000);
    const raw = await getLegacyTableSchema(resource_id, request);
    return { provider_id: this.id, dataset_id: resource_id.split("/").at(-1) ?? resource_id, resource_id, dimensions: mapPxWebDimensions(raw.variables), provenance: { source_url: resource_id, retrieved_at: new Date().toISOString(), schema_hash: createHash("sha256").update(JSON.stringify(raw.variables)).digest("hex") } };
  }
  async query({ resource_id, selections }: { resource_id: string; selections: Array<{ dimension_id: string; value_ids: string[] }> }) {
    const request = (url: string, init?: RequestInit) => pxwebClient().request(url, init, 30_000);
    return { provider_id: this.id, resource_id, rows: await executeLegacyPxWebQuery(resource_id, selections.map((selection) => ({ code: selection.dimension_id, values: selection.value_ids })), request, this.maxCells), retrieved_at: new Date().toISOString(), source_url: resource_id };
  }
}
