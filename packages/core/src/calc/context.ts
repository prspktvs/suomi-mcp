import type { SqlColumn, SqlEngine } from "./engine.js";

export type CalculationColumn = SqlColumn;
export type CalculationSource = { relation: string; columns: CalculationColumn[]; rows: number };
export type Calculation = { id: string; purpose: string; sql: string; result: Array<Record<string, string | number | null>> };
export type CalculationFeedback = { code: "calculation_statement_required" | "calculation_read_only_required" | "calculation_operation_not_allowed" | "calculation_execution_failed"; message: string };
export interface CalculationContextPort {
  addSource(rows: Array<Record<string, string | number | null>>): CalculationSource;
  calculate(sql: string, purpose: string): Calculation;
  close(): void;
}

class CalculationValidationError extends Error {
  constructor(readonly feedback: CalculationFeedback) { super(feedback.message); }
}

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const normaliseColumn = (header: string, position: number) => {
  // This regex validates the SQLite-safe identifier format, not a statistical label or intent.
  const cleaned = header.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || `column_${position + 1}`;
};
function columnType(rows: Array<Record<string, string | number | null>>, header: string): CalculationColumn["type"] {
  const values = rows.map((row) => row[header]).filter((value): value is string | number => value !== null);
  return values.length > 0 && values.every((value) => typeof value === "number") ? "number" : "text";
}
function validateSql(sql: string) {
  // Removes one optional trailing SQL statement terminator; any remaining semicolon fails below.
  const statement = sql.trim().replace(/;\s*$/, "");
  if (!statement || statement.includes(";")) throw new CalculationValidationError({ code: "calculation_statement_required", message: "Submit exactly one SQL statement." });
  // Validates that the statement starts with the supported read-only SQL statement forms.
  if (!/^(select|with)\b/i.test(statement)) throw new CalculationValidationError({ code: "calculation_read_only_required", message: "Only read-only SELECT or WITH statements are allowed." });
  // Rejects SQL operation and SQLite system-object tokens using SQL token boundaries.
  if (/\b(?:attach|detach|pragma|vacuum|insert|update|delete|drop|alter|create|replace|load_extension|sqlite_master|sqlite_schema)\b/i.test(statement)) throw new CalculationValidationError({ code: "calculation_operation_not_allowed", message: "This SQL operation is not allowed." });
  return statement;
}
export function calculationFeedback(error: unknown): CalculationFeedback {
  if (error instanceof CalculationValidationError) return error.feedback;
  return { code: "calculation_execution_failed", message: error instanceof Error ? error.message : "The calculation could not be executed." };
}

/** Validates read-only SQL and loads only retrieved answer cells into an injected in-memory engine. */
export class CalculationContext implements CalculationContextPort {
  private sourceCount = 0;
  private calculationCount = 0;
  constructor(private readonly engine: SqlEngine) {}
  addSource(rows: Array<Record<string, string | number | null>>): CalculationSource {
    if (!rows.length) throw new Error("Cannot load an empty PxWeb result into the calculation context.");
    const headers = Object.keys(rows[0]!);
    const names = new Set<string>();
    const columns = headers.map((source, position) => {
      const base = normaliseColumn(source, position); let name = base; let suffix = 2;
      while (names.has(name)) { name = `${base}_${suffix}`; suffix += 1; }
      names.add(name);
      return { source, name, type: columnType(rows, source) };
    });
    const physicalNames = new Set(columns.map((column) => column.name.toLocaleLowerCase("en-US")));
    const aliases = columns.flatMap((column) => {
      const aliasKey = column.source.toLocaleLowerCase("en-US");
      if (physicalNames.has(aliasKey)) return [];
      physicalNames.add(aliasKey);
      return [{ ...column, name: column.source }];
    });
    const storedColumns = [...columns, ...aliases];
    const relation = `source_${++this.sourceCount}`;
    this.engine.load(relation, storedColumns, rows.map((row) => storedColumns.map((column) => row[column.source] ?? null)));
    return { relation, columns, rows: rows.length };
  }
  calculate(sql: string, purpose: string): Calculation {
    const statement = validateSql(sql);
    const result = this.engine.query(`SELECT * FROM (${statement}) AS calculation_result LIMIT 1000`);
    return { id: `calculation_${++this.calculationCount}`, purpose: purpose.trim() || "Calculation", sql: statement, result };
  }
  close() { this.engine.close(); }
}

export { identifier as quoteSqlIdentifier };
