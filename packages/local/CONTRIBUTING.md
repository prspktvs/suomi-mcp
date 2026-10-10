# Contributing

1. Install dependencies with npm install.
2. Run npm run check and the relevant workspace tests.
3. Keep publisher selection, measure selection, geography, population, time scope, and interpretation in the model-authored structured contracts. Do not add keyword routing, term mappings, or question-specific rules.

To add a PxWeb provider, implement StatisticalProvider using publisher URLs from a fixed allowlist, CatalogPort for discovery metadata, the shared PxWebClient, JSON-stat flattening, schema value validation, and the configured cell cap. Add offline fixtures and tests for request shape, schema membership, retries, provenance, and the selected provider's license/attribution metadata.

Never store retrieved evidence rows in the disk cache. Keep stdio stdout reserved for MCP protocol messages; diagnostics go to stderr.
