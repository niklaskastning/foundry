import {
  CommandId,
  EnvironmentId,
  FoundryDevice,
  FoundryEnrollment,
  FoundryEnrollmentRequest,
  FoundryProviderConnection,
  FoundrySandboxAllocation,
  FoundrySandboxArchiveManifest,
  FoundrySandboxArchiveReceipt,
  FoundryArtifactChunk,
  FoundrySandboxError,
  ThreadId,
} from "@t3tools/contracts";
import { publishArtifact, artifactSha256 } from "@t3tools/shared/foundryArtifacts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Base64 from "effect/encoding/Base64";
import * as OciSupervisor from "./OciSupervisor.ts";
import * as Transport from "./Transport.ts";

const helper = ["node", "/app/foundry-sandbox-bootstrap.mjs"];
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const json = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const isSandboxError = Schema.is(FoundrySandboxError);
const decodeAllocations = Schema.decodeUnknownEffect(Schema.Array(FoundrySandboxAllocation));
const Identity = Schema.Struct({ environmentId: EnvironmentId, publicKey: Schema.String });
const Enrolled = Schema.Struct({ device: FoundryDevice, connection: FoundryProviderConnection });
const Approval = Schema.Union([Enrolled, Schema.Struct({ enrollment: FoundryEnrollment })]);
const Snapshot = Schema.Struct({
  threadIds: Schema.Array(ThreadId),
  manifests: Schema.Array(FoundrySandboxArchiveManifest),
});
const ResumeChunk = Schema.Struct({
  receipt: FoundrySandboxArchiveReceipt,
  chunk: FoundryArtifactChunk,
});
const SetupChunk = Schema.Struct({
  offset: Schema.Int,
  sizeBytes: Schema.Int,
  base64: Schema.String,
  sha256: Schema.optionalKey(Schema.String),
});
export class Supervisor extends Context.Service<
  Supervisor,
  {
    readonly run: Effect.Effect<never, never>;
  }
>()("t3/foundry/sandboxes/Supervisor") {}

const make = Effect.gen(function* () {
  const transport = yield* Transport.Transport;
  const oci = yield* OciSupervisor.OciSupervisor;
  const crypto = yield* Crypto.Crypto;
  const leaseId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
  const base = (allocation: FoundrySandboxAllocation) => ({
    leaseId,
    allocationId: allocation.allocationId,
    generation: allocation.generation,
  });
  const identity = (allocation: FoundrySandboxAllocation) => ({
    instanceId: transport.device.instanceId,
    allocationId: allocation.allocationId,
  });
  const send = transport.send;
  const step = Effect.fn("SandboxSupervisor.step")(function* (
    allocation: FoundrySandboxAllocation,
    state: FoundrySandboxAllocation["state"],
    failure: FoundrySandboxAllocation["failure"] = null,
  ) {
    return yield* send({ op: "transition", ...base(allocation), state, failure });
  });
  const exec = Effect.fn("SandboxSupervisor.bootstrap")(function* (
    allocation: FoundrySandboxAllocation,
    mode: string,
    input?: unknown,
  ) {
    const result = yield* oci.exec(identity(allocation), {
      argv: [...helper, mode],
      ...(input === undefined ? {} : { stdin: encode(input) }),
      timeoutMs: 600000,
    });
    if (result.exitCode !== 0) return yield* new FoundrySandboxError({ code: "unavailable" });
    return yield* json(result.stdout);
  });
  const finalize = Effect.fn("SandboxSupervisor.finalize")(function* (
    allocation: FoundrySandboxAllocation,
    argv: ReadonlyArray<string>,
    input?: unknown,
  ) {
    const result = yield* oci.finalize(identity(allocation), {
      argv,
      ...(input === undefined ? {} : { stdin: encode(input) }),
    });
    if (result.state === "running") return yield* new FoundrySandboxError({ code: "unavailable" });
    if (result.exitCode !== 0) return yield* new FoundrySandboxError({ code: "unavailable" });
    return result.stdout;
  });
  const resume = Effect.fn("SandboxSupervisor.resume")(function* (
    allocation: FoundrySandboxAllocation,
  ) {
    if (!allocation.request.resumeAllocationId) return;
    let offset = 0;
    while (true) {
      const value = yield* send({ op: "resumeChunk", ...base(allocation), offset }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ResumeChunk)),
      );
      yield* exec(allocation, "resume-chunk", {
        offset,
        base64: value.chunk.data,
        ...(offset === 0 ? { receipt: value.receipt } : {}),
      });
      const bytes = yield* Effect.fromResult(Base64.decode(value.chunk.data));
      offset += bytes.byteLength;
      if (offset === value.receipt.manifest.bundle.sizeBytes) break;
      if (bytes.byteLength === 0 || offset > value.receipt.manifest.bundle.sizeBytes)
        return yield* new FoundrySandboxError({ code: "conflict" });
    }
    yield* exec(allocation, "resume");
  });
  const setup = Effect.fn("SandboxSupervisor.setup")(function* (
    allocation: FoundrySandboxAllocation,
  ) {
    yield* resume(allocation);
    const setupComplete = yield* exec(allocation, "setup", {
      repositoryUrl: allocation.profile.checkout.repository,
      revision: allocation.profile.checkout.commit,
      setup: allocation.profile.setup,
      tools: allocation.profile.tools,
      skills: allocation.profile.skills ?? [],
    }).pipe(
      Effect.matchEffect({
        onSuccess: () => Effect.succeed(true),
        onFailure: () => step(allocation, "failed", "setup").pipe(Effect.as(false)),
      }),
    );
    const logs = yield* exec(allocation, "logs").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ log: Schema.String }))),
      Effect.option,
    );
    if (logs._tag === "Some")
      yield* send({ op: "setupReport", ...base(allocation), log: logs.value.log });
    if (!setupComplete) return;
    const local = yield* exec(allocation, "identity").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Identity)),
    );
    const approval = yield* send({ op: "approve", ...base(allocation), ...local }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Approval)),
    );
    const enrolled =
      "device" in approval
        ? approval
        : yield* Effect.gen(function* () {
            const enrollment = yield* exec(allocation, "sign-enrollment", approval.enrollment).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(FoundryEnrollmentRequest)),
            );
            return yield* send({ op: "enroll", ...base(allocation), enrollment }).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Enrolled)),
            );
          });
    yield* send({ op: "admitRuntime", ...base(allocation) });
    const connection = enrolled.connection;
    yield* exec(allocation, "runtime", {
      origin: transport.origin,
      registration: enrolled.device,
      environment: { FOUNDRY_SANDBOX_ALLOCATION_ID: allocation.allocationId },
      providerBinding: {
        connectionId: connection.id,
        connectionGeneration: connection.generation,
        providerInstanceId: connection.providerInstanceId,
        profileKey: connection.profileKey,
        allocationId: allocation.allocationId,
        factoryId:
          allocation.request.owner.kind === "workflow" ? allocation.request.owner.factoryId : null,
      },
      settings: {
        providerInstances: {
          [connection.providerInstanceId]: {
            driver: "codex",
            displayName: "Sandbox Codex",
            enabled: true,
            config: { setupMode: "managed" },
          },
        },
      },
    });
    yield* exec(allocation, "project").pipe(Effect.ignore);
    yield* step(allocation, "ready").pipe(
      Effect.catchIf(
        (error) => error.code === "unavailable",
        () => Effect.void,
      ),
    );
  });
  const archiveSetup = Effect.fn("SandboxSupervisor.archiveSetup")(function* (
    allocation: FoundrySandboxAllocation,
    snapshotThreadIds?: ReadonlyArray<ThreadId>,
  ) {
    if (!allocation.setupAdmitted) {
      yield* send({
        op: "setupArchive",
        ...base(allocation),
        archive: {
          kind: "empty",
          allocationId: allocation.allocationId,
          fence: allocation.generation,
        },
      });
      return;
    }
    yield* finalize(allocation, [
      "node",
      "/app/dist/bin.mjs",
      "foundry",
      "sandbox-archive",
      "capture-setup",
      "--allocation-id",
      allocation.allocationId,
      "--cwd",
      "/workspace/repo",
      "--setup-log",
      "/workspace/.foundry/setup.log",
      "--output",
      "/workspace/.foundry/setup-snapshot.json",
    ]);
    const chunks: Uint8Array[] = [];
    let offset = 0;
    let expectedHash: string | undefined;
    while (true) {
      const part = yield* finalize(allocation, [...helper, "read-setup-chunk"], { offset }).pipe(
        Effect.flatMap(json),
        Effect.flatMap(Schema.decodeUnknownEffect(SetupChunk)),
      );
      if (part.offset !== offset || part.sizeBytes > 50 * 1024 * 1024)
        return yield* new FoundrySandboxError({ code: "conflict" });
      const bytes = yield* Effect.fromResult(Base64.decode(part.base64));
      if (offset === 0) expectedHash = part.sha256;
      chunks.push(bytes);
      offset += bytes.length;
      if (offset === part.sizeBytes) break;
      if (!bytes.length || offset > part.sizeBytes)
        return yield* new FoundrySandboxError({ code: "conflict" });
    }
    const content = new Uint8Array(offset);
    let position = 0;
    for (const chunk of chunks) {
      content.set(chunk, position);
      position += chunk.length;
    }
    const sha256 = artifactSha256(content);
    if (expectedHash !== sha256) return yield* new FoundrySandboxError({ code: "conflict" });
    const artifact = yield* publishArtifact(
      transport.artifactSend,
      {
        instanceId: transport.device.instanceId,
        commandId: CommandId.make(
          `sandbox-setup-${allocation.allocationId}-${allocation.generation}`,
        ),
        owner: {
          environmentId: transport.device.environmentId,
          threadId: ThreadId.make(allocation.allocationId),
        },
        name: "sandbox-setup.json",
        mimeType: "application/json",
        sizeBytes: content.byteLength,
        sha256,
      },
      content,
    );
    yield* send({
      op: "setupArchive",
      ...base(allocation),
      archive: {
        kind: "setup",
        allocationId: allocation.allocationId,
        fence: allocation.generation,
        artifact,
      },
      ...(snapshotThreadIds ? { snapshotThreadIds } : {}),
    });
  });
  const archive = Effect.fn("SandboxSupervisor.archive")(function* (
    allocation: FoundrySandboxAllocation,
  ) {
    if (!allocation.runtimeAdmitted) return yield* archiveSetup(allocation);
    yield* finalize(allocation, [
      "node",
      "/app/dist/bin.mjs",
      "foundry",
      "sandbox-archive",
      "capture-environment",
      "--base-dir",
      "/workspace/.foundry/t3",
      "--allocation-id",
      allocation.allocationId,
      "--fence",
      String(allocation.generation),
      "--cwd",
      "/workspace/repo",
      "--output",
      "/workspace/.foundry/archive-manifest.json",
    ]);
    const snapshot = yield* finalize(allocation, [...helper, "read-archive"]).pipe(
      Effect.flatMap(json),
      Effect.flatMap(Schema.decodeUnknownEffect(Snapshot)),
    );
    if (!snapshot.threadIds.length) return yield* archiveSetup(allocation, []);
    yield* send({ op: "archive", ...base(allocation), ...snapshot });
  });
  const reconcile = Effect.fn("SandboxSupervisor.reconcile")(function* (
    allocation: FoundrySandboxAllocation,
  ) {
    switch (allocation.state) {
      case "requested":
        yield* step(allocation, "provisioning");
        return;
      case "provisioning": {
        yield* oci.ensure({
          ...identity(allocation),
          image: allocation.profile.image,
          architecture: allocation.profile.architecture,
          ...allocation.profile.resources,
          network: allocation.profile.network,
          command: [
            ...helper,
            "supervise",
            String(allocation.createdAt + allocation.profile.lifetimeSeconds * 1000),
            String(allocation.createdAt + allocation.profile.maxLifetimeSeconds * 1000),
          ],
        });
        yield* step(allocation, "setup");
        return;
      }
      case "setup":
        yield* setup(allocation);
        return;
      case "ready": {
        const state = yield* oci.inspect(identity(allocation));
        if (!state?.running) {
          yield* step(allocation, "failed", "unavailable");
          return;
        }
        yield* exec(allocation, "extend", { expiresAt: allocation.expiresAt });
        return;
      }
      case "draining":
        yield* oci.stop(identity(allocation));
        yield* step(allocation, "stopped");
        return;
      case "stopped":
        if (allocation.deleteRequested) yield* step(allocation, "archiving");
        return;
      case "archiving":
        yield* archive(allocation);
        return;
      case "deleting":
        yield* oci.remove(identity(allocation));
        yield* step(allocation, "deleted");
        return;
      case "failed":
      case "deleted":
        return;
    }
  });
  const run = Effect.gen(function* () {
    const jobs = yield* FiberMap.make<string, void>();
    const current = new Map<string, string>();
    const tick = Effect.gen(function* () {
      const allocations = yield* send({ op: "claim", leaseId }).pipe(
        Effect.flatMap(decodeAllocations),
      );
      const claimed = new Set(allocations.map((allocation) => allocation.allocationId));
      for (const id of current.keys()) {
        if (claimed.has(id)) continue;
        yield* FiberMap.remove(jobs, id);
        yield* FiberMap.remove(jobs, `logs:${id}`);
        current.delete(id);
      }
      for (const allocation of allocations) {
        const key = `${allocation.generation}:${allocation.state}`;
        if (current.get(allocation.allocationId) !== key) {
          yield* FiberMap.remove(jobs, allocation.allocationId);
          yield* FiberMap.remove(jobs, `logs:${allocation.allocationId}`);
          current.set(allocation.allocationId, key);
        }
        if (allocation.state === "setup") {
          yield* FiberMap.run(
            jobs,
            `logs:${allocation.allocationId}`,
            exec(allocation, "logs").pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ log: Schema.String }))),
              Effect.flatMap(({ log }) => send({ op: "setupReport", ...base(allocation), log })),
              Effect.asVoid,
              Effect.ignore,
            ),
            { onlyIfMissing: true },
          );
        }
        yield* FiberMap.run(
          jobs,
          allocation.allocationId,
          reconcile(allocation).pipe(
            Effect.catch((error) => {
              if (isSandboxError(error) && error.code === "conflict") return Effect.void;
              const failure =
                allocation.state === "archiving" || allocation.state === "deleting"
                  ? "archive"
                  : allocation.state === "provisioning"
                    ? "provisioning"
                    : "unavailable";
              return step(allocation, "failed", failure).pipe(Effect.ignore);
            }),
          ),
          { onlyIfMissing: true },
        );
      }
    }).pipe(Effect.ignore);
    yield* tick.pipe(Effect.repeat(Schedule.spaced("2 seconds")));
    return yield* Effect.never;
  }).pipe(Effect.scoped);
  return Supervisor.of({ run });
});
export const layer = Layer.effect(Supervisor, make);
