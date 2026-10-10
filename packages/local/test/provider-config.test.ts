import { describe, expect, it } from "vitest";
import { enabledProviderIds } from "../src/provider-config.js";

describe("local provider configuration", () => {
  it("enables the Helsinki beta provider by default", () => {
    expect(enabledProviderIds({} as NodeJS.ProcessEnv)).toContain("helsinki");
  });

  it("allows Helsinki to be disabled or explicitly enabled", () => {
    expect(enabledProviderIds({ SUOMI_MCP_HELSINKI: "0" } as NodeJS.ProcessEnv)).not.toContain("helsinki");
    expect(enabledProviderIds({ SUOMI_MCP_PROVIDERS: "statfin", SUOMI_MCP_HELSINKI: "1" } as NodeJS.ProcessEnv)).toEqual(["statfin", "helsinki"]);
  });
});
