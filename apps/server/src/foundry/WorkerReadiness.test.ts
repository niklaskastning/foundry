import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as ProjectService from "../project/ProjectService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ExecutionStore from "./ExecutionStore.ts";
import { WorkerReadiness, layer, providerState, supportsDefinitionV4 } from "./WorkerReadiness.ts";

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
  for (const [version, supported] of [
    ["0.165.9", false],
    ["0.166.0", true],
    ["codex-cli 0.166.0", true],
    ["1.0.0", true],
    ["unknown", false],
    [null, false],
  ] as const)
    assert.strictEqual(supportsDefinitionV4(version), supported);
});

function fixture(input: {
  enabled?: boolean;
  binding?: string;
  providers?: ReadonlyArray<ServerProvider>;
  runs?: number;
  capacity?: number;
  countFails?: boolean;
  workspace?: string;
  projectEnabled?: boolean;
  scratch?: boolean;
  missing?: boolean;
}) {
  return layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({ realPath: (path) => Effect.succeed(path) }),
        Path.layer,
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) =>
            Effect.succeed(
              input.missing
                ? Option.none()
                : Option.some({
                    id,
                    title: "Fixture",
                    workspaceRoot: input.workspace ?? "/allowed/repo",
                    defaultModelSelection: null,
                    scripts: [],
                    deletedAt: null,
                    createdAt: "1970-01-01T00:00:00.000Z",
                    updatedAt: "1970-01-01T00:00:00.000Z",
                  }),
            ),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/allowed",
          isScratchProject: () => Effect.succeed(input.scratch ?? false),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          isProviderInstanceEnabledForProject: () => Effect.succeed(input.projectEnabled ?? true),
        }),
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              FOUNDRY_WORKER_WORKSPACE_ROOTS: JSON.stringify(["/allowed"]),
              FOUNDRY_WORKER_ENABLED: String(input.enabled ?? true),
              FOUNDRY_WORKER_PROVIDER_INSTANCE_ID: input.binding ?? instanceId,
              FOUNDRY_WORKER_CAPACITY: String(input.capacity ?? 1),
            },
          }),
        ),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          refreshInstance: (bound: ProviderInstanceId) => {
            assert.strictEqual(bound, input.binding ?? instanceId);
            return Effect.succeed(input.providers ?? [ready]);
          },
        }),
        Layer.mock(ExecutionStore.ExecutionStore)({
          occupied: input.countFails
            ? Effect.fail(new ExecutionStore.ExecutionStoreError({ cause: "fixture" }))
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
          { runs: 1, capacity: 2 },
          { capacityAvailable: true, capacity: 2, occupied: 1, free: 1 },
        ],
        [
          { runs: 2, capacity: 2 },
          { capacityAvailable: false, capacity: 2, occupied: 2, free: 0 },
        ],
        [
          { runs: 3, capacity: 2 },
          { capacityAvailable: false, occupied: 3, free: 0 },
        ],
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
        [{ workspace: "/allowed/repo" }, { projectReady: true }],
        [{ workspace: "/allowed-other/repo" }, { projectReady: false }],
        [{ missing: true }, { projectReady: false }],
        [{ scratch: true }, { projectReady: false }],
        [{ projectEnabled: false }, { projectReady: false }],
      ] as const) {
        const result = yield* Effect.flatMap(WorkerReadiness, (service) =>
          service.read(ProjectId.make("fixture-project")),
        ).pipe(Effect.provide(fixture(input)));
        assert.deepInclude(result, { online: true, ...expected });
      }
    }),
);

it.effect("rejects disabled workers and stale registry recovery", () =>
  Effect.gen(function* () {
    for (const [input, code] of [
      [{ enabled: false }, "not_enabled"],
      [{ capacity: 0 }, "probe_failed"],
      [{ capacity: 9 }, "probe_failed"],
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
