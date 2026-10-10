# @prspktvs/suomi-mcp-core

Shared contracts and workflow logic for the hosted and local Suomi-MCP servers. This package includes schema-derived retrieval contracts, the v2 evidence workflow, publisher adapters, numeric auditing, bounded PxWeb handling, and a SQL engine interface.

It does not include the hosted catalog database, embeddings, credentials, evidence persistence, or a native SQLite dependency. The host supplies CatalogPort, SqlEngine, and optional provider/query-embedding dependencies.

~~~sh
npm install @prspktvs/suomi-mcp-core
~~~

The public exports are listed in package.json. See the repository's local server documentation in packages/local/README.md for setup and data-flow details.
