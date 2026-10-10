export type Filter = { code: string; values: string[] };

export function selectedCellCount(filters: Filter[]): number {
  return filters.reduce((total, filter) => total * filter.values.length, 1);
}

export function assertCellLimit(filters: Filter[], limit = 25_000): void {
  const cells = selectedCellCount(filters);
  if (!filters.length || filters.some((filter) => filter.values.length === 0) || cells > limit) {
    throw new Error(`Query selects ${cells} cells. Select one or more values per dimension and keep the total at or below ${limit}.`);
  }
}

export function flattenJsonStat(dataset: {
  id: string[]; size: number[]; dimension: Record<string, { category: { index: Record<string, number>; label: Record<string, string> } }>;
  value: Array<number | null>;
}): Array<Record<string, string | number | null>> {
  const rows: Array<Record<string, string | number | null>> = [];
  const cells = dataset.size.reduce((total, size) => total * size, 1);
  for (let position = 0; position < cells; position += 1) {
    let remainder = position;
    const row: Record<string, string | number | null> = {};
    for (let i = dataset.id.length - 1; i >= 0; i -= 1) {
      const dimensionId = dataset.id[i]!;
      const size = dataset.size[i]!;
      const offset = remainder % size;
      remainder = Math.floor(remainder / size);
      const category = dataset.dimension[dimensionId]!.category;
      const code = Object.entries(category.index).find(([, value]) => value === offset)?.[0] ?? String(offset);
      row[dimensionId] = category.label[code] ?? code;
    }
    row.Arvo = dataset.value[position] ?? null;
    rows.push(row);
  }
  return rows;
}

export function markdownTable(rows: Array<Record<string, string | number | null>>): string {
  if (!rows.length) return "No data returned.";
  const headers = Object.keys(rows[0]!);
  const escape = (value: unknown) => String(value ?? "…").replaceAll("|", "\\|").replaceAll("\n", " ");
  return [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${headers.map((header) => escape(row[header])).join(" | ")} |`)].join("\n");
}

