import type { SqlColumn, SqlEngine } from "@prspktvs/suomi-mcp-core/calc";

const quote = (value: string) => "\"" + value.replaceAll("\"", "\"\"") + "\"";
type EngineName = "node" | "wasm";

class NodeSqlEngine implements SqlEngine {
  private readonly db: import("node:sqlite").DatabaseSync;
  constructor(DatabaseSync: typeof import("node:sqlite").DatabaseSync) { this.db = new DatabaseSync(":memory:"); }
  load(table: string, columns: SqlColumn[], rows: unknown[][]) {
    this.db.exec("CREATE TABLE " + quote(table) + " (" + columns.map((column) => quote(column.name) + " " + (column.type === "number" ? "REAL" : "TEXT")).join(", ") + ")");
    const insert = this.db.prepare("INSERT INTO " + quote(table) + " (" + columns.map((column) => quote(column.name)).join(", ") + ") VALUES (" + columns.map(() => "?").join(", ") + ")");
    this.db.exec("BEGIN");
    try { for (const item of rows) insert.run(...item as (string | number | bigint | null)[]); this.db.exec("COMMIT"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  query(sql: string) { return this.db.prepare(sql).all() as Array<Record<string, string | number | null>>; }
  close() { this.db.close(); }
}

class WasmSqlEngine implements SqlEngine {
  constructor(private readonly db: import("sql.js").Database) {}
  load(table: string, columns: SqlColumn[], rows: unknown[][]) {
    this.db.run("CREATE TABLE " + quote(table) + " (" + columns.map((column) => quote(column.name) + " " + (column.type === "number" ? "REAL" : "TEXT")).join(", ") + ")");
    const insert = this.db.prepare("INSERT INTO " + quote(table) + " (" + columns.map((column) => quote(column.name)).join(", ") + ") VALUES (" + columns.map(() => "?").join(", ") + ")");
    try { for (const row of rows) insert.run(row as (string | number | null)[]); }
    finally { insert.free(); }
  }
  query(sql: string) {
    const results = this.db.exec(sql);
    return results.flatMap((result) => result.values.map((values) => Object.fromEntries(result.columns.map((column, index) => [column, values[index] as string | number | null]))));
  }
  close() { this.db.close(); }
}

/** Initialize the WASM module once, then create a fresh in-memory database for each workflow. */
export async function createSqlEngineFactory(requested = (process.env.SUOMI_MCP_SQL_ENGINE as EngineName | undefined) ?? "auto") {
  if (requested === "node" || requested === "auto") {
    try {
      const sqlite = await import("node:sqlite");
      const DatabaseSync = sqlite.DatabaseSync;
      return () => new NodeSqlEngine(DatabaseSync);
    } catch (error) {
      if (requested === "node") throw new Error("The node:sqlite engine is unavailable: " + (error instanceof Error ? error.message : String(error)));
      process.stderr.write("node:sqlite is unavailable; using the sql.js WebAssembly engine.\n");
    }
  }
  if (requested !== "auto" && requested !== "wasm") throw new Error("SUOMI_MCP_SQL_ENGINE must be node, wasm, or auto.");
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs();
  return () => new WasmSqlEngine(new SQL.Database());
}
