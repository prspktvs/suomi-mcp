import { createHash } from "node:crypto";
import type { CatalogPort } from "../catalog/port.js";
import { candidateFromSummary } from "../catalog/port.js";
import { assertCellLimit, flattenJsonStat } from "../pxweb/jsonstat.js";
import { pxwebClient } from "../pxweb/client.js";
import type { ProviderSchema, SourceCandidate } from "../contracts/retrieval.js";
import type { StatisticalProvider } from "./types.js";
import { mapPxWebDimensions, type PxWebSchemaVariable } from "./pxweb-schema.js";

export type PxWebProviderConfig = { id: string; label: string; api_base: string; web_base: string; database_id: string };

/** Recover the resource identity encoded by a canonical URL emitted by this
 * configured provider. This validates URL/route structure only. */
export function configuredPxWebResourceFromSourceUrl(sourceUrl: string, config: PxWebProviderConfig): string | undefined {
  let url: URL;
  let base: URL;
  try {
    url = new URL(sourceUrl);
    base = new URL(config.web_base);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.origin !== base.origin || url.username || url.password || url.search || url.hash || url.href !== sourceUrl) return undefined;
  let basePath = base.pathname;
  while (basePath.endsWith("/")) basePath = basePath.slice(0, -1);
  const prefix = `${basePath}/${encodeURIComponent(config.database_id)}/`;
  if (!url.pathname.startsWith(prefix)) return undefined;
  const encodedSegments = url.pathname.slice(prefix.length).split("/");
  if (!encodedSegments.length || encodedSegments.some((segment) => !segment)) return undefined;
  const segments: string[] = [];
  for (const encoded of encodedSegments) {
    let segment: string;
    try { segment = decodeURIComponent(encoded); } catch { return undefined; }
    // This character check rejects decoded path separators and ASCII control characters in one URL segment.
    if (!segment || segment === "." || segment === ".." || [...segment].some((character) => character === "/" || character === "\\" || character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f) || encodeURIComponent(segment) !== encoded) return undefined;
    segments.push(segment);
  }
  return segments.join("/");
}

/** Provider adapter for an API-v1 PxWeb database. Provider URLs and database
 * IDs are fixed transport identity, while all measure and scope selections
 * remain model-authored bindings validated against the returned schema. */
export class ConfiguredPxWebProvider implements StatisticalProvider {
  readonly id: string;
  readonly label: string;
  constructor(private readonly catalog: CatalogPort, private readonly config: PxWebProviderConfig, private readonly maxCells = 25_000) { this.id = config.id; this.label = config.label; }
  private apiUrl(resourceId: string) { return `${this.config.api_base}/${this.config.database_id}/${resourceId.split("/").map(encodeURIComponent).join("/")}`; }
  private sourceUrl(resourceId: string) { return `${this.config.web_base}/${this.config.database_id}/${resourceId.split("/").map(encodeURIComponent).join("/")}`; }
  async discover({ query, limit, embedding }: { query: string; limit: number; embedding?: { model: string; values: number[] } }): Promise<SourceCandidate[]> {
    return (await this.catalog.searchProvider(this.id, query, limit, embedding)).map(candidateFromSummary);
  }
  async getSchema({ resource_id }: { resource_id: string }): Promise<ProviderSchema> {
    const raw = await pxwebClient().schema<{ variables?: PxWebSchemaVariable[] }>(`${this.id}:${resource_id}`, this.apiUrl(resource_id));
    return { provider_id: this.id, dataset_id: resource_id.split("/").at(-1) ?? resource_id, resource_id, dimensions: mapPxWebDimensions(raw.variables ?? []), provenance: { source_url: this.sourceUrl(resource_id), retrieved_at: new Date().toISOString(), schema_hash: createHash("sha256").update(JSON.stringify(raw.variables ?? [])).digest("hex") } };
  }
  async query({ resource_id, selections }: { resource_id: string; selections: Array<{ dimension_id: string; value_ids: string[] }> }) {
    assertCellLimit(selections.map((selection) => ({ code: selection.dimension_id, values: selection.value_ids })), this.maxCells);
    const response = await pxwebClient().request(this.apiUrl(resource_id), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: selections.map((selection) => ({ code: selection.dimension_id, selection: { filter: "item", values: selection.value_ids } })), response: { format: "json-stat2" } }) });
    if (!response.ok) throw new Error(`${this.label} PxWeb query failed (${response.status}): ${await response.text()}`);
    return { provider_id: this.id, resource_id, rows: flattenJsonStat(await response.json() as Parameters<typeof flattenJsonStat>[0]), retrieved_at: new Date().toISOString(), source_url: this.sourceUrl(resource_id) };
  }
}
