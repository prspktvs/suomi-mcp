#!/usr/bin/env node
import { createServer as createHttpServer } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { RetrievalV2ContextStore, createMcpV2Server, type V2Dependencies } from "@prspktvs/suomi-mcp-core/session/v2";
import { CalculationContext } from "@prspktvs/suomi-mcp-core/calc";
import { HttpCatalog, pxwebProviders } from "./http-catalog.js";
import { createSqlEngineFactory } from "./sql-engines.js";
import { VeroDecisionTableProvider } from "./vero-decision-table.js";
import { LocalDiskCache } from "./disk-cache.js";
import { enabledProviderIds } from "./provider-config.js";
import { configurePxWebSchemaCache } from "@prspktvs/suomi-mcp-core/pxweb";

const version = "0.1.0";
const log = (level: "info" | "warn" | "error", event: string, detail?: unknown) => {
  if (process.env.SUOMI_MCP_LOG !== "debug" && level === "info") return;
  process.stderr.write(JSON.stringify({ time: new Date().toISOString(), level, event, ...(detail === undefined ? {} : { detail }) }) + "\n");
};
const dependencies = async (): Promise<V2Dependencies> => {
  const createEngine = await createSqlEngineFactory();
  const maxCells = Number(process.env.SUOMI_MCP_MAX_CELLS ?? 25_000);
  if (!Number.isInteger(maxCells) || maxCells < 1 || maxCells > 120_000) throw new Error("SUOMI_MCP_MAX_CELLS must be an integer from 1 through 120000.");
  const enabledProviders = enabledProviderIds();
  return {
    createCalculations: () => new CalculationContext(createEngine()),
    includeHelsinki: enabledProviders.includes("helsinki"),
    enabledProviders,
    maxCells,
    serverInfo: { name: "suomi-mcp", version },
    configureProviders: (registry, catalog) => registry.register(new VeroDecisionTableProvider(catalog)),
  };
};
const createCatalog = () => {
  const diskCache = new LocalDiskCache();
  configurePxWebSchemaCache({ get: (key) => diskCache.get(`schema:${key}`), set: (key, value) => diskCache.set(`schema:${key}`, value) });
  return new HttpCatalog({ diskCache });
};
const healthCheck = async () => {
  const catalog = createCatalog();
  const failures: string[] = [];
  try {
    const versionInfo = await catalog.checkVersion();
    log("info", "registry_ok", { generation: versionInfo.generation });
  } catch (error) {
    failures.push("registry: " + (error instanceof Error ? error.message : String(error)));
  }
  try {
    const factory = await createSqlEngineFactory();
    const engine = factory();
    engine.load("doctor", [{ source: "value", name: "value", type: "number" }], [[1]]);
    if (engine.query("SELECT SUM(value) AS result FROM doctor")[0]?.result !== 1) throw new Error("SQL smoke query returned an unexpected result.");
    engine.close();
  } catch (error) {
    failures.push("sql: " + (error instanceof Error ? error.message : String(error)));
  }
  for (const [providerId, publisher] of Object.entries(pxwebProviders)) {
    try {
      const response = await fetch(publisher.apiUrl, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) failures.push(providerId + ": HTTP " + response.status);
    } catch (error) {
      failures.push(providerId + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }
  return failures;
};

async function runHttp(port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be between 1 and 65535.");
  const catalog = createCatalog();
  const runtime = await dependencies();
  const contexts = new RetrievalV2ContextStore();
  const handler = createMcpHandler(() => createMcpV2Server(catalog, undefined, { contexts, dependencies: runtime }), { legacy: "stateless" });
  const server = createHttpServer(async (incoming, outgoing) => {
    const requestOrigin = incoming.headers.origin;
    const incomingHost = incoming.headers.host;
    const allowedHosts = new Set(["127.0.0.1:" + port, "localhost:" + port]);
    if (!incomingHost || !allowedHosts.has(incomingHost)) {
      outgoing.statusCode = 403;
      outgoing.end();
      return;
    }
    if (requestOrigin) {
      let origin: URL;
      try { origin = new URL(requestOrigin); } catch { outgoing.statusCode = 403; outgoing.end(); return; }
      if (!new Set(["http://127.0.0.1:" + port, "http://localhost:" + port]).has(origin.origin)) {
        outgoing.statusCode = 403;
        outgoing.end();
        return;
      }
    }
    const token = process.env.SUOMI_MCP_HTTP_TOKEN;
    if (token && incoming.headers.authorization !== "Bearer " + token) {
      outgoing.statusCode = 401;
      outgoing.setHeader("www-authenticate", "Bearer");
      outgoing.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) headers.set(name, value.join(", "));
      else if (value) headers.set(name, value);
    }
    const body = Buffer.concat(chunks);
    const request = new Request("http://127.0.0.1:" + port + (incoming.url ?? "/"), {
      method: incoming.method,
      headers,
      ...(body.length ? { body, duplex: "half" as const } : {}),
    });
    try {
      const response = await handler.fetch(request);
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => outgoing.setHeader(name, value));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      outgoing.statusCode = 500;
      outgoing.setHeader("content-type", "application/json");
      outgoing.end(JSON.stringify({ error: "request_failed" }));
      log("error", "http_request_failed", error instanceof Error ? error.message : String(error));
    }
  });
  server.listen(port, "127.0.0.1", () => log("info", "http_listening", { host: "127.0.0.1", port }));
  const close = () => { contexts.close(); server.close(); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--version") || args.includes("-v")) { process.stdout.write(version + "\n"); return; }
  if (args[0] === "doctor") {
    const failures = await healthCheck();
    if (failures.length) {
      for (const failure of failures) log("error", "doctor_check_failed", failure);
      process.exitCode = 1;
    } else process.stdout.write("suomi-mcp doctor: all checks passed\n");
    return;
  }
  const httpIndex = args.indexOf("--http");
  if (httpIndex >= 0) {
    const portIndex = args.indexOf("--port");
    const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 3333;
    await runHttp(port);
    return;
  }
  const catalog = createCatalog();
  void catalog.checkVersion().catch((error) => log("warn", "registry_unavailable_at_startup", error instanceof Error ? error.message : String(error)));
  const runtime = await dependencies();
  const contexts = new RetrievalV2ContextStore();
  process.once("SIGINT", () => contexts.close());
  process.once("SIGTERM", () => contexts.close());
  serveStdio(() => createMcpV2Server(catalog, undefined, { contexts, dependencies: runtime }), {
    legacy: "serve",
    onerror: (error) => log("error", "stdio_error", error.message),
  });
}

void main().catch((error) => {
  log("error", "startup_failed", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
