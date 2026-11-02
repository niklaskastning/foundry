// @effect-diagnostics nodeBuiltinImport:off -- Stable digests isolate worker command keys from ordinary T3 commands.
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  ThreadId,
  ProviderInstanceId,
  type FoundryWorkerLaunchInput,
  type FoundryWorkerLaunchReceipt,
  FoundryWorkerLaunchError,
  FoundryWorkerReadError,
  type FoundryWorkerReadInput,
  type FoundryWorkerExecution,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import { WorkerReadiness } from "./WorkerReadiness.ts";

const decodeRoots = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const isReadError = Schema.is(FoundryWorkerReadError);
const isLaunchError = Schema.is(FoundryWorkerLaunchError);
const readFailure = (code: FoundryWorkerReadError["code"]) => new FoundryWorkerReadError({ code });
const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
export function workerLaunchIds(input: FoundryWorkerLaunchInput, binding: string) {
  const key = digest(input.commandId);
  return {
    commandId: CommandId.make(`foundry-launch:${key}`),
    threadId: ThreadId.make(
      `foundry-launch:${digest(JSON.stringify([1, key, binding, input.projectId, input.title, input.model, input.prompt]))}`,
    ),
  };
}
const failure = (code: FoundryWorkerLaunchError["code"]) => new FoundryWorkerLaunchError({ code });
export class WorkerLaunch extends Context.Service<
  WorkerLaunch,
  {
    readonly read: (
      input: FoundryWorkerReadInput,
    ) => Effect.Effect<FoundryWorkerExecution, FoundryWorkerReadError>;
    readonly launch: (
      input: FoundryWorkerLaunchInput,
    ) => Effect.Effect<FoundryWorkerLaunchReceipt, FoundryWorkerLaunchError>;
  }
>()("t3/foundry/WorkerLaunch") {}

export const layer = Layer.effect(
  WorkerLaunch,
  Effect.gen(function* () {
    const enabled = yield* Config.Boolean("FOUNDRY_WORKER_ENABLED").pipe(Config.withDefault(false));
    const binding = yield* Config.String("FOUNDRY_WORKER_PROVIDER_INSTANCE_ID").pipe(
      Config.withDefault(""),
    );
    const rootsJson = yield* Config.String("FOUNDRY_WORKER_WORKSPACE_ROOTS").pipe(
      Config.withDefault("[]"),
    );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projects = yield* ProjectService.ProjectService;
    const managed = yield* ManagedProjectFolders.ManagedProjectFolders;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const eventsStore = yield* EventStore.EventStoreV2;
    const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
    const readiness = yield* WorkerReadiness;
    return {
      read: Effect.fn("WorkerLaunch.read")(
        function* (input: FoundryWorkerReadInput) {
          if (!enabled) return yield* readFailure("not_enabled");
          const commandId = CommandId.make(`foundry-launch:${digest(input.commandId)}`);
          const initial = yield* receipts.getByCommandId(commandId);
          const messageKey = CommandId.make(`${commandId}:initial-message`);
          const accepted = yield* receipts.getByCommandId(messageKey);
          if (Option.isNone(initial) || Option.isNone(accepted))
            return yield* readFailure("not_found");
          if (
            initial.value.commandType !== "thread.create" ||
            initial.value.status !== "accepted" ||
            accepted.value.commandType !== "message.dispatch" ||
            accepted.value.status !== "accepted" ||
            initial.value.threadId !== accepted.value.threadId ||
            initial.value.resultSequence >= accepted.value.resultSequence
          )
            return yield* readFailure("read_failed");
          const receipt = accepted.value;
          const events = yield* eventsStore.readByCommandId({ commandId: messageKey }).pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "run.created" &&
                stored.event.threadId === receipt.threadId &&
                stored.sequence > initial.value.resultSequence &&
                stored.sequence <= receipt.resultSequence,
            ),
            Stream.runCollect,
          );
          const event = events.length === 1 ? events[0]?.event : undefined;
          if (event?.type !== "run.created") return yield* readFailure("read_failed");
          const records = yield* threads.getThreadRecords(receipt.threadId, ["runs"], {
            runIds: [event.payload.id],
          });
          const run = records.runs.find((candidate) => candidate.id === event.payload.id);
          if (!run) return yield* readFailure("read_failed");
          return {
            receipt: {
              commandId: input.commandId,
              threadId: receipt.threadId,
              acceptedAt: DateTime.formatIso(receipt.acceptedAt),
              sequence: receipt.resultSequence,
            },
            run: { id: run.id, status: run.status, checkpointId: run.checkpointId },
          };
        },
        Effect.mapError((error) => (isReadError(error) ? error : readFailure("read_failed"))),
      ),
      launch: Effect.fn("WorkerLaunch.launch")(
        function* (input: FoundryWorkerLaunchInput) {
          if (!enabled || !binding) return yield* failure("not_enabled");
          const project = yield* projects.getById(input.projectId);
          if (
            Option.isNone(project) ||
            project.value.deletedAt !== null ||
            (yield* managed.isScratchProject(input.projectId))
          )
            return yield* failure("project_denied");
          const roots = yield* decodeRoots(rootsJson).pipe(
            Effect.mapError(() => failure("project_denied")),
          );
          const workspace = yield* fs
            .realPath(project.value.workspaceRoot)
            .pipe(Effect.mapError(() => failure("project_denied")));
          const allowed = yield* Effect.forEach(roots, (root) =>
            Effect.gen(function* () {
              if (!path.isAbsolute(root)) return false;
              const canonical = yield* fs.realPath(root);
              const relative = path.relative(canonical, workspace);
              return (
                relative === "" ||
                (!relative.startsWith(`..${path.sep}`) &&
                  relative !== ".." &&
                  !path.isAbsolute(relative))
              );
            }).pipe(Effect.orElseSucceed(() => false)),
          );
          if (!allowed.some(Boolean)) return yield* failure("project_denied");
          const ids = workerLaunchIds(input, binding);
          const initial = yield* receipts.getByCommandId(ids.commandId);
          if (
            Option.isSome(initial) &&
            (initial.value.threadId !== ids.threadId ||
              initial.value.commandType !== "thread.create" ||
              initial.value.status !== "accepted")
          )
            return yield* failure("command_conflict");
          const messageKey = CommandId.make(`${ids.commandId}:initial-message`);
          const receipt = yield* receipts.getByCommandId(messageKey);
          const toReceipt = (
            value: CommandReceipts.CommandReceiptV2,
          ): FoundryWorkerLaunchReceipt => ({
            commandId: input.commandId,
            threadId: value.threadId,
            acceptedAt: DateTime.formatIso(value.acceptedAt),
            sequence: value.resultSequence,
          });
          if (Option.isSome(receipt)) {
            if (
              Option.isNone(initial) ||
              receipt.value.threadId !== ids.threadId ||
              receipt.value.commandType !== "message.dispatch" ||
              receipt.value.status !== "accepted"
            )
              return yield* failure("command_conflict");
            return toReceipt(receipt.value);
          }
          if (
            !(yield* threads.isProviderInstanceEnabledForProject({
              projectId: input.projectId,
              instanceId: ProviderInstanceId.make(binding),
            }))
          )
            return yield* failure("provider_disabled");
          const status = yield* readiness.read();
          if (!status.providerReady || status.providerInstanceId !== binding)
            return yield* failure("provider_not_ready");
          yield* launches.launch({
            ...ids,
            projectId: input.projectId,
            title: input.title,
            modelSelection: { instanceId: ProviderInstanceId.make(binding), model: input.model },
            runtimeMode: "approval-required",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            initialMessage: { text: input.prompt, attachments: [] },
            createdBy: "system",
            creationSource: "server",
          });
          const accepted = yield* receipts.getByCommandId(messageKey);
          if (
            Option.isNone(accepted) ||
            accepted.value.threadId !== ids.threadId ||
            accepted.value.commandType !== "message.dispatch" ||
            accepted.value.status !== "accepted"
          )
            return yield* failure("launch_failed");
          return toReceipt(accepted.value);
        },
        Effect.mapError((error) => (isLaunchError(error) ? error : failure("launch_failed"))),
      ),
    };
  }),
);
