import { FoundryArchivePage } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ThreadArchive from "../foundry/ThreadArchive.ts";
import { collectEvaluationEvidence } from "./EvaluationEvidence.ts";
import { evaluationDigest } from "./Scorers.ts";

const decodePage = Schema.decodeUnknownSync(FoundryArchivePage);
it.effect(
  "keeps real nonagent evidence but rejects malformed agent results and partial snapshots",
  () =>
    Effect.gen(function* () {
      const principal = { instanceId: "11111111-1111-4111-8111-111111111111", operatorId: "test" };
      const publish = {
        id: "publish",
        kind: "publish",
        result: { publish: { commitSha: "a".repeat(40), url: "https://example.test/pr/1" } },
      };
      const evidence = yield* collectEvaluationEvidence(principal, [publish]);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]?.sha256).toBe(evaluationDigest(JSON.stringify(publish.result)));
      expect(
        yield* collectEvaluationEvidence(principal, [
          publish,
          { id: "agent", kind: "agent", result: { metadata: "not an execution" } },
        ]),
      ).toEqual([]);
      expect(yield* collectEvaluationEvidence(principal, [{ ...publish, kind: "test" }])).toEqual(
        [],
      );
      expect(yield* collectEvaluationEvidence(principal, [{ ...publish, result: null }])).toEqual(
        [],
      );
      expect(
        yield* collectEvaluationEvidence(principal, [
          { ...publish, result: { content: "x".repeat(100_001) } },
        ]),
      ).toEqual([]);
    }).pipe(Effect.provide(Layer.mock(ThreadArchive.ThreadArchive)({}))),
);

it.effect(
  "bounds archived evidence to the finalized cursor even after later thread events arrive",
  () =>
    Effect.gen(function* () {
      const principal = { instanceId: "11111111-1111-4111-8111-111111111111", operatorId: "test" };
      const owner = { environmentId: "worker", threadId: "thread" };
      const result = {
        execution: {
          receipt: {
            commandId: "command",
            threadId: "thread",
            acceptedAt: "2026-11-08T00:00:00Z",
            sequence: 1,
          },
          run: { id: "run", status: "completed", checkpointId: null },
          lifecycle: {
            generation: 1,
            expiresAt: 0,
            state: "completed",
            writerEnded: true,
            manifest: {
              generation: 1,
              runId: "run",
              checkpointId: null,
              checkpointRef: null,
              outcome: "completed",
              archive: {
                instanceId: principal.instanceId,
                deviceId: "22222222-2222-4222-8222-222222222222",
                deviceGeneration: 1,
                owner,
                cursor: 1,
                sourceSequence: 11,
              },
            },
          },
        },
      };
      const evidence = yield* collectEvaluationEvidence(principal, [
        { id: "agent", kind: "agent", result },
      ]);
      expect(evidence).toHaveLength(2);
      expect(evidence[1]?.content).toContain("original-evidence");
      expect(evidence[1]?.content).not.toContain("later-foreign-evidence");
      const wrongOwner = structuredClone(result);
      wrongOwner.execution.lifecycle.manifest.archive.owner.threadId = "other-thread";
      expect(
        yield* collectEvaluationEvidence(principal, [
          { id: "agent", kind: "agent", result: wrongOwner },
        ]),
      ).toEqual([]);
      const wrongRun = structuredClone(result);
      wrongRun.execution.lifecycle.manifest.runId = "other-run";
      expect(
        yield* collectEvaluationEvidence(principal, [
          { id: "agent", kind: "agent", result: wrongRun },
        ]),
      ).toEqual([]);
      const wrongSequence = structuredClone(result);
      wrongSequence.execution.lifecycle.manifest.archive.sourceSequence = 12;
      expect(
        yield* collectEvaluationEvidence(principal, [
          { id: "agent", kind: "agent", result: wrongSequence },
        ]),
      ).toEqual([]);
    }).pipe(
      Effect.provide(
        Layer.mock(ThreadArchive.ThreadArchive)({
          read: () =>
            Effect.succeed(
              decodePage({
                owner: { environmentId: "worker", threadId: "thread" },
                confirmedCursor: 2,
                confirmedSourceSequence: 12,
                sourceHead: 2,
                sourceComplete: true,
                complete: true,
                missingArtifacts: [],
                missingAttachmentCount: 0,
                nextCursor: null,
                events: [1, 2].map((sequence) => ({
                  sequence,
                  sourceSequence: sequence + 10,
                  event: {
                    id: `event-${sequence}`,
                    threadId: "thread",
                    occurredAt: "2026-11-08T00:00:00Z",
                    type: "plan.updated",
                    payload: {
                      id: `plan-${sequence}`,
                      threadId: "thread",
                      runId: "run",
                      nodeId: "node",
                      status: "completed",
                      kind: "proposed_plan",
                      markdown: sequence === 1 ? "original-evidence" : "later-foreign-evidence",
                    },
                  },
                })),
              }),
            ),
        }),
      ),
    ),
);
