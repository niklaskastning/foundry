import {
  FoundrySandboxError,
  type FoundrySandboxProfile,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Allocations from "../foundry/sandboxes/Allocations.ts";
import * as WorkerTransport from "./WorkerTransport.ts";
import * as AutomationDatabase from "./AutomationDatabase.ts";

type Profile = Pick<FoundrySandboxProfile, "profileId" | "revision">;
type Run = { readonly id: string; readonly factoryId: string; readonly revision: string };
type Resolved =
  | {
      readonly state: "ready";
      readonly identity: WorkerTransport.WorkerIdentity;
      readonly projectId: ProjectId;
    }
  | { readonly state: "waiting"; readonly reason: string }
  | { readonly state: "failed"; readonly reason: "sandbox_deleted" };
export class SandboxTargets extends Context.Reference<
  | {
      readonly validate: (
        operatorId: string,
        profile: Profile,
        revision: string,
      ) => Effect.Effect<void, FoundrySandboxError>;
      readonly resolve: (
        identity: WorkerTransport.WorkerIdentity,
        profile: Profile,
        run: Run,
      ) => Effect.Effect<Resolved, FoundrySandboxError | WorkerTransport.WorkerTransportError>;
      readonly cancel: (
        operatorId: string,
        runId: string,
      ) => Effect.Effect<void, FoundrySandboxError>;
      readonly reconcileCleanup: Effect.Effect<void, FoundrySandboxError>;
    }
  | undefined
>("t3/automation/SandboxTargets", { defaultValue: () => undefined }) {}

export const layer = Layer.effect(
  SandboxTargets,
  Effect.gen(function* () {
    const available = yield* Effect.serviceOption(Allocations.Allocations);
    if (Option.isNone(available)) return undefined;
    const allocations = available.value;
    const worker = yield* WorkerTransport.WorkerTransport;
    const sql = yield* AutomationDatabase.AutomationDatabase;
    const crypto = yield* Crypto.Crypto;
    const commandId = Effect.fn("SandboxTargets.commandId")(function* (runId: string) {
      return `workflow-${Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(runId)).pipe(Effect.orDie))}`;
    });
    const validate = Effect.fn("SandboxTargets.validate")(function* (
      operatorId: string,
      profile: Profile,
      revision: string,
    ) {
      const available = yield* allocations.list(operatorId);
      const pinned = available.profiles.find(
        (value) => value.profileId === profile.profileId && value.revision === profile.revision,
      );
      if (!pinned?.enabled || pinned.checkout.commit !== revision)
        return yield* new FoundrySandboxError({ code: "invalid_request" });
    });
    const resolve = Effect.fn("SandboxTargets.resolve")(function* (
      identity: WorkerTransport.WorkerIdentity,
      profile: Profile,
      run: Run,
    ) {
      const allocation = yield* allocations
        .request(identity.operatorId, {
          commandId: yield* commandId(run.id),
          profileId: profile.profileId,
          revision: profile.revision,
          owner: { kind: "workflow", factoryId: run.factoryId, runId: run.id },
        })
        .pipe(
          Effect.catchTags({
            FoundrySandboxError: (error) =>
              error.code === "capacity" ? Effect.succeed(null) : Effect.fail(error),
          }),
        );
      if (!allocation) return { state: "waiting", reason: "sandbox_capacity_unavailable" } as const;
      if (allocation.state === "deleted")
        return { state: "failed", reason: "sandbox_deleted" } as const;
      if (
        allocation.state !== "ready" ||
        !allocation.deviceId ||
        !allocation.environmentId ||
        !allocation.projectId
      )
        return {
          state: "waiting",
          reason: `sandbox_${allocation.failure ?? allocation.state}`,
        } as const;
      const assigned = yield* worker.retargetSandbox(identity, {
        instanceId: identity.instanceId,
        operatorId: identity.operatorId,
        allocationId: allocation.allocationId,
        deviceId: allocation.deviceId,
        environmentId: allocation.environmentId,
      });
      return {
        state: "ready",
        identity: assigned,
        projectId: allocation.projectId,
      } as const;
    });
    const cancel = Effect.fn("SandboxTargets.cancel")(function* (
      operatorId: string,
      runId: string,
    ) {
      const existing = yield* allocations.findByCommand(operatorId, yield* commandId(runId));
      if (existing)
        yield* allocations.control(operatorId, existing.allocation.allocationId, "delete");
    });
    const reconcileCleanup = Effect.gen(function* () {
      const active = yield* allocations.activeWorkflowAllocations;
      yield* Effect.forEach(
        active,
        ({ operatorId, allocation }) =>
          Effect.gen(function* () {
            if (allocation.request.owner.kind !== "workflow") return;
            // Repairable v4 attempts keep their run active; exhausted runs are terminal.
            const rows = yield* sql`SELECT 1 FROM foundry_automation.dispatch_runs d
        JOIN foundry_automation.run_controls c ON c.run_id=d.run_id
        WHERE d.run_id=${allocation.request.owner.runId} AND (d.state IN ('succeeded','failed') OR c.mode='cancelled')`;
            if (rows.length)
              yield* allocations.control(operatorId, allocation.allocationId, "delete");
          }),
        { discard: true },
      );
    }).pipe(
      Effect.catchTags({
        SqlError: () => Effect.fail(new FoundrySandboxError({ code: "unavailable" })),
      }),
    );
    return { validate, resolve, cancel, reconcileCleanup };
  }),
);
