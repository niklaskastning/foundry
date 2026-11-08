import * as ThreadArchive from "../foundry/ThreadArchive.ts";
import { collectEvaluationEvidence } from "./EvaluationEvidence.ts";
// @effect-diagnostics nodeBuiltinImport:off -- Random claim tokens fence asynchronous judge completion.
import * as NodeCrypto from "node:crypto";
import {
  EvaluationInput,
  EvaluationJudgment,
  EvaluationResult,
  EvaluationSummary,
  FactoryV4Scorer,
  RequestEvaluation,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as AutomationDatabase from "./AutomationDatabase.ts";
import * as EvaluationJudge from "./EvaluationJudge.ts";
import { classifyJudgment, evaluationDigest, evaluationPreflight } from "./Scorers.ts";

export class EvaluationError extends Schema.TaggedError<EvaluationError>()("EvaluationError", {
  reason: Schema.Literals(["invalid_input", "not_found", "conflict", "forbidden", "unavailable"]),
}) {}
type Identity = { readonly instanceId: string; readonly operatorId: string };
const decodeInput = Schema.decodeUnknownEffect(EvaluationInput);
const decodeResult = Schema.decodeUnknownEffect(EvaluationResult);
const isEvaluationError = Schema.is(EvaluationError);
const decodeRequest = Schema.decodeUnknownEffect(RequestEvaluation);
const decodeCatalog = Schema.decodeUnknownEffect(
  Schema.Struct({ scorers: Schema.Array(FactoryV4Scorer) }),
);
const decodeSummary = Schema.decodeUnknownEffect(EvaluationSummary);
const mapError = (error: unknown) =>
  isEvaluationError(error) ? error : new EvaluationError({ reason: "unavailable" });
export class Evaluations extends Context.Service<
  Evaluations,
  {
    readonly enqueue: (
      identity: Identity,
      input: RequestEvaluation,
      mode?: "manual" | "automatic",
    ) => Effect.Effect<string, EvaluationError>;
    readonly list: (
      identity: Identity,
      filter: { factoryId?: string; runId?: string; after?: string },
    ) => Effect.Effect<readonly EvaluationSummary[], EvaluationError>;
    readonly read: (
      identity: Identity,
      factoryId: string,
      id: string,
    ) => Effect.Effect<EvaluationResult, EvaluationError>;
    readonly tick: Effect.Effect<void, EvaluationError>;
  }
>()("t3/automation/Evaluations") {}

export const layer = Layer.effect(
  Evaluations,
  Effect.gen(function* () {
    const sql = yield* AutomationDatabase.AutomationDatabase;
    const judge = yield* EvaluationJudge.EvaluationJudge;
    const archive = yield* ThreadArchive.ThreadArchive;
    const enqueue = Effect.fn("Evaluations.enqueue")(function* (
      identity: Identity,
      raw: RequestEvaluation,
      mode: "manual" | "automatic" = "manual",
    ) {
      const request = yield* decodeRequest(raw).pipe(
        Effect.mapError(() => new EvaluationError({ reason: "invalid_input" })),
      );
      const rows = yield* sql<{
        definitionRevision: string;
        runRevision: string;
        definitionSource: unknown;
        modelConfiguration: unknown;
        state: string;
      }>`
      SELECT r.factory_version_id AS "definitionRevision", r.revision AS "runRevision", (SELECT jsonb_build_object('contentHash',v.content_hash,'source',v.source) FROM foundry_automation.definition_versions v WHERE v.factory_id=r.factory_id AND v.factory_version_id=r.factory_version_id LIMIT 1) AS "definitionSource", d.binding->'model' AS "modelConfiguration", d.state
      FROM foundry_automation.runs r JOIN foundry_automation.dispatch_runs d ON d.run_id=r.id
      WHERE r.id=${request.runId} AND r.factory_id=${request.factoryId}
      AND d.binding->'identity'->>'instanceId'=${identity.instanceId}
      AND d.binding->'identity'->>'operatorId'=${identity.operatorId}`;
      const run = rows[0];
      if (!run) return yield* new EvaluationError({ reason: "not_found" });
      if (!["succeeded", "failed", "cancelled"].includes(run.state))
        return yield* new EvaluationError({ reason: "conflict" });
      const activeAttempts =
        yield* sql`SELECT command_id FROM foundry_automation.step_attempts WHERE run_id=${request.runId} AND state NOT IN ('succeeded','failed','cancelled') LIMIT 1`;
      if (activeAttempts.length) return yield* new EvaluationError({ reason: "conflict" });
      const definitions = yield* sql<{
        definition: unknown;
        contentHash: string;
        source: unknown;
      }>`SELECT definition,content_hash AS "contentHash",source FROM foundry_automation.definition_versions WHERE factory_id=${request.scorerFactoryId} AND id=${request.scorerVersionId}`;
      const definition = definitions[0];
      if (!definition) return yield* new EvaluationError({ reason: "not_found" });
      const catalog = yield* decodeCatalog(definition.definition).pipe(
        Effect.mapError(() => new EvaluationError({ reason: "invalid_input" })),
      );
      const scorer = catalog.scorers.find((item) => item.id === request.scorerId);
      if (!scorer) return yield* new EvaluationError({ reason: "not_found" });
      const attempts = yield* sql<{
        id: string;
        result: unknown;
        request: unknown;
        kind: string;
      }>`SELECT a.command_id AS id,a.result,a.request,COALESCE((SELECT node->'definition'->>'kind' FROM jsonb_array_elements(COALESCE(d.v4_state->'nodes','[]'::jsonb)) node WHERE node->>'ordinal'=a.ordinal::text LIMIT 1),v.steps->a.ordinal->>'kind') AS kind FROM foundry_automation.step_attempts a JOIN foundry_automation.dispatch_runs d ON d.run_id=a.run_id JOIN foundry_automation.runs r ON r.id=a.run_id JOIN foundry_automation.workflow_versions v ON v.id=r.workflow_version_id WHERE a.run_id=${request.runId} ORDER BY a.ordinal,a.attempt_number LIMIT 101`;
      const evidence = yield* collectEvaluationEvidence(identity, attempts).pipe(
        Effect.provideService(ThreadArchive.ThreadArchive, archive),
      );
      const input = yield* decodeInput({
        id: request.id,
        factoryId: request.factoryId,
        runId: request.runId,
        definitionRevision: run.definitionRevision,
        runRevision: run.runRevision,
        definitionSource: run.definitionSource ?? null,
        modelConfiguration: {
          binding: run.modelConfiguration ?? null,
          attempts: attempts.map((item) => ({
            id: item.id,
            model:
              typeof item.request === "object" && item.request !== null && "model" in item.request
                ? item.request.model
                : null,
            options:
              typeof item.request === "object" && item.request !== null && "options" in item.request
                ? item.request.options
                : null,
          })),
        },
        scorerRevision: definition.contentHash,
        scorerSource: JSON.stringify({
          factoryId: request.scorerFactoryId,
          versionId: request.scorerVersionId,
          source: definition.source,
        }),
        scorer,
        evidence,
        mode,
      });
      const automaticKey =
        mode === "automatic"
          ? evaluationDigest(
              JSON.stringify([input.factoryId, input.runId, scorer.id, input.scorerRevision]),
            )
          : null;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO foundry_automation.evaluation_queue(id,factory_id,run_id,instance_id,operator_id,input,automatic_key) VALUES(${input.id},${input.factoryId},${input.runId},${identity.instanceId},${identity.operatorId},${sql.json(input)},${automaticKey}) ON CONFLICT DO NOTHING`;
          const prior = yield* sql<{
            id: string;
            same: boolean;
          }>`SELECT id,input=${sql.json(input)}::jsonb AS same FROM foundry_automation.evaluation_queue WHERE instance_id=${identity.instanceId} AND operator_id=${identity.operatorId} AND (id=${input.id} OR (${automaticKey}::text IS NOT NULL AND automatic_key=${automaticKey}))`;
          if (!prior[0] || (mode === "manual" && !prior[0].same))
            return yield* new EvaluationError({ reason: "conflict" });
          return prior[0].id;
        }),
      );
    }, Effect.mapError(mapError));
    const list = Effect.fn("Evaluations.list")(function* (
      identity: Identity,
      filter: { factoryId?: string; runId?: string; after?: string },
    ) {
      const rows = yield* sql<{ summary: unknown }>`SELECT jsonb_build_object(
      'id',r.id,'factoryId',r.factory_id,'runId',r.run_id,
      'scorerId',r.result->'input'->'scorer'->>'id','scorerRevision',r.result->'input'->>'scorerRevision',
      'definitionRevision',r.result->'input'->>'definitionRevision','status',r.result->>'status',
      'reason',r.result->'reason','passed',r.result->'passed','recordedAt',r.result->>'recordedAt') AS summary
      FROM foundry_automation.evaluation_results r JOIN foundry_automation.evaluation_queue q ON q.id=r.id
      WHERE q.instance_id=${identity.instanceId} AND q.operator_id=${identity.operatorId}
      AND (${filter.factoryId ?? null}::text IS NULL OR r.factory_id=${filter.factoryId ?? null})
      AND (${filter.runId ?? null}::text IS NULL OR r.run_id=${filter.runId ?? null}) AND (${filter.after ?? null}::text IS NULL OR (r.recorded_at,r.id)<((SELECT recorded_at FROM foundry_automation.evaluation_results WHERE id=${filter.after ?? null}),${filter.after ?? null})) ORDER BY r.recorded_at DESC,r.id DESC LIMIT 50`;
      return yield* Effect.forEach(rows, (row) => decodeSummary(row.summary));
    }, Effect.mapError(mapError));
    const read = Effect.fn("Evaluations.read")(function* (
      identity: Identity,
      factoryId: string,
      id: string,
    ) {
      const rows = yield* sql<{
        result: unknown;
      }>`SELECT r.result FROM foundry_automation.evaluation_results r JOIN foundry_automation.evaluation_queue q ON q.id=r.id WHERE r.id=${id} AND r.factory_id=${factoryId} AND q.instance_id=${identity.instanceId} AND q.operator_id=${identity.operatorId}`;
      if (!rows[0]) return yield* new EvaluationError({ reason: "not_found" });
      return yield* decodeResult(rows[0].result);
    }, Effect.mapError(mapError));
    const tick = Effect.gen(function* () {
      const automatic = yield* sql<{
        factoryId: string;
        runId: string;
        scorerFactoryId: string;
        scorerVersionId: string;
        scorerId: string;
        instanceId: string;
        operatorId: string;
      }>`
      SELECT r.factory_id AS "factoryId",r.id AS "runId",v.factory_id AS "scorerFactoryId",v.id AS "scorerVersionId",scorer->>'id' AS "scorerId",d.binding->'identity'->>'instanceId' AS "instanceId",d.binding->'identity'->>'operatorId' AS "operatorId"
      FROM foundry_automation.runs r JOIN foundry_automation.dispatch_runs d ON d.run_id=r.id
      JOIN foundry_automation.definition_versions v ON v.factory_id=r.factory_id AND v.factory_version_id=r.factory_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(v.definition->'scorers','[]'::jsonb)) scorer
      WHERE d.state IN ('succeeded','failed','cancelled')
      AND NOT EXISTS (SELECT 1 FROM foundry_automation.step_attempts a WHERE a.run_id=r.id AND a.state NOT IN ('succeeded','failed')) AND scorer->'sampling'->>'automatic'='true'
      AND NOT EXISTS (SELECT 1 FROM foundry_automation.evaluation_queue q WHERE q.run_id=r.id AND q.input->>'scorerRevision'=v.content_hash AND q.input->'scorer'->>'id'=scorer->>'id' AND q.automatic_key IS NOT NULL)
      ORDER BY r.id,scorer->>'id' LIMIT 20`;
      for (const candidate of automatic) {
        yield* enqueue(
          candidate,
          {
            factoryId: candidate.factoryId,
            runId: candidate.runId,
            scorerFactoryId: candidate.scorerFactoryId,
            scorerVersionId: candidate.scorerVersionId,
            scorerId: candidate.scorerId,
            id: `auto:${evaluationDigest(JSON.stringify(candidate))}`,
          },
          "automatic",
        );
      }
      // A lost judge claim becomes a visible failure; recovery never launches a second paid turn.
      const abandoned = yield* sql<{
        input: unknown;
      }>`SELECT input FROM foundry_automation.evaluation_queue WHERE state='running' AND claimed_at < now()-interval '10 minutes' LIMIT 20`;
      for (const row of abandoned) {
        const input = yield* decodeInput(row.input);
        const result = yield* decodeResult({
          input,
          status: "failed",
          reason: "judge_unavailable",
          judgment: null,
          passed: null,
          recordedAt: DateTime.formatIso(yield* DateTime.now),
        });
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows =
              yield* sql`SELECT id FROM foundry_automation.evaluation_queue WHERE id=${input.id} AND state='running' AND claimed_at < now()-interval '10 minutes' FOR UPDATE`;
            if (!rows.length) return;
            yield* sql`INSERT INTO foundry_automation.evaluation_results(id,factory_id,run_id,result) VALUES(${input.id},${input.factoryId},${input.runId},${sql.json(result)}) ON CONFLICT DO NOTHING`;
            yield* sql`UPDATE foundry_automation.evaluation_queue SET state='finished',claim_token=NULL WHERE id=${input.id}`;
          }),
        );
      }
      const token = NodeCrypto.randomUUID();
      const claimed = yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            id: string;
            input: unknown;
          }>`SELECT id,input FROM foundry_automation.evaluation_queue WHERE state='pending' ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`;
          const row = rows[0];
          if (!row) return null;
          yield* sql`UPDATE foundry_automation.evaluation_queue SET state='running',claim_token=${token},claimed_at=now() WHERE id=${row.id}`;
          return row;
        }),
      );
      if (!claimed) return;
      const input = yield* decodeInput(claimed.input);
      const preflight = evaluationPreflight(input);
      const outcome = preflight
        ? { ...preflight, judgment: null, passed: null }
        : yield* judge.judge(input).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(EvaluationJudgment)),
            Effect.map((judgment) => {
              const passed = classifyJudgment(input, judgment);
              return passed === null
                ? {
                    status: "incomplete" as const,
                    reason: "invalid_judgment" as const,
                    judgment: null,
                    passed: null,
                  }
                : { status: "completed" as const, reason: null, judgment, passed };
            }),
            Effect.catch((error) =>
              Effect.succeed({
                status: "failed" as const,
                reason:
                  error instanceof EvaluationJudge.EvaluationJudgeError
                    ? error.reason
                    : ("invalid_judgment" as const),
                judgment: null,
                passed: null,
              }),
            ),
          );
      const result = yield* decodeResult({
        input,
        ...outcome,
        recordedAt: DateTime.formatIso(yield* DateTime.now),
      });
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const owned =
            yield* sql`SELECT id FROM foundry_automation.evaluation_queue WHERE id=${input.id} AND state='running' AND claim_token=${token} FOR UPDATE`;
          if (!owned.length) return;
          yield* sql`INSERT INTO foundry_automation.evaluation_results(id,factory_id,run_id,result) VALUES(${input.id},${input.factoryId},${input.runId},${sql.json(result)}) ON CONFLICT DO NOTHING`;
          yield* sql`UPDATE foundry_automation.evaluation_queue SET state='finished',claim_token=NULL WHERE id=${input.id} AND claim_token=${token}`;
        }),
      );
    }).pipe(Effect.mapError(mapError));
    return Evaluations.of({ enqueue, list, read, tick });
  }),
);
