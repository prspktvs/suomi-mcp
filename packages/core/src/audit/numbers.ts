export type AuditEvidence = { rows: Array<Array<string | number | null>>; row_count?: number };
export type AuditCalculation = { result: Array<Record<string, string | number | null>> };

// This pattern validates the supported displayed-number formats used in evidence text; it does not assign meaning to a number.
const numericTokens = (text: string) => text.match(/-?(?:\d{1,3}(?:[ ,.\u00a0]\d{3})+|\d+)(?:[.,]\d+)?/g) ?? [];
const canonicalNumber = (value: string, locale: "en" | "fi" = "en") => {
  // Removes whitespace and nonbreaking-space thousands separators from display numbers.
  const compact = value.replace(/[\s\u00a0]/g, "");
  // Finnish decimal-comma display format permits one or more fractional digits.
  if (locale === "fi" && /^-?\d+,\d+$/.test(compact)) return compact.replace(",", ".");
  // A comma followed by one or two digits is decimal notation; three digits is a thousands group.
  if (/^-?\d+,\d{1,2}$/.test(compact)) return compact.replace(",", ".");
  return compact.replace(/,/g, "");
};

/** Reject prose that introduces numerical facts absent from its evidence and calculations. */
export function unauditedAnswerNumbers(answer: string, evidence: AuditEvidence[], calculations: AuditCalculation[], structuredLabels: string[] = [], locale: "en" | "fi" = "en") {
  const allowed = new Set<string>();
  for (const item of evidence) {
    for (const row of item.rows) for (const cell of row) for (const token of numericTokens(String(cell))) allowed.add(canonicalNumber(token, locale));
    if (item.row_count !== undefined) for (const token of numericTokens(String(item.row_count))) allowed.add(canonicalNumber(token, locale));
  }
  for (const calculation of calculations) for (const row of calculation.result) for (const value of Object.values(row)) for (const token of numericTokens(String(value ?? ""))) allowed.add(canonicalNumber(token, locale));
  const ignoredLabelNumbers = new Set(structuredLabels.flatMap(numericTokens).map((token) => canonicalNumber(token, locale)));
  // This pattern validates Finnish D.M.YYYY date display syntax and skips those tokens; it does not infer a time dimension.
  const numericAnswer = answer.replace(/\b\d{1,2}\.\d{1,2}\.\d{4}\b/g, "");
  return [...new Set(numericTokens(numericAnswer).filter((token) => !ignoredLabelNumbers.has(canonicalNumber(token, locale)) && !isAudited(token)))];
  function isAudited(token: string) {
    const value = canonicalNumber(token, locale);
    if (allowed.has(value)) return true;
    const numeric = Number(value);
    // Permit only display rounding to at most 15 decimal places.
    const decimalPlaces = value.includes(".") ? value.length - value.indexOf(".") - 1 : 0;
    if (decimalPlaces > 15) return false;
    return Number.isFinite(numeric) && [...allowed].some((candidate) => {
      const source = Number(candidate);
      return Number.isFinite(source) && Number(source.toFixed(decimalPlaces)) === numeric;
    });
  }
}

export function answerNumbersAreAudited(answer: string, evidence: AuditEvidence[], calculations: AuditCalculation[], structuredLabels: string[] = [], locale: "en" | "fi" = "en") {
  return unauditedAnswerNumbers(answer, evidence, calculations, structuredLabels, locale).length === 0;
}
