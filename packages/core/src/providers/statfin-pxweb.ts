import { createHash } from "node:crypto";
import type { CatalogPort } from "../catalog/port.js";
import { candidateFromSummary } from "../catalog/port.js";
import { assertCellLimit, flattenJsonStat } from "../pxweb/jsonstat.js";
import { currentStatFinTablePath, pxwebClient } from "../pxweb/client.js";
import type { ProviderSchema, SourceCandidate } from "../contracts/retrieval.js";
import type { StatisticalProvider } from "./types.js";
import { mapPxWebDimensions, type PxWebSchemaVariable } from "./pxweb-schema.js";

const apiUrl = (resourceId: string, language: string) => `https://pxdata.stat.fi/PxWeb/api/v1/${encodeURIComponent(language)}/${currentStatFinTablePath(resourceId).split("/").map(encodeURIComponent).join("/")}`;
export function statFinSourceUrl(resourceId: string, language: string) {
  const segments = resourceId.split("/");
  // Current StatFin web pages add the database name as `StatFin__<subject>`;
  // the API v1 resource path remains `StatFin/<subject>/<table>.px`.
  if (segments[0] === "StatFin" && segments.length >= 3 && !segments[1]?.startsWith("StatFin__")) {
    segments[1] = `StatFin__${segments[1]}`;
  }
  return `https://pxdata.stat.fi/PXWeb/pxweb/${encodeURIComponent(language)}/${segments.map(encodeURIComponent).join("/")}`;
}
export class StatFinPxWebProvider implements StatisticalProvider {
  readonly id = "statfin"; readonly label = "Statistics Finland PxWeb";
  constructor(private readonly catalog: CatalogPort, private readonly maxCells = 25_000) {}
  private async language(resourceId: string) { return (await this.catalog.resource(this.id, resourceId))?.language ?? "fi"; }
  async discover({ query, limit, embedding }: { query: string; limit: number; embedding?: { model: string; values: number[] } }): Promise<SourceCandidate[]> {
    return (await this.catalog.searchProvider(this.id, query, limit, embedding)).map(candidateFromSummary);
  }
  async getSchema({ resource_id }: { resource_id: string }): Promise<ProviderSchema> {
    const language = await this.language(resource_id);
    const raw = await pxwebClient().schema<{ title?: string; variables?: PxWebSchemaVariable[] }>(`${this.id}:${resource_id}:${language}`, apiUrl(resource_id, language));
    const dimensions = mapPxWebDimensions(raw.variables ?? []);
    return { provider_id: this.id, dataset_id: resource_id.split("/").at(-1) ?? resource_id, resource_id, dimensions, provenance: { source_url: statFinSourceUrl(resource_id, language), retrieved_at: new Date().toISOString(), schema_hash: createHash("sha256").update(JSON.stringify(raw.variables ?? [])).digest("hex") } };
  }
  async query({ resource_id, selections }: { resource_id: string; selections: Array<{ dimension_id: string; value_ids: string[] }> }) {
    const language = await this.language(resource_id);
    assertCellLimit(selections.map((selection) => ({ code: selection.dimension_id, values: selection.value_ids })), this.maxCells);
    const response = await pxwebClient().request(apiUrl(resource_id, language), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: selections.map((selection) => ({ code: selection.dimension_id, selection: { filter: "item", values: selection.value_ids } })), response: { format: "json-stat2" } }) });
    if (!response.ok) throw new Error(`Statistics Finland PxWeb query failed (${response.status}): ${await response.text()}`);
    const rows = flattenJsonStat(await response.json() as Parameters<typeof flattenJsonStat>[0]);
    return { provider_id: this.id, resource_id, rows, retrieved_at: new Date().toISOString(), source_url: statFinSourceUrl(resource_id, language) };
  }
}
