import type { SearchEmbedding } from "../catalog.js";
import type { CatalogPort } from "../catalog/port.js";
import type { ProviderQueryResult, ProviderSchema, SourceCandidate } from "../contracts/retrieval.js";

export interface StatisticalProvider {
  id: string;
  label: string;
  discover(input: { query: string; limit: number; embedding?: SearchEmbedding }): Promise<SourceCandidate[]>;
  getSchema(input: { resource_id: string }): Promise<ProviderSchema>;
  query(input: { resource_id: string; selections: Array<{ dimension_id: string; value_ids: string[] }> }): Promise<ProviderQueryResult>;
}

export type { CatalogPort };
