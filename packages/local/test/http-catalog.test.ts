import { describe, expect, it } from "vitest";
import { HttpCatalog } from "../src/http-catalog.js";

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });

describe("HttpCatalog", () => {
  it("loads search results and revalidates with ETags", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    let now = 100;
    const fetcher: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), headers });
      if (calls.length === 1) return json({ results: [] }, 200, { etag: '"generation-1"', "x-catalog-generation": "generation-1" });
      return new Response(null, { status: 304 });
    };
    const catalog = new HttpCatalog({ baseUrl: "https://registry.example", fetcher, now: () => now });
    expect(await catalog.searchProvider("statfin", "population", 5)).toEqual([]);
    // Expire the local search TTL so the next call reaches the conditional API.
    now += 600_001;
    const second = await catalog.searchProvider("statfin", "population", 5);
    expect(second).toEqual([]);
    expect(calls[1]!.headers.get("if-none-match")).toBe('"generation-1"');
    expect(calls[0]!.url).toContain("provider_id=statfin");
  });

  it("falls back to an allowlisted PxWeb table search after a registry 429", async () => {
    const urls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      if (url.hostname === "registry.example") return json({ error: { code: "rate_limited", message: "slow down" } }, 429);
      return json([{ id: "139e.px", path: "/vaenn", title: "Population forecast", score: 1 }]);
    };
    const catalog = new HttpCatalog({ baseUrl: "https://registry.example", fetcher });
    const results = await catalog.searchProvider("statfin", "population", 5);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ provider_id: "statfin", resource_id: "StatFin/vaenn/139e.px", dataset_id: "139e.px", title: "Population forecast" });
    expect(urls[1]).toContain("https://pxdata.stat.fi/PxWeb/api/v1/en/StatFin?query=population");
  });

  it("falls back when the registry catalog route has not been deployed", async () => {
    const urls: string[] = [];
    const catalog = new HttpCatalog({
      baseUrl: "https://registry.example",
      fetcher: async (input) => {
        const url = new URL(String(input));
        urls.push(url.toString());
        if (url.hostname === "registry.example") return json({ error: { code: "not_found", message: "not deployed" } }, 404);
        return json([{ id: "139e.px", path: "/vaenn", title: "Population forecast" }]);
      },
    });
    const results = await catalog.searchProvider("statfin", "population", 5);
    expect(results).toHaveLength(1);
    expect(urls[1]).toContain("https://pxdata.stat.fi/PxWeb/api/v1/en/StatFin?query=population");
  });

  it("uses fixed publisher fallback providers after registry network failure", async () => {
    const urls: string[] = [];
    const catalog = new HttpCatalog({
      baseUrl: "https://registry.example",
      fetcher: async (input) => {
        const url = new URL(String(input));
        urls.push(url.toString());
        if (url.hostname === "registry.example") throw new TypeError("offline");
        return json([{ id: "x.px", path: "/foo", title: "Foo" }]);
      },
    });
    const results = await catalog.searchSummaries("population", 2);
    expect(results).toHaveLength(2);
    expect(urls.every((url) => url.startsWith("https://registry.example/") || new URL(url).protocol === "https:")).toBe(true);
    expect(urls.some((url) => url.includes("pxdata.stat.fi"))).toBe(true);
  });

  it("sends the optional key and client identity to the registry", async () => {
    let seen = new Headers();
    const catalog = new HttpCatalog({
      baseUrl: "https://registry.example",
      apiKey: "test-key",
      clientName: "test-client",
      fetcher: async (_input, init) => { seen = new Headers(init?.headers); return json({ providers: [] }); },
    });
    await catalog.providers();
    expect(seen.get("authorization")).toBe("Bearer test-key");
    expect(seen.get("x-suomi-mcp-client")).toBe("test-client/0.1.0");
  });
});
