import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  FoundryDeviceId,
  FoundryInstanceId,
  type FoundrySandboxAllocation,
  type FoundrySandboxMachineOperation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as Transport from "./Transport.ts";
import * as Oci from "./OciSupervisor.ts";
import * as Supervisor from "./Supervisor.ts";

it.effect("fences lost setup leases and preserves work when archive fails", () =>
  Effect.gen(function* () {
    let allocation: FoundrySandboxAllocation = {
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
    };
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<FoundrySandboxMachineOperation>();
    let claimed = true;
    let stopped = false;
    let removed = false;
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
        input.argv.at(-1) === "logs"
          ? Effect.succeed({ stdout: '{"log":""}', stderr: "", exitCode: 0 })
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
          ? Effect.sync(() => (claimed ? [allocation] : []))
          : request.op === "setupReport"
            ? Effect.succeed(null)
            : Queue.offer(events, request).pipe(Effect.as(null)),
    });
    yield* Effect.gen(function* () {
      const service = yield* Supervisor.Supervisor;
      yield* Effect.forkScoped(service.run);
      yield* Deferred.await(started);
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
    }).pipe(
      Effect.provide(Supervisor.layer.pipe(Layer.provide(NodeCrypto.layer))),
      Effect.provideService(Transport.Transport, transport),
      Effect.provideService(Oci.OciSupervisor, oci),
    );
  }).pipe(Effect.scoped),
);
