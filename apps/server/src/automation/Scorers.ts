// @effect-diagnostics nodeBuiltinImport:off -- Stable SHA-256 sampling and evidence identities must agree across processes.
import { createHash } from "node:crypto";
import type { EvaluationInput, EvaluationJudgment, EvaluationResult } from "@t3tools/contracts";

export const evaluationDigest = (value: string) => createHash("sha256").update(value).digest("hex");
export function sampleEvaluation(input: EvaluationInput): boolean {
  if (input.mode === "manual") return true;
  if (!input.scorer.sampling.automatic) return false;
  const bucket = Number.parseInt(evaluationDigest(JSON.stringify([
    input.factoryId, input.runId, input.scorer.id, input.scorerRevision,
  ])).slice(0, 13), 16) / 0x10000000000000;
  return bucket < input.scorer.sampling.rate;
}
export function classifyJudgment(input: EvaluationInput, judgment: EvaluationJudgment) {
  if (judgment.modelRevision !== input.scorer.judge.model) return null;
  const criteria = new Map(judgment.criteria.map((item) => [item.id, item]));
  const evidence = new Set(input.evidence.map((item) => item.id));
  if (criteria.size !== judgment.criteria.length || criteria.size !== input.scorer.criteria.length ||
    input.scorer.criteria.some((item) => !criteria.has(item.id)) ||
    judgment.criteria.some((item) => !Number.isFinite(item.score) || item.score < 0 || item.score > 1 ||
      item.evidenceIds.length === 0 || item.evidenceIds.some((id) => !evidence.has(id)))) return null;
  return input.scorer.criteria.every((item) => criteria.get(item.id)!.score >= item.threshold);
}
export function evaluationPreflight(input: EvaluationInput): Pick<EvaluationResult, "status" | "reason"> | null {
  if (!sampleEvaluation(input)) return { status: "skipped", reason: "not_sampled" };
  if (input.evidence.length === 0 || new Set(input.evidence.map((item) => item.id)).size !== input.evidence.length ||
    input.evidence.some((item) => evaluationDigest(item.content) !== item.sha256))
    return { status: "incomplete", reason: "missing_evidence" };
  return null;
}
