import {
  FoundryWorkerError,
  type FoundryWorkerStatus,
  ProviderInstanceId,
  type ProjectId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProjectService from "../project/ProjectService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ExecutionStore from "./ExecutionStore.ts";

const decodeRoots = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
export function supportsDefinitionV4(version: string | null | undefined) {
  const parts = /^(?:codex-cli\s+)?v?(\d+)\.(\d+)\.\d+(?:[-+].*)?$/.exec(version ?? "");
  return parts !== null && (Number(parts[1]) > 0 || Number(parts[2]) >= 166);
}

export function providerState(
  provider: ServerProvider | undefined,
): FoundryWorkerStatus["providerState"] {
  if (!provider) return "missing";
  if (provider.driver !== "codex") return "unsupported_provider";
  if (!provider.enabled || provider.status === "disabled") return "disabled";
  if (!provider.installed) return "not_installed";
  if (provider.auth.status === "unauthenticated") return "login_required";
  if (provider.auth.status !== "authenticated") return "auth_unknown";
  if (
    !provider.version ||
    !provider.compatibilityAdvisory ||
    provider.compatibilityAdvisory.status === "unknown"
  )
    return "version_unknown";
  if (
    provider.compatibilityAdvisory.status !== "supported" &&
    provider.compatibilityAdvisory.status !== "graceful"
  )
    return "incompatible";
  if (provider.availability === "unavailable" || provider.status !== "ready") return "unavailable";
  return "ready";
}

export class WorkerReadiness extends Context.Service<
  WorkerReadiness,
  {
    readonly read: (
      projectId?: ProjectId,
    ) => Effect.Effect<FoundryWorkerStatus, FoundryWorkerError>;
  }
>()("t3/foundry/WorkerReadiness") {}

export const layer = Layer.effect(
  WorkerReadiness,
  Effect.gen(function* () {
    const enabled = yield* Config.Boolean("FOUNDRY_WORKER_ENABLED").pipe(Config.withDefault(false));
    const capacity = yield* Config.Int("FOUNDRY_WORKER_CAPACITY").pipe(Config.withDefault(1));
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
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const executions = yield* ExecutionStore.ExecutionStore;
    const projectReady = Effect.fn("WorkerReadiness.projectReady")(
      function* (projectId: ProjectId) {
        const project = yield* projects.getById(projectId);
        if (
          !binding ||
          Option.isNone(project) ||
          project.value.deletedAt !== null ||
          Boolean(project.value.archivedAt) ||
          (yield* managed.isScratchProject(projectId))
        )
          return false;
        if (
          !(yield* threads.isProviderInstanceEnabledForProject({
            projectId,
            instanceId: ProviderInstanceId.make(binding),
          }))
        )
          return false;
        const workspace = yield* fs.realPath(project.value.workspaceRoot);
        const roots = yield* decodeRoots(rootsJson);
        for (const root of roots) {
          if (!path.isAbsolute(root)) continue;
          const canonical = yield* fs.realPath(root);
          const relative = path.relative(canonical, workspace);
          if (
            relative === "" ||
            (!relative.startsWith(`..${path.sep}`) &&
              relative !== ".." &&
              !path.isAbsolute(relative))
          )
            return true;
        }
        return false;
      },
      Effect.orElseSucceed(() => false),
    );
    return {
      read: Effect.fn("WorkerReadiness.read")(function* (projectId?: ProjectId) {
        if (!enabled) return yield* new FoundryWorkerError({ code: "not_enabled" });
        if (capacity < 1 || capacity > 8)
          return yield* new FoundryWorkerError({ code: "probe_failed" });
        const started = yield* Clock.currentTimeMillis;
        const instanceId = binding ? ProviderInstanceId.make(binding) : null;
        const providers = instanceId
          ? yield* registry.refreshInstance(instanceId).pipe(
              Effect.timeout("30 seconds"),
              Effect.mapError(() => new FoundryWorkerError({ code: "probe_failed" })),
            )
          : [];
        const provider = providers.find((entry) => entry.instanceId === instanceId);
        // Registry recovery can return an older cached snapshot after a failed probe.
        if (provider && !(Date.parse(provider.checkedAt) >= started))
          return yield* new FoundryWorkerError({ code: "probe_failed" });
        const state = instanceId ? providerState(provider) : "unbound";
        const occupied = yield* executions.occupied.pipe(Effect.orElseSucceed(() => null));
        return {
          online: true as const,
          ...(projectId ? { projectReady: yield* projectReady(projectId) } : {}),
          roleExecutionVersion: 1 as const,
          parallelExecutionVersion: 1 as const,
          ...(state === "ready" && supportsDefinitionV4(provider?.version)
            ? { definitionExecutionVersion: 4 as const }
            : {}),
          capacity,
          occupied,
          free: occupied === null ? null : Math.max(0, capacity - occupied),
          models: (provider?.models ?? []).map((model) => ({
            id: model.slug,
            aliases: model.aliases ?? [],
            reasoningEfforts:
              model.capabilities?.optionDescriptors?.flatMap((option) =>
                option.id === "reasoningEffort" && option.type === "select"
                  ? option.options.map((choice) => choice.id)
                  : [],
              ) ?? [],
          })),
          providerInstanceId: instanceId,
          providerReady: state === "ready",
          providerState: state,
          version: provider?.version ?? null,
          checkedAt: DateTime.formatIso(yield* DateTime.now),
          capacityAvailable: occupied === null ? null : occupied < capacity,
          activeRuns: occupied,
        };
      }),
    };
  }),
);
