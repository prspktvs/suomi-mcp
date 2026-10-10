import type { CatalogResource, CatalogResourceSummary, SearchEmbedding } from "../catalog.js";
import type { SourceCard, SourceCandidate } from "../contracts/retrieval.js";
export type { CatalogResource, CatalogResourceSummary, SearchEmbedding } from "../catalog.js";

export type Awaitable<T> = T | Promise<T>;

/** Metadata boundary shared by the hosted SQLite adapter and the local HTTP registry client. */
export interface CatalogPort {
  searchSummaries(query: string, limit: number, embedding?: SearchEmbedding): Awaitable<CatalogResourceSummary[]>;
  searchProvider(providerId: string, query: string, limit: number, embedding?: SearchEmbedding): Awaitable<CatalogResourceSummary[]>;
  resource(providerId: string, resourceId: string): Awaitable<CatalogResource | undefined>;
  sourceCard(providerId: string, resourceId: string): Awaitable<SourceCard | undefined>;
  providers(): Awaitable<Array<{ provider_id: string; name: string }>>;
}

export function candidateFromSummary(summary: CatalogResourceSummary): SourceCandidate {
  return {
    provider_id: summary.provider_id,
    dataset_id: summary.dataset_id,
    resource_id: summary.resource_id,
    title: summary.title,
    ...(summary.description ? { description: summary.description } : {}),
    ...(summary.language ? { language: summary.language } : {}),
    ...(summary.availability ? { availability: summary.availability } : {}),
    ...(summary.source_card ? { source_card: summary.source_card } : {}),
    coverage: summary.coverage,
    measures: [],
    dimensions: summary.dimensions.map((dimension) => ({
      id: dimension.id, label: dimension.label,
      ...(dimension.definition ? { definition: dimension.definition } : {}),
      ...(dimension.metadata ? { metadata: dimension.metadata } : {}),
      role: dimension.role, value_count: dimension.value_count,
      value_samples: dimension.value_samples.map(({ id, label, unit, definition }) => ({ id, label, ...(unit ? { unit } : {}), ...(definition ? { definition } : {}) })),
    })),
    access: summary.access,
  };
}
