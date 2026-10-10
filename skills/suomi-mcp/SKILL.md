---
name: suomi-mcp
description: Use AgentFinland to discover official Finnish statistical sources, inspect their schemas, retrieve selected values, calculate from retrieved evidence, and cite the source rows.
license: MIT
compatibility: Requires an AgentFinland connection at https://agentfinland.fi/mcp.
---

# Suomi-MCP

Use the connected AgentFinland tools when a question needs Finnish official statistics.

## Evidence workflow

1. Record the question's requested measure, population, geography, period, operation, comparison endpoints, and completion requirements in the structured planning tool.
2. Discover candidate source tables, inspect the selected candidate's live schema, and verify that the returned dimensions and values can represent the planned request.
3. Bind or select only values present in the returned schema. When a selection is invalid, use the tool's structured feedback to revise it.
4. Retrieve the selected values and preserve the returned source, table, filters, units, periods, and rows as evidence.
5. Use the calculation tool only when a derived quantity is needed. Base calculations on retrieved evidence and keep the query read-only.
6. Assess whether each required part of the question is supported. If evidence is incomplete or incomparable, state the limitation or ask for the missing scope.
7. Cite each source table and distinguish retrieved values from calculated results.

The model decides the statistical meaning of the user's question and whether evidence answers it. Do not infer statistical intent from keyword lists, fixed term mappings, or table identifiers. Application validation checks schema membership, structure, numeric safety, and evidence provenance.

Statistics come from multiple official publishers, including Statistics Finland. Follow the applicable source attribution and licence returned with each result. AgentFinland is an independent service and is not affiliated with Statistics Finland.
