import { createHash } from "node:crypto";
import { parse } from "parse5";
import type { CatalogResource } from "@prspktvs/suomi-mcp-core/catalog";
import type { CatalogPort, StatisticalProvider } from "@prspktvs/suomi-mcp-core/providers";
import { candidateFromSummary } from "@prspktvs/suomi-mcp-core/catalog";
import type { ProviderSchema, SourceCandidate } from "@prspktvs/suomi-mcp-core/contracts";
import { pxwebClient } from "@prspktvs/suomi-mcp-core/pxweb";

export const veroDecisionResourceIdentity = {
  provider_id: "vero-web",
  dataset_id: "VH/6585/00.01.00/2025",
  resource_id: "municipal-income-tax-rates-2026",
  source_url: "https://www.vero.fi/syventavat-vero-ohjeet/paatokset/47465/kuntien-ja-seurakuntien-tuloveroprosentit-vuonna-2026/",
} as const;

const source = {
  ...veroDecisionResourceIdentity,
  title: "Kuntien ja seurakuntien tuloveroprosentit vuonna 2026",
  description: "Finnish Tax Administration decision listing municipality and parish income-tax percentages for tax year 2026. The decision is effective from 1 January 2026.",
  language: "fi",
  reference_period: "2026",
  unit: "%",
} as const;

type HtmlNode = { nodeName: string; attrs?: Array<{ name: string; value: string }>; childNodes?: HtmlNode[] };
type TableHeader = { title: string; key: string };
type TableCell = { text: string };
type TableRow = Record<string, TableCell>;
type PublishedTable = { headers: TableHeader[]; rows: TableRow[]; caption?: string };

function findDataTable(node: HtmlNode): HtmlNode | undefined {
  if (node.nodeName === "data-table") return node;
  for (const child of node.childNodes ?? []) {
    const found = findDataTable(child);
    if (found) return found;
  }
  return undefined;
}

function attribute(node: HtmlNode, name: string) {
  return node.attrs?.find((item) => item.name === name)?.value;
}

function parsePublishedTable(html: string): PublishedTable {
  const element = findDataTable(parse(html) as unknown as HtmlNode);
  if (!element) throw new Error("Vero source page did not contain a structured data-table element.");
  const rawHeaders = attribute(element, ":headers");
  const rawRows = attribute(element, ":rows");
  if (!rawHeaders || !rawRows) throw new Error("Vero data-table element is missing its structured headers or rows.");
  const headers = JSON.parse(rawHeaders) as unknown;
  const rows = JSON.parse(rawRows) as unknown;
  if (!Array.isArray(headers) || headers.length < 2 || !Array.isArray(rows) || rows.length === 0) throw new Error("Vero data-table headers or rows have an invalid shape.");
  const normalizedHeaders: TableHeader[] = headers.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Vero data-table header is not an object.");
    const header = item as Record<string, unknown>;
    if (typeof header.title !== "string" || !header.title.trim() || typeof header.key !== "string" || !header.key.trim()) throw new Error("Vero data-table header is missing a title or key.");
    return { title: header.title.trim(), key: header.key };
  });
  if (new Set(normalizedHeaders.map((item) => item.key)).size !== normalizedHeaders.length) throw new Error("Vero data-table contains duplicate header keys.");
  const normalizedRows: TableRow[] = rows.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Vero data-table row is not an object.");
    const row = item as Record<string, unknown>;
    const normalized: TableRow = {};
    for (const header of normalizedHeaders) {
      const cell = row[header.key];
      if (!cell || typeof cell !== "object" || typeof (cell as Record<string, unknown>).text !== "string") throw new Error(`Vero data-table row is missing cell ${header.key}.`);
      normalized[header.key] = { text: ((cell as Record<string, string>).text).trim() };
    }
    return normalized;
  });
  const rowHeader = normalizedHeaders[0]!;
  const rowIds = normalizedRows.map((row) => row[rowHeader.key]!.text);
  if (rowIds.some((value) => !value) || new Set(rowIds).size !== rowIds.length) throw new Error("Vero data-table row labels must be non-empty and unique.");
  return { headers: normalizedHeaders, rows: normalizedRows, ...(attribute(element, "caption") ? { caption: attribute(element, "caption") } : {}) };
}

/** Validates Vero's published decimal-comma rate-cell format before numeric conversion. */
function parseRateCell(value: string): number | null {
  if (!value) return null;
  if (!/^\d+(?:,\d+)?$/.test(value)) throw new Error(`Vero rate cell has an unsupported numeric format: ${value}`);
  const parsed = Number(value.replace(",", "."));
  if (!Number.isFinite(parsed)) throw new Error(`Vero rate cell is not finite: ${value}`);
  return parsed;
}

function schemaDimensions(table: PublishedTable): ProviderSchema["dimensions"] {
  const rowHeader = table.headers[0]!;
  const fieldHeaders = table.headers.slice(1);
  const uniqueRowLabels = table.rows.map((row) => row[rowHeader.key]!.text);
  return [
    {
      id: "row_label",
      label: rowHeader.title,
      definition: "Values are row labels from the first column of the published table; interpret them using the source label and request.",
      role: "unknown",
      values: uniqueRowLabels.map((label) => ({ id: label, label })),
    },
    {
      id: "table_field",
      label: "Published table column",
      definition: "Values are the publisher's remaining column headings. Each identifies a distinct field in the official table; select the field that matches the planned measure.",
      role: "unknown",
      values: fieldHeaders.map((header) => ({ id: header.key, label: header.title, unit: source.unit })),
    },
    {
      id: "reference_period",
      label: "Tax year",
      role: "time",
      values: [{ id: source.reference_period, label: source.reference_period }],
    },
  ];
}

function schemaHash(dimensions: ProviderSchema["dimensions"]) {
  return createHash("sha256").update(JSON.stringify(dimensions)).digest("hex");
}

function contentHash(table: PublishedTable) {
  return createHash("sha256").update(JSON.stringify(table)).digest("hex");
}

async function fetchSourceTable(): Promise<PublishedTable> {
  const response = await pxwebClient().request(source.source_url, {}, 15_000);
  if (!response.ok) throw new Error(`Vero official decision request failed (${response.status}).`);
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:" || finalUrl.hostname !== "www.vero.fi") throw new Error("Vero decision request redirected outside the configured official host.");
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  const maximumBytes = 5 * 1024 * 1024;
  if (contentLength > maximumBytes) throw new Error("Vero decision page exceeds the configured 5 MiB response limit.");
  if (!response.body) throw new Error("Vero decision response did not contain a body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new Error("Vero decision page exceeds the configured 5 MiB response limit.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return parsePublishedTable(new TextDecoder().decode(bytes));
}

export async function crawlVeroDecisionResource(retrievedAt = new Date().toISOString()): Promise<CatalogResource> {
  const table = await fetchSourceTable();
  const dimensions = schemaDimensions(table);
  const publishedColumns = table.headers.slice(1);
  for (const row of table.rows) for (const header of publishedColumns) parseRateCell(row[header.key]!.text);
  return {
    provider_id: source.provider_id,
    dataset_id: source.dataset_id,
    resource_id: source.resource_id,
    source_url: source.source_url,
    title: source.title,
    description: source.description,
    language: source.language,
    updated_at: "2026-01-01T00:00:00.000Z",
    retrieved_at: retrievedAt,
    availability: { status: "available", checked_at: retrievedAt },
    query_capability: { schema_available: true, queryable: true, resource_type: "other" },
    dimensions: dimensions.map((dimension) => ({ id: dimension.id, label: dimension.label, ...(dimension.definition ? { definition: dimension.definition } : {}), role: dimension.role, values: dimension.values })),
    coverage: { periods: [source.reference_period], frequencies: ["annual"] },
    provenance: { source_version: "2026", crawl_version: retrievedAt, schema_hash: schemaHash(dimensions), content_hash: contentHash(table) },
  };
}

export class VeroDecisionTableProvider implements StatisticalProvider {
  readonly id = source.provider_id;
  readonly label = "Finnish Tax Administration official decision tables";
  constructor(private readonly catalog: CatalogPort) {}

  async discover({ query, limit, embedding }: { query: string; limit: number; embedding?: { model: string; values: number[] } }): Promise<SourceCandidate[]> {
    return (await this.catalog.searchProvider(this.id, query, limit, embedding)).map(candidateFromSummary);
  }

  async getSchema({ resource_id }: { resource_id: string }): Promise<ProviderSchema> {
    if (resource_id !== source.resource_id) throw new Error(`Unknown ${this.label} resource: ${resource_id}`);
    const table = await fetchSourceTable();
    const dimensions = schemaDimensions(table);
    return { provider_id: this.id, dataset_id: source.dataset_id, resource_id, dimensions, provenance: { source_url: source.source_url, retrieved_at: new Date().toISOString(), schema_hash: schemaHash(dimensions) } };
  }

  async query({ resource_id, selections }: { resource_id: string; selections: Array<{ dimension_id: string; value_ids: string[] }> }) {
    if (resource_id !== source.resource_id) throw new Error(`Unknown ${this.label} resource: ${resource_id}`);
    const table = await fetchSourceTable();
    const dimensions = schemaDimensions(table);
    const selectionsByDimension = new Map(selections.map((selection) => [selection.dimension_id, selection.value_ids]));
    for (const dimension of dimensions) {
      const selected = selectionsByDimension.get(dimension.id);
      if (!selected?.length || selected.some((value) => !dimension.values.some((item) => item.id === value))) throw new Error(`Selection is not a member of the current ${dimension.label} schema.`);
    }
    const selectedRows = new Set(selectionsByDimension.get("row_label"));
    const selectedFields = new Set(selectionsByDimension.get("table_field"));
    const selectedPeriods = new Set(selectionsByDimension.get("reference_period"));
    if (!selectedPeriods.has(source.reference_period)) throw new Error("Selected tax year is not present in the current Vero schema.");
    const rowHeader = table.headers[0]!;
    const fields = table.headers.slice(1).filter((header) => selectedFields.has(header.key));
    const rows = table.rows.filter((row) => selectedRows.has(row[rowHeader.key]!.text)).flatMap((row) => fields.map((field) => {
      const sourceValue = row[field.key]!.text;
      return {
        [rowHeader.title]: row[rowHeader.key]!.text,
        "Published table field": field.title,
        "Reference period": source.reference_period,
        "Rate (%)": parseRateCell(sourceValue),
        "Rate as published": sourceValue,
      };
    }));
    return { provider_id: this.id, resource_id, rows, retrieved_at: new Date().toISOString(), source_url: source.source_url };
  }
}
