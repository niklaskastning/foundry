// @effect-diagnostics nodeBuiltinImport:off -- Assertions run only inside the isolated PostgreSQL harness.
import * as NodeAssert from "node:assert/strict";
import type { EvaluationInput, FactoryV4Scorer, RequestEvaluation } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Database from "../src/automation/AutomationDatabase.ts";
import * as Evaluations from "../src/automation/Evaluations.ts";
import * as EvaluationJudge from "../src/automation/EvaluationJudge.ts";
import * as ThreadArchive from "../src/foundry/ThreadArchive.ts";

export const evaluationGates = Effect.fn("Evaluations.postgresGates")(function* <E>(
  database: Layer.Layer<Database.AutomationDatabase, E>,
) {
  let judgeCalls = 0;
  let blockJudge = false;
  let failJudge = false;
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const judge = Layer.succeed(EvaluationJudge.EvaluationJudge, {
    judge: Effect.fn("EvaluationGate.judge")(function* (input: EvaluationInput) {
      judgeCalls++;
      if (blockJudge) {
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
      }
      if (failJudge)
        return yield* new EvaluationJudge.EvaluationJudgeError({ reason: "judge_unavailable" });
      return {
        modelRevision: "gpt-6.1-sol",
        criteria: input.scorer.criteria.map((criterion) => ({
          id: criterion.id,
          score: 1,
          rationale: "Deterministic fixture acceptance",
          evidenceIds: [input.evidence[0]!.id],
        })),
      };
    }),
  });
  const services = Evaluations.layer.pipe(
    Layer.provide(judge),
    Layer.provide(Layer.mock(ThreadArchive.ThreadArchive)({})),
    Layer.provideMerge(database),
  );
  yield* Effect.gen(function* () {
    const sql = yield* Database.AutomationDatabase;
    const evaluations = yield* Evaluations.Evaluations;
    const identity = {
      instanceId: "11111111-1111-4111-8111-111111111104",
      operatorId: "n04-evaluation-owner",
    };
    const scorer = (automatic: boolean): FactoryV4Scorer => ({
      id: "quality",
      name: "Quality",
      criteria: [{ id: "acceptance", instructions: "Check publish evidence", threshold: 0.8 }],
      judge: { provider: "codex", model: "gpt-6.1-sol", reasoningEffort: "medium" },
      sampling: { rate: 1, automatic },
    });
    const seed = Effect.fn("EvaluationGate.seed")(function* (
      factoryId: string,
      automatic = false,
      kind = "publish",
    ) {
      const versionId = `${factoryId}-version`;
      const definitionId = `${factoryId}-definition`;
      const runId = `${factoryId}-run`;
      const steps = [{ id: "result", kind, dependsOn: [] }];
      yield* sql`INSERT INTO foundry_automation.factories(id,name) VALUES(${factoryId},${factoryId})`;
      yield* sql`INSERT INTO foundry_automation.versions(id,factory_id,repositories) VALUES(${versionId},${factoryId},ARRAY['fixture'])`;
      yield* sql`INSERT INTO foundry_automation.commands(id,kind,payload) VALUES(${definitionId},'definition.activate','{}')`;
      yield* sql`INSERT INTO foundry_automation.workflow_versions(id,factory_id,factory_version_id,steps) VALUES(${factoryId + "-workflow"},${factoryId},${versionId},${sql.json(steps)})`;
      yield* sql`INSERT INTO foundry_automation.definition_versions(id,command_id,factory_id,factory_version_id,scope_version_id,content_hash,source,definition,workflow_versions) VALUES(${definitionId},${definitionId},${factoryId},${versionId},${versionId},${"a".repeat(64)},${sql.json({ kind: "git", commitSha: "a".repeat(40) })},${sql.json({ schemaVersion: 4, factoryId, scorers: [scorer(automatic)] })},'[]')`;
      yield* sql`INSERT INTO foundry_automation.definition_heads(factory_id,version_id) VALUES(${factoryId},${definitionId})`;
      yield* sql`INSERT INTO foundry_automation.work_items(id,factory_id,version_id,repository,title,source) VALUES(${factoryId + "-work"},${factoryId},${versionId},'fixture','Evaluation fixture','{}')`;
      yield* sql`INSERT INTO foundry_automation.runs(id,factory_id,work_item_id,workflow_version_id,factory_version_id,repository,revision,state) VALUES(${runId},${factoryId},${factoryId + "-work"},${factoryId + "-workflow"},${versionId},'fixture',${"c".repeat(40)},'pending')`;
      yield* sql`INSERT INTO foundry_automation.dispatch_runs(run_id,worker_id,binding,state) VALUES(${runId},'n04-fixture-worker',${sql.json({ identity, model: "original-model" })},'succeeded')`;
      yield* sql`INSERT INTO foundry_automation.step_attempts(command_id,run_id,ordinal,request,state,result) VALUES(${factoryId + "-attempt"},${runId},0,${sql.json({ model: "original-model", options: { reasoningEffort: "low" } })},'succeeded',${sql.json({ publish: { url: "https://fixture.invalid/pr/1", commitSha: "d".repeat(40) } })})`;
      return {
        factoryId,
        runId,
        scorerFactoryId: factoryId,
        scorerVersionId: definitionId,
        scorerId: "quality",
      };
    });
    const request = yield* seed("n04-evaluation-manual");
    const first: RequestEvaluation = { ...request, id: "n04-evaluation-first" };
    NodeAssert.equal(yield* evaluations.enqueue(identity, first), first.id);
    NodeAssert.equal(yield* evaluations.enqueue(identity, first), first.id);
    yield* evaluations.tick;
    NodeAssert.equal(judgeCalls, 1);
    const original = yield* evaluations.read(identity, request.factoryId, first.id);
    NodeAssert.equal(original.status, "completed");
    NodeAssert.equal(original.passed, true);
    NodeAssert.equal(original.input.runRevision, "c".repeat(40));
    NodeAssert.equal(original.input.definitionRevision, `${request.factoryId}-version`);
    const changed = yield* Effect.result(
      evaluations.enqueue(identity, { ...first, scorerId: "missing" }),
    );
    NodeAssert.equal(changed._tag, "Failure");
    NodeAssert.equal(yield* evaluations.enqueue(identity, first), first.id);
    yield* evaluations.tick;
    NodeAssert.equal(judgeCalls, 1);
    yield* evaluations.enqueue(identity, { ...request, id: "n04-evaluation-second" });
    yield* evaluations.tick;
    NodeAssert.equal(judgeCalls, 2);
    NodeAssert.deepEqual(yield* evaluations.read(identity, request.factoryId, first.id), original);
    NodeAssert.equal(
      (yield* evaluations.list(identity, { factoryId: request.factoryId })).length,
      2,
    );
    NodeAssert.equal((yield* evaluations.list({ ...identity, operatorId: "other" }, {})).length, 0);
    NodeAssert.equal(
      (yield* Effect.result(
        evaluations.read({ ...identity, operatorId: "other" }, request.factoryId, first.id),
      ))._tag,
      "Failure",
    );
    NodeAssert.equal(
      (yield* Effect.result(
        evaluations.enqueue(
          { ...identity, operatorId: "other" },
          { ...request, id: "n04-foreign" },
        ),
      ))._tag,
      "Failure",
    );

    const incomplete = yield* seed("n04-evaluation-incomplete", false, "agent");
    yield* evaluations.enqueue(identity, { ...incomplete, id: "n04-evaluation-incomplete-result" });
    yield* evaluations.tick;
    NodeAssert.equal(
      (yield* evaluations.read(identity, incomplete.factoryId, "n04-evaluation-incomplete-result"))
        .reason,
      "missing_evidence",
    );
    NodeAssert.equal(judgeCalls, 2);
    yield* sql`UPDATE foundry_automation.dispatch_runs SET state='running' WHERE run_id=${incomplete.runId}`;
    NodeAssert.equal(
      (yield* Effect.result(
        evaluations.enqueue(identity, { ...incomplete, id: "n04-still-running" }),
      ))._tag,
      "Failure",
    );

    blockJudge = true;
    yield* evaluations.enqueue(identity, { ...request, id: "n04-evaluation-claim" });
    const firstTick = yield* evaluations.tick.pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* evaluations.tick;
    NodeAssert.equal(judgeCalls, 3);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(firstTick);
    blockJudge = false;
    NodeAssert.equal(
      (yield* evaluations.read(identity, request.factoryId, "n04-evaluation-claim")).status,
      "completed",
    );

    yield* evaluations.enqueue(identity, { ...request, id: "n04-evaluation-stale" });
    yield* sql`UPDATE foundry_automation.evaluation_queue SET state='running',claim_token='dead-worker',claimed_at=now()-interval '11 minutes' WHERE id='n04-evaluation-stale'`;
    yield* evaluations.tick;
    NodeAssert.equal(
      (yield* evaluations.read(identity, request.factoryId, "n04-evaluation-stale")).reason,
      "judge_unavailable",
    );
    NodeAssert.equal(judgeCalls, 3);
    failJudge = true;
    yield* evaluations.enqueue(identity, { ...request, id: "n04-evaluation-judge-error" });
    yield* evaluations.tick;
    NodeAssert.equal(
      (yield* evaluations.read(identity, request.factoryId, "n04-evaluation-judge-error")).status,
      "failed",
    );
    NodeAssert.equal(judgeCalls, 4);
    failJudge = false;

    const automatic = yield* seed("n04-evaluation-auto", true);
    const currentDefinition = "n04-evaluation-current-definition";
    yield* sql`INSERT INTO foundry_automation.versions(id,factory_id,repositories) VALUES('n04-evaluation-current-version',${automatic.factoryId},ARRAY['fixture'])`;
    yield* sql`INSERT INTO foundry_automation.commands(id,kind,payload) VALUES(${currentDefinition},'definition.activate','{}')`;
    yield* sql`INSERT INTO foundry_automation.definition_versions(id,command_id,factory_id,factory_version_id,scope_version_id,content_hash,source,definition,workflow_versions) VALUES(${currentDefinition},${currentDefinition},${automatic.factoryId},'n04-evaluation-current-version','n04-evaluation-current-version',${"b".repeat(64)},${sql.json({ kind: "git", commitSha: "b".repeat(40) })},${sql.json({ schemaVersion: 4, factoryId: automatic.factoryId, scorers: [scorer(false)] })},'[]')`;
    yield* sql`UPDATE foundry_automation.definition_heads SET version_id=${currentDefinition} WHERE factory_id=${automatic.factoryId}`;
    yield* evaluations.tick;
    const history = yield* evaluations.list(identity, { factoryId: automatic.factoryId });
    NodeAssert.equal(history.length, 1);
    const automaticResult = yield* evaluations.read(identity, automatic.factoryId, history[0]!.id);
    NodeAssert.equal(automaticResult.input.mode, "automatic");
    NodeAssert.equal(automaticResult.input.scorerRevision, "a".repeat(64));
    NodeAssert.equal(automaticResult.input.definitionRevision, `${automatic.factoryId}-version`);
    NodeAssert.equal(automaticResult.input.scorer.sampling.automatic, true);
    NodeAssert.equal(judgeCalls, 5);
    yield* evaluations.tick;
    NodeAssert.equal(judgeCalls, 5);
    NodeAssert.equal(
      (yield* evaluations.list(identity, { factoryId: automatic.factoryId })).length,
      1,
    );
  }).pipe(Effect.provide(services), Effect.scoped);
});
