import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  EnvironmentId,
  FoundryDeviceId,
  FoundryInstanceId,
  FoundrySandboxError,
  FoundryArtifactError,
  FoundryArtifactId,
  type FoundryArtifactBegin,
  type FoundryArtifactManifest,
  type FoundrySandboxAllocation,
  type FoundrySandboxMachineOperation,
} from "@t3tools/contracts";
import { artifactSha256 } from "@t3tools/shared/foundryArtifacts";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import * as Base64 from "effect/encoding/Base64";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as Transport from "./Transport.ts";
import * as Oci from "./OciSupervisor.ts";

const decodeResumeWrite = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ base64: Schema.String })),
);
const decodeSetupRead = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ part: Schema.optionalKey(Schema.Int) })),
);
import * as Supervisor from "./Supervisor.ts";

const fixtureAllocation = (): FoundrySandboxAllocation => ({
  allocationId: "11111111-1111-4111-8111-111111111111",
  request: {
    commandId: "fixture",
    profileId: "fixture",
    revision: "22222222-2222-4222-8222-222222222222",
    owner: { kind: "interactive" },
  },
  profile: {
    profileId: "fixture",
    revision: "22222222-2222-4222-8222-222222222222",
    label: "fixture",
    image: `example.test/foundry@sha256:${"a".repeat(64)}`,
    architecture: "amd64",
    resources: { cpuMillis: 1000, memoryMiB: 512, pids: 128 },
    lifetimeSeconds: 300,
    maxLifetimeSeconds: 600,
    network: "none",
    checkout: { repository: "https://example.test/repo.git", commit: "b".repeat(40) },
    setup: [["true"]],
    tools: [],
    providerConnectionId: "fixture",
    enabled: true,
  },
  state: "setup",
  generation: 1,
  createdAt: 0,
  expiresAt: 300000,
  environmentId: null,
  deviceId: null,
  projectId: null,
  failure: null,
  failureFrom: null,
  setupAdmitted: true,
  runtimeAdmitted: false,
  deleteRequested: false,
});

it.effect("fences lost setup leases and preserves work when archive fails", () =>
  Effect.gen(function* () {
    let allocation = fixtureAllocation();
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<FoundrySandboxMachineOperation>();
    let claimed = true;
    let fetchedProfiles = 0;
    let stopped = false;
    let removed = false;
    let completeSetup = false;
    let approved = false;
    const runtimeReady = yield* Deferred.make<{
      settings: {
        providerInstances: Record<string, { config: { customModels?: unknown } }>;
        defaultModelSelection?: unknown;
      };
    }>();
    let approvalError = new FoundrySandboxError({ code: "credentials_required" });
    const oci = Oci.OciSupervisor.of({
      ensure: () => Effect.die("unexpected provision"),
      inspect: () => Effect.succeed(null),
      stop: () =>
        Effect.sync(() => {
          stopped = true;
          return null;
        }),
      remove: () =>
        Effect.sync(() => {
          removed = true;
        }),
      exec: (_, input) =>
        input.argv.at(-1) === "runtime"
          ? Deferred.succeed(runtimeReady, JSON.parse(input.stdin!)).pipe(
              Effect.as({ stdout: "null", stderr: "", exitCode: 0 }),
            )
          : input.argv.at(-1) === "logs"
            ? Effect.succeed({ stdout: '{"log":""}', stderr: "", exitCode: 0 })
            : completeSetup
              ? Effect.succeed({
                  stdout: JSON.stringify(
                    input.argv.at(-1) === "identity"
                      ? { environmentId: "sandbox", publicKey: "fixture" }
                      : null,
                  ),
                  stderr: "",
                  exitCode: 0,
                })
              : Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
                ),
      finalize: () => Effect.fail(new Oci.OciError({ operation: "exec", reason: "command" })),
    });
    const transport = Transport.Transport.of({
      device: {
        deviceId: FoundryDeviceId.make("33333333-3333-4333-8333-333333333333"),
        instanceId: FoundryInstanceId.make("44444444-4444-4444-8444-444444444444"),
        environmentId: EnvironmentId.make("supervisor"),
        generation: 1,
        revoked: false,
        publicKey: "fixture",
      },
      origin: "https://example.test",
      artifactSend: () => Effect.die("unexpected artifact"),
      send: (request) =>
        request.op === "claim"
          ? Effect.sync(() =>
              claimed
                ? [
                    {
                      ...allocation,
                      profile: {
                        ...allocation.profile,
                        setupStepCount: allocation.profile.setup.length,
                      },
                    },
                  ]
                : [],
            )
          : request.op === "setupProfile"
            ? Effect.sync(() => {
                fetchedProfiles++;
                return allocation.profile;
              })
            : request.op === "approve"
              ? approved
                ? Effect.succeed({
                    device: {
                      ...transport.device,
                      environmentId: EnvironmentId.make("sandbox"),
                      publicKey: "a".repeat(43),
                    },
                    connection: {
                      id: "fixture",
                      label: "Selected central connection",
                      providerInstanceId: "authorized-codex",
                      profileKey: "a".repeat(64),
                      generation: 1,
                      grants: [],
                      revoked: false,
                      lastIssuedExpiresAt: 0,
                      modelCatalog: {
                        protocolVersion: "1",
                        models: [{ slug: "confirmed-luna", name: "Confirmed Luna" }],
                        defaultModel: "confirmed-luna",
                      },
                    },
                  })
                : Effect.fail(approvalError)
              : request.op === "setupReport"
                ? Effect.succeed(null)
                : Queue.offer(events, request).pipe(Effect.as(null)),
    });
    yield* Effect.gen(function* () {
      const service = yield* Supervisor.Supervisor;
      yield* Effect.forkScoped(service.run);
      yield* Deferred.await(started);
      assert.equal(fetchedProfiles, 1);
      claimed = false;
      yield* TestClock.adjust("2 seconds");
      assert.isTrue(yield* Deferred.isDone(interrupted));
      claimed = true;
      allocation = { ...allocation, generation: 2, state: "draining", deleteRequested: true };
      yield* TestClock.adjust("2 seconds");
      yield* Deferred.await(interrupted);
      const stop = yield* Queue.take(events);
      assert.equal(stop.op, "transition");
      if (stop.op === "transition") {
        assert.equal(stop.state, "stopped");
        assert.equal(stop.generation, 2);
      }
      assert.isTrue(stopped);
      allocation = { ...allocation, state: "archiving", runtimeAdmitted: true };
      yield* TestClock.adjust("2 seconds");
      const failed = yield* Queue.take(events);
      assert.equal(failed.op, "transition");
      if (failed.op === "transition") {
        assert.equal(failed.state, "failed");
        assert.equal(failed.failure, "archive");
      }
      assert.isFalse(removed);
      completeSetup = true;
      allocation = { ...allocation, generation: 3, state: "setup", runtimeAdmitted: false };
      yield* TestClock.adjust("2 seconds");
      const credentials = yield* Queue.take(events);
      assert.equal(credentials.op, "transition");
      if (credentials.op === "transition") {
        assert.equal(credentials.state, "failed");
        assert.equal(credentials.failure, "credentials");
      }
      assert.isFalse(removed);
      approvalError = new FoundrySandboxError({ code: "capabilities_required" });
      allocation = { ...allocation, generation: 4, state: "setup" };
      yield* TestClock.adjust("2 seconds");
      const capabilities = yield* Queue.take(events);
      assert.equal(capabilities.op, "transition");
      if (capabilities.op === "transition") {
        assert.equal(capabilities.state, "failed");
        assert.equal(capabilities.failure, "tools");
      }
      assert.isFalse(removed);
      approved = true;
      allocation = { ...allocation, generation: 5, state: "setup" };
      yield* TestClock.adjust("2 seconds");
      const runtime = yield* Deferred.await(runtimeReady);
      assert.deepStrictEqual(
        runtime.settings.providerInstances["authorized-codex"]?.config.customModels,
        [{ slug: "confirmed-luna", name: "Confirmed Luna" }],
      );
      assert.deepStrictEqual(runtime.settings.defaultModelSelection, {
        instanceId: "authorized-codex",
        model: "confirmed-luna",
      });
    }).pipe(
      Effect.provide(Supervisor.layer.pipe(Layer.provide(NodeCrypto.layer))),
      Effect.provideService(Transport.Transport, transport),
      Effect.provideService(Oci.OciSupervisor, oci),
    );
  }).pipe(Effect.scoped),
);

it.effect(
  "resumes setup archives without rereading completed parts and rejects changed uploads",
  () =>
    Effect.gen(function* () {
      let allocation = {
        ...fixtureAllocation(),
        state: "archiving" as const,
        deleteRequested: true,
      };
      const bytes = ["published", "complete upload", "missing upload"].map((value) =>
        new TextEncoder().encode(value),
      );
      const local = new TextEncoder().encode(
        JSON.stringify({
          format: "foundry-setup-local-2",
          parts: bytes.map((part) => ({ sizeBytes: part.length, sha256: artifactSha256(part) })),
        }),
      );
      const events = yield* Queue.unbounded<FoundrySandboxMachineOperation>();
      const reads: number[] = [];
      let changed = false;
      let corruptChunk = false;
      const manifests = new Map<string, FoundryArtifactManifest>();
      const offsets = new Map<string, number>();
      const oci = Oci.OciSupervisor.of({
        ensure: () => Effect.die("unexpected provision"),
        inspect: () => Effect.succeed(null),
        stop: () => Effect.die("unexpected stop"),
        remove: () => Effect.die("unexpected removal"),
        exec: () => Effect.die("unexpected exec"),
        finalize: (_, input) =>
          Effect.gen(function* () {
            if (input.argv.includes("capture-setup"))
              return { state: "completed" as const, stdout: "{}", stderr: "", exitCode: 0 };
            const request = yield* decodeSetupRead(input.stdin!).pipe(Effect.orDie);
            const part = request.part;
            if (part !== undefined) reads.push(part);
            const data = part === undefined ? local : bytes[part]!;
            return {
              state: "completed" as const,
              stdout: JSON.stringify({
                offset: 0,
                sizeBytes: data.length,
                base64: Base64.encode(data),
                sha256: corruptChunk && part !== undefined ? "b".repeat(64) : artifactSha256(data),
              }),
              stderr: "",
              exitCode: 0,
            };
          }),
      });
      const device = {
        deviceId: FoundryDeviceId.make("33333333-3333-4333-8333-333333333333"),
        instanceId: FoundryInstanceId.make("44444444-4444-4444-8444-444444444444"),
        environmentId: EnvironmentId.make("supervisor"),
        generation: 1,
        revoked: false,
        publicKey: "fixture",
      };
      const begin = (input: FoundryArtifactBegin) => {
        const index = input.commandId.endsWith("part-0")
          ? 0
          : input.commandId.endsWith("part-1")
            ? 1
            : 2;
        const id = `${allocation.generation}${index}${input.commandId.endsWith("index") ? "i" : "p"}`;
        const manifest = manifests.get(id) ?? {
          reference: {
            artifactId: FoundryArtifactId.make(
              `55555555-5555-4555-8555-${String(manifests.size).padStart(12, "0")}`,
            ),
            instanceId: input.instanceId,
            owner: input.owner,
          },
          name: input.name,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          sha256: input.sha256,
        };
        manifests.set(id, manifest);
        const offset =
          offsets.get(manifest.reference.artifactId) ??
          (input.name.includes("part-0") || input.name.includes("part-1") ? input.sizeBytes : 0);
        offsets.set(manifest.reference.artifactId, offset);
        return {
          reference: manifest.reference,
          state: input.name.includes("part-0") ? "published" : "uploading",
          offset,
          sizeBytes: input.sizeBytes,
          sha256: changed ? "a".repeat(64) : input.sha256,
        };
      };
      const transport = Transport.Transport.of({
        device,
        origin: "https://example.test",
        artifactSend: (request) => {
          if (request.op === "begin") return Effect.succeed(begin(request.input));
          const reference =
            request.op === "write"
              ? request.input.reference
              : "artifactId" in request.input
                ? request.input
                : undefined;
          const manifest = [...manifests.values()].find(
            (entry) => entry.reference.artifactId === reference?.artifactId,
          );
          if (!manifest) return Effect.fail(new FoundryArtifactError({ code: "changed" }));
          if (request.op === "publish") return Effect.succeed(manifest);
          if (request.op === "write") {
            const offset =
              request.input.offset + Result.getOrThrow(Base64.decode(request.input.data)).length;
            offsets.set(manifest.reference.artifactId, offset);
            return Effect.succeed({
              reference: manifest.reference,
              state: "uploading",
              offset,
              sizeBytes: manifest.sizeBytes,
              sha256: manifest.sha256,
            });
          }
          return Effect.die("unexpected artifact operation");
        },
        send: (request) =>
          request.op === "claim"
            ? Effect.succeed([
                { ...allocation, profile: { ...allocation.profile, setupStepCount: 1 } },
              ])
            : Queue.offer(events, request).pipe(Effect.as(null)),
      });
      yield* Effect.gen(function* () {
        const supervisor = yield* Supervisor.Supervisor;
        yield* Effect.forkScoped(supervisor.run);
        const archived = yield* Queue.take(events);
        assert.equal(archived.op, "setupArchive");
        assert.deepEqual(reads, [2]);
        changed = true;
        allocation = { ...allocation, generation: 2 };
        yield* TestClock.adjust("2 seconds");
        const failed = yield* Queue.take(events);
        assert.equal(failed.op, "transition");
        if (failed.op === "transition") assert.equal(failed.failure, "archive");
        assert.deepEqual(reads, [2]);
        changed = false;
        corruptChunk = true;
        allocation = { ...allocation, generation: 3 };
        yield* TestClock.adjust("2 seconds");
        const corrupt = yield* Queue.take(events);
        assert.equal(corrupt.op, "transition");
        if (corrupt.op === "transition") assert.equal(corrupt.failure, "archive");
        assert.deepEqual(reads, [2, 2]);
      }).pipe(
        Effect.provide(Supervisor.layer.pipe(Layer.provide(NodeCrypto.layer))),
        Effect.provideService(Transport.Transport, transport),
        Effect.provideService(Oci.OciSupervisor, oci),
      );
    }).pipe(Effect.scoped),
);

it.effect(
  "restores pinned multipart and raw bundles and rejects a changed receipt or corrupted part",
  () =>
    Effect.forEach(["multipart", "raw", "receipt", "corrupt"] as const, (mode) =>
      Effect.scoped(
        Effect.gen(function* () {
          let allocation = fixtureAllocation();
          allocation = {
            ...allocation,
            request: {
              ...allocation.request,
              resumeAllocationId: "33333333-3333-4333-8333-333333333333",
            },
          };
          const events = yield* Queue.unbounded<FoundrySandboxMachineOperation>();
          const chunks: Uint8Array[] = [];
          const parts: number[] = [];
          let resumed = false;
          const bytes = [new TextEncoder().encode("first"), new TextEncoder().encode("-last")];
          const full = new TextEncoder().encode("first-last");
          const owner = {
            environmentId: EnvironmentId.make("source"),
            threadId: ThreadId.make("source-thread"),
          };
          const manifest = (
            data: Uint8Array,
            index: number,
            mimeType = "application/octet-stream",
          ): FoundryArtifactManifest => ({
            reference: {
              instanceId: FoundryInstanceId.make("44444444-4444-4444-8444-444444444444"),
              owner,
              artifactId: FoundryArtifactId.make(
                `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`,
              ),
            },
            name: `bundle-${index}`,
            mimeType,
            sizeBytes: data.length,
            sha256: artifactSha256(data),
          });
          const index = new TextEncoder().encode(
            JSON.stringify({
              format: "foundry-git-bundle-1",
              sizeBytes: full.length,
              sha256: artifactSha256(full),
              parts: bytes.map((data, part) => manifest(data, part)),
            }),
          );
          const root =
            mode === "raw"
              ? manifest(full, 9)
              : manifest(index, 9, "application/vnd.foundry.git-bundle-index+json");
          const receipt = {
            digest: "e".repeat(64),
            manifest: {
              allocationId: allocation.request.resumeAllocationId!,
              fence: 1,
              owner,
              relativeWorkspacePath: "repo",
              finalCursor: 1,
              finalSourceSequence: 1,
              headCommit: "b".repeat(40),
              checkpointCommit: "c".repeat(40),
              checkpointTree: "d".repeat(40),
              bundle: root,
            },
          };
          const oci = Oci.OciSupervisor.of({
            ensure: () => Effect.die("unexpected provision"),
            inspect: () => Effect.succeed(null),
            stop: () => Effect.die("unexpected stop"),
            remove: () => Effect.die("unexpected remove"),
            finalize: () => Effect.die("unexpected finalizer"),
            exec: (_, input) =>
              Effect.gen(function* () {
                const command = input.argv.at(-1);
                if (command === "resume-chunk") {
                  const inputChunk = yield* decodeResumeWrite(input.stdin!).pipe(Effect.orDie);
                  chunks.push(
                    yield* Effect.fromResult(Base64.decode(inputChunk.base64)).pipe(Effect.orDie),
                  );
                } else if (command === "resume") resumed = true;
                else if (command === "setup")
                  return yield* new Oci.OciError({ operation: "exec", reason: "command" });
                return {
                  stdout: command === "logs" ? '{"log":""}' : "null",
                  stderr: "",
                  exitCode: 0,
                };
              }),
          });
          const transport = Transport.Transport.of({
            origin: "https://example.test",
            device: {
              deviceId: FoundryDeviceId.make("66666666-6666-4666-8666-666666666666"),
              instanceId: root.reference.instanceId,
              environmentId: EnvironmentId.make("provisioner"),
              publicKey: "fixture",
              generation: 1,
              revoked: false,
            },
            artifactSend: () => Effect.die("unexpected artifact upload"),
            send: (request) => {
              if (request.op === "claim")
                return Effect.succeed([
                  {
                    ...allocation,
                    profile: {
                      ...allocation.profile,
                      setupStepCount: allocation.profile.setup.length,
                    },
                  },
                ]);
              if (request.op === "setupProfile") return Effect.succeed(allocation.profile);
              if (request.op === "resumeChunk") {
                if (request.part !== undefined) parts.push(request.part);
                const expected =
                  request.part === undefined
                    ? mode === "raw"
                      ? full
                      : index
                    : bytes[request.part]!;
                const actual =
                  mode === "corrupt" && request.part === 0
                    ? new TextEncoder().encode("other")
                    : expected;
                return Effect.succeed({
                  receipt:
                    mode === "receipt" && request.part !== undefined
                      ? { ...receipt, digest: "f".repeat(64) }
                      : receipt,
                  chunk: {
                    offset: request.offset,
                    total: expected.length,
                    fileSha256: artifactSha256(expected),
                    sha256: artifactSha256(actual),
                    data: Base64.encode(actual),
                  },
                });
              }
              if (request.op === "setupReport") return Effect.succeed(null);
              if (request.op === "transition") allocation = { ...allocation, state: request.state };
              return Queue.offer(events, request).pipe(Effect.as(null));
            },
          });
          yield* Effect.gen(function* () {
            const service = yield* Supervisor.Supervisor;
            yield* Effect.forkScoped(service.run);
            const event = yield* Queue.take(events);
            assert.equal(event.op, "transition");
            if (event.op === "transition") assert.equal(event.state, "failed");
            const valid = mode === "raw" || mode === "multipart";
            assert.equal(resumed, valid);
            if (valid)
              assert.equal(
                new TextDecoder().decode(
                  Uint8Array.from(chunks.flatMap((chunk) => Array.from(chunk))),
                ),
                "first-last",
              );
            assert.deepEqual(parts, mode === "raw" ? [] : valid ? [0, 1] : [0]);
          }).pipe(
            Effect.provide(Supervisor.layer.pipe(Layer.provide(NodeCrypto.layer))),
            Effect.provideService(Transport.Transport, transport),
            Effect.provideService(Oci.OciSupervisor, oci),
          );
        }),
      ),
    ).pipe(Effect.asVoid),
);
