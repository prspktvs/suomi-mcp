import { randomUUID } from "node:crypto";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CalculationContext, calculationFeedback, type Calculation, type CalculationContextPort } from "../calc/context.js";
import type { CatalogPort } from "../catalog/port.js";
import { unauditedAnswerNumbers, type AuditEvidence } from "../audit/numbers.js";
import { ProviderRegistry } from "../providers/registry.js";
import type { StatisticalProvider } from "../providers/types.js";
import { answerClaimSchema, assessmentFeedback, bindingFeedback, claimFeedback, evidenceAssessmentSchema, intentPlanBaseSchema, intentPlanSchema, providerQueryResultSchema, renderAnswerClaims, selectedMeasureMetadata, sourceBindingSchema, type ProviderSchema, type SourceCandidate } from "../contracts/retrieval.js";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
// Candidate cards contain no value lists, so a wider first page gives the
// model genuine source choice without exposing a full provider schema.
const searchPageSize = z.number().int().min(1).max(30).default(30);
const valuePageSize = z.number().int().min(1).max(100).default(5);
const candidateCardLimit = 10;
const providerId = z.enum(["statfin", "traficom", "vero", "vero-web", "visitfinland", "kototietokanta", "luke", "etk", "helsinki"]).describe("Publisher IDs from the available provider registry. `vero` is the Finnish Tax Administration PxWeb database; `vero-web` is its official decision-table source. Choose a publisher from the plan and returned metadata; these IDs do not imply a measure or answer.");
const findAndInspectInput = z.object({
  action: z.enum(["search", "inspect", "page", "match"]),
  query: z.string().min(1).describe("For search: one to three publisher-metadata terms chosen from the plan. Candidate source cards, when present, are generated discovery hints with explicit provenance—not official claims, evidence, or source authorization. Verify every choice against the live inspected schema. Omit on other actions.").optional(),
  provider_id: providerId.describe("Choose the publisher from the plan before searching; omit only if the plan genuinely does not identify a suitable publisher. Never send an empty string.").optional(),
  resource_id: z.string().min(1).describe("For inspect only: a known publisher resource path, paired with provider_id. This lets a caller inspect a source whose catalog entry is not currently discoverable.").optional(),
  candidate_id: z.string().min(1).optional(), source_ref: z.string().min(1).optional(), dimension_id: z.string().min(1).optional(), value_text: z.string().min(1).describe("Exact provider schema value ID or exact label for one already selected dimension; this performs exact membership lookup, not substring or concept matching.").optional(), value_texts: z.array(z.string().min(1)).min(1).max(50).describe("Exact provider schema value IDs or exact labels for one already selected dimension; each lookup uses exact membership.").optional(), cursor: z.string().min(1).optional(),
  limit: searchPageSize.describe("For search only: maximum candidate cards. It does not increase schema samples."),
  value_limit: valuePageSize.describe("For inspect, page, or match only: maximum 100 value tuples. Use a larger page when complete comparable-dimension coverage requires every schema value. Defaults to 5."),
});
const retrieveInput = z.object({ id: z.string().min(1), request_id: z.string().min(1), source_ref: z.string().min(1), selection: sourceBindingSchema.shape.selection, interpretation: sourceBindingSchema.shape.interpretation, expected_coverage: sourceBindingSchema.shape.expected_coverage, evidence_id: z.string().min(1), preview_limit: z.number().int().min(1).max(50).default(20), cursor: z.string().min(1).optional(), page_size: z.number().int().min(1).max(50).default(50) });
// Keep this a Zod object, rather than a top-level union: the MCP SDK publishes
// object fields to JSON Schema, whereas a top-level discriminated union was
// emitted as `{}` and left agents unable to call the tool at all.
const answerInput = z.object({
  action: z.enum(["calculate", "finalize", "needs_clarification", "cannot_complete"]).describe("Use the workflow's allowed_next_actions. cannot_complete becomes available only after a source-schema inspection attempt or two distinct discovery queries return no candidates; needs_clarification remains available when genuine ambiguity remains."),
  evidence_id: z.string().min(1).optional(),
  sql: z.string().min(1).max(12_000).optional(),
  purpose: z.string().min(1).max(1_000).optional(),
  assessments: z.array(evidenceAssessmentSchema).optional(),
  claims: z.array(answerClaimSchema).min(1).optional(),
  clarification_questions: z.array(z.string().min(1).max(500)).min(1).max(5).optional(),
  missing_scope: z.array(z.enum(["measure", "geography", "population_or_entity", "period", "unit", "coverage", "source_availability"])).min(1).optional(),
}).superRefine((input, context) => {
  if (input.action === "calculate") {
    if (!input.evidence_id) context.addIssue({ code: "custom", path: ["evidence_id"], message: "Calculation requires evidence_id." });
    if (!input.sql) context.addIssue({ code: "custom", path: ["sql"], message: "Calculation requires sql." });
    if (!input.purpose) context.addIssue({ code: "custom", path: ["purpose"], message: "Calculation requires purpose." });
  } else if (input.action === "finalize") {
    if (!input.assessments) context.addIssue({ code: "custom", path: ["assessments"], message: "Finalization requires assessments." });
    if (!input.claims) context.addIssue({ code: "custom", path: ["claims"], message: "Finalization requires claims." });
  } else if (input.action === "needs_clarification" && !input.clarification_questions?.length) {
    context.addIssue({ code: "custom", path: ["clarification_questions"], message: "Clarification outcomes require one or more questions." });
  } else if (input.action === "cannot_complete" && !input.missing_scope?.length) {
    context.addIssue({ code: "custom", path: ["missing_scope"], message: "Cannot-complete outcomes require structured missing-scope fields." });
  }
});
export type AnswerInput = z.infer<typeof answerInput>;
export type V2Dependencies = { createCalculations?: () => CalculationContextPort; queryEmbedding?: (query: string) => Promise<{ model: string; values: number[] } | undefined>; additionalProviders?: StatisticalProvider[]; configureProviders?: (registry: ProviderRegistry, catalog: CatalogPort) => void; includeHelsinki?: boolean; enabledProviders?: string[]; maxCells?: number; serverInfo?: { name: string; version: string } };
const contextIdSchema = z.string().uuid().describe("Opaque UUID returned by plan_request. Pass it unchanged to every subsequent tool call for this workflow.");
const findAndInspectContextInput = findAndInspectInput.extend({ context_id: contextIdSchema });
const retrieveContextInput = retrieveInput.extend({ context_id: contextIdSchema });
const answerContextInput = answerInput.extend({ context_id: contextIdSchema });

type Evidence = { binding_id: string; provider_id: string; dataset_id: string; resource_id: string; rows: Array<Record<string, string | number | null>>; source_url: string; retrieved_at: string; selected_measure: ReturnType<typeof selectedMeasureMetadata>; selected_dimension_values: Array<{ dimension_id: string; values: Array<{ id: string; label: string }> }> };
type V2AuditEvidence = AuditEvidence & { evidence_id?: string; table_id: string; table_path: string; citation_url: string; headers: string[]; filters: []; selected_dimension_values: Evidence["selected_dimension_values"]; period_policy: "claim_specified" | "latest_available"; retrieved_at: string };

/** Four model-facing tools with compact, cursor-based payloads.
 * It preserves model-led source/value selection while keeping full schemas and
 * evidence server-side for membership and provenance validation. */
export class RetrievalV2Session {
  private readonly catalog: CatalogPort;
  private readonly providers: ProviderRegistry;
  private readonly calculations: CalculationContextPort;
  private plan: z.infer<typeof intentPlanSchema> | undefined;
  private readonly schemas = new Map<string, ProviderSchema>();
  private readonly candidates = new Map<string, { provider_id: string; dataset_id: string; resource_id: string }>();
  private readonly sourceRefs = new Map<string, ProviderSchema>();
  private readonly bindings = new Map<string, z.infer<typeof sourceBindingSchema>>();
  private readonly evidence = new Map<string, Evidence>();
  private readonly calculationsById = new Map<string, string>();
  private readonly calculationResults = new Map<string, Calculation>();
  private stage: "unplanned" | "ready" | "candidates" | "inspected" | "matched" | "retrieved" | "calculated" | "finalized" = "unplanned";
  private candidateCount = 0;
  private sourceCount = 0;
  private inspectionAttempts = 0;
  private hasUninspectedCandidate = false;
  private readonly emptySearchQueries = new Set<string>();

  constructor(catalog: CatalogPort, private readonly currentDate = new Date().toISOString().slice(0, 10), private readonly dependencies: V2Dependencies = {}) {
    this.catalog = catalog;
    this.providers = new ProviderRegistry(catalog, dependencies.additionalProviders, { includeHelsinki: dependencies.includeHelsinki, maxCells: dependencies.maxCells });
    dependencies.configureProviders?.(this.providers, catalog);
    if (dependencies.enabledProviders) this.providers.setEnabled(dependencies.enabledProviders);
    this.calculations = dependencies.createCalculations?.() ?? new CalculationContext({ load() { throw new Error("No SQL engine was configured."); }, query() { throw new Error("No SQL engine was configured."); }, close() {} });
  }
  close() { this.calculations.close(); }
  hasRequest(requestId: string) { return Boolean(this.plan?.requests.some((request) => request.id === requestId)); }
  sourceSchema(sourceRef: string) { return this.sourceRefs.get(sourceRef); }
  evidenceFor(evidenceId: string) { return this.evidence.get(evidenceId); }
  private requirePlan() { return this.plan ? undefined : { error: { code: "intent_plan_required", message: "Call plan_request first." } }; }
  private schemaKey(providerId: string, resourceId: string) { return `${providerId}:${resourceId}`; }
  private rememberCandidate(candidate: { provider_id: string; dataset_id: string; resource_id: string }) { const id = `candidate_${++this.candidateCount}`; this.candidates.set(id, candidate); return id; }
  private rememberSource(schema: ProviderSchema) { const id = `source_${++this.sourceCount}`; this.sourceRefs.set(id, schema); return id; }
  private canDeclareCannotComplete() { return !this.hasUninspectedCandidate && (this.inspectionAttempts > 0 || this.emptySearchQueries.size >= 2); }
  private allowedNextActions() {
    const terminalOutcomes = ["answer_with_evidence.needs_clarification", ...(this.canDeclareCannotComplete() ? ["answer_with_evidence.cannot_complete"] : [])];
    if (this.stage === "ready") return ["find_and_inspect.search", "find_and_inspect.inspect", ...terminalOutcomes];
    if (this.stage === "candidates") return ["find_and_inspect.search", "find_and_inspect.inspect", ...terminalOutcomes];
    if (["inspected", "matched", "retrieved", "calculated"].includes(this.stage)) return ["find_and_inspect.search", "find_and_inspect.inspect", "find_and_inspect.match", "find_and_inspect.page", "retrieve", "answer_with_evidence.calculate", "answer_with_evidence.finalize", ...terminalOutcomes];
    return [];
  }
  private withWorkflow<T extends Record<string, unknown>>(value: T) { return { ...value, workflow: { stage: this.stage, allowed_next_actions: this.allowedNextActions() } }; }
  private actionNotAllowed(action: string) { return { error: { code: "workflow_action_not_allowed", stage: this.stage, action, allowed_next_actions: this.allowedNextActions() } }; }

  planRequest(input: unknown, currentDate = this.currentDate) {
    const planInput = input as Record<string, unknown>;
    const parsed = intentPlanSchema.safeParse({ ...planInput, current_date: planInput.current_date ?? currentDate });
    if (!parsed.success) return { error: { code: "invalid_intent_plan", issues: parsed.error.issues.map(({ path, code, message }) => ({ path, code, message })) } };
    this.plan = parsed.data;
    this.stage = "ready";
    return this.withWorkflow({ accepted: true, plan: this.plan });
  }
  async findAndInspect(input: z.infer<typeof findAndInspectInput>) {
    const missing = this.requirePlan(); if (missing) return missing;
    if (input.action === "search") {
      const discoveryAllowed = this.stage === "ready" || ["candidates", "inspected", "matched", "retrieved", "calculated"].includes(this.stage);
      if (!discoveryAllowed) return this.actionNotAllowed("find_and_inspect.search");
      if (!input.query) return { error: { code: "query_required" } };
      const normalizedQuery = input.query.trim().toLocaleLowerCase();
      const embedding = await this.dependencies.queryEmbedding?.(input.query);
      if (!input.provider_id) {
        let indexed: Awaited<ReturnType<CatalogPort["searchSummaries"]>>;
        try { indexed = await this.catalog.searchSummaries(input.query, input.limit, embedding); }
        catch (error) {
          this.stage = "ready";
          return this.withWorkflow({ error: { code: "registry_unavailable", message: error instanceof Error ? error.message : "The catalog and publisher search endpoints are unavailable. Ask the user for a publisher table path or retry later." } });
        }
        if (indexed.length) {
          this.stage = "candidates";
          this.hasUninspectedCandidate = true;
          const candidateCards = indexed.map((candidate) => ({ candidate_id: this.rememberCandidate(candidate), ...candidate }));
          return this.withWorkflow({ candidate_tuple: ["candidate_id", "title"], candidates: candidateCards.map((candidate) => [candidate.candidate_id, candidate.title]), candidate_cards: candidateCards.slice(0, candidateCardLimit) });
        }
      }
      const providers = input.provider_id ? [this.providers.get(input.provider_id)] : this.providers.all();
      let candidates: SourceCandidate[];
      try { candidates = (await Promise.all(providers.map((provider) => provider.discover({ query: input.query!, limit: input.limit, embedding })))).flat().slice(0, input.limit); }
      catch (error) {
        this.stage = "ready";
        return this.withWorkflow({ error: { code: "registry_unavailable", message: error instanceof Error ? error.message : "The catalog and publisher search endpoints are unavailable. Ask the user for a publisher table path or retry later." } });
      }
      // Full value lists stay behind inspect/page; candidate cards carry only
      // bounded official metadata and generated discovery hints.
      if (!candidates.length) { this.emptySearchQueries.add(normalizedQuery); this.stage = "ready"; return this.withWorkflow({ error: { code: "discovery_empty", message: "No source candidates were returned. Reformulate the publisher-metadata query and search again." }, candidates: [] }); }
      this.stage = "candidates";
      this.hasUninspectedCandidate = true;
      const candidateCards = await Promise.all(candidates.map(async (candidate) => {
        const resource = await this.catalog.resource(candidate.provider_id, candidate.resource_id);
        return {
          candidate_id: this.rememberCandidate(candidate), provider_id: candidate.provider_id, dataset_id: candidate.dataset_id, resource_id: candidate.resource_id, title: candidate.title,
          ...(resource?.description ?? candidate.description ? { description: resource?.description ?? candidate.description } : {}),
          ...(resource?.language ? { language: resource.language } : {}),
          ...(resource?.availability ? { availability: resource.availability } : {}),
          source_card: await this.catalog.sourceCard(candidate.provider_id, candidate.resource_id),
          coverage: resource?.coverage ?? candidate.coverage,
          access: resource ? { provider: resource.provider_id, ...resource.query_capability } : candidate.access,
          dimensions: resource ? resource.dimensions.map((dimension) => ({ id: dimension.id, label: dimension.label, ...(dimension.definition ? { definition: dimension.definition } : {}), ...(dimension.metadata ? { metadata: dimension.metadata } : {}), role: dimension.role, value_count: dimension.values.length, value_samples: dimension.values.slice(0, 3).map((value) => ({ id: value.id, label: value.label, ...(value.unit ? { unit: value.unit } : {}), ...(value.definition ? { definition: value.definition } : {}) })) })) : candidate.dimensions,
        };
      }));
      return this.withWorkflow({ candidate_tuple: ["candidate_id", "title"], candidates: candidateCards.map((candidate) => [candidate.candidate_id, candidate.title]), candidate_cards: candidateCards.slice(0, candidateCardLimit) });
    }
    const directResourceInspection = input.action === "inspect" && Boolean(input.provider_id && input.resource_id);
    if (input.action === "inspect" && !["candidates", "inspected", "matched", "retrieved", "calculated"].includes(this.stage) && !(this.stage === "ready" && directResourceInspection)) return this.actionNotAllowed("find_and_inspect.inspect");
    if (["page", "match"].includes(input.action) && !["inspected", "matched", "retrieved", "calculated"].includes(this.stage)) return this.actionNotAllowed(`find_and_inspect.${input.action}`);
    const selected = input.action === "inspect"
      ? (this.candidates.get(input.candidate_id ?? "") ?? (input.provider_id && input.resource_id ? { provider_id: input.provider_id, resource_id: input.resource_id, dataset_id: input.resource_id.split("/").at(-1) ?? input.resource_id } : undefined))
      : this.sourceRefs.get(input.source_ref ?? "");
    if (!selected) return { error: { code: input.action === "inspect" ? "candidate_required" : "source_ref_required" } };
    if (input.action === "inspect") {
      this.inspectionAttempts += 1;
      this.hasUninspectedCandidate = false;
    }
    let schema = this.schemas.get(this.schemaKey(selected.provider_id, selected.resource_id));
    if (!schema) {
      try {
        schema = await this.providers.get(selected.provider_id).getSchema({ resource_id: selected.resource_id });
        this.schemas.set(this.schemaKey(selected.provider_id, selected.resource_id), schema);
      } catch (error) {
        // An upstream table can disappear or be moved after a catalogue
        // snapshot. Return a normal, actionable tool result so the model can
        // choose another candidate; do not lose the workflow on a transport
        // exception.
        return this.withWorkflow({ error: { code: "schema_request_failed", candidate_id: input.candidate_id, message: error instanceof Error ? error.message : String(error) } });
      }
    }
    const sourceRef = input.action === "inspect" ? this.rememberSource(schema) : input.source_ref!;
    const valueLimit = input.value_limit;
    const values = (items: ProviderSchema["dimensions"][number]["values"]) => items.slice(0, valueLimit).map(({ id, label, unit, definition }) => [id, label, unit ?? null, definition ?? null]);
    if (input.action === "inspect") {
      this.stage = "inspected";
      return this.withWorkflow({
        source_ref: sourceRef, provider_id: schema.provider_id, dataset_id: schema.dataset_id,
        value_tuple: ["id", "label", "unit", "definition"],
        dimensions: schema.dimensions.map((dimension) => ({ id: dimension.id, label: dimension.label, role: dimension.role, ...(dimension.definition ? { definition: dimension.definition } : {}), ...(dimension.metadata ? { metadata: dimension.metadata } : {}), value_count: dimension.values.length, values: values(dimension.values), ...(dimension.values.length > valueLimit ? { next_cursor: `${dimension.id}:0` } : {}) })),
        provenance: schema.provenance,
      });
    }
    if (!input.dimension_id) return { error: { code: "dimension_required" } };
    const dimension = schema.dimensions.find((item) => item.id === input.dimension_id);
    if (!dimension) return { error: { code: "unknown_dimension", dimension_id: input.dimension_id } };
    if (input.action === "match") {
      const requestedTexts = input.value_texts ?? (input.value_text ? [input.value_text] : []);
      if (!requestedTexts.length) return { error: { code: "value_text_required" } };
      // Resolve only exact IDs or labels from the already selected provider
      // dimension. The model still chooses among the returned schema values.
      this.stage = "matched";
      return this.withWorkflow({
        source_ref: sourceRef, value_tuple: ["id", "label", "unit", "definition"], match_tuple: ["text", "values"],
        dimension: { id: dimension.id, label: dimension.label, role: dimension.role, value_count: dimension.values.length },
        matches: requestedTexts.map((valueText) => {
          return [valueText, values(dimension.values.filter((value) => value.id === valueText || value.label === valueText))];
        }),
      });
    }
    if (input.cursor && !input.cursor.startsWith(`${input.dimension_id}:`)) return { error: { code: "invalid_cursor" } };
    const offset = input.cursor ? Number(input.cursor.split(":")[1]) : 0;
    if (!Number.isInteger(offset) || offset < 0) return { error: { code: "invalid_cursor" } };
    const pageValues = dimension.values.slice(offset, offset + valueLimit).map(({ id, label, unit, definition }) => [id, label, unit ?? null, definition ?? null]);
    const next = offset + pageValues.length;
    this.stage = "matched";
    return this.withWorkflow({ source_ref: sourceRef, value_tuple: ["id", "label", "unit", "definition"], dimension: { id: dimension.id, label: dimension.label, role: dimension.role, value_count: dimension.values.length }, values: pageValues, ...(next < dimension.values.length ? { next_cursor: `${dimension.id}:${next}` } : {}) });
  }
  async retrieve(input: z.input<typeof retrieveInput>) {
    const missing = this.requirePlan(); if (missing) return missing;
    if (!["inspected", "matched", "retrieved", "calculated"].includes(this.stage)) return this.actionNotAllowed("retrieve");
    const { evidence_id, preview_limit = 20, cursor, page_size = 50, source_ref, ...partialBinding } = input;
    if (cursor) {
      // Evidence row cursors use the documented `<evidence_id>:<offset>` format.
      const prefix = `${evidence_id}:`;
      if (!cursor.startsWith(prefix)) return { error: { code: "invalid_cursor", evidence_id } };
      const offset = Number(cursor.slice(prefix.length));
      const retained = this.evidence.get(evidence_id);
      if (!Number.isInteger(offset) || offset < 0 || !retained || offset >= retained.rows.length) return { error: { code: "invalid_cursor", evidence_id } };
      const columns = retained.rows[0] ? Object.keys(retained.rows[0]) : [];
      const rows = retained.rows.slice(offset, offset + page_size);
      const nextOffset = offset + rows.length;
      return this.withWorkflow({ evidence_id, binding_id: retained.binding_id, provider_id: retained.provider_id, dataset_id: retained.dataset_id, resource_id: retained.resource_id, row_count: retained.rows.length, page_offset: offset, columns, selected_measure: retained.selected_measure, preview: rows, ...(nextOffset < retained.rows.length ? { next_cursor: `${evidence_id}:${nextOffset}` } : {}) });
    }
    const schema = this.sourceRefs.get(source_ref);
    if (!schema) return { error: { code: "source_ref_required", source_ref } };
    const binding = { ...partialBinding, provider_id: schema.provider_id, dataset_id: schema.dataset_id, resource_id: schema.resource_id };
    if (!this.plan!.requests.some((request) => request.id === binding.request_id)) return { error: { code: "unknown_request_id", request_id: binding.request_id } };
    const feedback = bindingFeedback(binding, schema); if (feedback) return { error: feedback };
    this.bindings.set(binding.id, binding);
    const selections = [binding.selection.measure, ...binding.selection.dimensions].map((selection) => ({ dimension_id: selection.dimension_id, value_ids: selection.value_ids }));
    let result: z.infer<typeof providerQueryResultSchema>;
    try {
      result = providerQueryResultSchema.parse(await this.providers.get(binding.provider_id).query({ resource_id: binding.resource_id, selections }));
    } catch (error) {
      // Keep an unavailable/moved upstream table recoverable in-band. The
      // model remains responsible for choosing the next source.
      return this.withWorkflow({ error: { code: "query_request_failed", provider_id: binding.provider_id, resource_id: binding.resource_id, message: error instanceof Error ? error.message : String(error) } });
    }
    const columns = result.rows[0] ? Object.keys(result.rows[0]) : [];
    this.stage = "retrieved";
    const selectedMeasure = selectedMeasureMetadata(binding, schema);
    const selectedDimensionValues = binding.selection.dimensions.map((selection) => {
      const dimension = schema.dimensions.find((item) => item.id === selection.dimension_id)!;
      return { dimension_id: selection.dimension_id, values: dimension.values.filter((value) => selection.value_ids.includes(value.id)).map(({ id, label }) => ({ id, label })) };
    });
    this.evidence.set(evidence_id, { binding_id: binding.id, provider_id: binding.provider_id, dataset_id: binding.dataset_id, resource_id: binding.resource_id, rows: result.rows, source_url: result.source_url, retrieved_at: result.retrieved_at, selected_measure: selectedMeasure, selected_dimension_values: selectedDimensionValues });
    return this.withWorkflow({ evidence_id, binding_id: binding.id, provider_id: binding.provider_id, dataset_id: binding.dataset_id, resource_id: binding.resource_id, row_count: result.rows.length, columns, selected_measure: selectedMeasure, selected_dimensions: binding.selection.dimensions, selected_dimension_values: selectedDimensionValues, provenance: { source_url: result.source_url, retrieved_at: result.retrieved_at }, preview: result.rows.slice(0, preview_limit), ...(result.rows.length > preview_limit ? { next_cursor: `${evidence_id}:${preview_limit}` } : {}) });
  }
  answerWithEvidence(input: AnswerInput) {
    const missing = this.requirePlan(); if (missing) return missing;
    if (this.stage === "finalized") return { error: { code: "session_finalized" } };
    if (input.action === "needs_clarification") {
      this.stage = "finalized";
      return this.withWorkflow({ accepted: true, outcome: "needs_clarification", clarification_questions: input.clarification_questions, rendered_answer: `I need clarification: ${input.clarification_questions!.join(" ")}`, numeric_audit: { status: "not_applicable", claim_results: [] } });
    }
    if (input.action === "cannot_complete") {
      if (!this.canDeclareCannotComplete()) return this.actionNotAllowed("answer_with_evidence.cannot_complete");
      this.stage = "finalized";
      return this.withWorkflow({ accepted: true, outcome: "cannot_complete", missing_scope: input.missing_scope, rendered_answer: `I cannot complete the planned retrieval. Missing scope: ${input.missing_scope!.join(", ")}.`, numeric_audit: { status: "not_applicable", claim_results: [] } });
    }
    if (!["retrieved", "calculated"].includes(this.stage)) return this.actionNotAllowed(`answer_with_evidence.${input.action}`);
    if (input.action === "calculate") {
      const calculation = z.object({ evidence_id: z.string().min(1), sql: z.string().min(1).max(12_000), purpose: z.string().min(1).max(1_000) }).parse(input);
      const evidence = this.evidence.get(calculation.evidence_id); if (!evidence) return { error: { code: "evidence_required", evidence_id: calculation.evidence_id } };
      let source: ReturnType<CalculationContext["addSource"]> | undefined;
      try { source = this.calculations.addSource(evidence.rows); const result = this.calculations.calculate(calculation.sql.replaceAll("{{source}}", source.relation), calculation.purpose); this.calculationsById.set(result.id, calculation.evidence_id); this.calculationResults.set(result.id, result); this.stage = "calculated"; return this.withWorkflow({ ...result, evidence_id: calculation.evidence_id, source }); }
      catch (error) { return { error: calculationFeedback(error), evidence_id: calculation.evidence_id, ...(source ? { source, sql_template: "SELECT … FROM {{source}}" } : {}) }; }
    }
    const finalized = z.object({ assessments: z.array(evidenceAssessmentSchema), claims: z.array(answerClaimSchema).min(1) }).parse(input);
    const assessments = finalized.assessments;
    for (const assessment of assessments) {
      const consistency = assessmentFeedback(assessment); if (consistency) return { error: consistency };
      if (!this.plan!.requests.some((request) => request.id === assessment.request_id)) return { error: { code: "unknown_request_id", request_id: assessment.request_id } };
      const bindings = assessment.binding_ids.map((id) => this.bindings.get(id));
      if (bindings.some((binding) => !binding)) return { error: { code: "unknown_binding", binding_ids: assessment.binding_ids.filter((id) => !this.bindings.has(id)) } };
      if (bindings.some((binding) => binding!.request_id !== assessment.request_id)) return { error: { code: "assessment_binding_request_mismatch", request_id: assessment.request_id } };
      if (assessment.binding_ids.some((id) => ![...this.evidence.values()].some((item) => item.binding_id === id))) return { error: { code: "assessment_evidence_required", binding_ids: assessment.binding_ids } };
      const hasProxy = bindings.some((binding) => binding!.interpretation.proxy);
      if (hasProxy && assessment.allowed_for_final_answer && assessment.status !== "proxy") return { error: { code: "proxy_status_required", binding_ids: assessment.binding_ids } };
      if (assessment.status === "proxy" && !this.plan!.proxy_policy.allowed) return { error: { code: "proxy_forbidden_by_plan", request_id: assessment.request_id } };
    }
    const required = this.plan!.requests.filter((request) => request.required && !assessments.some((assessment) => assessment.request_id === request.id)).map((request) => request.id);
    if (required.length) return { error: { code: "required_assessments_missing", request_ids: required } };
    const requiresCalculation = this.plan!.operation.required_calculation && finalized.claims.some((claim) => claim.kind !== "limitation") && !finalized.claims.some((claim) => claim.evidence_refs.some((ref) => ref.calculation_id));
    if (requiresCalculation) return { error: { code: "operation_calculation_required", operation: this.plan!.operation.kind } };
    const mismatchedCalculations = finalized.claims.flatMap((claim) => claim.evidence_refs.filter((ref) => ref.calculation_id && this.calculationsById.get(ref.calculation_id) !== ref.evidence_id).map((ref) => ({ claim_id: claim.id, calculation_id: ref.calculation_id, evidence_id: ref.evidence_id })));
    if (mismatchedCalculations.length) return { error: { code: "calculation_evidence_mismatch", references: mismatchedCalculations } };
    const evidenceBindings = new Map([...this.evidence.entries()].map(([id, item]) => [id, item.binding_id]));
    const feedback = claimFeedback(finalized.claims, assessments, new Set(this.evidence.keys()), new Set(this.calculationsById.keys()), evidenceBindings);
    if (feedback) return { error: feedback };
    const evidenceForAudit: V2AuditEvidence[] = [...this.evidence.entries()].map(([evidenceId, item]) => ({ evidence_id: evidenceId, table_id: item.binding_id, table_path: item.source_url, citation_url: item.source_url, headers: Object.keys(item.rows[0] ?? {}), rows: item.rows.map((row) => Object.values(row).map((value) => String(value ?? ""))), row_count: item.rows.length, filters: [], selected_dimension_values: item.selected_dimension_values, period_policy: this.plan!.scope.period.selection === "specified" ? "claim_specified" : "latest_available", retrieved_at: item.retrieved_at }));
    const unsupportedClaims = finalized.claims.flatMap((claim) => {
      const references = new Map(claim.evidence_refs.map((reference) => [reference.evidence_id, reference]));
      const linkedEvidence = [...this.evidence.entries()].filter(([evidenceId]) => references.has(evidenceId));
      const auditEvidence = evidenceForAudit.filter((item) => references.has(item.evidence_id ?? ""));
      const linkedCalculations = [...references.values()].flatMap((reference) => reference.calculation_id ? [this.calculationResults.get(reference.calculation_id)].filter((item): item is Calculation => Boolean(item)) : []);
      const structuredLabels = linkedEvidence.flatMap(([, item]) => [
        ...item.selected_measure.values.flatMap((value) => [value.id, value.label, value.unit, value.definition].filter((text): text is string => typeof text === "string")),
        ...item.selected_dimension_values.flatMap((dimension) => [dimension.dimension_id, ...dimension.values.flatMap((value) => [value.id, value.label])]),
      ]);
      const numbers = unauditedAnswerNumbers(claim.text, auditEvidence, linkedCalculations, structuredLabels);
      return numbers.length ? [{ claim_id: claim.id, numbers }] : [];
    });
    if (unsupportedClaims.length) return { error: { code: "claim_unsupported_numbers", claims: unsupportedClaims, message: "Claim numbers must appear in cited retrieved rows, selected schema values, or a linked calculation result. The current date is planning context, not evidence for a statistical observation." } };
    this.stage = "finalized";
    return this.withWorkflow({ accepted: true, claims: finalized.claims, rendered_answer: renderAnswerClaims(finalized.claims), numeric_audit: { status: "passed", claim_results: finalized.claims.map((claim) => ({ claim_id: claim.id, evidence_ids: [...new Set(claim.evidence_refs.map((reference) => reference.evidence_id))], calculation_ids: [...new Set(claim.evidence_refs.flatMap((reference) => reference.calculation_id ? [reference.calculation_id] : []))], status: "passed" })) } });
  }
}

type RetrievalContext = { principalId?: string; session: RetrievalV2Session; releaseCatalog?: () => void; idleTimer?: ReturnType<typeof setTimeout> };

/** Workflow state keyed by an explicit model-carried context handle, independent of MCP transport sessions. */
export class RetrievalV2ContextStore {
  private readonly contexts = new Map<string, RetrievalContext>();
  constructor(private readonly idleTimeoutMs = 30 * 60 * 1_000) {}
  private expire(contextId: string, context: RetrievalContext) {
    if (context.idleTimer) clearTimeout(context.idleTimer);
    this.contexts.delete(contextId);
    context.session.close();
    context.releaseCatalog?.();
  }
  private refresh(contextId: string, context: RetrievalContext) {
    if (context.idleTimer) clearTimeout(context.idleTimer);
    context.idleTimer = setTimeout(() => this.expire(contextId, context), this.idleTimeoutMs);
    context.idleTimer.unref?.();
  }
  create(catalog: CatalogPort, input: unknown, currentDate?: string, principalId?: string, retainCatalog?: () => () => void, dependencies?: V2Dependencies) {
    const session = new RetrievalV2Session(catalog, currentDate, dependencies);
    const planned = session.planRequest(input);
    if (!("accepted" in planned) || planned.accepted !== true) {
      session.close();
      return planned;
    }
    const contextId = randomUUID();
    const context: RetrievalContext = { principalId, session, releaseCatalog: retainCatalog?.() };
    this.contexts.set(contextId, context);
    this.refresh(contextId, context);
    return { ...planned, context_id: contextId };
  }
  get(contextId: string, principalId?: string): RetrievalV2Session | undefined {
    const context = this.contexts.get(contextId);
    if (!context || context.principalId !== principalId) return undefined;
    this.refresh(contextId, context);
    return context.session;
  }
  close() { for (const [contextId, context] of this.contexts) this.expire(contextId, context); }
}

export type McpV2ServerOptions = { contexts?: RetrievalV2ContextStore; principalId?: string; retainCatalog?: () => () => void; dependencies?: V2Dependencies };
export function createMcpV2Server(catalog: CatalogPort, currentDate?: string, options: McpV2ServerOptions = {}) {
  const serverInfo = options.dependencies?.serverInfo ?? { name: "AgentFinland", version: "2.0.0" };
  const server = new McpServer(serverInfo);
  const contexts = options.contexts ?? new RetrievalV2ContextStore();
  const ownsContexts = !options.contexts;
  let sessionClosed = false;
  server.server.onclose = () => {
    if (sessionClosed) return;
    sessionClosed = true;
    if (ownsContexts) contexts.close();
  };
  server.registerTool("plan_request", { title: "Plan a statistics request", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }, description: "Record the model's source-independent statistical intent and completion requirements. Include the client's current ISO date when available; otherwise the server records its current date in the accepted plan. Resolve relative periods against that supplied or returned date. Comparison, change, and ratio operations require at least two structured endpoints; rankings require an explicit ranking basis. Invalid cross-field combinations return structured issues for correction. On success, retain the returned context_id and pass it unchanged to each later tool call in this workflow.", inputSchema: intentPlanBaseSchema }, async (input) => text(contexts.create(catalog, input, currentDate, options.principalId, options.retainCatalog, options.dependencies)));
  server.registerTool("find_and_inspect", { title: "Find and inspect official sources", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }, description: "Search official sources, inspect a selected source compactly, page a selected dimension, or exactly look up schema value IDs or labels in one selected official dimension. Pass the context_id returned by plan_request. The model chooses every action, publisher, candidate, dimension, exact value, and cursor; large values stay paginated. Exact lookup checks schema membership only; it does not perform substring, synonym, translation, or concept matching. If a value is not known exactly, page the returned schema values and choose from them. Search uses lexical metadata/card matches and available source-card embeddings for candidate recall; embeddings do not select or validate a source. Review each bounded candidate card's official language, availability, access.queryable, dimension definitions, value samples, and generated source_card. A source card is a discovery hint with provenance, not official evidence or source authorization; confirm all semantic choices against the live inspected schema. This is discovery, not semantic source selection: choose the publisher from the plan and formulate a concise query using the candidate metadata's declared language. The Finnish Tax Administration has separate `vero` PxWeb and `vero-web` official decision-table providers. A nonempty candidate list does not mean it matches the plan. Do not use a candidate whose title/schema is for a related but different statistic; reformulate and search the same provider again. Start with one concise metadata term and limit 30; add a second term only to disambiguate. Search returns `candidate_tuple` field order `[candidate_id, title]`; inspect a returned candidate ID to see its dimensions. Search may be repeated at any later workflow stage to refine candidates. Then use only the returned source_ref for page, match, and retrieve. Inspection returns at most five value tuples per dimension by default; `value_tuple` declares their field order `[id, label, unit, definition]`. For several exact values in one dimension, send `value_texts` once (rather than separate match calls); `match_tuple` is `[text, values]`. Use `value_limit: 100` when all values of a large comparable dimension are needed, then continue with the returned cursor. Before retrieval, verify the inspected schema has the exact requested geography/entity and measure; if it does not, inspect another candidate. When no current candidate has the exact geography, reformulate the metadata query around the model-selected official statistic and geography level rather than retrieving a merely contextual source. Do not send blank optional fields or invent IDs. Follow workflow.allowed_next_actions.", inputSchema: findAndInspectContextInput }, async (input) => { const session = contexts.get(input.context_id, options.principalId); if (!session) return text({ error: { code: "context_not_found", message: "The workflow context was not found or is unavailable to this client." } }); const { context_id: _contextId, ...args } = input; return text(await session.findAndInspect(args)); });
  server.registerTool("retrieve", { title: "Retrieve selected statistics", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }, description: "Pass the context_id returned by plan_request. Validate model-selected schema IDs, query one source, retain full official evidence server-side, and return a bounded provenance receipt. If the receipt has next_cursor, repeat retrieve with the same selected binding and evidence_id plus that cursor to read the next bounded row page; page_size is at most 50. Cursors are for the exact evidence_id returned by the initial query.", inputSchema: retrieveContextInput }, async (input) => { const session = contexts.get(input.context_id, options.principalId); if (!session) return text({ error: { code: "context_not_found", message: "The workflow context was not found or is unavailable to this client." } }); const { context_id: _contextId, ...args } = input; return text(await session.retrieve(args)); });
  server.registerTool("answer_with_evidence", { title: "Answer with evidence", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }, description: "Pass the context_id returned by plan_request. Run server-side arithmetic, finalize evidence-linked answer claims, request clarification, or state that a request cannot be completed. For needs_clarification, provide structured clarification_questions; for cannot_complete, provide structured missing_scope. Use action=calculate for every derived numeric relationship (including differences, rates, shares, percentage changes, totals, or category counts); write one read-only SQL SELECT and use {{source}} exactly where the retrieved evidence relation belongs. Use only source.columns returned by a prior calculation response or the retrieved row headers. For action=finalize, submit assessments and claims after all required evidence/calculations are ready. The model decides which criteria are unmet from the retrieval plan and returned evidence; the assessment schema records coverage and source_availability gaps explicitly. If a request assessment has status proxy, every direct or derived claim for that request must be accompanied by a proxy_disclosure claim for the same request that cites the same evidence_id; describe the narrower measure or scope in the disclosure. A proxy_disclosure_required error returns the affected claim, request, and evidence IDs; repair it with those structured values without changing the assessment or bypassing other validation. Numeric claims not supported by each claim's cited rows, selected schema values, or linked calculation return claim_unsupported_numbers for correction; the current date is planning context, not evidence for an observation. If evidence is a narrower subtotal or the latest available period is older than requested, include its actual figure in an evidence-linked limitation claim, name its period, and state precisely what it excludes or why it is not the requested period; do not discard verified useful evidence. The model decides calculations, completeness, caveats, and claim text; the runtime checks provenance.", inputSchema: answerContextInput }, async (input) => { const session = contexts.get(input.context_id, options.principalId); if (!session) return text({ error: { code: "context_not_found", message: "The workflow context was not found or is unavailable to this client." } }); const { context_id: _contextId, ...args } = input; return text(session.answerWithEvidence(args)); });
  return server;
}

export class McpV2SessionManager {
  private readonly contexts: RetrievalV2ContextStore;
  constructor(idleTimeoutMs = 30 * 60 * 1_000, private readonly dependencies: V2Dependencies = {}) { this.contexts = new RetrievalV2ContextStore(idleTimeoutMs); }
  async handle(request: Request, catalog: CatalogPort, principalId: string, releaseCatalog: () => void = () => undefined, retainCatalog?: () => () => void): Promise<Response> {
    const handler = createMcpHandler(() => createMcpV2Server(catalog, undefined, { contexts: this.contexts, principalId, retainCatalog, dependencies: this.dependencies }), { legacy: "stateless" });
    try {
      return await handler.fetch(request);
    } finally { releaseCatalog(); }
  }
  close() { this.contexts.close(); }
}
