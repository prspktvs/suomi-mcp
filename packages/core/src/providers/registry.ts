import type { CatalogPort } from "../catalog/port.js";
import { StatFinPxWebProvider } from "./statfin-pxweb.js";
import { TraficomPxWebProvider } from "./traficom-pxweb.js";
import { VeroPxWebProvider } from "./vero-pxweb.js";
import { ConfiguredPxWebProvider } from "./configured-pxweb.js";
import { HelsinkiLegacyPxWebProvider } from "./helsinki-legacy-pxweb.js";
import type { StatisticalProvider } from "./types.js";

export const configuredPxWebProviderConfigs = [
  { id: "visitfinland", label: "Visit Finland PxWeb", api_base: "https://visitfinland.stat.fi/PXWeb/api/v1/en", web_base: "https://visitfinland.stat.fi/PXWeb/pxweb/en", database_id: "VisitFinland" },
  { id: "kototietokanta", label: "Kototietokanta PxWeb", api_base: "https://kototietokanta.stat.fi/PXWeb/api/v1/fi", web_base: "https://kototietokanta.stat.fi/PXWeb/pxweb/fi", database_id: "Kototietokanta" },
  { id: "luke", label: "Natural Resources Institute Finland PxWeb", api_base: "https://statdb.luke.fi/PXWeb/api/v1/fi", web_base: "https://statdb.luke.fi/PXWeb/pxweb/fi", database_id: "LUKE" },
  { id: "etk", label: "Finnish Centre for Pensions PxWeb", api_base: "https://tilastot.etk.fi/api/v1/en", web_base: "https://tilastot.etk.fi/pxweb/en", database_id: "ETK" },
] as const;

export class ProviderRegistry {
  private readonly providers = new Map<string, StatisticalProvider>();
  constructor(catalog: CatalogPort, additional: StatisticalProvider[] = [], options: { includeHelsinki?: boolean; maxCells?: number } = {}) {
    const maxCells = options.maxCells ?? 25_000;
    this.register(new StatFinPxWebProvider(catalog, maxCells)); this.register(new TraficomPxWebProvider(catalog, maxCells)); this.register(new VeroPxWebProvider(catalog, maxCells));
    configuredPxWebProviderConfigs.forEach((config) => this.register(new ConfiguredPxWebProvider(catalog, config, maxCells)));
    if (options.includeHelsinki !== false) this.register(new HelsinkiLegacyPxWebProvider(catalog, maxCells));
    additional.forEach((provider) => this.register(provider));
  }
  register(provider: StatisticalProvider) { this.providers.set(provider.id, provider); }
  setEnabled(providerIds: string[]) {
    const enabled = new Set(providerIds);
    for (const providerId of this.providers.keys()) if (!enabled.has(providerId)) this.providers.delete(providerId);
  }
  get(id: string) { const provider = this.providers.get(id); if (!provider) throw new Error(`Unknown statistical provider: ${id}`); return provider; }
  all() { return [...this.providers.values()]; }
}
