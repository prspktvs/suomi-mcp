# suomi-mcp

Run a local Model Context Protocol server for Finnish official statistics. The server uses the hosted catalog only for discovery metadata. It retrieves live schemas and data directly from the selected publisher, and performs calculations and numeric checks on your machine.

## Quick start

Requires Node.js 22 or later.

~~~sh
npx -y @prspktvs/suomi-mcp
~~~

Claude Desktop:

~~~json
{
  "mcpServers": {
    "suomi-mcp": {
      "command": "npx",
      "args": ["-y", "@prspktvs/suomi-mcp"]
    }
  }
}
~~~

Claude Code:

~~~sh
claude mcp add suomi-mcp -- npx -y @prspktvs/suomi-mcp
~~~

Cursor and VS Code MCP clients can use the same command and args in their MCP server configuration.

The hosted service remains available at https://agentfinland.fi/mcp. To run the optional local Streamable HTTP transport on loopback:

~~~sh
npx -y @prspktvs/suomi-mcp --http --port 3333
~~~

It binds to 127.0.0.1. For browser clients, same-origin requests are required. Set SUOMI_MCP_HTTP_TOKEN to require a bearer token.

## Data flow and privacy

~~~text
Your MCP client
    │ stdio (or optional loopback HTTP)
    ▼
suomi-mcp on your computer ── search text and selected source IDs ──▶ AgentFinland catalog
    │
    ├── live schemas and data ──▶ official publisher PxWeb endpoints
    ├── calculations and numeric checks run locally
    └── evidence rows remain in memory and are not written to disk
~~~

The registry normally receives discovery search text and the provider/resource IDs looked up. If the registry is unavailable, rate limited, or its catalog route is not deployed, the local client sends discovery search text to the selected publishers' public PxWeb table-search endpoints. Publishers also receive the schema and data requests needed to answer your selected query. The server sends no prompt transcript, user identity, or analytics. It writes registry metadata and publisher schemas to the OS cache by default; set SUOMI_MCP_CACHE_DIR=off to disable disk caching.

Generated source cards are discovery hints, not official evidence. The inspected live publisher schema and returned data are the evidence used by the workflow.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| SUOMI_MCP_REGISTRY_URL | https://agentfinland.fi | Hosted discovery catalog origin |
| SUOMI_MCP_API_KEY | unset | Optional key for a higher catalog rate limit |
| SUOMI_MCP_PROVIDERS | statfin,traficom,vero,vero-web,visitfinland,kototietokanta,luke,etk,helsinki | Comma-separated publisher IDs |
| SUOMI_MCP_HELSINKI | 1 | Set to 0 to disable Helsinki's beta HTML-form source |
| SUOMI_MCP_CACHE_DIR | OS cache directory | Disk cache location; off disables it |
| SUOMI_MCP_MAX_CELLS | 25000 | Maximum query cells, from 1 through 120000 |
| SUOMI_MCP_SQL_ENGINE | auto | node, wasm, or auto (node:sqlite, with a sql.js fallback) |
| SUOMI_MCP_LOG | info | Set to debug for structured logs on stderr |
| SUOMI_MCP_HTTP_TOKEN | unset | Optional bearer token for local HTTP mode |

Anonymous catalog access is rate limited. Resource metadata is cached separately; only discovery searches count against the search quota. Run npx -y @prspktvs/suomi-mcp doctor to check the registry, publisher endpoints, and SQL engine.

## Limits

The local server paces publisher requests, retries temporary upstream failures, validates selected dimension IDs and values against the inspected schema, and limits each query to the configured cell count. Publisher availability and terms are controlled by the publishers. Give credit to the provider named by each source and follow the data-specific terms linked in its metadata.

## Development

From the monorepo root:

~~~sh
npm install
npm run build --workspace @prspktvs/suomi-mcp
npm test --workspace @prspktvs/suomi-mcp
~~~

See NOTICE, CONTRIBUTING.md, and SECURITY.md.
