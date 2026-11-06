import * as WorkerTransport from "../../automation/WorkerTransport.ts";
import {
  ThreadId,
  FoundrySandboxMachineRequest,
  FoundrySandboxError,
  FoundryProviderConnectionError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as DeviceConfig from "../DeviceConfig.ts";
import * as DeviceRegistry from "../DeviceRegistry.ts";
import * as DeviceChannel from "../DeviceChannel.ts";
import * as DeviceGrants from "../DeviceGrants.ts";
import * as InstanceDatabase from "../InstanceDatabase.ts";
import * as ProviderConnections from "../ProviderConnections.ts";
import * as SandboxArchive from "../SandboxArchive.ts";
import * as Artifacts from "../Artifacts.ts";
import * as Allocations from "./Allocations.ts";
import { verifySandboxRequest } from "./Proof.ts";

export class MachineAccess extends Context.Reference<
  | {
      readonly handle: (input: unknown) => Effect.Effect<unknown, FoundrySandboxError>;
    }
  | undefined
>("t3/foundry/sandboxes/MachineAccess", { defaultValue: () => undefined }) {}

const decode = Schema.decodeUnknownEffect(FoundrySandboxMachineRequest, {
  onExcessProperty: "error",
});
const isError = Schema.is(FoundrySandboxError);
const isConnectionError = Schema.is(FoundryProviderConnectionError);
export const layer = Layer.effect(
  MachineAccess,
  Effect.gen(function* () {
    const registry = yield* DeviceRegistry.DeviceRegistry;
    const channel = yield* DeviceChannel.DeviceChannel;
    const worker = yield* WorkerTransport.WorkerTransport;
    const grants = yield* DeviceGrants.DeviceGrants;
    const allocations = yield* Allocations.Allocations;
    const connections = yield* ProviderConnections.ProviderConnections;
    const archives = yield* SandboxArchive.SandboxArchiveConfirmation;
    const artifacts = yield* Artifacts.Artifacts;
    const policy = yield* Allocations.SandboxPolicy;
    const sql = yield* InstanceDatabase.InstanceDatabase;
    const { origin } = yield* DeviceConfig.DeviceOrigin;
    const handle = Effect.fn("SandboxMachineAccess.handle")(
      function* (raw: unknown) {
        const input = yield* decode(raw);
        const device = yield* registry.get(input.deviceId);
        if (
          device.deviceId !== policy.supervisorDeviceId ||
          device.revoked ||
          device.instanceId !== input.instanceId ||
          device.environmentId !== input.environmentId ||
          device.generation !== input.generation ||
          Math.abs((yield* Clock.currentTimeMillis) - input.issuedAt) > 120000 ||
          !verifySandboxRequest(origin, input, device.publicKey)
        )
          return yield* new FoundrySandboxError({ code: "forbidden" });
        const owners = yield* sql<{
          operator_id: string;
        }>`SELECT d.operator_id FROM foundry_instance.devices d
      JOIN foundry_instance.device_grants g USING(device_id) WHERE d.device_id=${device.deviceId}
      AND d.instance_id=${device.instanceId} AND NOT d.revoked AND g.kind='sandboxProvisioning' AND g.enabled`;
        const operatorId = owners[0]?.operator_id;
        if (!operatorId) return yield* new FoundrySandboxError({ code: "forbidden" });
        const request = input.request;
        if (request.op === "claim") return yield* allocations.claim(operatorId, request.leaseId);
        const { allocation, archive_receipt } = yield* allocations.checkLease(
          operatorId,
          request.allocationId,
          request.leaseId,
          request.generation,
        );
        const owner = { instanceId: device.instanceId, operatorId };
        const withLease = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
          Allocations.withSandboxAllocationLock(
            Effect.gen(function* () {
              yield* allocations
                .checkLease(operatorId, request.allocationId, request.leaseId, request.generation)
                .pipe(Effect.provideService(InstanceDatabase.InstanceDatabase, sql));
              return yield* operation;
            }),
          ).pipe(Effect.provideService(InstanceDatabase.InstanceDatabase, sql));
        if (request.op === "setupProfile") {
          if (allocation.state !== "setup")
            return yield* new FoundrySandboxError({ code: "conflict" });
          return allocation.profile;
        }
        if (request.op === "setupReport") {
          yield* withLease(
            allocations.reportSetup(
              operatorId,
              allocation.allocationId,
              allocation.generation,
              request.log,
            ),
          );
          return null;
        }
        if (request.op === "admitRuntime") {
          yield* withLease(
            allocations.admitRuntime(operatorId, allocation.allocationId, allocation.generation),
          );
          return null;
        }
        if (request.op === "approve") {
          return yield* withLease(
            Effect.gen(function* () {
              if (allocation.state !== "setup")
                return yield* new FoundrySandboxError({ code: "conflict" });
              if (allocation.environmentId && allocation.environmentId !== request.environmentId)
                return yield* new FoundrySandboxError({ code: "conflict" });
              const existing = yield* sql<{
                device_id: import("@t3tools/contracts").FoundryDeviceId;
              }>`SELECT device_id FROM foundry_instance.devices
        WHERE environment_id=${request.environmentId} AND instance_id=${device.instanceId} AND operator_id=${operatorId}
        AND public_key=${request.publicKey} AND NOT revoked`;
              if (existing[0]) {
                if (!allocation.environmentId)
                  return yield* new FoundrySandboxError({ code: "conflict" });
                const registered = yield* registry.get(existing[0].device_id);
                yield* allocations.bind(
                  operatorId,
                  allocation.allocationId,
                  allocation.generation,
                  registered.environmentId,
                  registered.deviceId,
                );
                const connection = yield* connections.authorizeAllocation(owner, {
                  connectionId: allocation.profile.providerConnectionId,
                  device: registered,
                  allocationId: allocation.allocationId,
                  factoryId:
                    allocation.request.owner.kind === "workflow"
                      ? allocation.request.owner.factoryId
                      : null,
                });
                return { device: registered, connection };
              }
              yield* allocations.bind(
                operatorId,
                allocation.allocationId,
                allocation.generation,
                request.environmentId,
                null,
              );
              return {
                enrollment: yield* registry.approve({
                  environmentId: request.environmentId,
                  publicKey: request.publicKey,
                }),
              };
            }),
          );
        }
        if (request.op === "enroll") {
          if (allocation.state !== "setup")
            return yield* new FoundrySandboxError({ code: "conflict" });
          if (request.enrollment.enrollment.environmentId !== allocation.environmentId)
            return yield* new FoundrySandboxError({ code: "conflict" });
          return yield* withLease(
            Effect.gen(function* () {
              const registered = yield* registry.enroll(request.enrollment);
              yield* allocations.bind(
                operatorId,
                allocation.allocationId,
                allocation.generation,
                registered.environmentId,
                registered.deviceId,
              );
              const current = yield* grants.read(registered.deviceId, operatorId);
              for (const grant of current) {
                if (
                  (grant.kind === "clientAccess" || grant.kind === "automationExecution") &&
                  !grant.enabled
                )
                  yield* grants.update(
                    {
                      deviceId: registered.deviceId,
                      kind: grant.kind,
                      enabled: true,
                      generation: grant.generation,
                    },
                    operatorId,
                  );
              }
              const connection = yield* connections.authorizeAllocation(owner, {
                connectionId: allocation.profile.providerConnectionId,
                device: registered,
                allocationId: allocation.allocationId,
                factoryId:
                  allocation.request.owner.kind === "workflow"
                    ? allocation.request.owner.factoryId
                    : null,
              });
              return { device: registered, connection };
            }),
          );
        }
        if (request.op === "resumeChunk") {
          if (
            !allocation.request.resumeAllocationId ||
            !["provisioning", "setup"].includes(allocation.state)
          )
            return yield* new FoundrySandboxError({ code: "forbidden" });
          const source = yield* allocations.get(operatorId, allocation.request.resumeAllocationId);
          const cleanup = source.archive_receipt;
          const receipt =
            cleanup && "threads" in cleanup
              ? allocation.request.resumeThreadId
                ? cleanup.threads.find(
                    (thread) =>
                      thread.manifest.owner.threadId === allocation.request.resumeThreadId,
                  )
                : cleanup.threads[0]
              : undefined;
          if (!receipt) return yield* new FoundrySandboxError({ code: "archive_required" });
          return {
            receipt,
            chunk: yield* artifacts.read(owner, {
              reference: receipt.manifest.bundle.reference,
              offset: request.offset,
            }),
          };
        }
        if (request.op === "setupArchive") {
          if (allocation.state !== "archiving")
            return yield* new FoundrySandboxError({ code: "conflict" });
          const receipt = yield* archives.confirmSetup(owner, request.archive, {
            allocationId: allocation.allocationId,
            fence: allocation.generation,
            owner: {
              environmentId: device.environmentId,
              threadId: ThreadId.make(allocation.allocationId),
            },
            setupAdmitted: allocation.setupAdmitted,
            runtimeAdmitted: allocation.runtimeAdmitted,
            ...(request.snapshotThreadIds ? { snapshotThreadIds: request.snapshotThreadIds } : {}),
            ...(allocation.environmentId ? { environmentId: allocation.environmentId } : {}),
          });
          return yield* withLease(
            allocations.transition(
              operatorId,
              allocation.allocationId,
              allocation.generation,
              "deleting",
              {},
              receipt,
            ),
          );
        }
        if (request.op === "archive") {
          if (allocation.state !== "archiving" || !allocation.environmentId)
            return yield* new FoundrySandboxError({ code: "conflict" });
          const receipt = yield* archives.confirmEnvironment(owner, request.manifests, {
            allocationId: allocation.allocationId,
            fence: allocation.generation,
            environmentId: allocation.environmentId,
            threadIds: request.threadIds,
          });
          return yield* withLease(
            allocations.transition(
              operatorId,
              allocation.allocationId,
              allocation.generation,
              "deleting",
              {},
              receipt,
            ),
          );
        }
        let projectId = allocation.projectId;
        if (request.state === "ready") {
          if (!allocation.deviceId) return yield* new FoundrySandboxError({ code: "conflict" });
          const active = yield* channel.current(allocation.deviceId);
          if (!active.rpcStream || active.device.environmentId !== allocation.environmentId)
            return yield* new FoundrySandboxError({ code: "unavailable" });
          const target = {
            ...owner,
            allocationId: allocation.allocationId,
            deviceId: allocation.deviceId,
            environmentId: active.device.environmentId,
          };
          const projects = yield* worker.sandboxProjects(target);
          const project = projects.projects.find(
            (project) => project.workspaceRoot === "/workspace/repo" && project.deletedAt === null,
          );
          if (!project) return yield* new FoundrySandboxError({ code: "unavailable" });
          const status = yield* worker.sandboxStatus(target, project.id);
          if (
            !status.providerReady ||
            !status.projectReady ||
            status.definitionExecutionVersion !== 4
          )
            return yield* new FoundrySandboxError({ code: "unavailable" });
          projectId = project.id;
        }
        return yield* withLease(
          Effect.gen(function* () {
            if (request.state === "deleted") {
              if (!archive_receipt)
                return yield* new FoundrySandboxError({ code: "archive_required" });
              if (allocation.deviceId) yield* registry.revoke(allocation.deviceId);
              yield* connections.releaseAllocation(owner, {
                connectionId: allocation.profile.providerConnectionId,
                allocationId: allocation.allocationId,
              });
            }
            if (request.state === "deleting")
              return yield* new FoundrySandboxError({ code: "archive_required" });
            return yield* allocations.transition(
              operatorId,
              allocation.allocationId,
              allocation.generation,
              request.state,
              { failure: request.failure, projectId },
            );
          }),
        );
      },
      Effect.mapError((error) =>
        isError(error)
          ? error
          : new FoundrySandboxError({
              code:
                isConnectionError(error) &&
                (error.code === "forbidden" || error.code === "login_required")
                  ? "credentials_required"
                  : "unavailable",
            }),
      ),
    );
    return { handle };
  }),
);
