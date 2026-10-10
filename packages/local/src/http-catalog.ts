import type { CatalogPort, CatalogResource, CatalogResourceSummary, SearchEmbedding } from "@prspktvs/suomi-mcp-core/catalog";
import type { SourceCard } from "@prspktvs/suomi-mcp-core/contracts";
import { createDisabledDiskCache, type JsonCache } from "./disk-cache.js";

export type CatalogProvider = { provider_id: string; name: string; publisher: string; api_base: string | null; web_base: string | null; database_id: string | null; languages: string[]; resource_count: number; queryable: boolean; license: string; attribution: string };
export type CatalogVersion = { generation: string; built_at: string; schema_version: number; source_card_prompt_version: string; providers: string[] };
type CacheEntry = { etag?: string; value: unknown; generation?: string };
type SearchEntry = { expiresAt: number; values: CatalogResourceSummary[] };
type PxWebProvider = { origin: string; apiUrl: string; webUrl: string; databaseId: string; language: string; prefix: string };

/** Fixed publisher origins prevent catalog responses from redirecting PxWeb fallback requests to arbitrary hosts. */
export const pxwebProviders: Record<string, PxWebProvider> = {
  statfin: { origin: "https://pxdata.stat.fi", apiUrl: "https://pxdata.stat.fi/PxWeb/api/v1/en/StatFin", webUrl: "https://pxdata.stat.fi/PXWeb/pxweb/en/StatFin", databaseId: "StatFin", language: "en", prefix: "StatFin" },
  traficom: { origin: "https://trafi2.stat.fi", apiUrl: "https://trafi2.stat.fi/PXWeb/api/v1/fi/TraFi", webUrl: "https://trafi2.stat.fi/PXWeb/pxweb/fi/TraFi", databaseId: "TraFi", language: "fi", prefix: "" },
  vero: { origin: "https://vero2.stat.fi", apiUrl: "https://vero2.stat.fi/PXWeb/api/v1/fi/Vero", webUrl: "https://vero2.stat.fi/PXWeb/pxweb/fi/Vero", databaseId: "Vero", language: "fi", prefix: "" },
  visitfinland: { origin: "https://visitfinland.stat.fi", apiUrl: "https://visitfinland.stat.fi/PXWeb/api/v1/en/VisitFinland", webUrl: "https://visitfinland.stat.fi/PXWeb/pxweb/en/VisitFinland", databaseId: "VisitFinland", language: "en", prefix: "" },
  kototietokanta: { origin: "https://kototietokanta.stat.fi", apiUrl: "https://kototietokanta.stat.fi/PXWeb/api/v1/fi/Kototietokanta", webUrl: "https://kototietokanta.stat.fi/PXWeb/pxweb/fi/Kototietokanta", databaseId: "Kototietokanta", language: "fi", prefix: "" },
  luke: { origin: "https://statdb.luke.fi", apiUrl: "https://statdb.luke.fi/PXWeb/api/v1/fi/LUKE", webUrl: "https://statdb.luke.fi/PXWeb/pxweb/fi/LUKE", databaseId: "LUKE", language: "fi", prefix: "" },
  etk: { origin: "https://tilastot.etk.fi", apiUrl: "https://tilastot.etk.fi/api/v1/en/ETK", webUrl: "https://tilastot.etk.fi/pxweb/en/ETK", databaseId: "ETK", language: "en", prefix: "" },
};
const providerFallbacks: CatalogProvider[] = Object.entries(pxwebProviders).map(([provider_id, value]) => ({ provider_id, name: provider_id, publisher: provider_id, api_base: value.apiUrl, web_base: value.webUrl, database_id: value.databaseId, languages: [value.language], resource_count: 0, queryable: true, license: "Publisher terms apply; consult the source page.", attribution: `${provider_id}; see the publisher table metadata.` }));

export class CatalogHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export type HttpCatalogOptions = {
  baseUrl?: string;
  apiKey?: string;
  clientName?: string;
  version?: string;
  fetcher?: typeof fetch;
  now?: () => number;
  onWarning?: (message: string) => void;
  diskCache?: JsonCache;
};

export class HttpCatalog implements CatalogPort {
  private readonly baseUrl: URL;
  private readonly apiKey?: string;
  private readonly clientName: string;
  private readonly version: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly onWarning: (message: string) => void;
  private readonly diskCache: JsonCache;
  private readonly etagCache = new Map<string, CacheEntry>();
  private readonly searchCache = new Map<string, SearchEntry>();
  private cachedProviders?: CatalogProvider[];
  private currentGeneration?: string;

  constructor(options: HttpCatalogOptions = {}) {
    const rawBase = options.baseUrl ?? process.env.SUOMI_MCP_REGISTRY_URL ?? "https://agentfinland.fi";
    this.baseUrl = new URL(rawBase);
    if (!(["https:", "http:"].includes(this.baseUrl.protocol)) || this.baseUrl.username || this.baseUrl.password) throw new Error("SUOMI_MCP_REGISTRY_URL must be an HTTP(S) URL without embedded credentials.");
    // Removes trailing slashes from the configured registry base path.
    this.baseUrl.pathname = this.baseUrl.pathname.replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? process.env.SUOMI_MCP_API_KEY;
    this.clientName = options.clientName ?? "suomi-mcp";
    this.version = options.version ?? "0.1.0";
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.onWarning = options.onWarning ?? ((message) => process.stderr.write(`${message}\n`));
    this.diskCache = options.diskCache ?? createDisabledDiskCache();
  }

  private endpoint(path: string) { return new URL(`/api/v1/catalog${path}`, this.baseUrl); }
  private headers(etag?: string) {
    const headers = new Headers({ accept: "application/json", "user-agent": `suomi-mcp/${this.version} (+https://github.com/prspktvs/suomi-mcp)`, "x-suomi-mcp-client": `${this.clientName}/${this.version}` });
    if (this.apiKey) headers.set("authorization", `Bearer ${this.apiKey}`);
    if (etag) headers.set("if-none-match", etag);
    return headers;
  }
  private async requestJson<T>(url: URL, cacheKey?: string): Promise<T> {
    let cached = cacheKey ? this.etagCache.get(cacheKey) : undefined;
    if (!cached && cacheKey && !cacheKey.startsWith("search:")) {
      cached = await this.diskCache.get<CacheEntry>(`registry:${cacheKey}`);
      if (cached) this.etagCache.set(cacheKey, cached);
    }
    let response: Response;
    try { response = await this.fetcher(url, { headers: this.headers(cached?.etag) }); }
    catch (error) { throw new CatalogHttpError(0, error instanceof Error ? error.message : "Catalog request failed."); }
    if (response.status === 304 && cached) return cached.value as T;
    if (!response.ok) throw new CatalogHttpError(response.status, `Catalog request failed (${response.status}).`);
    let value: T;
    try { value = await response.json() as T; }
    catch { throw new CatalogHttpError(502, "Catalog returned invalid JSON."); }
    const generation = response.headers.get("x-catalog-generation") ?? undefined;
    if (generation) this.currentGeneration = generation;
    if (cacheKey) {
      const entry = { etag: response.headers.get("etag") ?? undefined, value, generation };
      this.etagCache.set(cacheKey, entry);
      if (!cacheKey.startsWith("search:")) await this.diskCache.set(`registry:${cacheKey}`, entry);
    }
    return value;
  }
  private mayUsePublisherFallback(error: unknown) { return error instanceof CatalogHttpError && (error.status === 0 || error.status === 404 || error.status === 429 || error.status >= 500); }
  async checkVersion(): Promise<CatalogVersion> {
    const result = await this.requestJson<CatalogVersion>(this.endpoint("/version"), "version");
    this.currentGeneration = result.generation;
    if (result.schema_version > 1) this.onWarning(`Registry schema version ${result.schema_version} is newer than this client supports (1).`);
    return result;
  }
  async providers(): Promise<Array<{ provider_id: string; name: string }>> {
    if (!this.cachedProviders) {
      try {
        const result = await this.requestJson<{ providers: CatalogProvider[] }>(this.endpoint("/providers"), "providers");
        this.cachedProviders = result.providers;
      } catch (error) {
        if (!this.mayUsePublisherFallback(error)) throw error;
        this.cachedProviders = providerFallbacks;
      }
    }
    return this.cachedProviders.map(({ provider_id, name }) => ({ provider_id, name }));
  }
  async searchSummaries(query: string, limit: number, _embedding?: SearchEmbedding): Promise<CatalogResourceSummary[]> {
    const key = JSON.stringify([query.trim().toLocaleLowerCase(), limit]);
    const cached = this.searchCache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.values.slice(0, limit);
    try {
      const url = this.endpoint("/search");
      url.searchParams.set("q", query);
      url.searchParams.set("limit", String(limit));
      const response = await this.requestJson<{ results: CatalogResourceSummary[] }>(url, `search:${key}`);
      this.searchCache.set(key, { expiresAt: this.now() + 600_000, values: response.results });
      return response.results.slice(0, limit);
    } catch (error) {
      if (!this.mayUsePublisherFallback(error)) throw error;
      const publishers = await this.providers();
      const perProvider = await Promise.allSettled(publishers.map(({ provider_id }) => this.searchProvider(provider_id, query, Math.max(1, Math.ceil(limit / publishers.length)))));
      const available = perProvider.filter((result): result is PromiseFulfilledResult<CatalogResourceSummary[]> => result.status === "fulfilled");
      if (!available.length) throw new CatalogHttpError(503, "The registry and publisher table-search endpoints are unavailable. Ask the user for a provider/resource path or retry later.");
      return available.flatMap((result) => result.value).slice(0, limit);
    }
  }
  async searchProvider(providerId: string, query: string, limit: number, _embedding?: SearchEmbedding): Promise<CatalogResourceSummary[]> {
    const key = JSON.stringify([providerId, query.trim().toLocaleLowerCase(), limit]);
    const cached = this.searchCache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.values.slice(0, limit);
    try {
      const url = this.endpoint("/search");
      url.searchParams.set("q", query);
      url.searchParams.set("provider_id", providerId);
      url.searchParams.set("limit", String(limit));
      const response = await this.requestJson<{ results: CatalogResourceSummary[] }>(url, `search:${key}`);
      this.searchCache.set(key, { expiresAt: this.now() + 600_000, values: response.results });
      return response.results.slice(0, limit);
    } catch (error) {
      if (!this.mayUsePublisherFallback(error)) throw error;
      return this.pxwebSearch(providerId, query, limit);
    }
  }
  async resource(providerId: string, resourceId: string): Promise<CatalogResource | undefined> {
    const path = resourceId.split("/").map(encodeURIComponent).join("/");
    try { return await this.requestJson<CatalogResource>(this.endpoint(`/resources/${encodeURIComponent(providerId)}/${path}`), `resource:${providerId}:${resourceId}`); }
    catch (error) { if ((error instanceof CatalogHttpError && error.status === 404) || this.mayUsePublisherFallback(error)) return undefined; throw error; }
  }
  async sourceCard(providerId: string, resourceId: string): Promise<SourceCard | undefined> {
    const path = resourceId.split("/").map(encodeURIComponent).join("/");
    try {
      const result = await this.requestJson<SourceCard & { origin?: string }>(this.endpoint(`/resources/${encodeURIComponent(providerId)}/${path}/source-card`), `source-card:${providerId}:${resourceId}`);
      const { origin: _origin, ...card } = result;
      return card;
    } catch (error) { if ((error instanceof CatalogHttpError && error.status === 404) || this.mayUsePublisherFallback(error)) return undefined; throw error; }
  }
  private async pxwebSearch(providerId: string, query: string, limit: number): Promise<CatalogResourceSummary[]> {
    const provider = pxwebProviders[providerId];
    if (!provider) throw new CatalogHttpError(503, `The registry is unavailable and provider ${providerId} has no built-in publisher search fallback.`);
    const url = new URL(provider.apiUrl);
    if (url.origin !== provider.origin || url.protocol !== "https:") throw new Error("PxWeb fallback URL is not on the built-in publisher allowlist.");
    url.searchParams.set("query", query);
    let response: Response;
    try { response = await this.fetcher(url, { headers: this.headers() }); }
    catch (error) { throw new CatalogHttpError(503, error instanceof Error ? error.message : "Publisher search failed."); }
    if (!response.ok) throw new CatalogHttpError(503, `Publisher search failed (${response.status}).`);
    let raw: unknown;
    try { raw = await response.json() as unknown; }
    catch { throw new CatalogHttpError(502, "Publisher returned invalid search JSON."); }
    if (!Array.isArray(raw)) throw new CatalogHttpError(502, "Publisher returned an unexpected search response.");
    return raw.slice(0, limit).flatMap((item): CatalogResourceSummary[] => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      if (typeof row.id !== "string" || typeof row.path !== "string" || typeof row.title !== "string") return [];
      const pathSegments = row.path.split("/").filter(Boolean);
      if (pathSegments[0]?.toLocaleLowerCase() === provider.databaseId.toLocaleLowerCase()) pathSegments.shift();
      // StatFin provider IDs include its database prefix; the configured
      // PxWeb adapters add their database prefix when constructing the API URL.
      const resourceId = [...(provider.prefix ? [provider.prefix] : []), ...pathSegments, row.id].join("/");
      return [{
        provider_id: providerId, dataset_id: row.id, resource_id: resourceId, title: row.title,
        language: provider.language, coverage: {},
        access: { provider: providerId, schema_available: true, queryable: true, resource_type: "pxweb" },
        dimensions: [],
      }];
    });
  }
}
