// @effect-diagnostics nodeBuiltinImport:off -- Assertions run inside the isolated PostgreSQL harness.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { exportFactoryFiles } from "@t3tools/shared/factoryDefinition";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as DispatchStore from "../src/automation/DispatchStore.ts";
import * as Control from "../src/automation/Control.ts";
import * as Inbox from "../src/automation/Inbox.ts";
import * as Scheduler from "../src/automation/Scheduler.ts";
import * as WorkerTransport from "../src/automation/WorkerTransport.ts";
import * as Database from "../src/automation/AutomationDatabase.ts";
import * as Definitions from "../src/automation/Definitions.ts";
import * as DefinitionSources from "../src/automation/DefinitionSources.ts";
import * as Factories from "../src/automation/Factories.ts";
import * as Workflows from "../src/automation/Workflows.ts";
import * as GitHubApp from "../src/automation/GitHubApp.ts";

const decodeBinding = Schema.decodeSync(Scheduler.DispatchBinding);

export const definitionSourceGates = Effect.fn("DefinitionSources.postgresGates")(function <E, E2>(
  database: Layer.Layer<Database.AutomationDatabase, E>,
  restart: Effect.Effect<void, E2>,
) {
  return Effect.gen(function* () {
    const testDatabase = database.pipe(Layer.orDie);
    let appGeneration = 1;
    const identity = {
      instanceId: "11111111-1111-4111-8111-111111111148",
      operatorId: "source-owner",
    };
    const location = {
      connectionId: "github-app" as const,
      repositoryId: 42,
      repository: "fixture/definitions",
      branch: "main",
      path: "factories",
    };
    const github = Layer.mock(GitHubApp.GitHubApp)({
      binding: () =>
        Effect.sync(() => ({ ...location, generation: appGeneration, baseBranch: "main" })),
    });
    const definitionsLayer = Definitions.layer.pipe(
      Layer.provideMerge(Workflows.layer.pipe(Layer.provideMerge(Factories.layer))),
    );
    const services = DefinitionSources.layer.pipe(
      Layer.provideMerge(definitionsLayer),
      Layer.provide(github),
      Layer.provide(testDatabase),
      Layer.provide(NodeCrypto.layer),
    );
    const call = <A, E3>(
      f: (service: DefinitionSources.DefinitionSources["Service"]) => Effect.Effect<A, E3>,
    ) => DefinitionSources.DefinitionSources.pipe(Effect.flatMap(f), Effect.provide(services));
    const local = <A, E3>(
      f: (service: Definitions.Definitions["Service"]) => Effect.Effect<A, E3>,
    ) => Definitions.Definitions.pipe(Effect.flatMap(f), Effect.provide(services));
    const query = <A, E3>(
      f: (sql: Database.AutomationDatabase["Service"]) => Effect.Effect<A, E3>,
    ) => Database.AutomationDatabase.pipe(Effect.flatMap(f), Effect.provide(testDatabase));
    const files = (factoryId: string, prompt = "Original") =>
      exportFactoryFiles({
        schemaVersion: 1,
        factoryId,
        repositories: ["source-repo"],
        workflows: [
          { id: "flow", steps: [{ id: "approval", kind: "approval", prompt, dependsOn: [] }] },
        ],
      });
    const runBinding = decodeBinding({
      identity: {
        ...identity,
        deviceId: "22222222-2222-4222-8222-222222222248",
        environmentId: "source-g11-worker",
        deviceGeneration: 1,
        accessGeneration: 1,
        automationGeneration: 1,
        clientSessionId: "source-g11-session",
        foundrySessionHash: "g".repeat(43),
      },
      projectId: "source-g11-isolated-project",
      model: "replay",
      checks: [],
      requiredArtifacts: [],
    });
    const runServices = Layer.mergeAll(Control.layer, Inbox.layer).pipe(
      Layer.provideMerge(DispatchStore.layer),
      Layer.provide(Workflows.layer.pipe(Layer.provideMerge(Factories.layer))),
      Layer.provide(testDatabase),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(
        Layer.succeed(Scheduler.SchedulerConfig, {
          deviceId: runBinding.identity.deviceId,
          environmentId: runBinding.identity.environmentId,
          allowedRunIds: [],
        }),
      ),
      Layer.provide(
        Layer.mock(WorkerTransport.WorkerTransport)({
          identityForRead: () => Effect.succeed(runBinding.identity),
          identityForWrite: () => Effect.succeed(runBinding.identity),
        }),
      ),
    );
    const request = HttpServerRequest.fromWeb(new Request("http://source-g11.invalid"));
    const dispatch = <A, E3>(
      f: (service: DispatchStore.DispatchStore["Service"]) => Effect.Effect<A, E3>,
    ) => DispatchStore.DispatchStore.pipe(Effect.flatMap(f), Effect.provide(runServices));
    const startRun = Effect.fn("DefinitionSources.startGateRun")(function* (
      id: string,
      definition: typeof initial,
    ) {
      yield* Factories.Factories.pipe(
        Effect.flatMap((factories) =>
          factories.createWorkItem({
            commandId: `${id}-work`,
            id: `${id}-work`,
            factoryId,
            versionId: definition.factoryVersionId,
            repository: "source-repo",
            title: id,
            source: { kind: "manual", reference: "g11-isolated" },
          }),
        ),
        Effect.provide(services),
      );
      return yield* dispatch((store) =>
        store.startManual(
          {
            commandId: id,
            id,
            factoryId,
            workItemId: `${id}-work`,
            workflowVersionId: definition.workflowVersions[0]!.versionId,
            revision: "input",
          },
          runBinding.identity.deviceId,
          runBinding,
          runBinding.identity,
        ),
      );
    });
    const factoryId = "source-gates";
    const scopeVersionId = "source-scope";
    yield* Effect.gen(function* () {
      const factories = yield* Factories.Factories;
      yield* factories.createFactory({
        commandId: "source-create",
        id: factoryId,
        name: "Definition source gates",
      });
      yield* factories.createVersion({
        commandId: scopeVersionId,
        id: scopeVersionId,
        factoryId,
        repositories: ["source-repo"],
      });
    }).pipe(Effect.provide(services));
    const localInput = {
      commandId: "source-local",
      factoryId,
      scopeVersionId,
      expectedVersionId: null,
      source: { kind: "foundry" as const, reference: "fixture" },
      files: files(factoryId),
    };
    let initial = yield* local((service) => service.activate(localInput));
    const originalLocal = initial;
    NodeAssert.equal(
      (yield* local((service) =>
        service.activate({
          ...localInput,
          source: {
            kind: "github",
            reference: "forged",
            repositoryId: 42,
            repository: "fixture/definitions",
            branch: "main",
            path: "",
            commitSha: "a".repeat(40),
          },
        } as unknown as typeof localInput),
      ).pipe(Effect.flip)).reason,
      "invalid_input",
    );
    const configure = {
      commandId: "source-configure",
      factoryId,
      scopeVersionId,
      expectedVersionId: initial.id,
      expectedContentHash: initial.contentHash,
      location,
    };
    let binding = yield* call((service) => service.configure(configure, identity));
    NodeAssert.deepEqual(yield* call((service) => service.configure(configure, identity)), binding);
    NodeAssert.equal(
      (yield* call((service) =>
        service.configure({ ...configure, location: { ...location, path: "elsewhere" } }, identity),
      ).pipe(Effect.flip)).reason,
      "command_conflict",
    );
    NodeAssert.equal(
      (yield* call((service) =>
        service.configure(configure, { ...identity, operatorId: "intruder" }),
      ).pipe(Effect.flip)).reason,
      "forbidden",
    );
    yield* call((service) =>
      service.accept(binding, { commitSha: "a".repeat(40), files: files(factoryId, "Drift") }, 100),
    );
    const driftId = (yield* call((service) => service.source(factoryId)))!.selectedRevisionId!;
    const drift = (yield* call((service) => service.readRevision(factoryId, driftId))).revision;
    NodeAssert.equal(
      (yield* call((service) =>
        service.activateRevision(
          {
            commandId: "source-drift",
            factoryId,
            revisionId: drift.id,
            expectedGeneration: binding.generation,
            expectedVersionId: initial.id,
          },
          identity,
        ),
      ).pipe(Effect.flip)).reason,
      "version_conflict",
    );
    initial = yield* local((service) =>
      service.activate({
        ...localInput,
        commandId: "source-local-after-binding",
        expectedVersionId: initial.id,
      }),
    );
    const refresh = {
      ...configure,
      commandId: "source-refresh-basis",
      expectedGeneration: binding.generation,
      expectedVersionId: initial.id,
      expectedContentHash: initial.contentHash,
    };
    binding = yield* call((service) => service.configure(refresh, identity));
    NodeAssert.equal(binding.importVersionId, initial.id);
    NodeAssert.equal(
      (yield* call((service) =>
        service.configure({ ...refresh, commandId: "source-stale-refresh" }, identity),
      ).pipe(Effect.flip)).reason,
      "version_conflict",
    );
    yield* call((service) =>
      service.accept(binding, { commitSha: "b".repeat(40), files: files(factoryId) }, 200),
    );
    binding = (yield* call((service) => service.source(factoryId)))!;
    const revisionId = binding.selectedRevisionId!;
    const activate = {
      commandId: "source-activate",
      factoryId,
      revisionId,
      expectedGeneration: binding.generation,
      expectedVersionId: initial.id,
    };
    const first = yield* call((service) => service.activateRevision(activate, identity));
    NodeAssert.equal(first.source.kind, "github");
    NodeAssert.equal(first.source.kind === "github" && first.source.commitSha, "b".repeat(40));
    yield* startRun("source-old-run", first);
    NodeAssert.deepEqual(
      yield* call((service) => service.activateRevision(activate, identity)),
      first,
    );
    NodeAssert.equal(
      (yield* local((service) =>
        service.activate({
          ...localInput,
          commandId: "source-bypass",
          expectedVersionId: first.id,
        }),
      ).pipe(Effect.flip)).reason,
      "version_conflict",
    );
    NodeAssert.deepEqual(yield* local((service) => service.activate(localInput)), originalLocal);
    yield* call((service) =>
      service.accept(binding, { commitSha: "c".repeat(40), files: files(factoryId) }, 300),
    );
    yield* call((service) => service.fail(binding, "late failure", 400));
    NodeAssert.equal(
      (yield* call((service) => service.listRevisions(factoryId, undefined, 100))).items.length,
      2,
    );
    NodeAssert.equal((yield* call((service) => service.source(factoryId)))!.status, "ready");
    binding = (yield* call((service) => service.source(factoryId)))!;
    yield* call((service) =>
      service.accept(
        binding,
        { commitSha: "d".repeat(40), files: [{ path: "factory.yaml", content: "broken: [" }] },
        400,
      ),
    );
    const invalid = (yield* call((service) => service.source(factoryId)))!.selectedRevisionId!;
    NodeAssert.equal(
      (yield* call((service) => service.readRevision(factoryId, invalid))).revision.valid,
      false,
    );
    NodeAssert.equal(
      (yield* call((service) =>
        service.activateRevision(
          {
            commandId: "source-invalid",
            factoryId,
            revisionId: invalid,
            expectedGeneration: binding.generation,
            expectedVersionId: first.id,
          },
          identity,
        ),
      ).pipe(Effect.flip)).reason,
      "invalid_definition",
    );
    NodeAssert.equal(
      Option.getOrThrow(yield* local((service) => service.active(factoryId))).id,
      first.id,
    );
    const sync = { commandId: "source-sync", factoryId, expectedGeneration: binding.generation };
    binding = yield* call((service) => service.requestSync(sync, identity));
    NodeAssert.deepEqual(yield* call((service) => service.requestSync(sync, identity)), binding);
    yield* call((service) =>
      service.accept(binding, { commitSha: "e".repeat(40), files: files(factoryId, "Next") }, 500),
    );
    const nextRevision = (yield* call((service) => service.source(factoryId)))!.selectedRevisionId!;
    const second = yield* call((service) =>
      service.activateRevision(
        {
          commandId: "source-second",
          factoryId,
          revisionId: nextRevision,
          expectedGeneration: binding.generation,
          expectedVersionId: first.id,
        },
        identity,
      ),
    );
    binding = (yield* call((service) => service.source(factoryId)))!;
    yield* call((service) =>
      service.accept(
        binding,
        {
          commitSha: "9".repeat(40),
          files: [{ path: "factory.yaml", content: "broken: [" }],
        },
        550,
      ),
    );
    NodeAssert.equal(
      Option.getOrThrow(yield* local((service) => service.active(factoryId))).id,
      second.id,
    );
    NodeAssert.equal(second.source.kind === "github" && second.source.commitSha, "e".repeat(40));
    yield* startRun("source-run", second);
    const old = yield* dispatch((store) => store.read(factoryId, "source-old-run"));
    NodeAssert.equal(old.run.factoryVersionId, first.factoryVersionId);
    const oldStep = old.workflow.steps[0]!;
    NodeAssert.equal(oldStep.kind, "approval");
    NodeAssert.equal(oldStep.kind === "approval" && oldStep.prompt, "Original");
    binding = (yield* call((service) => service.source(factoryId)))!;
    const rollback = yield* call((service) =>
      service.activateRevision(
        {
          commandId: "source-rollback",
          factoryId,
          revisionId,
          expectedGeneration: binding.generation,
          expectedVersionId: second.id,
        },
        identity,
      ),
    );
    NodeAssert.deepEqual(rollback, first);
    NodeAssert.equal(
      (yield* query(
        (sql) =>
          sql<{
            id: string;
          }>`SELECT factory_version_id AS id FROM foundry_automation.runs WHERE id='source-run'`,
      ))[0]!.id,
      second.factoryVersionId,
    );
    yield* Effect.gen(function* () {
      const store = yield* DispatchStore.DispatchStore;
      const inbox = yield* Inbox.Inbox;
      const control = yield* Control.Control;
      for (const runId of ["source-old-run", "source-run"]) {
        const claim = yield* store.claimNext({
          workerId: runBinding.identity.deviceId,
          owner: "source-g11",
          leaseMillis: 60000,
        });
        NodeAssert.ok(claim);
        NodeAssert.equal(claim.run.id, runId);
        yield* store.wait(claim, "approval_required");
        const page = yield* inbox.query(request, { factoryId, kind: "approval", status: "open" });
        const entry = page.items.find((item) => item.runId === runId)!;
        NodeAssert.ok(entry);
        NodeAssert.equal(entry.detail, runId === "source-old-run" ? "Original" : "Next");
        const decision = {
          commandId: `${runId}-approve`,
          factoryId,
          runId,
          action: "approve" as const,
          stepId: entry.stepId!,
          expectedRevision: entry.expectedRevision,
          resultRevision: entry.resultRevision,
        };
        const receipt = yield* control.execute(request, decision);
        NodeAssert.deepEqual(yield* control.execute(request, decision), receipt);
        NodeAssert.equal(yield* store.completeApproval(claim, 0, `${runId}-approval`), true);
        NodeAssert.equal(
          (yield* inbox.query(request, {
            factoryId,
            kind: "approval",
            status: "open",
          })).items.some((item) => item.runId === runId),
          false,
        );
        const pinned = yield* store.read(factoryId, runId);
        NodeAssert.equal(
          pinned.run.factoryVersionId,
          runId === "source-old-run" ? first.factoryVersionId : second.factoryVersionId,
        );
        yield* store.release(claim);
      }
    }).pipe(Effect.provide(runServices));
    binding = (yield* call((service) => service.source(factoryId)))!;
    yield* call((service) =>
      service.accept(
        binding,
        { commitSha: "b".repeat(40), files: files(factoryId, "Cannot replace immutable content") },
        600,
      ),
    );
    NodeAssert.deepEqual(
      (yield* call((service) => service.readRevision(factoryId, revisionId))).files,
      files(factoryId),
    );
    NodeAssert.equal(
      (yield* query(
        (sql) =>
          sql<{
            count: number;
          }>`SELECT count(*)::int AS count FROM foundry_automation.definition_versions WHERE factory_id=${factoryId} AND source->>'reference'=${revisionId}`,
      ))[0]!.count,
      1,
    );
    const paused = yield* call((service) =>
      service.setEnabled(
        {
          commandId: "source-pause",
          factoryId,
          expectedGeneration: binding.generation,
          enabled: false,
        },
        identity,
      ),
    );
    yield* call((service) =>
      service.accept(binding, { commitSha: "f".repeat(40), files: files(factoryId) }, 700),
    );
    NodeAssert.equal(
      (yield* call((service) => service.activateRevision(activate, identity)).pipe(Effect.flip))
        .reason,
      "forbidden",
    );
    NodeAssert.equal(
      (yield* call((service) => service.requestSync(sync, identity)).pipe(Effect.flip)).reason,
      "forbidden",
    );
    appGeneration = 2;
    NodeAssert.equal(
      (yield* call((service) => service.configure(configure, identity)).pipe(Effect.flip)).reason,
      "forbidden",
    );
    binding = yield* call((service) =>
      service.setEnabled(
        {
          commandId: "source-reauthorize",
          factoryId,
          expectedGeneration: paused.generation,
          enabled: true,
        },
        identity,
      ),
    );
    NodeAssert.equal(binding.appGeneration, 2);
    appGeneration = 3;
    NodeAssert.equal(
      (yield* call((service) =>
        service.accept(binding, { commitSha: "f".repeat(40), files: files(factoryId) }, 800),
      ).pipe(Effect.flip)).reason,
      "forbidden",
    );
    NodeAssert.equal(
      (yield* call((service) => service.activateRevision(activate, identity)).pipe(Effect.flip))
        .reason,
      "forbidden",
    );
    binding = yield* call((service) =>
      service.setEnabled(
        {
          commandId: "source-revoked-pause",
          factoryId,
          expectedGeneration: binding.generation,
          enabled: false,
        },
        identity,
      ),
    );
    NodeAssert.equal(binding.enabled, false);
    appGeneration = 2;
    yield* restart;
    NodeAssert.deepEqual(yield* call((service) => service.source(factoryId)), binding);
    for (const [runId, definition] of [
      ["source-old-run", first],
      ["source-run", second],
    ] as const) {
      const persisted = yield* dispatch((store) => store.read(factoryId, runId));
      NodeAssert.equal(persisted.run.factoryVersionId, definition.factoryVersionId);
      NodeAssert.equal(persisted.state, "succeeded");
    }
    NodeAssert.deepEqual(
      yield* local((service) => service.readVersion(factoryId, second.id)),
      second,
    );
    const page = yield* call((service) => service.listRevisions(factoryId, undefined, 3));
    NodeAssert.equal(page.items.length, 3);
    NodeAssert.ok(page.next);
    const rest = yield* call((service) => service.listRevisions(factoryId, page.next!, 2));
    NodeAssert.equal(rest.items.length, 2);
    NodeAssert.equal(rest.next, null);
    NodeAssert.equal(
      new Set([...page.items, ...rest.items].map((revision) => revision.id)).size,
      5,
    );
    NodeAssert.equal(
      (yield* call((service) => service.due(0, 20))).some((item) => item.factoryId === factoryId),
      false,
    );
    yield* Effect.gen(function* () {
      const factories = yield* Factories.Factories;
      yield* factories.createFactory({
        commandId: "source-new-create",
        id: "source-new",
        name: "Empty factory import",
      });
      yield* factories.createVersion({
        commandId: "source-new-scope",
        id: "source-new-scope",
        factoryId: "source-new",
        repositories: ["source-repo"],
      });
    }).pipe(Effect.provide(services));
    const fresh = yield* call((service) =>
      service.configure(
        {
          commandId: "source-new-configure",
          factoryId: "source-new",
          scopeVersionId: "source-new-scope",
          expectedVersionId: null,
          expectedContentHash: null,
          location,
        },
        identity,
      ),
    );
    yield* call((service) =>
      service.accept(fresh, { commitSha: "a".repeat(40), files: files("source-new") }, 900),
    );
    NodeAssert.equal(Option.isNone(yield* local((service) => service.active("source-new"))), true);
    const freshRevision = (yield* call((service) => service.source("source-new")))!
      .selectedRevisionId!;
    const imported = yield* call((service) =>
      service.activateRevision(
        {
          commandId: "source-new-activate",
          factoryId: "source-new",
          revisionId: freshRevision,
          expectedGeneration: fresh.generation,
          expectedVersionId: null,
        },
        identity,
      ),
    );
    NodeAssert.equal(imported.source.kind, "github");
    const currentSource = (yield* call((service) => service.source("source-new")))!;
    const moved = yield* call((service) =>
      service.configure(
        {
          commandId: "source-change-branch",
          factoryId: "source-new",
          scopeVersionId: fresh.scopeVersionId,
          expectedGeneration: currentSource.generation,
          expectedVersionId: imported.id,
          expectedContentHash: imported.contentHash,
          location: { ...location, branch: "review" },
        },
        identity,
      ),
    );
    yield* call((service) =>
      Effect.all(
        [
          service.accept(moved, { commitSha: "a".repeat(40), files: files("source-new") }, 1000),
          service.accept(moved, { commitSha: "a".repeat(40), files: files("source-new") }, 1000),
        ],
        { concurrency: 2 },
      ),
    );
    const movedRevision = (yield* call((service) => service.source("source-new")))!
      .selectedRevisionId!;
    NodeAssert.notEqual(movedRevision, freshRevision);
    NodeAssert.equal(
      (yield* call((service) => service.readRevision("source-new", freshRevision))).revision
        .location?.branch,
      "main",
    );
    NodeAssert.equal(
      (yield* call((service) => service.readRevision("source-new", movedRevision))).revision
        .location?.branch,
      "review",
    );
    const duplicates = yield* query(
      (sql) =>
        sql<{
          count: number;
        }>`SELECT count(*)::int AS count FROM foundry_automation.definition_git_revisions WHERE factory_id='source-new'`,
    );
    NodeAssert.equal(duplicates[0]!.count, 2);
    NodeAssert.equal(
      Option.getOrNull(yield* local((service) => service.active("source-new")))?.id,
      imported.id,
    );

    for (const table of [
      "definition_git_revisions",
      "definition_source_commands",
      "definition_versions",
    ]) {
      const privilege = yield* query(
        (sql) =>
          sql<{
            update: boolean;
            delete: boolean;
          }>`SELECT has_table_privilege(current_user,${`foundry_automation.${table}`},'UPDATE') AS update,has_table_privilege(current_user,${`foundry_automation.${table}`},'DELETE') AS delete`,
      );
      NodeAssert.equal(privilege[0]!.update, false);
      NodeAssert.equal(privilege[0]!.delete, false);
    }
  });
});
