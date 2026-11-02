import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { WorkerReadiness, layer, providerState } from "./WorkerReadiness.ts";

const instanceId = ProviderInstanceId.make("codex-worker");
const ready: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  checkedAt: "1970-01-01T00:00:00.000Z",
  auth: { status: "authenticated" },
  models: [],
  skills: [],
  slashCommands: [],
  compatibilityAdvisory: {
    status: "supported",
    message: null,
    recommendedVersion: null,
    recommendedRange: null,
  },
};

it("keeps installation, authentication, compatibility and availability failures distinct", () => {
  const cases: Array<[Partial<ServerProvider>, ReturnType<typeof providerState>]> = [
    [{}, "ready"],
    [{ installed: false }, "not_installed"],
    [{ enabled: false }, "disabled"],
    [{ auth: { status: "unauthenticated" } }, "login_required"],
    [{ auth: { status: "unknown" } }, "auth_unknown"],
    [{ version: null }, "version_unknown"],
    [
      { compatibilityAdvisory: { ...ready.compatibilityAdvisory!, status: "unknown" } },
      "version_unknown",
    ],
    [
      { compatibilityAdvisory: { ...ready.compatibilityAdvisory!, status: "broken" } },
      "incompatible",
    ],
    [{ availability: "unavailable" }, "unavailable"],
    [{ status: "warning" }, "unavailable"],
    [{ driver: ProviderDriverKind.make("devReplay") }, "unsupported_provider"],
  ];
  assert.strictEqual(providerState(undefined), "missing");
  for (const [changes, expected] of cases)
    assert.strictEqual(providerState({ ...ready, ...changes }), expected);
});

function fixture(input: {
  enabled?: boolean;
  binding?: string;
  providers?: ReadonlyArray<ServerProvider>;
  runs?: number;
  countFails?: boolean;
}) {
  return layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              FOUNDRY_WORKER_ENABLED: String(input.enabled ?? true),
              FOUNDRY_WORKER_PROVIDER_INSTANCE_ID: input.binding ?? instanceId,
            },
          }),
        ),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          refreshInstance: (bound: ProviderInstanceId) => {
            assert.strictEqual(bound, input.binding ?? instanceId);
            return Effect.succeed(input.providers ?? [ready]);
          },
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          countActiveRuns: () =>
            input.countFails
              ? Effect.fail(new ProjectionStore.ProjectionStoreSetupError({}))
              : Effect.succeed(input.runs ?? 0),
        }),
      ),
    ),
  );
}

it.effect(
  "separates reachable worker, provider readiness and run capacity without fallback binding",
  () =>
    Effect.gen(function* () {
      for (const [input, expected] of [
        [{}, { providerReady: true, capacityAvailable: true, providerState: "ready" }],
        [{ runs: 1 }, { providerReady: true, capacityAvailable: false, activeRuns: 1 }],
        [
          { providers: [{ ...ready, auth: { status: "unauthenticated" as const } }] },
          { providerReady: false, capacityAvailable: true, providerState: "login_required" },
        ],
        [
          { providers: [{ ...ready, instanceId: ProviderInstanceId.make("other") }] },
          { providerReady: false, providerState: "missing" },
        ],
        [
          { binding: "" },
          { providerReady: false, providerState: "unbound", providerInstanceId: null },
        ],
        [{ countFails: true }, { providerReady: true, capacityAvailable: null, activeRuns: null }],
      ] as const) {
        const result = yield* Effect.flatMap(WorkerReadiness, (service) => service.read()).pipe(
          Effect.provide(fixture(input)),
        );
        assert.deepInclude(result, { online: true, ...expected });
      }
    }),
);

it.effect("rejects disabled workers and stale registry recovery", () =>
  Effect.gen(function* () {
    for (const [input, code] of [
      [{ enabled: false }, "not_enabled"],
      [{ providers: [{ ...ready, checkedAt: "1969-12-31T23:59:59.000Z" }] }, "probe_failed"],
    ] as const) {
      const error = yield* Effect.flatMap(WorkerReadiness, (service) => service.read()).pipe(
        Effect.provide(fixture(input)),
        Effect.flip,
      );
      assert.deepInclude(error, { code });
    }
  }),
);
