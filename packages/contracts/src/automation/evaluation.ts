import * as Schema from "effect/Schema";
import { FactoryV4Scorer } from "./scorer.ts";

const Key = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const EvaluationEvidence = Schema.Struct({
  id: Key,
  sha256: Hash,
  source: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
  content: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
});
export type EvaluationEvidence = typeof EvaluationEvidence.Type;
export const EvaluationInput = Schema.Struct({
  id: Key,
  factoryId: Key,
  runId: Key,
  definitionRevision: Key,
  runRevision: Key,
  definitionSource: Schema.Json,
  modelConfiguration: Schema.Json,
  scorerRevision: Hash,
  scorerSource: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
  scorer: FactoryV4Scorer,
  evidence: Schema.Array(EvaluationEvidence).check(Schema.isMaxLength(100)),
  mode: Schema.Literals(["manual", "automatic"]),
});
export type EvaluationInput = typeof EvaluationInput.Type;
export const EvaluationJudgment = Schema.Struct({
  criteria: Schema.Array(Schema.Struct({
    id: Key,
    score: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    rationale: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
    evidenceIds: Schema.Array(Key).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  })).check(Schema.isMaxLength(100)),
  modelRevision: Key,
});
export type EvaluationJudgment = typeof EvaluationJudgment.Type;
export const EvaluationResult = Schema.Struct({
  input: EvaluationInput,
  status: Schema.Literals(["completed", "incomplete", "failed", "skipped"]),
  reason: Schema.NullOr(Schema.Literals(["missing_evidence", "invalid_judgment", "judge_unavailable", "not_sampled"])),
  judgment: Schema.NullOr(EvaluationJudgment),
  passed: Schema.NullOr(Schema.Boolean),
  recordedAt: Schema.String,
});
export type EvaluationResult = typeof EvaluationResult.Type;

export const RequestEvaluation = Schema.Struct({
  id: EvaluationInput.fields.id,
  factoryId: EvaluationInput.fields.factoryId,
  runId: EvaluationInput.fields.runId,
  scorerFactoryId: EvaluationInput.fields.factoryId,
  scorerVersionId: EvaluationInput.fields.definitionRevision,
  scorerId: FactoryV4Scorer.fields.id,
});
export type RequestEvaluation = typeof RequestEvaluation.Type;

export const EvaluationSummary = Schema.Struct({
  id: EvaluationInput.fields.id,
  factoryId: EvaluationInput.fields.factoryId,
  runId: EvaluationInput.fields.runId,
  scorerId: FactoryV4Scorer.fields.id,
  scorerRevision: EvaluationInput.fields.scorerRevision,
  definitionRevision: EvaluationInput.fields.definitionRevision,
  status: EvaluationResult.fields.status,
  reason: EvaluationResult.fields.reason,
  passed: EvaluationResult.fields.passed,
  recordedAt: EvaluationResult.fields.recordedAt,
});
export type EvaluationSummary = typeof EvaluationSummary.Type;
