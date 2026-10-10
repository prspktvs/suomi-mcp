export type SqlColumn = { source: string; name: string; type: "text" | "number" };

/** Minimal in-memory SQL engine boundary; core never loads a native module. */
export interface SqlEngine {
  load(table: string, columns: SqlColumn[], rows: unknown[][]): void;
  query(sql: string): Array<Record<string, string | number | null>>;
  close(): void;
}
