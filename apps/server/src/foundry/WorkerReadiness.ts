import {
  FoundryWorkerError,
  type FoundryWorkerStatus,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

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
    readonly read: () => Effect.Effect<FoundryWorkerStatus, FoundryWorkerError>;
  }
>()("t3/foundry/WorkerReadiness") {}

export const layer = Layer.effect(
  WorkerReadiness,
  Effect.gen(function* () {
    const enabled = yield* Config.Boolean("FOUNDRY_WORKER_ENABLED").pipe(Config.withDefault(false));
    const binding = yield* Config.String("FOUNDRY_WORKER_PROVIDER_INSTANCE_ID").pipe(
      Config.withDefault(""),
    );
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return {
      read: Effect.fn("WorkerReadiness.read")(function* () {
        if (!enabled) return yield* new FoundryWorkerError({ code: "not_enabled" });
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
        const activeRuns = yield* projections
          .countActiveRuns()
          .pipe(Effect.orElseSucceed(() => null));
        return {
          online: true as const,
          providerInstanceId: instanceId,
          providerReady: state === "ready",
          providerState: state,
          version: provider?.version ?? null,
          checkedAt: DateTime.formatIso(yield* DateTime.now),
          capacityAvailable: activeRuns === null ? null : activeRuns === 0,
          activeRuns,
        };
      }),
    };
  }),
);
