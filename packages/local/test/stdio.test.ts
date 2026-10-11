import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";

let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe("local stdio server", () => {
  it("negotiates the modern protocol and retains an explicit context across tool calls", async () => {
    const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: {
        PATH: process.env.PATH ?? "",
        SUOMI_MCP_REGISTRY_URL: "http://127.0.0.1:1",
        SUOMI_MCP_SQL_ENGINE: "wasm",
      },
      stderr: "pipe",
    });
    client = new Client({ name: "suomi-mcp-local-smoke", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(transport);
    expect(client.getProtocolEra()).toBe("modern");
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "answer_with_evidence", "find_and_inspect", "plan_request", "retrieve",
    ]);
    const planned = await client.callTool({
      name: "plan_request",
      arguments: {
        answer_language: "English",
        requests: [{ id: "r1", concept: "population", required: true, acceptable_units: ["people"], acceptable_measure_kinds: ["count"] }],
        scope: {
          geography: { description: "Finland", exactness: "exact" },
          population_or_entity: "resident population",
          period: { selection: "latest_available", requested_values: [] },
        },
        operation: { kind: "direct", required_calculation: false },
        proxy_policy: { allowed: false, disclosure_required: true },
        completion: { require_all_requests: true, require_exact_geography: true, require_all_requested_periods: true, require_comparable_units: true },
      },
    });
    const result = JSON.parse(planned.content?.[0]?.type === "text" ? planned.content[0].text : "{}");
    expect(result.accepted).toBe(true);
    expect(result.context_id).toMatch(/^[\da-f-]{36}$/i);
    expect(client.getProtocolEra()).toBe("modern");
  }, 20_000);
});
