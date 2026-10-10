import { describe, expect, it } from "vitest";
import { createSqlEngineFactory } from "../src/sql-engines.js";

describe("local SQL engines", () => {
  it("calculates with the WASM engine", async () => {
    const createEngine = await createSqlEngineFactory("wasm");
    const engine = createEngine();
    engine.load("facts", [{ source: "value", name: "value", type: "number" }], [[2], [3]]);
    expect(engine.query("SELECT SUM(value) AS total FROM facts")).toEqual([{ total: 5 }]);
    engine.close();
  });

  it("calculates with node:sqlite when the runtime provides it", async () => {
    const createEngine = await createSqlEngineFactory("node");
    const engine = createEngine();
    engine.load("facts", [{ source: "value", name: "value", type: "number" }], [[2], [3]]);
    expect(engine.query("SELECT SUM(value) AS total FROM facts")).toEqual([{ total: 5 }]);
    engine.close();
  });
});
