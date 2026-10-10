import { describe, expect, it } from "vitest";
import { RetrievalV2Session } from "../src/session/v2.js";
import type { CatalogPort } from "../src/catalog/port.js";
import type { StatisticalProvider } from "../src/providers/types.js";

const plan = {
  answer_language: "English" as const,
  requests: [{ id: "r1", concept: "population", required: true, acceptable_units: ["people"], acceptable_measure_kinds: ["count"] }],
  scope: { geography: { description: "Finland", exactness: "exact" as const }, population_or_entity: "resident population", period: { selection: "latest_available" as const, requested_values: [] } },
  operation: { kind: "direct" as const, required_calculation: false },
  proxy_policy: { allowed: false, disclosure_required: true },
  completion: { require_all_requests: true, require_exact_geography: true, require_all_requested_periods: true, require_comparable_units: true },
};
const catalog = (searchSummaries: CatalogPort["searchSummaries"]): CatalogPort => ({
  searchSummaries, searchProvider: async () => [], resource: async () => undefined,
  sourceCard: async () => undefined, providers: async () => [],
});

describe("v2 catalog fallback contract", () => {
  it("returns in-band registry_unavailable feedback when registry search is unavailable", async () => {
    const session = new RetrievalV2Session(catalog(async () => { throw new Error("offline"); }));
    session.planRequest(plan);
    const result = await session.findAndInspect({ action: "search", query: "population", limit: 5, value_limit: 5 });
    expect(result).toMatchObject({ error: { code: "registry_unavailable" } });
    session.close();
  });

  it("allows schema inspection from an explicit publisher resource path", async () => {
    let receivedResourceId = "";
    const provider: StatisticalProvider = {
      id: "statfin",
      label: "Statistics Finland",
      discover: async () => [],
      getSchema: async ({ resource_id }) => { receivedResourceId = resource_id; return ({
        provider_id: "statfin", dataset_id: "table.px", resource_id,
        dimensions: [{ id: "Year", label: "Year", role: "time", values: [{ id: "2025", label: "2025" }] }],
        provenance: { source_url: "https://pxdata.stat.fi/table.px", retrieved_at: "2026-10-11T00:00:00.000Z" },
      }); },
      query: async () => ({ provider_id: "statfin", resource_id: "table.px", rows: [], source_url: "https://pxdata.stat.fi/table.px", retrieved_at: "2026-10-11T00:00:00.000Z" }),
    };
    const session = new RetrievalV2Session(catalog(async () => []), "2026-10-11", {
      configureProviders: (registry) => registry.register(provider),
    });
    session.planRequest(plan);
    const result = await session.findAndInspect({
      action: "inspect", provider_id: "statfin", resource_id: "StatFin/topic/table.px", limit: 5, value_limit: 5,
    });
    expect(result).toMatchObject({ provider_id: "statfin", dimensions: [{ id: "Year" }] });
    expect(receivedResourceId).toBe("StatFin/topic/table.px");
    expect(result).toHaveProperty("source_ref");
    session.close();
  });
});
