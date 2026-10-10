import { assertCellLimit, type Filter } from "./pxweb/jsonstat.js";

type PxWebVariable = { code: string; text: string; unit?: string; note?: string; elimination?: boolean; values?: string[]; valueTexts?: string[]; time?: boolean };

const schemaCache = new Map<string, { expires: number; schema: LegacySchema }>();
const cacheMs = 15 * 60 * 1_000;

type LegacyDimension = PxWebVariable & { field: string; options: Array<{ code: string; label: string }> };
type LegacySchema = { table_path: string; source_type: "legacy_pxweb_form"; variables: LegacyDimension[] };

// Decodes decimal numeric and named HTML entities present in PxWeb form markup.
const decodeHtml = (value: string) => value.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
// Parses a quoted HTML attribute from the known PxWeb form markup.
const attribute = (tag: string, name: string) => decodeHtml(tag.match(new RegExp(`\\b${name}="([^"]*)"`, "i"))?.[1] ?? "");

export function isLegacyPxWebUrl(value: string) {
  try {
    const url = new URL(value);
    // Validates the legacy PxWeb route and .px table endpoint path formats.
    return url.protocol === "https:" && url.hostname === "stat.hel.fi" && /^\/pxweb\//i.test(url.pathname) && /\.px\/?$/i.test(url.pathname);
  } catch { return false; }
}

/** List table endpoints from an older PxWeb navigation tree. This consumes
 * only the site's own URL and ASP.NET menu structure; it does not interpret
 * table names or labels. */
export async function listLegacyPxWebTableUrls(roots: string[], request: (url: string, init?: RequestInit) => Promise<Response>): Promise<string[]> {
  const pending = [...roots];
  const rootPaths = roots.map((root) => new URL(root).pathname);
  const visited = new Set<string>();
  const tables = new Set<string>();
  while (pending.length) {
    const url = pending.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    const response = await request(url);
    if (!response.ok) throw new Error(`Legacy PxWeb catalog request failed (${response.status}) for ${url}.`);
    const html = await response.text();
    const root = new URL(url);
    // This expression validates the href attribute format emitted by PxWeb.
    const links = [...html.matchAll(/href="([^"]+)"/gi)].map((match) => decodeHtml(match[1]!));
    for (const link of links) {
      const target = new URL(link, url);
      if (target.origin !== root.origin || !rootPaths.some((path) => target.pathname.startsWith(path))) continue;
      // PxWeb sometimes emits a breadcrumb-like href with an empty path
      // segment; it is not a navigable catalog endpoint and returns HTTP 500.
      if (target.pathname.includes("//")) continue;
      // Recognizes a PxWeb table endpoint by its .px path suffix.
      if (/\.px\/?$/i.test(target.pathname)) {
        // Removes an optional final slash from the table URL path.
        target.pathname = target.pathname.replace(/\/$/, "");
        tables.add(target.toString());
      }
      else if (target.pathname.endsWith("/")) pending.push(target.toString());
    }
    // Root menu items are ASP.NET postbacks rather than links. Submit each
    // advertised navigation event and harvest the resulting structural URLs.
    // The menu event argument is PxWeb's own structural path encoding:
    // `pDatabase__folder` corresponds to `/pxweb/fi/Database/folder/`.
    // Reading it avoids stateful menu submissions and never derives meaning
    // from directory or table wording.
    // Parses the ASP.NET MenuNavigationTree postback argument format.
    for (const match of decodeHtml(html).matchAll(/MenuNavigationTree','p([^']+)'/gi)) {
      const path = match[1]!;
      const database = path.split("__", 1)[0]!;
      const target = new URL(`/pxweb/fi/${database}/${path}/`, root);
      if (!target.pathname.includes("//") && rootPaths.some((prefix) => target.pathname.startsWith(prefix))) pending.push(target.toString());
    }
  }
  return [...tables].sort();
}

function cookieHeader(response: Response) {
  const setCookies = response.headers.getSetCookie?.() ?? [];
  return [...new Map(setCookies.map((raw) => {
    const cookie = raw.split(";", 1)[0]!;
    return [cookie.split("=", 1)[0]!, cookie];
  })).values()].join("; ");
}

function parseSchema(url: string, html: string): LegacySchema {
  const variables: LegacyDimension[] = [];
  // Reads select/option elements from the publisher's legacy HTML form structure.
  for (const match of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const field = attribute(match[1], "name");
    if (!field.includes("ValuesListBox")) continue;
    const id = attribute(match[1], "id");
    // Escapes regex metacharacters in the publisher-supplied HTML id before using it in a label-for parser.
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Extracts the matching label element from the legacy form markup.
    const text = decodeHtml(html.match(new RegExp(`<label[^>]*for="${escapedId}"[^>]*>([\\s\\S]*?)<\\/label>`, "i"))?.[1]?.replace(/<[^>]+>/g, "") ?? field).replace(/\s+/g, " ").trim();
    // Reads option value attributes and their display text from the same form.
    const options = [...match[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map((option) => ({
      code: attribute(option[1], "value"), label: decodeHtml(option[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(),
    })).filter((option) => option.code);
    if (!options.length) continue;
    // The HTML form supplies a label but no machine-readable dimension role.
    // Keep it as display metadata; assigning `time` from Finnish/English
    // label words would make a semantic decision outside the model binding.
    variables.push({ code: field, field, text, values: options.map((option) => option.code), valueTexts: options.map((option) => option.label), options });
  }
  if (!variables.length) throw new Error("Legacy PxWeb form exposed no selectable dimensions.");
  return { table_path: url, source_type: "legacy_pxweb_form", variables };
}

type LegacyRequest = (url: string, init?: RequestInit) => Promise<Response>;
async function page(url: string, request: LegacyRequest = fetch) {
  const response = await request(url, { signal: AbortSignal.timeout(30_000), headers: { "user-agent": "suomi-mcp/0.1.0 (+https://github.com/prspktvs/suomi-mcp)" } });
  if (!response.ok) throw new Error(`Legacy PxWeb schema request failed (${response.status}) for ${url}.`);
  return { html: await response.text(), cookies: cookieHeader(response) };
}

export async function getLegacyTableSchema(url: string, request: LegacyRequest = fetch): Promise<LegacySchema> {
  if (!isLegacyPxWebUrl(url)) throw new Error("Only known stat.hel.fi legacy PxWeb table URLs are supported.");
  const cached = schemaCache.get(url);
  if (cached && cached.expires > Date.now()) return cached.schema;
  const loaded = await page(url, request);
  const schema = parseSchema(url, loaded.html);
  schemaCache.set(url, { schema, expires: Date.now() + cacheMs });
  return schema;
}

function hiddenFields(html: string) {
  const fields = new URLSearchParams();
  // Selects HTML input tags so ASP.NET hidden form state can be resubmitted.
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0];
    if (attribute(tag, "type").toLowerCase() === "hidden" && attribute(tag, "name")) fields.append(attribute(tag, "name"), attribute(tag, "value"));
  }
  return fields;
}

function combinations(dimensions: LegacyDimension[], chosen: Map<string, string[]>) {
  return dimensions.reduce<Array<Record<string, string>>>((rows, dimension) => rows.flatMap((row) =>
    (chosen.get(dimension.code) ?? []).map((value) => ({ ...row, [dimension.text]: dimension.options.find((option) => option.code === value)?.label ?? value })),
  ), [{}]);
}

function numericCells(html: string) {
  // Selects the known PxWeb result table and its data cells by HTML structure.
  const table = html.match(/<table\b[^>]*_DataTable"[^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if (!table) throw new Error("Legacy PxWeb result contained no data table.");
  // Extracts data-cell markup, retaining only cells in the publisher's numeric value format.
  return [...table.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => decodeHtml(cell[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim())
    .filter((value) => value && value !== "…" && value !== "-")
    .filter((value) => /\d/.test(value));
}

function parseValue(value: string): number | string | null {
  // These patterns validate missing-value markers and decimal numeric-cell syntax.
  if (/^\.{1,2}$/.test(value)) return null;
  const normalized = value.replace(/[\s ]/g, "").replace(",", ".");
  return /^-?\d+(?:\.\d+)?$/.test(normalized) ? Number(normalized) : value;
}

/** Execute a bounded query via the stable ASP.NET PXWeb form protocol. */
export async function executeLegacyPxWebQuery(url: string, filters: Filter[], request: LegacyRequest = fetch, cellLimit = 25_000) {
  if (!isLegacyPxWebUrl(url)) throw new Error("Only known stat.hel.fi legacy PxWeb table URLs are supported.");
  assertCellLimit(filters, cellLimit);
  // Fetch a fresh page for every submit: ASP.NET view-state is session-bound.
  const loaded = await page(url, request);
  const schema = parseSchema(url, loaded.html);
  const byCode = new Map(schema.variables.map((variable) => [variable.code, variable]));
  const chosen = new Map(filters.map((filter) => [filter.code, filter.values]));
  if (filters.some((filter) => !byCode.has(filter.code))) throw new Error("Legacy PxWeb query contains an unknown dimension.");
  const missing = schema.variables.filter((variable) => !(chosen.get(variable.code)?.length));
  if (missing.length) throw new Error(`Legacy PxWeb requires a selection for every dimension: ${missing.map((variable) => variable.text).join(", ")}.`);
  for (const variable of schema.variables) {
    const allowed = new Set(variable.values);
    if ((chosen.get(variable.code) ?? []).some((value) => !allowed.has(value))) throw new Error(`Legacy PxWeb query contains an invalid value for ${variable.text}.`);
  }
  const form = hiddenFields(loaded.html);
  for (const variable of schema.variables) for (const value of chosen.get(variable.code)!) form.append(variable.field, value);
  form.append("ctl00$ContentPlaceHolderMain$VariableSelector1$VariableSelector1$ButtonViewTable", "Näytä taulukko");
  const submit = await request(url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000), headers: { "content-type": "application/x-www-form-urlencoded", referer: url, cookie: loaded.cookies, "user-agent": "suomi-mcp/0.1.0 (+https://github.com/prspktvs/suomi-mcp)" }, body: form });
  const location = submit.headers.get("location");
  if (submit.status < 300 || submit.status >= 400 || !location) throw new Error(`Legacy PxWeb form submission failed (${submit.status}).`);
  const result = await request(new URL(location, url).toString(), { signal: AbortSignal.timeout(30_000), headers: { cookie: loaded.cookies, "user-agent": "suomi-mcp/0.1.0 (+https://github.com/prspktvs/suomi-mcp)" } });
  const resultHtml = await result.text();
  // Detects the publisher's named ASP.NET error endpoint response.
  if (!result.ok || /ErrorGeneral\.aspx/i.test(result.url)) throw new Error(`Legacy PxWeb result request failed (${result.status}).`);
  const cells = numericCells(resultHtml);
  const selections = combinations(schema.variables, chosen);
  if (cells.length !== selections.length) throw new Error(`Legacy PxWeb result shape could not be normalized safely (expected ${selections.length} cells, found ${cells.length}).`);
  return selections.map((selection, index) => ({ ...selection, Arvo: parseValue(cells[index]!) }));
}
