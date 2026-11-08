import {
  FOUNDRY_SANDBOX_BUNDLE_MIME_TYPE,
  FoundrySandboxSetupLocalIndex,
  FoundrySandboxSetupIndex,
  FOUNDRY_SETUP_PART_BYTES,
  CommandId,
  EnvironmentId,
  FoundryDevice,
  FoundryEnrollment,
  FoundryEnrollmentRequest,
  FoundryProviderConnection,
  FoundrySandboxAllocationSummary,
  FoundrySandboxProfile,
  FoundrySandboxArchiveManifest,
  FoundrySandboxArchiveReceipt,
  FoundryArtifactChunk,
  FoundryArtifactStatus,
  FoundryArtifactError,
  FoundryArtifactManifest,
  FoundrySandboxError,
  ThreadId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { decodeSandboxBundleIndex } from "../SandboxBundle.ts";
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

const decodeSetupIndex = Schema.decodeEffect(Schema.fromJsonString(FoundrySandboxSetupLocalIndex));
const encodeSetupIndex = Schema.encodeEffect(Schema.fromJsonString(FoundrySandboxSetupIndex));
const helper = ["node", "/app/foundry-sandbox-bootstrap.mjs"];
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const json = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const isSandboxError = Schema.is(FoundrySandboxError);
const decodeAllocations = Schema.decodeUnknownEffect(Schema.Array(FoundrySandboxAllocationSummary));
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
  const base = (allocation: FoundrySandboxAllocationSummary) => ({
    leaseId,
    allocationId: allocation.allocationId,
    generation: allocation.generation,
  });
  const identity = (allocation: FoundrySandboxAllocationSummary) => ({
    instanceId: transport.device.instanceId,
    allocationId: allocation.allocationId,
  });
  const send = transport.send;
  const setupProfiles = new Map<string, { generation: number; profile: FoundrySandboxProfile }>();
  const step = Effect.fn("SandboxSupervisor.step")(function* (
    allocation: FoundrySandboxAllocationSummary,
    state: FoundrySandboxAllocationSummary["state"],
    failure: FoundrySandboxAllocationSummary["failure"] = null,
  ) {
    return yield* send({ op: "transition", ...base(allocation), state, failure });
  });
  const exec = Effect.fn("SandboxSupervisor.bootstrap")(function* (
    allocation: FoundrySandboxAllocationSummary,
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
    allocation: FoundrySandboxAllocationSummary,
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
    allocation: FoundrySandboxAllocationSummary,
  ) {
    if (!allocation.request.resumeAllocationId) return;
    const first = yield* send({ op: "resumeChunk", ...base(allocation), offset: 0 }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ResumeChunk)),
    );
    const receipt = first.receipt;
    const changed = () => new FoundryArtifactError({ code: "changed" });
    const read = Effect.fn("SandboxSupervisor.readResumeArtifact")(function* (
      manifest: FoundryArtifactManifest,
      part: number | undefined,
    ) {
      let offset = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const value =
          part === undefined && offset === 0
            ? first
            : yield* send({
                op: "resumeChunk",
                ...base(allocation),
                offset,
                ...(part === undefined ? {} : { part }),
              }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ResumeChunk)));
        const chunk = value.chunk;
        const bytes = yield* Effect.fromResult(Base64.decode(chunk.data));
        if (
          stableStringify(value.receipt) !== stableStringify(receipt) ||
          chunk.offset !== offset ||
          chunk.total !== manifest.sizeBytes ||
          chunk.fileSha256 !== manifest.sha256 ||
          artifactSha256(bytes) !== chunk.sha256 ||
          offset + bytes.byteLength > manifest.sizeBytes ||
          (bytes.byteLength === 0 && offset !== manifest.sizeBytes)
        )
          return yield* changed();
        chunks.push(bytes);
        offset += bytes.byteLength;
        if (offset === manifest.sizeBytes) break;
      }
      const bytes = new Uint8Array(offset);
      let position = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, position);
        position += chunk.length;
      }
      if (artifactSha256(bytes) !== manifest.sha256) return yield* changed();
      return bytes;
    });
    if (receipt.manifest.bundle.mimeType === FOUNDRY_SANDBOX_BUNDLE_MIME_TYPE) {
      if (receipt.manifest.bundle.sizeBytes > 1024 * 1024) return yield* changed();
      const encoded = yield* read(receipt.manifest.bundle, undefined);
      const index = yield* decodeSandboxBundleIndex(receipt.manifest.bundle, encoded);
      yield* exec(allocation, "resume-chunk", {
        offset: 0,
        base64: "",
        receipt,
        indexBase64: Base64.encode(encoded),
      });
      let offset = 0;
      for (let part = 0; part < index.parts.length; part++) {
        const bytes = yield* read(index.parts[part]!, part);
        for (let local = 0; local < bytes.byteLength; local += 256 * 1024) {
          const chunk = bytes.subarray(local, local + 256 * 1024);
          yield* exec(allocation, "resume-chunk", { offset, base64: Base64.encode(chunk) });
          offset += chunk.byteLength;
        }
      }
      if (offset !== index.sizeBytes) return yield* changed();
    } else {
      const bytes = yield* read(receipt.manifest.bundle, undefined);
      for (let offset = 0; offset < bytes.byteLength; offset += 256 * 1024)
        yield* exec(allocation, "resume-chunk", {
          offset,
          base64: Base64.encode(bytes.subarray(offset, offset + 256 * 1024)),
          ...(offset === 0 ? { receipt } : {}),
        });
    }
    yield* exec(allocation, "resume");
  });
  const setup = Effect.fn("SandboxSupervisor.setup")(function* (
    allocation: FoundrySandboxAllocationSummary,
  ) {
    const cached = setupProfiles.get(allocation.allocationId);
    const profile =
      cached?.generation === allocation.generation
        ? cached.profile
        : yield* send({ op: "setupProfile", ...base(allocation) }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(FoundrySandboxProfile)),
          );
    if (
      profile.profileId !== allocation.request.profileId ||
      profile.revision !== allocation.request.revision
    )
      return yield* new FoundrySandboxError({ code: "conflict" });
    setupProfiles.set(allocation.allocationId, { generation: allocation.generation, profile });
    yield* resume(allocation);
    const setupComplete = yield* exec(allocation, "setup", {
      repositoryUrl: profile.checkout.repository,
      revision: profile.checkout.commit,
      setup: profile.setup,
      tools: profile.tools,
      skills: profile.skills ?? [],
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
      ...(transport.publicCaPem ? { controlCaPem: transport.publicCaPem } : {}),
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
        ...(connection.modelCatalog
          ? {
              defaultModelSelection: {
                instanceId: connection.providerInstanceId,
                model: connection.modelCatalog.defaultModel,
              },
            }
          : {}),
        providerInstances: {
          [connection.providerInstanceId]: {
            driver: "codex",
            displayName: "Sandbox Codex",
            enabled: true,
            config: {
              setupMode: "managed",
              ...(connection.modelCatalog ? { customModels: connection.modelCatalog.models } : {}),
            },
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
    allocation: FoundrySandboxAllocationSummary,
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
    const readSnapshot = Effect.fn("SandboxSupervisor.readSetupSnapshot")(function* (
      partIndex?: number,
    ) {
      const chunks: Uint8Array[] = [];
      let offset = 0;
      let expectedHash: string | undefined;
      let expectedSize: number | undefined;
      while (true) {
        const part = yield* finalize(allocation, [...helper, "read-setup-chunk"], {
          offset,
          ...(partIndex === undefined ? {} : { part: partIndex }),
        }).pipe(Effect.flatMap(json), Effect.flatMap(Schema.decodeUnknownEffect(SetupChunk)));
        if (
          part.offset !== offset ||
          part.sizeBytes > FOUNDRY_SETUP_PART_BYTES ||
          part.sizeBytes < 1 ||
          (expectedSize !== undefined && part.sizeBytes !== expectedSize)
        )
          return yield* new FoundryArtifactError({ code: "changed" });
        expectedSize = part.sizeBytes;
        const bytes = yield* Effect.fromResult(Base64.decode(part.base64));
        if (offset === 0) expectedHash = part.sha256;
        chunks.push(bytes);
        offset += bytes.length;
        if (offset === part.sizeBytes) break;
        if (!bytes.length || offset > part.sizeBytes)
          return yield* new FoundryArtifactError({ code: "changed" });
      }
      const content = new Uint8Array(offset);
      let position = 0;
      for (const chunk of chunks) {
        content.set(chunk, position);
        position += chunk.length;
      }
      if (expectedHash !== artifactSha256(content))
        return yield* new FoundryArtifactError({ code: "changed" });
      return content;
    });
    const local = yield* decodeSetupIndex(new TextDecoder().decode(yield* readSnapshot()));
    const artifactInput = (sizeBytes: number, sha256: string, suffix: string) => ({
      instanceId: transport.device.instanceId,
      commandId: CommandId.make(
        `sandbox-setup-${allocation.allocationId}-${allocation.generation}-${suffix}`,
      ),
      owner: {
        environmentId: transport.device.environmentId,
        threadId: ThreadId.make(allocation.allocationId),
      },
      name: `sandbox-setup-${suffix}.json`,
      mimeType: "application/json",
      sizeBytes,
      sha256,
    });
    const publish = Effect.fn("SandboxSupervisor.publishSetupSnapshot")(function* (
      content: Uint8Array,
      suffix: string,
    ) {
      return yield* publishArtifact(
        transport.artifactSend,
        artifactInput(content.byteLength, artifactSha256(content), suffix),
        content,
      );
    });
    const parts = yield* Effect.forEach(local.parts, (expected, index) =>
      Effect.gen(function* () {
        const input = artifactInput(expected.sizeBytes, expected.sha256, `part-${index}`);
        const status = yield* transport
          .artifactSend({ op: "begin", input })
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(FoundryArtifactStatus)));
        if (
          status.reference.instanceId !== input.instanceId ||
          status.reference.owner.environmentId !== input.owner.environmentId ||
          status.reference.owner.threadId !== input.owner.threadId ||
          status.sha256 !== input.sha256 ||
          status.sizeBytes !== input.sizeBytes ||
          status.offset > input.sizeBytes ||
          status.state === "aborted" ||
          (status.state === "published" && status.offset !== input.sizeBytes)
        )
          return yield* new FoundryArtifactError({ code: "changed" });
        if (status.offset === input.sizeBytes) {
          const manifest = yield* transport
            .artifactSend({ op: "publish", input: status.reference })
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(FoundryArtifactManifest)));
          if (
            manifest.reference.artifactId !== status.reference.artifactId ||
            manifest.reference.instanceId !== input.instanceId ||
            manifest.reference.owner.environmentId !== input.owner.environmentId ||
            manifest.reference.owner.threadId !== input.owner.threadId ||
            manifest.name !== input.name ||
            manifest.mimeType !== input.mimeType ||
            manifest.sha256 !== input.sha256 ||
            manifest.sizeBytes !== input.sizeBytes
          )
            return yield* new FoundryArtifactError({ code: "changed" });
          return manifest;
        }
        const content = yield* readSnapshot(index);
        if (
          content.byteLength !== expected.sizeBytes ||
          artifactSha256(content) !== expected.sha256
        )
          return yield* new FoundryArtifactError({ code: "changed" });
        return yield* publish(content, `part-${index}`);
      }),
    );
    const index = yield* encodeSetupIndex({
      format: "foundry-setup-snapshot-2",
      parts,
    });
    const artifact = yield* publish(new TextEncoder().encode(index), "index");
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
    allocation: FoundrySandboxAllocationSummary,
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
    allocation: FoundrySandboxAllocationSummary,
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
        setupProfiles.delete(id);
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
                    : isSandboxError(error) && error.code === "credentials_required"
                      ? "credentials"
                      : isSandboxError(error) && error.code === "capabilities_required"
                        ? "tools"
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
