import { describe, expect, it } from "vitest";
import { PxWebClient } from "../src/pxweb/client.js";

describe("PxWebClient", () => {
  it("rejects a publisher URL outside the fixed HTTPS host allowlist", async () => {
    const client = new PxWebClient({ fetcher: async () => new Response("{}") });
    await expect(client.request("https://example.com/table")).rejects.toThrow("publisher host allowlist");
  });

  it("paces requests, retries 429 using Retry-After, and sets the package user agent", async () => {
    const waits: number[] = [];
    const headersSeen: Headers[] = [];
    let calls = 0;
    const client = new PxWebClient({
      intervalMs: 100,
      now: () => 1_000,
      sleep: async (milliseconds) => { waits.push(milliseconds); },
      random: () => 0,
      fetcher: async (_url, init) => {
        calls += 1;
        headersSeen.push(new Headers(init?.headers));
        return calls === 1 ? new Response("", { status: 429, headers: { "retry-after": "2" } }) : new Response(JSON.stringify({ variables: [] }));
      },
    });
    const response = await client.request("https://pxdata.stat.fi/PxWeb/api/v1/en/StatFin");
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(waits).toEqual([2_000, 100]);
    expect(headersSeen[0]!.get("user-agent")).toContain("suomi-mcp/");
  });

  it("caches live schemas by resource identity and expires them by TTL", async () => {
    let now = 0;
    let calls = 0;
    const client = new PxWebClient({ now: () => now, schemaTtlMs: 50, intervalMs: 0, fetcher: async () => { calls += 1; return new Response(JSON.stringify({ call: calls })); } });
    const url = "https://pxdata.stat.fi/PxWeb/api/v1/en/StatFin";
    expect(await client.schema("statfin:one:en", url)).toEqual({ call: 1 });
    expect(await client.schema("statfin:one:en", url)).toEqual({ call: 1 });
    now = 51;
    expect(await client.schema("statfin:one:en", url)).toEqual({ call: 2 });
    expect(calls).toBe(2);
  });

  it("times out slow publisher requests and retries within the bounded attempt count", async () => {
    let calls = 0;
    const client = new PxWebClient({
      intervalMs: 0,
      sleep: async () => undefined,
      fetcher: async (_url, init) => {
        calls += 1;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      },
    });
    await expect(client.request("https://pxdata.stat.fi/PxWeb/api/v1/en/StatFin", {}, 5)).rejects.toThrow("after retries");
    expect(calls).toBe(3);
  });

  it("rewrites only the documented legacy StatFin path shape", async () => {
    const { currentStatFinTablePath } = await import("../src/pxweb/client.js");
    expect(currentStatFinTablePath("/uvjrt/statfin_vaerak_pxt_11rc.px")).toBe("StatFin/vaerak/11rc.px");
    expect(currentStatFinTablePath("StatFin/vaerak/11rc.px")).toBe("StatFin/vaerak/11rc.px");
  });
});
