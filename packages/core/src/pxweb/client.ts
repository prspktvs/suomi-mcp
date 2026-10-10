const allowedHosts = new Set([
  "pxdata.stat.fi", "trafi2.stat.fi", "vero2.stat.fi", "visitfinland.stat.fi",
  "kototietokanta.stat.fi", "statdb.luke.fi", "tilastot.etk.fi", "stat.hel.fi",
  "www.vero.fi",
]);
const defaultUserAgent = "suomi-mcp/0.1.0 (+https://github.com/prspktvs/suomi-mcp)";
const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const retryDelay = (response: Response, now: number) => {
  const header = response.headers.get("retry-after");
  if (!header) return 1_000;
  // Retry-After delta-seconds uses one or more decimal digits per RFC 9110.
  if (/^\d+$/.test(header.trim())) return Math.max(0, Number(header) * 1_000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : 1_000;
};
export type PxWebClientOptions = {
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  intervalMs?: number;
  timeoutMs?: number;
  schemaTtlMs?: number;
  schemaCache?: PxWebSchemaCache;
};
export interface PxWebSchemaCache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

/** Shared, bounded HTTP client for publisher PxWeb APIs and the one opt-in legacy host. */
export class PxWebClient {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly schemaTtlMs: number;
  private readonly nextAt = new Map<string, number>();
  private readonly schemas = new Map<string, { expires: number; value: unknown }>();
  private schemaCache?: PxWebSchemaCache;
  constructor(options: PxWebClientOptions = {}) {
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? pause;
    this.random = options.random ?? Math.random;
    this.intervalMs = options.intervalMs ?? 1_500;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.schemaTtlMs = options.schemaTtlMs ?? 3_600_000;
    this.schemaCache = options.schemaCache;
  }
  setSchemaCache(cache: PxWebSchemaCache | undefined) { this.schemaCache = cache; }
  private validateUrl(input: string | URL) {
    const url = new URL(input);
    if (url.protocol !== "https:" || !allowedHosts.has(url.hostname) || url.username || url.password) throw new Error("PxWeb request URL is outside the publisher host allowlist.");
    return url;
  }
  private async pace(host: string) {
    const current = this.now();
    const requestAt = Math.max(current, this.nextAt.get(host) ?? current);
    this.nextAt.set(host, requestAt + this.intervalMs);
    if (requestAt > current) await this.sleep(requestAt - current);
  }
  async request(input: string | URL, init: RequestInit = {}, timeoutMs = this.timeoutMs): Promise<Response> {
    const url = this.validateUrl(input);
    const headers = new Headers(init.headers);
    if (!headers.has("user-agent")) headers.set("user-agent", defaultUserAgent);
    let lastError: unknown;
    for (let attempt = 0; attempt <= 2; attempt += 1) {
      await this.pace(url.hostname);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("PxWeb request timed out.")), timeoutMs);
      try {
        const response = await this.fetcher(url, { ...init, headers, signal: controller.signal });
        if (response.url) this.validateUrl(response.url);
        if (response.status === 429 && attempt < 2) {
          const wait = retryDelay(response, this.now());
          await this.sleep(wait);
          continue;
        }
        if (response.status >= 500 && attempt < 2) {
          await this.sleep((250 * (2 ** attempt)) + Math.floor(this.random() * 250));
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt >= 2) break;
        await this.sleep((250 * (2 ** attempt)) + Math.floor(this.random() * 250));
      } finally { clearTimeout(timer); }
    }
    throw new Error("PxWeb request failed after retries: " + (lastError instanceof Error ? lastError.message : String(lastError ?? "upstream unavailable")));
  }
  async schema<T>(key: string, url: string | URL, timeoutMs = this.timeoutMs): Promise<T> {
    const cached = this.schemas.get(key);
    if (cached && cached.expires > this.now()) return cached.value as T;
    const persisted = await this.schemaCache?.get<{ expiresAt: number; value: T }>("pxweb:" + key);
    if (persisted && persisted.expiresAt > this.now()) {
      this.schemas.set(key, { expires: persisted.expiresAt, value: persisted.value });
      return persisted.value;
    }
    const response = await this.request(url, {}, timeoutMs);
    if (!response.ok) throw new Error("PxWeb schema request failed (" + response.status + ").");
    const value = await response.json() as T;
    this.schemas.set(key, { expires: this.now() + this.schemaTtlMs, value });
    await this.schemaCache?.set("pxweb:" + key, { expiresAt: this.now() + this.schemaTtlMs, value });
    return value;
  }
}

const shared = new PxWebClient();
export const pxwebClient = () => shared;
export function configurePxWebSchemaCache(cache: PxWebSchemaCache | undefined) { shared.setSchemaCache(cache); }

/** Rewrites an obsolete catalogue path while preserving its table ID. */
export function currentStatFinTablePath(path: string) {
  // This regex parses the documented `/statfin_<subject>_pxt_<table>.px` path format.
  const legacy = path.match(/\/statfin_([^/]+?)_pxt_(.+\.px)$/i);
  return legacy ? "StatFin/" + legacy[1] + "/" + legacy[2] : path;
}
