const defaultProviderIds = ["statfin", "traficom", "vero", "vero-web", "visitfinland", "kototietokanta", "luke", "etk", "helsinki"];

/** Resolve explicit provider configuration; Helsinki's beta HTML provider is enabled by default. */
export function enabledProviderIds(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.SUOMI_MCP_PROVIDERS;
  const providers = new Set((configured ?? defaultProviderIds.join(",")).split(",").map((value) => value.trim()).filter(Boolean));
  if (env.SUOMI_MCP_HELSINKI === "1") providers.add("helsinki");
  if (env.SUOMI_MCP_HELSINKI === "0") providers.delete("helsinki");
  return [...providers];
}
