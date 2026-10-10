export type PxWebSchemaVariable = { code?: string; text?: string; time?: boolean; values?: string[]; valueTexts?: string[]; unit?: string; note?: string; elimination?: boolean };

export function mapPxWebDimensions(variables: PxWebSchemaVariable[]) {
  return variables.map((variable) => ({
    id: variable.code ?? "",
    label: variable.text ?? variable.code ?? "",
    ...(variable.note ? { definition: variable.note } : {}),
    ...((variable.time !== undefined || variable.elimination !== undefined) ? { metadata: { ...(variable.time === undefined ? {} : { time: variable.time }), ...(variable.elimination === undefined ? {} : { elimination: variable.elimination }) } } : {}),
    role: variable.time ? "time" as const : "unknown" as const,
    values: (variable.values ?? []).map((id, index) => ({
      id,
      label: variable.valueTexts?.[index] ?? id,
      ...(variable.unit ? { unit: variable.unit } : {}),
    })),
  }));
}
