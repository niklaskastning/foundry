// @effect-diagnostics nodeBuiltinImport:off -- Stable reservation keys do not expose thread or command IDs as paths.
import * as NodeCrypto from "node:crypto";
import { type FoundryWorkspaceReservation, type FoundryWorkspaceError } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ServerConfig from "../../config.ts";
import * as ReservationStore from "./ReservationStore.ts";
import * as WorkspaceReservations from "./WorkspaceReservations.ts";
import * as WriterStopVerifier from "./WriterStopVerifier.ts";

const decodeRoots = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const key = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
interface WorkerInput {
  commandId: string;
  threadId: string;
  generation: number;
  repositoryPath: string;
  mode: "checkout" | "worktree";
}
export class WorkspaceGate extends Context.Reference<{
  readonly handoffs: ReservationStore.ReservationStore["Service"] | null;
  readonly reconcile: Effect.Effect<void>;
  readonly installReconciler: (
    effect: Effect.Effect<void>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly reserve: (
    input: WorkerInput,
  ) => Effect.Effect<FoundryWorkspaceReservation | null, FoundryWorkspaceError>;
  readonly prepare: (input: {
    threadId: string;
    runId: string;
    attemptId?: string;
    cwd: string | null;
  }) => Effect.Effect<boolean>;
  readonly starting: (input: {
    threadId: string;
    runId: string;
    attemptId?: string;
    cwd: string | null;
  }) => Effect.Effect<boolean>;
  readonly bindings: Effect.Effect<
    ReadonlyArray<ReservationStore.WriterBinding>,
    FoundryWorkspaceError
  >;
  readonly confirm: (requestId: string) => Effect.Effect<void, FoundryWorkspaceError>;
}>("t3/foundry/workspaces/WorkspaceGate", {
  defaultValue: () => ({
    handoffs: null,
    reconcile: Effect.void,
    installReconciler: () => Effect.void,
    reserve: () => Effect.succeed(null),
    prepare: () => Effect.succeed(true),
    starting: () => Effect.succeed(true),
    bindings: Effect.succeed([]),
    confirm: () => Effect.void,
  }),
}) {}

export const layer = (allowedRoots: ReadonlyArray<string>) =>
  Layer.effect(
    WorkspaceGate,
    Effect.gen(function* () {
      const store = yield* ReservationStore.ReservationStore;
      const reservations = yield* WorkspaceReservations.WorkspaceReservations;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const roots = yield* Effect.forEach(allowedRoots, (root) => fs.realPath(root));
      const rootFor = (cwd: string) =>
        roots.find((root) => {
          const relative = path.relative(root, cwd);
          return (
            relative === "" ||
            (relative !== ".." &&
              !relative.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relative))
          );
        });
      let refresh = Effect.void;
      const prepareStart = Effect.fn("WorkspaceGate.prepareStart")(
        (input: { threadId: string; runId: string; attemptId?: string; cwd: string | null }) =>
          Effect.gen(function* () {
            yield* refresh;
            if (input.cwd === null)
              return input.threadId.startsWith("foundry-launch:") ? false : null;
            const cwd = yield* fs.realPath(input.cwd);
            const root = rootFor(cwd);
            if (!(yield* store.handoffAllowed(input.threadId, cwd))) return false;
            if (!root) return input.threadId.startsWith("foundry-launch:") ? false : null;
            const bound = (yield* store.bindings).find(
              (binding) => binding.threadId === input.threadId && binding.commandId !== null,
            );
            let requestId: string;
            if (bound) {
              requestId = bound.requestId;
              const reservation = yield* store.read(requestId);
              if (reservation.workspacePath !== cwd) return false;
            } else {
              if (input.threadId.startsWith("foundry-launch:")) return false;
              requestId = `manual:${key(`${input.runId.length}:${input.runId}${input.attemptId ?? ""}`)}`;
              yield* reservations.reserve(
                {
                  requestId,
                  repositoryPath: cwd,
                  mode: "checkout",
                  managedRoot: root,
                },
                input.threadId,
              );
              yield* store.bind({
                requestId,
                threadId: input.threadId,
                commandId: null,
                generation: null,
              });
            }
            return requestId;
          }).pipe(Effect.orElseSucceed(() => false as const)),
      );
      return {
        handoffs: store,
        reconcile: Effect.suspend(() => refresh),
        // Provider sessions must exist before their verifier can be attached to the admission fence.
        installReconciler: Effect.fn("WorkspaceGate.installReconciler")(
          (effect: Effect.Effect<void>) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                refresh = effect;
              }),
              () =>
                Effect.sync(() => {
                  refresh = Effect.void;
                }),
            ),
        ),
        bindings: store.bindings,
        reserve: Effect.fn("WorkspaceGate.reserve")(function* (input: WorkerInput) {
          const requestId = `worker:${key(input.commandId)}`;
          const reservation = yield* reservations.reserve(
            {
              requestId,
              repositoryPath: input.repositoryPath,
              mode: input.mode,
              managedRoot: rootFor(input.repositoryPath) ?? "",
            },
            input.threadId,
          );
          yield* store.bind({
            requestId,
            threadId: input.threadId,
            commandId: input.commandId,
            generation: input.generation,
          });
          return reservation;
        }),
        prepare: Effect.fn("WorkspaceGate.prepare")((input) =>
          prepareStart(input).pipe(Effect.map((reservation) => reservation !== false)),
        ),
        starting: Effect.fn("WorkspaceGate.starting")((input) =>
          Effect.gen(function* () {
            const requestId = yield* prepareStart(input);
            if (requestId === false) return false;
            if (requestId === null) return true;
            return yield* store.enter(requestId, input.threadId, input.runId, input.attemptId);
          }).pipe(Effect.orElseSucceed(() => false)),
        ),
        confirm: Effect.fn("WorkspaceGate.confirm")(function* (requestId: string) {
          yield* store.confirm(requestId);
          yield* reservations.release(requestId);
        }),
      };
    }),
  );

export const layerConfigured = Layer.unwrap(
  Effect.gen(function* () {
    if (!(yield* Config.Boolean("FOUNDRY_WORKER_ENABLED").pipe(Config.withDefault(false))))
      return Layer.empty;
    if (
      !(yield* Config.String("FOUNDRY_WORKER_PROVIDER_INSTANCE_ID").pipe(
        Config.withDefault(""),
      )).trim()
    )
      return Layer.empty;
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const roots = yield* decodeRoots(
      yield* Config.String("FOUNDRY_WORKER_WORKSPACE_ROOTS").pipe(Config.withDefault("[]")),
    );
    const journal = ReservationStore.layer(path.join(config.stateDir, "foundry-workspaces.sqlite"));
    return layer(roots).pipe(
      Layer.provide(
        WorkspaceReservations.layer(roots).pipe(
          Layer.provide(WriterStopVerifier.layerBound.pipe(Layer.provide(journal))),
          Layer.provide(journal),
        ),
      ),
      Layer.provide(journal),
    );
  }),
);
