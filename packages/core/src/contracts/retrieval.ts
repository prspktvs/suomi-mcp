import { z } from "zod";

/** Provider-neutral retrieval contracts. Semantic values are authored by the
 * model; the runtime only validates their shape, schema membership and links. */
export const intentPlanBaseSchema = z.object({
  current_date: z.iso.date().optional(),
  answer_language: z.enum(["English", "Finnish", "Swedish", "other"]),
  requests: z.array(z.object({ id: z.string().min(1), concept: z.string().min(1), required: z.boolean(), acceptable_units: z.array(z.string()), acceptable_measure_kinds: z.array(z.string()) })).min(1),
  scope: z.object({
    geography: z.object({ description: z.string().min(1), exactness: z.enum(["exact", "comparison", "national_context_allowed"]) }),
    population_or_entity: z.string().min(1),
    period: z.object({ selection: z.enum(["specified", "latest_available", "trend"]), requested_values: z.array(z.string()), requested_frequency: z.string().optional() }),
  }),
  operation: z.object({
    kind: z.enum(["direct", "comparison", "ranking", "change", "ratio", "aggregation", "other"]),
    required_calculation: z.boolean(),
    ranking_basis: z.enum(["absolute_change", "relative_change", "level", "ratio", "model_defined"]).optional(),
    comparison_endpoints: z.array(z.object({ id: z.string().min(1), period_values: z.array(z.string()), label: z.string().min(1) })).max(50).optional(),
  }),
  proxy_policy: z.object({ allowed: z.boolean().describe("Whether a disclosed alternative measure or scope may answer this request if exact evidence is unavailable; the model decides from the request and context."), disclosure_required: z.boolean() }),
  completion: z.object({ require_all_requests: z.boolean(), require_exact_geography: z.boolean(), require_all_requested_periods: z.boolean(), require_comparable_units: z.boolean() }),
});

/** Structural plan consistency only: the model supplies meanings and values. */
export const intentPlanSchema = intentPlanBaseSchema.superRefine((plan, context) => {
  const { operation } = plan;
  if (["comparison", "change", "ratio"].includes(operation.kind) && (!operation.comparison_endpoints || operation.comparison_endpoints.length < 2)) {
    context.addIssue({ code: "custom", path: ["operation", "comparison_endpoints"], message: "Comparison, change, and ratio operations require at least two structured endpoints." });
  }
  if (operation.kind === "ranking" && !operation.ranking_basis) {
    context.addIssue({ code: "custom", path: ["operation", "ranking_basis"], message: "Ranking operations require an explicit basis." });
  }
  if (plan.scope.period.selection === "specified") {
    operation.comparison_endpoints?.forEach((endpoint, index) => {
      if (endpoint.period_values.length === 0) {
        context.addIssue({ code: "custom", path: ["operation", "comparison_endpoints", index, "period_values"], message: "Specified-period operations require explicit endpoint period values." });
      }
    });
  }
});
export type IntentPlan = z.infer<typeof intentPlanSchema>;

export const sourceCardSchema = z.object({
    source_ref: z.string(),
    official: z.object({ provider_id: z.string(), title: z.string(), url: z.string().url(), language: z.string().optional(), schema_hash: z.string() }),
    discovery: z.object({ origin: z.literal("generated"), summary_en: z.string().max(500), summary_fi: z.string().max(500), aliases_en: z.array(z.string().max(100)).max(12), aliases_fi: z.array(z.string().max(100)).max(12) }),
    scope_card: z.object({ origin: z.literal("generated"), geography_coverage: z.string().max(300), population_or_entity: z.string().max(300), time_coverage: z.string().max(300), frequency: z.string().max(100), units: z.array(z.string().max(100)).max(20), included: z.array(z.string().max(120)).max(12), excluded_or_ambiguities: z.array(z.string().max(160)).max(12) }),
    capability_hints: z.object({ origin: z.literal("generated"), supports_time_series: z.boolean(), candidate_ranking_dimensions: z.array(z.string().max(120)).max(12), requires_live_schema_confirmation: z.literal(true) }),
    provenance: z.object({ schema_hash: z.string(), generation_model: z.string(), prompt_version: z.string(), generated_at: z.string() }),
});
export type SourceCard = z.infer<typeof sourceCardSchema>;

export const sourceCandidateSchema = z.object({
  provider_id: z.string(), dataset_id: z.string(), resource_id: z.string(), title: z.string(), description: z.string().optional(), language: z.string().optional(), availability: z.object({ status: z.enum(["available", "unavailable", "not_queryable"]), checked_at: z.string(), error: z.object({ code: z.string(), message: z.string() }).optional() }).optional(), source_card: sourceCardSchema.optional(),
  coverage: z.object({ geography: z.array(z.string()).optional(), periods: z.array(z.string()).optional(), frequencies: z.array(z.string()).optional(), population_or_entity: z.array(z.string()).optional() }),
  measures: z.array(z.object({ id: z.string(), label: z.string(), unit: z.string().optional(), description: z.string().optional() })),
  dimensions: z.array(z.object({ id: z.string(), label: z.string(), definition: z.string().optional(), metadata: z.record(z.string(), z.unknown()).optional(), role: z.enum(["measure", "geography", "time", "population", "category", "unknown"]).optional(), value_count: z.number().int().nonnegative().optional(), value_samples: z.array(z.object({ id: z.string(), label: z.string(), unit: z.string().optional(), definition: z.string().optional() })).optional() })),
  access: z.object({ provider: z.string(), resource_type: z.enum(["pxweb", "api", "file", "other"]), schema_available: z.boolean(), queryable: z.boolean().optional() }),
});
export type SourceCandidate = z.infer<typeof sourceCandidateSchema>;

export const providerSchemaSchema = z.object({ provider_id: z.string(), dataset_id: z.string(), resource_id: z.string(), dimensions: z.array(z.object({ id: z.string(), label: z.string(), definition: z.string().optional(), metadata: z.record(z.string(), z.unknown()).optional(), role: z.enum(["measure", "geography", "time", "population", "category", "unknown"]), values: z.array(z.object({ id: z.string(), label: z.string(), unit: z.string().optional(), definition: z.string().optional(), metadata: z.record(z.string(), z.unknown()).optional() })) })), provenance: z.object({ source_url: z.string().url(), retrieved_at: z.string(), schema_hash: z.string().optional() }) });
export type ProviderSchema = z.infer<typeof providerSchemaSchema>;

/** A provider result carries provider-native rows plus enough provenance to
 * attach those rows to a source binding and an eventual answer claim. */
export const providerQueryResultSchema = z.object({
  provider_id: z.string(),
  resource_id: z.string(),
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
  retrieved_at: z.string(),
  source_url: z.string().url(),
});
export type ProviderQueryResult = z.infer<typeof providerQueryResultSchema>;

export const sourceBindingSchema = z.object({
  id: z.string().min(1), request_id: z.string().min(1), provider_id: z.string(), dataset_id: z.string(), resource_id: z.string(),
  selection: z.object({ measure: z.object({ dimension_id: z.string(), value_ids: z.array(z.string()).min(1), labels: z.array(z.string()), unit: z.string().optional() }), dimensions: z.array(z.object({ dimension_id: z.string(), value_ids: z.array(z.string()).min(1), purpose: z.enum(["geography", "time", "population", "category", "other"]) })) }),
  interpretation: z.object({
    direct_match: z.boolean().describe("The model's schema-based assessment of whether the selected source directly matches the planned measure and scope."),
    proxy: z.boolean().describe("True only when the selected measure or non-time scope is a substitute for the planned request. An older or incomplete time range alone is not a proxy; represent it as partial period coverage in the assessment."),
    proxy_explanation: z.string().optional().describe("When proxy is true, state the model-identified measure or non-time scope difference from the request."),
    comparability_group: z.string().optional(),
  }),
  expected_coverage: z.object({ request_id: z.string(), geography_values: z.array(z.string()), period_values: z.array(z.string()) }),
});
export type SourceBinding = z.infer<typeof sourceBindingSchema>;

export const evidenceAssessmentSchema = z.object({ request_id: z.string(), binding_ids: z.array(z.string()), status: z.enum(["complete", "partial", "unavailable", "proxy"]).describe("Use partial when the planned scope matches but requested coverage such as periods is missing. Use proxy only for a model-identified alternative measure or non-time scope allowed by proxy_policy."), fulfilled: z.object({ measure: z.boolean(), geography: z.boolean(), population_or_entity: z.boolean(), periods: z.boolean(), unit_comparability: z.boolean() }), missing: z.array(z.object({ criterion: z.enum(["measure", "geography", "population_or_entity", "period", "unit", "calculation", "coverage", "source_availability"]), explanation: z.string() })).describe("Record each model-assessed gap against the plan and retrieved evidence. Use coverage or source_availability when those are the unmet criteria; application code does not infer them from question wording."), allowed_for_final_answer: z.boolean() });
export type EvidenceAssessment = z.infer<typeof evidenceAssessmentSchema>;

/** Validates internal consistency of the model-authored assessment without
 * deciding whether any measure or scope is semantically correct. */
export function assessmentFeedback(assessment: EvidenceAssessment) {
  const unmet = Object.entries(assessment.fulfilled).filter(([, fulfilled]) => !fulfilled).map(([criterion]) => criterion);
  if (assessment.status === "complete" && (unmet.length || assessment.missing.length)) return { code: "complete_assessment_has_missing_criteria", unmet, missing: assessment.missing };
  const missingCriteria = new Set(assessment.missing.map((item) => item.criterion));
  const missingKey = { measure: "measure", geography: "geography", population_or_entity: "population_or_entity", periods: "period", unit_comparability: "unit" } as const;
  const unexplained = unmet.filter((criterion) => !missingCriteria.has(missingKey[criterion as keyof typeof missingKey]));
  if (unexplained.length) return { code: "assessment_missing_explanation", criteria: unexplained };
  return undefined;
}

export const answerClaimSchema = z.object({ id: z.string(), request_ids: z.array(z.string()).min(1), kind: z.enum(["direct", "derived", "limitation", "proxy_disclosure"]), text: z.string().min(1), measure: z.string(), unit: z.string().optional(), geography: z.string().optional(), population_or_entity: z.string().optional(), periods: z.array(z.string()).optional(), evidence_refs: z.array(z.object({ evidence_id: z.string(), row_ids: z.array(z.string()).optional(), calculation_id: z.string().optional() })).min(1) });
export type AnswerClaim = z.infer<typeof answerClaimSchema>;

/** Final display is assembled only from already validated, evidence-linked
 * claims. Rendering does not inspect question prose, table labels, or SQL. */
export function renderAnswerClaims(claims: AnswerClaim[]): string {
  return claims.map((claim) => claim.text.trim()).filter(Boolean).join("\n\n");
}

export function bindingFeedback(binding: SourceBinding, schema: ProviderSchema) {
  const dimensions = new Map(schema.dimensions.map((dimension) => [dimension.id, dimension]));
  const selections = [binding.selection.measure, ...binding.selection.dimensions];
  const selectedDimensionIds = selections.map((selection) => selection.dimension_id);
  const errors: Array<Record<string, unknown>> = selections.flatMap((selection) => {
    const dimension = dimensions.get(selection.dimension_id);
    if (!dimension) return [{ code: "unknown_dimension", dimension_id: selection.dimension_id }];
    const known = new Set(dimension.values.map((value) => value.id));
    const absent = selection.value_ids.filter((id) => !known.has(id));
    return absent.length ? [{ code: "unknown_value", dimension_id: selection.dimension_id, value_ids: absent }] : [];
  });
  const missingDimensions = schema.dimensions.map((dimension) => dimension.id).filter((dimensionId) => !selectedDimensionIds.includes(dimensionId));
  if (missingDimensions.length) errors.push({ code: "dimension_selection_required", dimension_ids: missingDimensions });
  const duplicateDimensions = [...new Set(selectedDimensionIds.filter((dimensionId, index) => selectedDimensionIds.indexOf(dimensionId) !== index))];
  if (duplicateDimensions.length) errors.push({ code: "dimension_selected_more_than_once", dimension_ids: duplicateDimensions });
  return errors.length ? { code: "binding_schema_mismatch", errors, available_dimensions: schema.dimensions.map(({ id, label, values }) => ({ id, label, value_count: values.length })) } : undefined;
}

/** Resolves the measure description that a provider exposed in the inspected
 * schema. Binding labels are model context, never evidence metadata. */
export function selectedMeasureMetadata(binding: SourceBinding, schema: ProviderSchema) {
  const dimension = schema.dimensions.find((item) => item.id === binding.selection.measure.dimension_id);
  return {
    dimension_id: binding.selection.measure.dimension_id,
    dimension_label: dimension?.label,
    values: dimension?.values
      .filter((value) => binding.selection.measure.value_ids.includes(value.id))
      .map(({ id, label, unit, definition, metadata }) => ({ id, label, unit, definition, metadata })) ?? [],
  };
}

export function claimFeedback(claims: AnswerClaim[], assessments: EvidenceAssessment[], evidenceIds: Set<string>, calculationIds: Set<string>, evidenceBindingIds = new Map<string, string>()) {
  const assessmentByRequest = new Map(assessments.map((assessment) => [assessment.request_id, assessment]));
  const proxyDisclosureEvidenceByRequest = new Map<string, Set<string>>();
  for (const claim of claims) {
    if (claim.kind !== "proxy_disclosure") continue;
    for (const requestId of claim.request_ids) {
      const evidence = proxyDisclosureEvidenceByRequest.get(requestId) ?? new Set<string>();
      claim.evidence_refs.forEach(({ evidence_id }) => evidence.add(evidence_id));
      proxyDisclosureEvidenceByRequest.set(requestId, evidence);
    }
  }
  const errors: unknown[] = [];
  for (const claim of claims) {
    const claimEvidenceBindings = [...new Set(claim.evidence_refs.map((ref) => evidenceBindingIds.get(ref.evidence_id)).filter((id): id is string => Boolean(id)))];
    const requestedAssessmentBindingIds = new Set(claim.request_ids.flatMap((requestId) => assessmentByRequest.get(requestId)?.binding_ids ?? []));
    const unassessedBindings = claimEvidenceBindings.filter((bindingId) => !requestedAssessmentBindingIds.has(bindingId));
    const hasEvidenceForRequestedBinding = claimEvidenceBindings.some((bindingId) => requestedAssessmentBindingIds.has(bindingId));
    if (claim.kind !== "limitation" && evidenceBindingIds.size > 0 && requestedAssessmentBindingIds.size > 0 && unassessedBindings.length) {
      errors.push({ code: "claim_evidence_not_assessed", claim_id: claim.id, request_ids: claim.request_ids, binding_ids: unassessedBindings, assessment_binding_ids: [...requestedAssessmentBindingIds] });
    }
    for (const requestId of claim.request_ids) {
      const assessment = assessmentByRequest.get(requestId);
      if (!assessment) errors.push({ code: "assessment_missing", claim_id: claim.id, request_id: requestId });
      else if (claim.kind !== "limitation" && (assessment.status === "partial" || assessment.status === "unavailable" || !assessment.allowed_for_final_answer)) errors.push({ code: "incomplete_evidence", claim_id: claim.id, request_id: requestId, status: assessment.status });
      else if (claim.kind === "proxy_disclosure" && assessment.status !== "proxy") errors.push({ code: "proxy_assessment_required", claim_id: claim.id, request_id: requestId, status: assessment.status });
      else if (claim.kind !== "limitation" && assessment.status === "proxy" && claim.kind !== "proxy_disclosure") {
        const proxyEvidenceIds = claim.evidence_refs.flatMap(({ evidence_id }) => {
          const bindingId = evidenceBindingIds.get(evidence_id);
          return evidenceBindingIds.size === 0 || (bindingId && assessment.binding_ids.includes(bindingId)) ? [evidence_id] : [];
        });
        const disclosedEvidenceIds = proxyDisclosureEvidenceByRequest.get(requestId) ?? new Set<string>();
        const missingDisclosureEvidenceIds = [...new Set(proxyEvidenceIds)].filter((evidence_id) => !disclosedEvidenceIds.has(evidence_id));
        if (missingDisclosureEvidenceIds.length) errors.push({ code: "proxy_disclosure_required", claim_id: claim.id, request_id: requestId, evidence_ids: missingDisclosureEvidenceIds });
      }
      const requestHasClaimEvidence = claimEvidenceBindings.some((bindingId) => assessment?.binding_ids.includes(bindingId));
      if (assessment && claim.kind !== "limitation" && evidenceBindingIds.size > 0 && hasEvidenceForRequestedBinding && !requestHasClaimEvidence) {
        errors.push({ code: "claim_evidence_not_assessed", claim_id: claim.id, request_id: requestId, binding_ids: claimEvidenceBindings, assessment_binding_ids: assessment.binding_ids });
      }
    }
  }
  for (const claim of claims) for (const ref of claim.evidence_refs) {
    if (!evidenceIds.has(ref.evidence_id)) errors.push({ code: "unknown_evidence", claim_id: claim.id, evidence_id: ref.evidence_id });
    if (ref.calculation_id && !calculationIds.has(ref.calculation_id)) errors.push({ code: "unknown_calculation", claim_id: claim.id, calculation_id: ref.calculation_id });
  }
  return errors.length ? { code: "claim_provenance_mismatch", errors } : undefined;
}
