// @effect-diagnostics nodeBuiltinImport:off -- Fixture bytes exercise the same artifact digest validation as native bundles.
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import { FoundryWorkerExecution, FoundryArtifactManifest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import * as Publish from "./Publish.ts";
import * as DispatchStore from "./DispatchStore.ts";
import * as WorkerTransport from "./WorkerTransport.ts";
import * as GitHubApp from "./GitHubApp.ts";
import * as Artifacts from "../foundry/Artifacts.ts";

const decodeIdentity = Schema.decodeSync(WorkerTransport.WorkerIdentity);
const decodeArtifact = Schema.decodeSync(FoundryArtifactManifest);
const decodeExecution = Schema.decodeSync(FoundryWorkerExecution);
function fixture(assignedWorker = false) {
  const bytes = new TextEncoder().encode("bounded fixture git bundle");
  const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  const identity = decodeIdentity({
    instanceId: "22222222-2222-4222-8222-222222222222",
    operatorId: "operator",
    deviceId: "11111111-1111-4111-8111-111111111111",
    environmentId: "worker",
    deviceGeneration: 1,
    accessGeneration: 1,
    automationGeneration: 1,
    clientSessionId: "client",
    foundrySessionHash: "h".repeat(43),
  });
  const bundle = decodeArtifact({
    reference: {
      instanceId: identity.instanceId,
      artifactId: "33333333-3333-4333-8333-333333333333",
      owner: { environmentId: "worker", threadId: "native-test" },
    },
    name: "result.bundle",
    mimeType: "application/octet-stream",
    sizeBytes: bytes.length,
    sha256,
  });
  const execution = decodeExecution({
    receipt: {
      commandId: "native-check",
      threadId: "native-test",
      acceptedAt: "2026-11-04T00:00:00Z",
      sequence: 1,
    },
    run: { id: "native-run", status: "completed", checkpointId: "checkpoint" },
    lifecycle: {
      generation: 1,
      expiresAt: 1,
      state: "completed",
      writerEnded: true,
      manifest: {
        generation: 1,
        runId: "native-run",
        checkpointId: "checkpoint",
        checkpointRef: "refs/t3/checkpoint",
        outcome: "completed",
        publishEvidence: {
          repository: "owner/test",
          baseBranch: "main",
          sourceCwd: "/fixture",
          commitSha: "a".repeat(40),
          treeSha: "b".repeat(40),
          checks: [
            {
              id: "check",
              command: "test -f checked",
              cwd: "/fixture",
              relativeCwd: ".",
              exitCode: 0,
              commitSha: "a".repeat(40),
              treeSha: "b".repeat(40),
            },
          ],
          bundle,
        },
      },
    },
  });
  const claim: DispatchStore.DispatchClaim = {
    owner: "scheduler",
    generation: 1,
    run: {
      id: "run",
      factoryId: "factory",
      workItemId: "work",
      workflowVersionId: "workflow",
      factoryVersionId: "version",
      repository: "binding",
      revision: "input",
      state: "pending",
    },
    workflow: {
      id: "workflow",
      factoryId: "factory",
      factoryVersionId: "version",
      steps: [
        { id: "test", kind: "test", dependsOn: [], checkId: "check" },
        { id: "publish", kind: "publish", target: "pull_request", dependsOn: ["test"] },
      ],
    },
    workerId: identity.deviceId,
    binding: {
      identity: assignedWorker
        ? {
            ...identity,
            deviceId: "44444444-4444-4444-8444-444444444444",
            environmentId: "coordinator-worker",
          }
        : identity,
      checks: [{ id: "check", command: "test -f checked", cwd: "/fixture" }],
    },
    state: "running",
    reason: null,
    mode: "active",
    revision: 2,
    resultRevision: 1,
    attempts: [
      {
        commandId: "native-check",
        ...(assignedWorker ? { workerId: identity.deviceId, workerBinding: { identity } } : {}),
        request: {},
        ordinal: 0,
        state: "succeeded",
        reason: null,
        receipt: null,
        result: { execution, artifacts: [bundle] },
      },
    ],
  };
  let current = claim;
  let approved = true;
  let generation = 1;
  let transfers = 0;
  let creations = 0;
  let lost = true;
  let published: GitHubApp.PublishedPullRequest | null = null;
  let stored: GitHubApp.PublishedPullRequest | null = null;
  const keys: string[] = [];
  const layer = Publish.serviceLayer.pipe(
    Layer.provide(
      Layer.mock(DispatchStore.DispatchStore)({
        read: () => Effect.succeed(current),
        canLaunch: () => Effect.succeed(true),
        approved: () => Effect.succeed(approved),
      }),
    ),
    Layer.provide(
      Layer.mock(WorkerTransport.WorkerTransport)({
        status: (assignedIdentity) =>
          assignedIdentity.deviceId !== identity.deviceId
            ? Effect.fail(new WorkerTransport.WorkerTransportError({ reason: "forbidden" }))
            : Effect.succeed({
                online: true,
                providerInstanceId: null,
                providerReady: true,
                providerState: "ready",
                version: null,
                checkedAt: "2026-11-04T00:00:00Z",
                capacityAvailable: true,
                activeRuns: 0,
              }),
      }),
    ),
    Layer.provide(
      Layer.mock(GitHubApp.GitHubApp)({
        binding: () =>
          Effect.succeed({
            connectionId: "github-app",
            repositoryId: 12,
            repository: "owner/test",
            baseBranch: "main",
            generation,
          }),
        credential: () => Effect.succeed(Redacted.make("fixture")),
        publish: (input) =>
          Effect.suspend(() => {
            if (!published) {
              creations++;
              published = {
                number: 7,
                url: "https://github.com/owner/test/pull/7",
                commitSha: input.commitSha,
                operationKey: input.operationKey,
              };
            }
            if (lost) {
              lost = false;
              return Effect.fail(new GitHubApp.GitHubAppError({ reason: "unavailable" }));
            }
            return Effect.succeed(published);
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(Artifacts.Artifacts)({
        status: () =>
          Effect.succeed({
            reference: bundle.reference,
            state: "published",
            offset: bytes.length,
            sizeBytes: bytes.length,
            sha256,
          }),
        read: () =>
          Effect.succeed({
            offset: 0,
            total: bytes.length,
            fileSha256: sha256,
            sha256,
            data: Buffer.from(bytes).toString("base64"),
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(Publish.PublishOperations, {
        begin: (input) =>
          Effect.sync(() => {
            keys.push(input.operationKey);
            return stored;
          }),
        finish: (_key, _request, result) =>
          Effect.sync(() => {
            stored = result;
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(Publish.GitTransfer, (input) =>
        input.authorize.pipe(
          Effect.andThen(
            Effect.sync(() => {
              transfers++;
            }),
          ),
        ),
      ),
    ),
  );
  return {
    claim,
    identity,
    execution,
    layer,
    keys,
    setCurrent: (value: DispatchStore.DispatchClaim) => {
      current = value;
    },
    revoke: () => {
      approved = false;
      generation++;
    },
    counts: () => ({ creations, transfers }),
  };
}
it.effect("reuses one durable publish operation after a lost answer and restart", () =>
  Effect.gen(function* () {
    const test = fixture(true);
    const run = Effect.gen(function* () {
      const publisher = yield* Publish.Publish;
      return yield* publisher.execute(test.claim, "publish");
    });
    expect((yield* run.pipe(Effect.provide(test.layer), Effect.result))._tag).toBe("Failure");
    const result = yield* run.pipe(Effect.provide(test.layer));
    expect(result.result?.number).toBe(7);
    yield* run.pipe(Effect.provide(test.layer));
    expect(new Set(test.keys).size).toBe(1);
    expect(test.counts()).toEqual({ creations: 1, transfers: 2 });
    test.revoke();
    expect((yield* run.pipe(Effect.provide(test.layer), Effect.result))._tag).toBe("Failure");
  }),
);
it.effect(
  "blocks stale approvals and absent, different-commit or mismatched test evidence before transfer",
  () =>
    Effect.gen(function* () {
      const test = fixture();
      const run = Effect.gen(function* () {
        const publisher = yield* Publish.Publish;
        return yield* publisher.execute(test.claim, "publish");
      });
      test.setCurrent({ ...test.claim, resultRevision: 2 });
      expect((yield* run.pipe(Effect.provide(test.layer), Effect.result))._tag).toBe("Failure");
      for (const command of ["missing", "wrong command"]) {
        test.setCurrent({
          ...test.claim,
          attempts: test.claim.attempts.map((attempt) => ({
            ...attempt,
            result: {
              execution: {
                ...test.execution,
                lifecycle: {
                  ...test.execution.lifecycle,
                  manifest: {
                    ...test.execution.lifecycle?.manifest,
                    publishEvidence:
                      command === "missing"
                        ? undefined
                        : {
                            ...test.execution.lifecycle?.manifest?.publishEvidence,
                            checks: [
                              {
                                id: "check",
                                command,
                                cwd: "/fixture",
                                relativeCwd: ".",
                                exitCode: 0,
                                commitSha: "c".repeat(40),
                                treeSha: "b".repeat(40),
                              },
                            ],
                          },
                  },
                },
              },
            },
          })),
        });
        expect((yield* run.pipe(Effect.provide(test.layer))).state).toBe("waiting");
      }
      for (const identity of [
        {
          ...test.identity,
          environmentId: "foreign-worker",
        },
        {
          ...test.identity,
          operatorId: "foreign-operator",
        },
      ]) {
        test.setCurrent({
          ...test.claim,
          attempts: test.claim.attempts.map((attempt) => ({
            ...attempt,
            workerBinding: { identity },
          })),
        });
        expect((yield* run.pipe(Effect.provide(test.layer), Effect.result))._tag).toBe("Failure");
      }
      expect(test.counts()).toEqual({ creations: 0, transfers: 0 });
    }),
);

it.effect("publishes the dependency checkpoint when v4 declares publish before its test", () =>
  Effect.gen(function* () {
    const test = fixture();
    const publishNode = {
      id: "publish",
      kind: "publish" as const,
      dependsOn: ["test"],
      target: "pull_request" as const,
    };
    const testNode = { id: "test", kind: "test" as const, dependsOn: [], checkId: "check" };
    const execution = test.execution;
    const claim: DispatchStore.DispatchClaim = {
      ...test.claim,
      workflow: {
        ...test.claim.workflow,
        steps: [publishNode, testNode, { ...testNode, id: "unrelated", checkId: "unrelated" }],
        v4: {
          workflow: {
            id: "flow",
            limits: { maxConcurrentAgents: 1, maxAgentExecutions: 2 },
            steps: [publishNode, testNode, { ...testNode, id: "unrelated", checkId: "unrelated" }],
          },
          agents: [],
          skills: [],
          mcp: [],
          files: [],
        },
      },
      v4State: {
        status: "waiting",
        inputs: {},
        startedAgentExecutions: 0,
        nodes: [
          {
            path: "publish",
            scope: "",
            definition: publishNode,
            status: "ready",
            ordinal: 0,
            base: "a".repeat(40),
          },
          {
            path: "test",
            scope: "",
            definition: testNode,
            status: "succeeded",
            ordinal: 1,
            base: "a".repeat(40),
          },
        ],
      },
      attempts: test.claim.attempts.map((attempt) => ({
        ...attempt,
        ordinal: 1,
        result: {
          execution: {
            ...execution,
            lifecycle: {
              ...execution.lifecycle!,
              manifest: { ...execution.lifecycle!.manifest!, workspacePath: "/fixture" },
            },
          },
          artifacts: [],
        },
      })),
    };
    test.setCurrent(claim);
    const run = Publish.Publish.pipe(
      Effect.flatMap((publisher) => publisher.execute(claim, "publish")),
      Effect.provide(test.layer),
    );
    expect((yield* run.pipe(Effect.result))._tag).toBe("Failure");
    expect((yield* run).state).toBe("published");
  }),
);
