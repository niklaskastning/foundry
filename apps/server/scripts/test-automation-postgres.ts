import { v4Gates } from "./test-automation-v4-gates.ts";
import * as McpBindings from "../src/automation/McpBindings.ts";
import { parallelGates } from "./test-automation-parallel-gates.ts";
import { handoffGates } from "./test-automation-handoff-gates.ts";
import { definitionSourceGates } from "./test-automation-definition-source-gates.ts";
import { triggerGates } from "./test-automation-trigger-gates.ts";
import * as Publish from "../src/automation/Publish.ts";
// @effect-diagnostics nodeBuiltinImport:off -- The isolated harness owns its temporary cluster and filesystem.
// @effect-diagnostics globalProcess:off -- Only a PostgreSQL binary directory is read from the environment.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Console from "effect/Console";
import * as Option from "effect/Option";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { exportFactoryFiles } from "@t3tools/shared/factoryDefinition";
import * as Database from "../src/automation/AutomationDatabase.ts";
import * as Migrations from "../src/automation/AutomationMigrations.ts";
import * as Factories from "../src/automation/Factories.ts";
import * as Workflows from "../src/automation/Workflows.ts";
import * as Definitions from "../src/automation/Definitions.ts";
import { applicationGates } from "./test-automation-application-gates.ts";
import * as Control from "../src/automation/Control.ts";
import {
  FoundryArchiveEvent,
  FoundryWorkerExecution,
  EnvironmentId,
  AutomationTriggerError,
  type AutomationControlCommand,
  type StartAutomationRun,
} from "@t3tools/contracts";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as DispatchStore from "../src/automation/DispatchStore.ts";
import * as Scheduler from "../src/automation/Scheduler.ts";
import * as WorkerTransport from "../src/automation/WorkerTransport.ts";
import * as ThreadArchive from "../src/foundry/ThreadArchive.ts";
import * as InstanceDatabase from "../src/foundry/InstanceDatabase.ts";
import * as InstanceMigrations from "../src/foundry/InstanceMigrations.ts";
import * as ArtifactFiles from "../src/foundry/ArtifactFiles.ts";
import * as Artifacts from "../src/foundry/Artifacts.ts";
import * as Schema from "effect/Schema";
const decodeDispatchBinding = Schema.decodeUnknownSync(Scheduler.DispatchBinding);
const bin = process.env.FOUNDRY_TEST_PG_BIN;
NodeAssert.ok(
  bin,
  "Set FOUNDRY_TEST_PG_BIN to a PostgreSQL 17+ bin directory; no existing database is used.",
);
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "foundry-automation-pg-"));
const data = NodePath.join(root, "data");
const path = NodePath.join(root, ".s.PGSQL.5432");
let child: NodeChildProcess.ChildProcess | undefined;

async function start() {
  const server = NodeChildProcess.spawn(
    NodePath.join(bin!, "postgres"),
    ["-D", data, "-k", root, "-c", "listen_addresses=", "-c", "fsync=on"],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" } },
  );
  child = server;
  await new Promise<void>((resolve, reject) => {
    let output = "";
    server.once("error", reject);
    server.once("exit", (code) =>
      reject(new Error(`Isolated PostgreSQL exited before readiness (${code}). ${output}`)),
    );
    server.stderr!.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4000);
      if (output.includes("database system is ready to accept connections")) resolve();
    });
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const server = child;
  const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
  server.kill("SIGQUIT");
  await exited;
  child = undefined;
}

const db = (username: string) => Database.layer({ path, username, database: "postgres" });
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const query = (statement: string, username = "fixture_admin") =>
  run(
    Effect.gen(function* () {
      const sql = yield* Database.AutomationDatabase;
      return yield* sql.unsafe<Record<string, unknown>>(statement);
    }).pipe(Effect.provide(db(username))),
  );
const migration = Migrations.AutomationMigrations.pipe(
  Effect.flatMap((s) => s.migrate("automation_runtime")),
  Effect.provide(Migrations.layer.pipe(Layer.provide(db("automation_migrator")))),
);
const call = <A, E>(f: (s: Factories.Factories["Service"]) => Effect.Effect<A, E>) =>
  run(
    Factories.Factories.pipe(
      Effect.flatMap(f),
      Effect.provide(Factories.layer.pipe(Layer.provide(db("automation_runtime")))),
    ),
  );
const workflowCall = <A, E>(f: (s: Workflows.Workflows["Service"]) => Effect.Effect<A, E>) =>
  run(
    Workflows.Workflows.pipe(
      Effect.flatMap(f),
      Effect.provide(
        Workflows.layer.pipe(
          Layer.provide(Factories.layer),
          Layer.provide(db("automation_runtime")),
        ),
      ),
    ),
  );
const dispatchCall = <A, E>(
  f: (s: DispatchStore.DispatchStore["Service"]) => Effect.Effect<A, E>,
) =>
  run(
    DispatchStore.DispatchStore.pipe(
      Effect.flatMap(f),
      Effect.provide(
        DispatchStore.layer.pipe(
          Layer.provide(Workflows.layer.pipe(Layer.provideMerge(Factories.layer))),
          Layer.provide(db("automation_runtime")),
        ),
      ),
    ),
  );
const failure = async (promise: Promise<unknown>, reason: string) => {
  await NodeAssert.rejects(
    promise,
    (error: unknown) =>
      typeof error === "object" && error !== null && "reason" in error && error.reason === reason,
  );
};
const definitionCall = <A, E>(f: (s: Definitions.Definitions["Service"]) => Effect.Effect<A, E>) =>
  run(
    Definitions.Definitions.pipe(
      Effect.flatMap(f),
      Effect.provide(
        Definitions.layer.pipe(
          Layer.provide(Workflows.layer.pipe(Layer.provideMerge(Factories.layer))),
          Layer.provide(db("automation_runtime")),
          Layer.provide(NodeCrypto.layer),
        ),
      ),
    ),
  );
try {
  const initialized = NodeChildProcess.spawnSync(
    NodePath.join(bin, "initdb"),
    ["-D", data, "-U", "fixture_admin", "--auth=trust", "--no-locale"],
    { encoding: "utf8" },
  );
  NodeAssert.equal(initialized.status, 0, initialized.stderr);
  await start();
  for (const statement of [
    "CREATE ROLE automation_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    "CREATE ROLE automation_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    "REVOKE ALL ON DATABASE postgres FROM PUBLIC",
    "GRANT CONNECT,CREATE ON DATABASE postgres TO automation_migrator",
    "GRANT CONNECT ON DATABASE postgres TO automation_runtime",
    "REVOKE ALL ON SCHEMA public FROM PUBLIC",
    "CREATE SCHEMA foundry_instance",
    "CREATE TABLE foundry_instance.fixture(id text PRIMARY KEY, version integer)",
    "INSERT INTO foundry_instance.fixture VALUES('existing-instance',5)",
  ])
    await query(statement);
  const instanceBefore = await query("SELECT * FROM foundry_instance.fixture");
  await run(Effect.all([migration, migration], { concurrency: "unbounded" }));
  await run(migration);
  for (const statement of [
    "DROP TABLE foundry_automation.evaluation_results,foundry_automation.evaluation_queue",
    "ALTER TABLE foundry_automation.runs DROP CONSTRAINT runs_factory_id_unique",
    "DROP INDEX foundry_automation.definition_git_revision_location_commit",
    "ALTER TABLE foundry_automation.definition_git_revisions DROP COLUMN location, ADD CONSTRAINT definition_git_revisions_factory_id_commit_sha_key UNIQUE(factory_id,commit_sha)",
    "UPDATE foundry_automation.schema_version SET version=11",
  ]) await query(statement, "automation_migrator");
  await run(Effect.all([migration, migration], { concurrency: "unbounded" }));
  NodeAssert.equal((await query("SELECT version FROM foundry_automation.schema_version"))[0]?.version, 12);
  const factory = { commandId: "create-a", id: "a", name: "Factory A" };
  const factories = await Promise.all(
    Array.from({ length: 8 }, () => call((s) => s.createFactory(factory))),
  );
  NodeAssert.equal(new Set(factories.map((f) => f.id)).size, 1);
  await call((s) => s.createFactory({ commandId: "create-b", id: "b", name: "Factory B" }));
  await call((s) =>
    s.createVersion({
      commandId: "version-a1",
      id: "a1",
      factoryId: "a",
      repositories: ["repo-a"],
    }),
  );
  await call((s) =>
    s.createVersion({
      commandId: "version-b1",
      id: "b1",
      factoryId: "b",
      repositories: ["repo-b"],
    }),
  );
  const work = {
    commandId: "work-1",
    id: "w1",
    factoryId: "a",
    versionId: "a1",
    repository: "repo-a",
    title: "Do work",
    source: { kind: "manual" as const, reference: "local-request" },
  };
  const items = await Promise.all(
    Array.from({ length: 12 }, () => call((s) => s.createWorkItem(work))),
  );
  NodeAssert.equal(new Set(items.map((w) => w.id)).size, 1);
  NodeAssert.equal((await query("SELECT * FROM foundry_automation.work_items")).length, 1);
  await failure(
    call((s) => s.createWorkItem({ ...work, title: "changed" })),
    "command_conflict",
  );
  await failure(
    call((s) => s.createFactory({ ...factory, id: "other" })),
    "command_conflict",
  );
  await failure(
    call((s) =>
      s.createWorkItem({ ...work, commandId: "foreign-version", id: "foreign", versionId: "b1" }),
    ),
    "not_found",
  );
  await failure(
    call((s) =>
      s.createWorkItem({ ...work, commandId: "foreign-repo", id: "foreign", repository: "repo-b" }),
    ),
    "scope_mismatch",
  );
  NodeAssert.equal(
    (
      await query(
        "SELECT * FROM foundry_automation.commands WHERE id IN ('foreign-version','foreign-repo')",
      )
    ).length,
    0,
  );
  await failure(
    call((s) => s.readWorkItem("b", "w1")),
    "not_found",
  );
  await call((s) =>
    s.createVersion({
      commandId: "version-a2",
      id: "a2",
      factoryId: "a",
      repositories: ["repo-new"],
    }),
  );
  NodeAssert.deepEqual((await call((s) => s.readVersion("a", "a1"))).repositories, ["repo-a"]);
  NodeAssert.equal((await call((s) => s.readWorkItem("a", "w1"))).versionId, "a1");
  await call((s) => s.setArchived("a", true));
  await failure(
    call((s) => s.withStartEligibility("a", "w1", Effect.void)),
    "archived",
  );
  NodeAssert.equal((await call((s) => s.readFactory("b"))).archived, false);
  await call((s) =>
    s.createWorkItem({
      ...work,
      commandId: "work-b",
      id: "wb",
      factoryId: "b",
      versionId: "b1",
      repository: "repo-b",
    }),
  );
  await call((s) => s.withStartEligibility("b", "wb", Effect.void));
  await call((s) => s.setWorkItemState("a", "w1", "completed"));
  NodeAssert.equal((await call((s) => s.createWorkItem(work))).state, "completed");
  await stop();
  await start();
  await failure(
    call((s) => s.withStartEligibility("a", "w1", Effect.void)),
    "archived",
  );
  NodeAssert.equal((await call((s) => s.readWorkItem("a", "w1"))).state, "completed");
  NodeAssert.equal((await call((s) => s.createWorkItem(work))).id, "w1");
  await call((s) => s.setArchived("a", false));
  await call((s) => s.withStartEligibility("a", "w1", Effect.void));
  const workflow = {
    commandId: "workflow-a1",
    id: "flow-a1",
    factoryId: "a",
    factoryVersionId: "a1",
    steps: [
      { id: "implement", kind: "agent" as const, dependsOn: [], prompt: "Fixture input" },
      { id: "check", kind: "test" as const, dependsOn: ["implement"], checkId: "unit" },
      { id: "review", kind: "approval" as const, dependsOn: ["check"], prompt: "Fixture decision" },
      {
        id: "publish",
        kind: "publish" as const,
        dependsOn: ["review"],
        target: "pull_request" as const,
      },
    ],
  };
  const beforeUpgrade = await call((s) => s.readWorkItem("a", "w1"));
  // Reconstruct the deployed v1 schema around existing P18a data before testing its upgrade.
  for (const statement of [
    "DROP TABLE foundry_automation.evaluation_results,foundry_automation.evaluation_queue",
    "ALTER TABLE foundry_automation.runs DROP CONSTRAINT runs_factory_id_unique",
    "DROP TABLE foundry_automation.dispatch_capacity,foundry_automation.handoff_commands,foundry_automation.work_item_handoffs,foundry_automation.definition_sources,foundry_automation.definition_git_revisions,foundry_automation.definition_source_commands",
    "DROP TABLE foundry_automation.publish_operations,foundry_automation.trigger_commands,foundry_automation.trigger_admissions,foundry_automation.trigger_events,foundry_automation.unattended_grants,foundry_automation.trigger_bindings",
    "DROP TABLE foundry_automation.inbox_marks,foundry_automation.inbox_entries,foundry_automation.inbox_commands,foundry_automation.manual_admissions,foundry_automation.run_questions,foundry_automation.run_decisions,foundry_automation.control_commands,foundry_automation.run_controls,foundry_automation.dispatch_outbox,foundry_automation.step_attempts,foundry_automation.dispatch_workers,foundry_automation.dispatch_runs",
    "DROP TABLE foundry_automation.definition_heads,foundry_automation.definition_versions,foundry_automation.outbox,foundry_automation.runs,foundry_automation.workflow_versions",
    "ALTER TABLE foundry_automation.work_items DROP CONSTRAINT work_items_factory_id_id_key",
    "UPDATE foundry_automation.schema_version SET version=1",
  ])
    await query(statement, "automation_migrator");
  await run(Effect.all([migration, migration], { concurrency: "unbounded" }));
  NodeAssert.deepEqual(await call((s) => s.readWorkItem("a", "w1")), beforeUpgrade);
  NodeAssert.equal(
    (await query("SELECT version FROM foundry_automation.schema_version"))[0]?.version,
    12,
  );
  const definitions = await Promise.all(
    Array.from({ length: 8 }, () => workflowCall((s) => s.createVersion(workflow))),
  );
  NodeAssert.deepEqual(definitions[0]?.steps, workflow.steps);
  NodeAssert.equal((await query("SELECT * FROM foundry_automation.workflow_versions")).length, 1);
  for (const steps of [
    [],
    [workflow.steps[0]!, workflow.steps[0]!],
    [{ ...workflow.steps[0]!, dependsOn: ["missing"] }],
    [{ ...workflow.steps[0]!, dependsOn: ["check"] }, workflow.steps[1]!],
    [workflow.steps[0]!, { ...workflow.steps[1]!, dependsOn: ["implement", "implement"] }],
  ])
    await failure(
      workflowCall((s) =>
        s.createVersion({ ...workflow, commandId: "bad-flow", id: "bad-flow", steps }),
      ),
      "invalid_input",
    );
  await failure(
    workflowCall((s) =>
      s.createVersion({
        ...workflow,
        commandId: "foreign-definition",
        id: "foreign-definition",
        factoryVersionId: "b1",
      }),
    ),
    "not_found",
  );
  await failure(
    workflowCall((s) => s.createVersion({ ...workflow, steps: [workflow.steps[0]!] })),
    "command_conflict",
  );
  const startInput = {
    commandId: "start-a1",
    id: "run-a1",
    factoryId: "a",
    workItemId: "w1",
    workflowVersionId: "flow-a1",
    revision: "input-revision-1",
  };
  const unsupportedDefinition = {
    ...workflow,
    commandId: "unsupported-flow",
    credentials: "fixture",
  };
  await failure(
    workflowCall((s) => s.createVersion(unsupportedDefinition)),
    "invalid_input",
  );
  const unsupportedStart = { ...startInput, commandId: "unsupported-start", grant: "fixture" };
  await failure(
    workflowCall((s) => s.start(unsupportedStart)),
    "invalid_input",
  );
  const runs = await Promise.all(
    Array.from({ length: 12 }, () => workflowCall((s) => s.start(startInput))),
  );
  NodeAssert.equal(new Set(runs.map((r) => r.id)).size, 1);
  NodeAssert.deepEqual(runs[0], {
    id: "run-a1",
    factoryId: "a",
    workItemId: "w1",
    workflowVersionId: "flow-a1",
    factoryVersionId: "a1",
    repository: "repo-a",
    revision: "input-revision-1",
    state: "pending",
  });
  NodeAssert.deepEqual(await workflowCall((s) => s.readOutbox("a", "run-a1")), [
    { id: "start-a1", runId: "run-a1", kind: "run.created", payload: { runId: "run-a1" } },
  ]);
  await failure(
    workflowCall((s) => s.start({ ...startInput, revision: "changed" })),
    "command_conflict",
  );
  await failure(
    workflowCall((s) => s.start({ ...startInput, commandId: "create-a" })),
    "command_conflict",
  );
  await failure(
    workflowCall((s) => s.readRun("b", "run-a1")),
    "not_found",
  );
  await failure(
    workflowCall((s) => s.readOutbox("b", "run-a1")),
    "not_found",
  );
  await workflowCall((s) =>
    s.createVersion({
      ...workflow,
      commandId: "workflow-a2",
      id: "flow-a2",
      factoryVersionId: "a2",
    }),
  );
  await failure(
    workflowCall((s) =>
      s.start({
        ...startInput,
        commandId: "out-of-scope",
        id: "out-of-scope",
        workflowVersionId: "flow-a2",
      }),
    ),
    "scope_mismatch",
  );
  await call((s) =>
    s.createVersion({
      commandId: "version-a3",
      id: "a3",
      factoryId: "a",
      repositories: ["repo-a"],
    }),
  );
  await workflowCall((s) =>
    s.createVersion({
      ...workflow,
      commandId: "workflow-a3",
      id: "flow-a3",
      factoryVersionId: "a3",
      steps: [workflow.steps[0]!],
    }),
  );
  await workflowCall((s) =>
    s.start({
      ...startInput,
      commandId: "start-a3",
      id: "run-a3",
      workflowVersionId: "flow-a3",
      revision: "input-revision-2",
    }),
  );
  NodeAssert.deepEqual(await workflowCall((s) => s.readRun("a", "run-a1")), runs[0]);
  NodeAssert.deepEqual(
    (await workflowCall((s) => s.readVersion("a", "flow-a1"))).steps,
    workflow.steps,
  );
  NodeAssert.equal((await workflowCall((s) => s.readRun("a", "run-a3"))).workItemId, "w1");
  await call((s) => s.setArchived("a", true));
  NodeAssert.deepEqual(await workflowCall((s) => s.start(startInput)), runs[0]);
  await failure(
    workflowCall((s) =>
      s.start({ ...startInput, commandId: "archived-start", id: "archived-start" }),
    ),
    "archived",
  );
  await call((s) => s.setArchived("a", false));
  await query(
    "CREATE FUNCTION foundry_automation.fail_fixture_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected after run insert'; END $$",
    "automation_migrator",
  );
  await query(
    "CREATE TRIGGER fail_fixture_outbox BEFORE INSERT ON foundry_automation.outbox FOR EACH ROW EXECUTE FUNCTION foundry_automation.fail_fixture_outbox()",
    "automation_migrator",
  );
  await failure(
    workflowCall((s) =>
      s.start({ ...startInput, commandId: "rollback-start", id: "rollback-run" }),
    ),
    "unavailable",
  );
  for (const statement of [
    "SELECT * FROM foundry_automation.runs WHERE id='rollback-run'",
    "SELECT * FROM foundry_automation.outbox WHERE run_id='rollback-run'",
    "SELECT * FROM foundry_automation.commands WHERE id IN ('rollback-start','archived-start','out-of-scope','bad-flow','foreign-definition','unsupported-flow','unsupported-start')",
  ])
    NodeAssert.equal((await query(statement)).length, 0);
  await query(
    "DROP TRIGGER fail_fixture_outbox ON foundry_automation.outbox",
    "automation_migrator",
  );
  await query("DROP FUNCTION foundry_automation.fail_fixture_outbox()", "automation_migrator");
  await workflowCall((s) =>
    s.start({ ...startInput, commandId: "rollback-start", id: "rollback-run" }),
  );
  await stop();
  await start();
  NodeAssert.deepEqual(await workflowCall((s) => s.start(startInput)), runs[0]);
  NodeAssert.equal((await workflowCall((s) => s.readOutbox("a", "run-a1"))).length, 1);
  NodeAssert.equal((await query("SELECT * FROM foundry_automation.runs")).length, 3);
  NodeAssert.equal((await call((s) => s.readWorkItem("a", "w1"))).state, "completed");
  for (const statement of [
    "DROP TABLE foundry_automation.evaluation_results,foundry_automation.evaluation_queue",
    "ALTER TABLE foundry_automation.runs DROP CONSTRAINT runs_factory_id_unique",
    "DROP TABLE foundry_automation.dispatch_capacity,foundry_automation.handoff_commands,foundry_automation.work_item_handoffs,foundry_automation.definition_sources,foundry_automation.definition_git_revisions,foundry_automation.definition_source_commands",
    "DROP TABLE foundry_automation.publish_operations,foundry_automation.trigger_commands,foundry_automation.trigger_admissions,foundry_automation.trigger_events,foundry_automation.unattended_grants,foundry_automation.trigger_bindings",
    "DROP TABLE foundry_automation.inbox_marks,foundry_automation.inbox_entries,foundry_automation.inbox_commands,foundry_automation.manual_admissions,foundry_automation.run_questions,foundry_automation.run_decisions,foundry_automation.control_commands,foundry_automation.run_controls,foundry_automation.dispatch_outbox,foundry_automation.step_attempts,foundry_automation.dispatch_workers,foundry_automation.dispatch_runs",
    "DROP TABLE foundry_automation.definition_heads,foundry_automation.definition_versions",
    "ALTER TABLE foundry_automation.workflow_versions DROP COLUMN execution",
    "UPDATE foundry_automation.schema_version SET version=2",
  ])
    await query(statement, "automation_migrator");
  await run(migration);
  NodeAssert.deepEqual(await workflowCall((s) => s.readRun("a", "run-a1")), runs[0]);
  const activation = {
    commandId: "activate-a1",
    factoryId: "a",
    scopeVersionId: "a1",
    expectedVersionId: null,
    files: exportFactoryFiles({
      schemaVersion: 1,
      factoryId: "a",
      repositories: ["repo-a"],
      workflows: [
        { id: "main", steps: workflow.steps },
        { id: "quick", steps: [workflow.steps[0]!] },
      ],
    }),
    source: { kind: "files" as const, reference: "fixture-import" },
  };
  NodeAssert.ok(Option.isNone(await definitionCall((s) => s.active("a"))));
  const activated = await Promise.all(
    Array.from({ length: 8 }, () => definitionCall((s) => s.activate(activation))),
  );
  const initialDefinition = activated[0]!;
  NodeAssert.equal(new Set(activated.map((item) => item.id)).size, 1);
  NodeAssert.equal(initialDefinition.workflowVersions.length, 2);
  NodeAssert.equal(initialDefinition.commandId, activation.commandId);
  NodeAssert.equal(initialDefinition.scopeVersionId, activation.scopeVersionId);
  for (const version of initialDefinition.workflowVersions) {
    const persisted = await workflowCall((s) => s.readVersion("a", version.versionId));
    NodeAssert.equal(persisted.factoryVersionId, initialDefinition.factoryVersionId);
    NodeAssert.deepEqual(
      persisted.steps,
      initialDefinition.definition.workflows.find((item) => item.id === version.id)?.steps,
    );
  }
  NodeAssert.match(initialDefinition.contentHash, /^[a-f0-9]{64}$/);
  NodeAssert.deepEqual(initialDefinition.source, activation.source);
  const exportedFiles = await definitionCall((s) => s.exportVersion("a", initialDefinition.id));
  const pinnedRun = await workflowCall((s) =>
    s.start({
      ...startInput,
      commandId: "definition-run",
      id: "definition-run",
      workflowVersionId: initialDefinition.workflowVersions[0]!.versionId,
    }),
  );
  NodeAssert.equal(pinnedRun.factoryVersionId, initialDefinition.factoryVersionId);
  const roundtrip = await definitionCall((s) =>
    s.activate({
      ...activation,
      commandId: "roundtrip",
      expectedVersionId: initialDefinition.id,
      files: exportedFiles,
      source: { kind: "foundry", reference: "roundtrip" },
    }),
  );
  NodeAssert.equal(roundtrip.contentHash, initialDefinition.contentHash);
  NodeAssert.deepEqual(roundtrip.definition, initialDefinition.definition);
  if (initialDefinition.definition.schemaVersion === 4)
    throw new Error("Expected legacy definition fixture");
  const legacyInitialDefinition = initialDefinition.definition;
  const edits = await Promise.allSettled(
    ["left", "right"].map((edit) =>
      definitionCall((s) =>
        s.activate({
          ...activation,
          commandId: "edit-" + edit,
          expectedVersionId: roundtrip.id,
          files: exportFactoryFiles({
            ...legacyInitialDefinition,
            workflows: [
              {
                id: "main",
                steps: [{ id: "implement", kind: "agent", dependsOn: [], prompt: edit }],
              },
            ],
          }),
        }),
      ),
    ),
  );
  NodeAssert.equal(edits.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = edits.find((item) => item.status === "rejected");
  NodeAssert.ok(rejected?.status === "rejected" && rejected.reason.reason === "version_conflict");
  const current = await definitionCall((s) => s.active("a"));
  NodeAssert.ok(Option.isSome(current));
  if (Option.isNone(current)) throw new Error("Missing active definition");
  NodeAssert.notEqual(current.value.contentHash, initialDefinition.contentHash);
  const invalidPathFiles = exportedFiles.map((file) =>
    file.path === "factory.yaml"
      ? { ...file, content: file.content.replace("workflows/main.yaml", "../private.yaml") }
      : file,
  );
  await failure(
    definitionCall((s) =>
      s.activate({
        ...activation,
        commandId: "bad-path-activation",
        expectedVersionId: current.value.id,
        files: invalidPathFiles,
      }),
    ),
    "invalid_definition",
  );
  const invalidReferenceFiles = exportedFiles.map((file) =>
    file.path === "workflows/main.yaml"
      ? { ...file, content: file.content.replace("dependsOn: []", "dependsOn: [missing]") }
      : file,
  );
  await failure(
    definitionCall((s) =>
      s.activate({
        ...activation,
        commandId: "bad-reference-activation",
        expectedVersionId: current.value.id,
        files: invalidReferenceFiles,
      }),
    ),
    "invalid_definition",
  );
  await failure(
    definitionCall((s) =>
      s.activate({
        ...activation,
        commandId: "bad-scope-activation",
        expectedVersionId: current.value.id,
        scopeVersionId: "a2",
      }),
    ),
    "scope_mismatch",
  );
  await failure(
    definitionCall((s) =>
      s.activate({
        ...activation,
        commandId: "bad-factory-activation",
        factoryId: "b",
        expectedVersionId: null,
      }),
    ),
    "scope_mismatch",
  );
  const credentialsFiles = exportedFiles.map((file) =>
    file.path === "factory.yaml"
      ? { ...file, content: file.content + "credentials: fixture-secret\ngrants: [admin]\n" }
      : file,
  );
  await failure(
    definitionCall((s) =>
      s.activate({
        ...activation,
        commandId: "credentials-activation",
        expectedVersionId: current.value.id,
        files: credentialsFiles,
      }),
    ),
    "invalid_definition",
  );
  NodeAssert.deepEqual(await definitionCall((s) => s.active("a")), current);
  NodeAssert.deepEqual(await workflowCall((s) => s.readRun("a", "definition-run")), pinnedRun);
  NodeAssert.deepEqual(await definitionCall((s) => s.activate(activation)), initialDefinition);
  await failure(
    definitionCall((s) =>
      s.activate({ ...activation, source: { kind: "files", reference: "changed" } }),
    ),
    "command_conflict",
  );
  await failure(
    definitionCall((s) => s.readVersion("b", initialDefinition.id)),
    "not_found",
  );
  const historyCounts =
    "SELECT 'factory' AS kind,count(*) AS n FROM foundry_automation.versions UNION ALL SELECT 'workflow',count(*) FROM foundry_automation.workflow_versions UNION ALL SELECT 'definition',count(*) FROM foundry_automation.definition_versions UNION ALL SELECT 'command',count(*) FROM foundry_automation.commands ORDER BY kind";
  const historyBeforeFailure = await query(historyCounts);
  await query(
    "CREATE FUNCTION foundry_automation.fail_fixture_activation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected activation failure'; END $$",
    "automation_migrator",
  );
  await query(
    "CREATE TRIGGER fail_fixture_activation BEFORE UPDATE ON foundry_automation.definition_heads FOR EACH ROW EXECUTE FUNCTION foundry_automation.fail_fixture_activation()",
    "automation_migrator",
  );
  await failure(
    definitionCall((s) =>
      s.activate({
        ...activation,
        commandId: "rollback-activation",
        expectedVersionId: current.value.id,
      }),
    ),
    "unavailable",
  );
  NodeAssert.deepEqual(await definitionCall((s) => s.active("a")), current);
  NodeAssert.deepEqual(await query(historyCounts), historyBeforeFailure);
  await query(
    "DROP TRIGGER fail_fixture_activation ON foundry_automation.definition_heads",
    "automation_migrator",
  );
  await query("DROP FUNCTION foundry_automation.fail_fixture_activation()", "automation_migrator");
  const restoredDefinition = await definitionCall((s) =>
    s.activate({
      ...activation,
      commandId: "rollback-activation",
      expectedVersionId: current.value.id,
    }),
  );
  NodeAssert.equal(restoredDefinition.contentHash, initialDefinition.contentHash);
  await stop();
  await start();
  const restoredActive = await definitionCall((s) => s.active("a"));
  NodeAssert.ok(Option.isSome(restoredActive));
  if (Option.isSome(restoredActive)) NodeAssert.deepEqual(restoredActive.value, restoredDefinition);
  NodeAssert.deepEqual(await workflowCall((s) => s.readRun("a", "definition-run")), pinnedRun);
  const roleDefinition = {
    schemaVersion: 2 as const,
    factoryId: "a",
    repositories: ["repo-a"],
    defaults: {
      provider: "codex" as const,
      model: "fixture-default",
      options: { reasoningEffort: "low" as const },
    },
    roles: [
      {
        id: "implementer",
        name: "Implementer",
        description: "Implement changes",
        instructions: "Preserve behavior.",
        skills: ["verification"],
      },
    ],
    skills: [{ id: "verification", name: "Verification", instructions: "Run focused tests." }],
    workflows: [
      {
        id: "build",
        steps: [
          {
            id: "work",
            kind: "agent" as const,
            dependsOn: [],
            role: "implementer",
            prompt: "Build the requested change.",
          },
        ],
      },
      {
        id: "repair",
        steps: [
          {
            id: "work",
            kind: "agent" as const,
            dependsOn: [],
            role: "implementer",
            prompt: "Repair the reported issue.",
            execution: { options: { reasoningEffort: "high" as const } },
          },
        ],
      },
    ],
  };
  const roleVersion = await definitionCall((s) =>
    s.activate({
      ...activation,
      commandId: "role-v1",
      expectedVersionId: restoredDefinition.id,
      files: exportFactoryFiles(roleDefinition),
    }),
  );
  const roleWorkflow = await workflowCall((s) =>
    s.readVersion("a", roleVersion.workflowVersions[0]!.versionId),
  );
  const roleRun = await workflowCall((s) =>
    s.start({
      ...startInput,
      commandId: "role-run-v1",
      id: "role-run-v1",
      workflowVersionId: roleWorkflow.id,
    }),
  );
  NodeAssert.equal(roleWorkflow.steps[0]?.kind, "agent");
  if (roleWorkflow.steps[0]?.kind !== "agent") throw new Error("Missing resolved agent step");
  NodeAssert.equal(roleWorkflow.steps[0].resolved?.execution.model, "fixture-default");
  NodeAssert.equal(roleWorkflow.steps[0].resolved?.skills[0]?.instructions, "Run focused tests.");
  const replacement = await definitionCall((s) =>
    s.activate({
      ...activation,
      commandId: "role-v2",
      expectedVersionId: roleVersion.id,
      files: exportFactoryFiles({
        ...roleDefinition,
        defaults: { ...roleDefinition.defaults, model: "fixture-new" },
        skills: [{ ...roleDefinition.skills[0]!, instructions: "Verify the new requirements." }],
      }),
    }),
  );
  const newWorkflow = await workflowCall((s) =>
    s.readVersion("a", replacement.workflowVersions[0]!.versionId),
  );
  const newRun = await workflowCall((s) =>
    s.start({
      ...startInput,
      commandId: "role-run-v2",
      id: "role-run-v2",
      workflowVersionId: newWorkflow.id,
    }),
  );
  NodeAssert.notEqual(newRun.workflowVersionId, roleRun.workflowVersionId);
  if (newWorkflow.steps[0]?.kind !== "agent") throw new Error("Missing new resolved agent step");
  NodeAssert.equal(newWorkflow.steps[0].resolved?.execution.model, "fixture-new");
  NodeAssert.equal(
    newWorkflow.steps[0].resolved?.skills[0]?.instructions,
    "Verify the new requirements.",
  );
  await stop();
  await start();
  NodeAssert.deepEqual(
    await workflowCall((s) => s.readVersion("a", roleRun.workflowVersionId)),
    roleWorkflow,
  );
  NodeAssert.deepEqual(await workflowCall((s) => s.readRun("a", "definition-run")), pinnedRun);
  NodeAssert.deepEqual(
    await definitionCall((s) => s.readVersion("a", roleVersion.id)),
    roleVersion,
  );
  await definitionCall((s) =>
    s.activate({
      ...activation,
      commandId: "restore-v1-after-role-gate",
      expectedVersionId: replacement.id,
    }),
  );
  await NodeAssert.rejects(
    call((s) =>
      s.withStartEligibility(
        "a",
        "w1",
        s
          .createWorkItem({ ...work, commandId: "rolled-back", id: "rollback" })
          .pipe(
            Effect.andThen(Effect.fail(new Factories.AutomationError({ reason: "invalid_input" }))),
          ),
      ),
    ),
  );
  await failure(
    call((s) => s.readWorkItem("a", "rollback")),
    "not_found",
  );
  NodeAssert.equal(
    (await query("SELECT * FROM foundry_automation.commands WHERE id='rolled-back'")).length,
    0,
  );
  await NodeAssert.rejects(query("INSERT INTO foundry_automation.evaluation_queue(id,factory_id,run_id,instance_id,operator_id,input) SELECT 'evaluation-wrong-factory','b',id,'fixture','fixture','{}'::jsonb FROM foundry_automation.runs WHERE factory_id='a' LIMIT 1", "automation_runtime"));
  await query("INSERT INTO foundry_automation.evaluation_queue(id,factory_id,run_id,instance_id,operator_id,input) SELECT 'evaluation-fixture',factory_id,id,'fixture','fixture','{}'::jsonb FROM foundry_automation.runs WHERE factory_id='a' LIMIT 1", "automation_runtime");
  NodeAssert.equal((await query("SELECT id FROM foundry_automation.evaluation_queue WHERE id='evaluation-fixture'")).length, 1);
  await NodeAssert.rejects(query("INSERT INTO foundry_automation.evaluation_results(id,factory_id,run_id,result) SELECT id,'b',run_id,'{}'::jsonb FROM foundry_automation.evaluation_queue WHERE id='evaluation-fixture'", "automation_runtime"));
  await query("INSERT INTO foundry_automation.evaluation_results(id,factory_id,run_id,result) SELECT id,factory_id,run_id,'{}'::jsonb FROM foundry_automation.evaluation_queue WHERE id='evaluation-fixture'", "automation_runtime");
  await query("UPDATE foundry_automation.evaluation_queue SET state='running',claim_token='fixture',claimed_at=now() WHERE id='evaluation-fixture'", "automation_runtime");
  for (const statement of [
    "UPDATE foundry_automation.evaluation_results SET result='{}'",
    "DELETE FROM foundry_automation.evaluation_results",
    "UPDATE foundry_automation.evaluation_queue SET input='{}'",
    "UPDATE foundry_automation.evaluation_queue SET factory_id='b'",
    "UPDATE foundry_automation.evaluation_queue SET run_id=run_id",
    "DELETE FROM foundry_automation.evaluation_queue",
  ]) await NodeAssert.rejects(query(statement, "automation_runtime"));
  for (const statement of [
    "UPDATE foundry_automation.versions SET repositories=ARRAY['evil']",
    "UPDATE foundry_automation.work_items SET version_id='a2'",
    "DELETE FROM foundry_automation.work_items",
    "DELETE FROM foundry_automation.factories",
    "UPDATE foundry_automation.commands SET payload='{}'",
    "UPDATE foundry_automation.workflow_versions SET steps='[]'",
    "UPDATE foundry_automation.runs SET workflow_version_id='flow-a3'",
    "UPDATE foundry_automation.outbox SET payload='{}'",
    "DELETE FROM foundry_automation.outbox",
    "UPDATE foundry_automation.definition_versions SET content_hash=repeat('0',64)",
    "DELETE FROM foundry_automation.definition_versions",
    "UPDATE foundry_automation.definition_heads SET factory_id='b'",
    "UPDATE foundry_automation.schema_version SET version=2",
    "UPDATE foundry_instance.fixture SET version=99",
    "CREATE TABLE foundry_automation.forbidden(id int)",
  ])
    await NodeAssert.rejects(query(statement, "automation_runtime"));
  await NodeAssert.rejects(
    query("UPDATE foundry_instance.fixture SET version=99", "automation_migrator"),
  );
  NodeAssert.deepEqual(await query("SELECT * FROM foundry_instance.fixture"), instanceBefore);
  await query("UPDATE foundry_automation.schema_version SET version=99", "automation_migrator");
  await NodeAssert.rejects(run(migration));
  NodeAssert.equal(
    (await query("SELECT version FROM foundry_automation.schema_version"))[0]?.version,
    99,
  );
  await query("UPDATE foundry_automation.schema_version SET version=12", "automation_migrator");
  await run(migration);
  const preservedQueries = [
    "SELECT * FROM foundry_automation.definition_versions ORDER BY id",
    "SELECT * FROM foundry_automation.definition_heads ORDER BY factory_id",
    "SELECT * FROM foundry_automation.workflow_versions ORDER BY id",
    "SELECT * FROM foundry_automation.runs ORDER BY id",
    "SELECT * FROM foundry_automation.commands ORDER BY id",
    "SELECT * FROM foundry_automation.outbox ORDER BY id",
  ];
  const schema3Data = await Promise.all(preservedQueries.map((statement) => query(statement)));
  NodeAssert.ok(schema3Data.every((rows) => rows.length > 0));
  await query("DROP TABLE foundry_automation.evaluation_results,foundry_automation.evaluation_queue", "automation_migrator");
  await query("ALTER TABLE foundry_automation.runs DROP CONSTRAINT runs_factory_id_unique", "automation_migrator");
  await query(
    "DROP TABLE foundry_automation.dispatch_capacity,foundry_automation.handoff_commands,foundry_automation.work_item_handoffs,foundry_automation.definition_sources,foundry_automation.definition_git_revisions,foundry_automation.definition_source_commands",
    "automation_migrator",
  );
  await query(
    "DROP TABLE foundry_automation.publish_operations,foundry_automation.trigger_commands,foundry_automation.trigger_admissions,foundry_automation.trigger_events,foundry_automation.unattended_grants,foundry_automation.trigger_bindings",
    "automation_migrator",
  );
  await query(
    "DROP TABLE foundry_automation.inbox_marks,foundry_automation.inbox_entries,foundry_automation.inbox_commands,foundry_automation.manual_admissions,foundry_automation.run_questions,foundry_automation.run_decisions,foundry_automation.control_commands,foundry_automation.run_controls,foundry_automation.dispatch_outbox,foundry_automation.step_attempts,foundry_automation.dispatch_workers,foundry_automation.dispatch_runs",
    "automation_migrator",
  );
  await query(
    "ALTER TABLE foundry_automation.workflow_versions DROP COLUMN execution",
    "automation_migrator",
  );
  await query("UPDATE foundry_automation.schema_version SET version=3", "automation_migrator");
  NodeAssert.equal(
    (await query("SELECT version FROM foundry_automation.schema_version"))[0]?.version,
    3,
  );
  await run(migration);
  await run(migration);
  NodeAssert.equal(
    (await query("SELECT version FROM foundry_automation.schema_version"))[0]?.version,
    12,
  );
  NodeAssert.deepEqual(
    await Promise.all(preservedQueries.map((statement) => query(statement))),
    schema3Data,
  );
  NodeAssert.equal((await query("SELECT * FROM foundry_automation.dispatch_runs")).length, 0);
  await call((s) => s.createFactory({ commandId: "p19-factory", id: "p19", name: "P19 fixture" }));
  await call((s) =>
    s.createVersion({
      commandId: "p19-version",
      id: "p19-version",
      factoryId: "p19",
      repositories: ["fixture"],
    }),
  );
  await call((s) =>
    s.createWorkItem({
      commandId: "p19-work",
      id: "p19-work",
      factoryId: "p19",
      versionId: "p19-version",
      repository: "fixture",
      title: "P19 fixture",
      source: { kind: "manual", reference: "fixture" },
    }),
  );
  await workflowCall((s) =>
    s.createVersion({
      commandId: "p19-flow",
      id: "p19-flow",
      factoryId: "p19",
      factoryVersionId: "p19-version",
      steps: [
        { id: "first", kind: "agent", prompt: "fixture", dependsOn: [] },
        { id: "test", kind: "test", checkId: "fixture-check", dependsOn: ["first"] },
      ],
    }),
  );
  for (const id of [
    "p19-run",
    "p19-queued",
    "p19-inactive",
    "p19-success",
    "p19-next",
    "p19-network",
  ])
    await workflowCall((s) =>
      s.start({
        commandId: id,
        id,
        factoryId: "p19",
        workItemId: "p19-work",
        workflowVersionId: "p19-flow",
        revision: "pinned",
      }),
    );
  const enrollment = {
    factoryId: "p19",
    runId: "p19-run",
    workerId: "fixture-worker",
    binding: { projectId: "own-fixture", model: "replay" },
  };
  await Promise.all(Array.from({ length: 4 }, () => dispatchCall((s) => s.enroll(enrollment))));
  await failure(
    dispatchCall((s) => s.enroll({ ...enrollment, binding: { projectId: "other" } })),
    "conflict",
  );
  await dispatchCall((s) => s.enroll({ ...enrollment, runId: "p19-queued" }));
  NodeAssert.equal(
    (await query("SELECT count(*)::int AS count FROM foundry_automation.dispatch_runs"))[0]?.count,
    2,
  );
  const acquire = () =>
    dispatchCall((s) =>
      s.claimNext({ workerId: "fixture-worker", owner: "fixture-owner", leaseMillis: 60000 }),
    );
  const competing = await Promise.all(Array.from({ length: 4 }, acquire));
  const first = competing.find((claim) => claim !== null);
  NodeAssert.ok(first);
  NodeAssert.equal(competing.filter((claim) => claim !== null).length, 1);
  NodeAssert.equal(first.run.id, "p19-run");
  NodeAssert.deepEqual(
    first.workflow.steps.map((step) => step.id),
    ["first", "test"],
  );
  // A claimed job survives a process/connection restart without creating another attempt.
  await stop();
  await start();
  NodeAssert.equal(await acquire(), null);
  await query(
    "UPDATE foundry_automation.dispatch_workers SET lease_until='-infinity' WHERE worker_id='fixture-worker'",
    "automation_migrator",
  );
  const recovered = await acquire();
  NodeAssert.ok(recovered);
  NodeAssert.equal(recovered.run.id, first.run.id);
  NodeAssert.ok(recovered.generation > first.generation);
  await failure(
    dispatchCall((s) =>
      s.prepare(first, { ordinal: 0, commandId: "dispatch-first", request: { prompt: "fixture" } }),
    ),
    "stale_claim",
  );
  const request = { ordinal: 0, commandId: "dispatch-first", request: { prompt: "fixture" } };
  await query(
    "CREATE FUNCTION foundry_automation.reject_dispatch_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected after attempt insert'; END $$",
    "automation_migrator",
  );
  await query(
    "CREATE TRIGGER reject_dispatch_outbox BEFORE INSERT ON foundry_automation.dispatch_outbox FOR EACH ROW EXECUTE FUNCTION foundry_automation.reject_dispatch_outbox()",
    "automation_migrator",
  );
  await NodeAssert.rejects(dispatchCall((s) => s.prepare(recovered, request)));
  NodeAssert.equal((await query("SELECT * FROM foundry_automation.step_attempts")).length, 0);
  await query(
    "DROP TRIGGER reject_dispatch_outbox ON foundry_automation.dispatch_outbox",
    "automation_migrator",
  );
  await query("DROP FUNCTION foundry_automation.reject_dispatch_outbox()", "automation_migrator");
  const attempt = await dispatchCall((s) => s.prepare(recovered, request));
  NodeAssert.deepEqual(await dispatchCall((s) => s.prepare(recovered, request)), attempt);
  await failure(
    dispatchCall((s) => s.prepare(recovered, { ...request, request: { prompt: "changed" } })),
    "conflict",
  );
  await failure(
    dispatchCall((s) =>
      s.prepare(recovered, {
        ordinal: 1,
        commandId: "dispatch-test",
        request: { checkId: "fixture-check" },
      }),
    ),
    "invalid_step",
  );
  const receipt = { threadId: "fixture-thread", commandId: attempt.commandId };
  // The fake transport holds no Automation transaction or row lock while it delivers.
  await run(
    Effect.gen(function* () {
      const sql = yield* Database.AutomationDatabase;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET LOCAL lock_timeout='1ms'`;
          yield* sql`SELECT * FROM foundry_automation.dispatch_workers FOR UPDATE`;
        }),
      );
    }).pipe(Effect.provide(db("automation_migrator"))),
  );
  const active = await query(
    "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='foundry-automation' AND state='idle in transaction'",
  );
  NodeAssert.equal(active[0]?.count, 0);
  await dispatchCall((s) => s.release(recovered));
  const deliveredRecovery = await acquire();
  NodeAssert.ok(deliveredRecovery);
  NodeAssert.equal(deliveredRecovery.attempts[0]?.commandId, attempt.commandId);
  NodeAssert.equal(deliveredRecovery.attempts[0]?.receipt, null);
  const waiting = {
    commandId: attempt.commandId,
    state: "finalizing" as const,
    reason: "archive_incomplete",
    receipt,
    result: null,
  };
  NodeAssert.equal(await dispatchCall((s) => s.record(recovered, waiting)), false);
  NodeAssert.equal(await dispatchCall((s) => s.record(deliveredRecovery, waiting)), true);
  await failure(
    dispatchCall((s) =>
      s.record(deliveredRecovery, { ...waiting, receipt: { threadId: "other" } }),
    ),
    "conflict",
  );
  NodeAssert.equal((await dispatchCall((s) => s.read("p19", "p19-run"))).state, "waiting");
  const confirmed = {
    ...waiting,
    state: "succeeded" as const,
    reason: null,
    result: { complete: true },
  };
  // Crash before result confirmation leaves the same durable job awaiting reconciliation.
  await dispatchCall((s) => s.release(deliveredRecovery));
  const finalizationRecovery = await acquire();
  NodeAssert.ok(finalizationRecovery);
  NodeAssert.equal(finalizationRecovery.attempts[0]?.state, "finalizing");
  NodeAssert.equal(await dispatchCall((s) => s.record(finalizationRecovery, confirmed)), true);
  NodeAssert.equal(await dispatchCall((s) => s.record(finalizationRecovery, confirmed)), true);
  await failure(
    dispatchCall((s) =>
      s.record(finalizationRecovery, { ...confirmed, result: { complete: false } }),
    ),
    "conflict",
  );
  await failure(
    dispatchCall((s) =>
      s.prepare(finalizationRecovery, {
        ordinal: 1,
        commandId: "stale-result-step",
        request: { checkId: "fixture-check" },
      }),
    ),
    "stale_claim",
  );
  const nextStepClaim = {
    ...finalizationRecovery,
    ...(await dispatchCall((store) => store.read("p19", "p19-run"))),
  };
  await dispatchCall((s) =>
    s.prepare(nextStepClaim, {
      ordinal: 1,
      commandId: "dispatch-test",
      request: { checkId: "fixture-check" },
    }),
  );
  await dispatchCall((s) =>
    s.record(finalizationRecovery, {
      commandId: "dispatch-test",
      state: "failed",
      reason: "test_failed",
      receipt: { threadId: "test-thread" },
      result: { exitCode: 1 },
    }),
  );
  await dispatchCall((s) => s.release(finalizationRecovery));
  NodeAssert.equal(await acquire(), null);
  NodeAssert.equal((await dispatchCall((s) => s.read("p19", "p19-queued"))).attempts.length, 0);
  NodeAssert.equal(
    (await query("SELECT count(*)::int AS count FROM foundry_automation.dispatch_outbox"))[0]
      ?.count,
    2,
  );
  for (const runId of ["p19-success", "p19-next"])
    await dispatchCall((store) =>
      store.enroll({ ...enrollment, runId, workerId: "success-worker" }),
    );
  const successClaim = await dispatchCall((store) =>
    store.claimNext({ workerId: "success-worker", owner: "success-owner", leaseMillis: 60000 }),
  );
  NodeAssert.ok(successClaim);
  NodeAssert.equal(successClaim.run.id, "p19-success");
  for (const ordinal of [0, 1]) {
    const commandId = `success-${ordinal}`;
    const currentSuccessClaim = {
      ...successClaim,
      ...(await dispatchCall((store) => store.read("p19", "p19-success"))),
    };
    await dispatchCall((store) =>
      store.prepare(currentSuccessClaim, { ordinal, commandId, request: { ordinal } }),
    );
    await dispatchCall((store) =>
      store.record(successClaim, {
        commandId,
        state: "succeeded",
        reason: null,
        receipt: { commandId },
        result: { exitCode: 0 },
      }),
    );
  }
  const nextClaim = await dispatchCall((store) =>
    store.claimNext({ workerId: "success-worker", owner: "success-owner", leaseMillis: 60000 }),
  );
  NodeAssert.ok(nextClaim);
  NodeAssert.equal(nextClaim.run.id, "p19-next");
  NodeAssert.equal(
    (await dispatchCall((store) => store.read("p19", "p19-success"))).state,
    "succeeded",
  );
  NodeAssert.equal(
    (await query("SELECT * FROM foundry_automation.dispatch_runs WHERE run_id='p19-inactive'"))
      .length,
    0,
  );
  const networkBinding = Schema.decodeSync(Scheduler.DispatchBinding)({
    identity: {
      instanceId: "11111111-1111-4111-8111-111111111111",
      operatorId: "44444444-4444-4444-8444-444444444444",
      deviceId: "22222222-2222-4222-8222-222222222222",
      environmentId: "fixture-environment",
      deviceGeneration: 1,
      accessGeneration: 1,
      automationGeneration: 1,
      clientSessionId: "fixture-client-session",
      foundrySessionHash: "a".repeat(43),
    },
    projectId: "explicit-isolated-project",
    model: "replay",
    checks: [],
    requiredArtifacts: [],
  });
  await dispatchCall((store) =>
    store.enroll({
      ...enrollment,
      runId: "p19-network",
      workerId: networkBinding.identity.deviceId,
      binding: networkBinding,
    }),
  );
  let networkReads = 0;
  const unused = Effect.fn("fixture.unexpected")(() =>
    Effect.die("Unexpected network-lock fixture operation"),
  );
  const networkWorker = WorkerTransport.WorkerTransport.of({
    sandboxProjects: Effect.fn("Fixture.sandboxProjects")(() => Effect.die("unused")),
    sandboxStatus: Effect.fn("Fixture.sandboxStatus")(() => Effect.die("unused")),
    retargetSandbox: Effect.fn("Fixture.retargetSandbox")(() => Effect.die("unused")),
    handoffOpen: Effect.fn("Fixture.handoffOpen")(() =>
      Effect.die("Handoff not configured in this fixture"),
    ),
    handoffFinish: Effect.fn("Fixture.handoffFinish")(() =>
      Effect.die("Handoff not configured in this fixture"),
    ),
    handoffReopen: Effect.fn("Fixture.handoffReopen")(() =>
      Effect.die("Handoff not configured in this fixture"),
    ),
    cancel: unused,
    answer: unused,
    identityForWrite: unused,
    identityForRead: unused,
    authorize: unused,
    launch: unused,
    renew: unused,
    status: Effect.fn("fixture.workerStatus")(() =>
      Effect.succeed({
        online: true,
        providerInstanceId: null,
        providerReady: false,
        providerState: "unbound",
        version: null,
        checkedAt: "2026-11-03T20:00:00Z",
        capacityAvailable: true,
        activeRuns: 0,
      } as const),
    ),
    read: Effect.fn("fixture.workerRead")(() =>
      Effect.tryPromise({
        try: async () => {
          networkReads++;
          await query(
            "SELECT * FROM foundry_automation.dispatch_workers FOR UPDATE NOWAIT",
            "automation_migrator",
          );
          const transactions = await query(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='foundry-automation' AND state='idle in transaction'",
          );
          NodeAssert.equal(transactions[0]?.count, 0);
          return null;
        },
        catch: (cause) =>
          new WorkerTransport.WorkerTransportError({ reason: "unavailable", cause }),
      }),
    ),
  });
  const networkArchive = ThreadArchive.ThreadArchive.of({
    ingest: unused,
    cursor: unused,
    read: unused,
    list: unused,
  });
  const networkArtifacts = Artifacts.Artifacts.of({
    begin: unused,
    status: unused,
    write: unused,
    publish: unused,
    abort: unused,
    metadata: unused,
    read: unused,
    list: unused,
  });
  await run(
    Scheduler.Scheduler.pipe(
      Effect.flatMap((scheduler) => scheduler.tick),
      Effect.provide(
        Scheduler.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              DispatchStore.layer.pipe(
                Layer.provide(Workflows.layer.pipe(Layer.provideMerge(Factories.layer))),
                Layer.provide(db("automation_runtime")),
              ),
              Layer.mock(Publish.Publish)({ prepareEvidence: () => Effect.succeed(null) }),
              Layer.mock(McpBindings.McpBindings)({ authorize: () => Effect.succeed([]) }),
              Layer.succeed(WorkerTransport.WorkerTransport, networkWorker),
              Layer.succeed(ThreadArchive.ThreadArchive, networkArchive),
              Layer.succeed(Artifacts.Artifacts, networkArtifacts),
              Layer.succeed(Scheduler.SchedulerConfig, {
                deviceId: networkBinding.identity.deviceId,
                environmentId: networkBinding.identity.environmentId,
                allowedRunIds: ["p19-network"],
              }),
              NodeCrypto.layer,
            ),
          ),
        ),
      ),
    ),
  );
  NodeAssert.equal(networkReads, 1);
  NodeAssert.equal(
    (await dispatchCall((store) => store.read("p19", "p19-network"))).reason,
    "worker_not_ready",
  );
  for (const statement of [
    "CREATE ROLE archive_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    "CREATE ROLE archive_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    "CREATE DATABASE archive_fixture OWNER archive_migrator",
    "REVOKE ALL ON DATABASE archive_fixture FROM PUBLIC",
    "GRANT CONNECT ON DATABASE archive_fixture TO archive_runtime",
  ])
    await query(statement);
  const archiveDb = (username: string) =>
    InstanceDatabase.layer({ path, username, database: "archive_fixture" });
  const archiveQuery = (statement: string) =>
    run(
      Effect.gen(function* () {
        const sql = yield* InstanceDatabase.InstanceDatabase;
        return yield* sql.unsafe(statement);
      }).pipe(Effect.provide(archiveDb("fixture_admin"))),
    );
  await archiveQuery("REVOKE ALL ON SCHEMA public FROM PUBLIC");
  await run(
    InstanceMigrations.InstanceMigrations.pipe(
      Effect.flatMap((service) =>
        service.migrate({
          instanceId: networkBinding.identity.instanceId,
          mainEnvironmentId: EnvironmentId.make("archive-main"),
          runtimeRole: "archive_runtime",
        }),
      ),
      Effect.provide(InstanceMigrations.layer.pipe(Layer.provide(archiveDb("archive_migrator")))),
    ),
  );
  await archiveQuery(
    `INSERT INTO foundry_instance.operator_binding(operator_id,issuer,subject) VALUES('${networkBinding.identity.operatorId}','https://fixture.invalid','operator')`,
  );
  await archiveQuery(
    `INSERT INTO foundry_instance.devices(device_id,instance_id,operator_id,environment_id,public_key) VALUES('${networkBinding.identity.deviceId}','${networkBinding.identity.instanceId}','${networkBinding.identity.operatorId}','${networkBinding.identity.environmentId}','${"a".repeat(43)}')`,
  );
  const archiveEvents = Schema.decodeSync(Schema.Array(FoundryArchiveEvent))([
    {
      sequence: 1,
      sourceSequence: 1,
      event: {
        id: "archive-run-complete",
        threadId: "archive-thread",
        occurredAt: "2026-11-04T00:00:00Z",
        type: "run.updated",
        payload: {
          id: "archive-native-run",
          threadId: "archive-thread",
          ordinal: 1,
          providerInstanceId: "fixture",
          modelSelection: { instanceId: "fixture", model: "fixture" },
          providerThreadId: null,
          userMessageId: "archive-message",
          rootNodeId: "archive-node",
          activeAttemptId: "archive-attempt",
          status: "completed",
          requestedAt: "2026-11-04T00:00:00Z",
          startedAt: "2026-11-04T00:00:00Z",
          completedAt: "2026-11-04T00:00:00Z",
          checkpointId: "archive-checkpoint",
          contextHandoffId: null,
        },
      },
    },
    {
      sequence: 2,
      sourceSequence: 2,
      event: {
        id: "archive-checkpoint-ready",
        threadId: "archive-thread",
        occurredAt: "2026-11-04T00:00:00Z",
        type: "checkpoint.captured",
        payload: {
          id: "archive-checkpoint",
          threadId: "archive-thread",
          scopeId: "archive-scope",
          runId: "archive-native-run",
          nodeId: "archive-node",
          parentCheckpointId: null,
          ordinalWithinScope: 1,
          appRunOrdinal: 1,
          ref: "refs/checkpoints/archive-fixture",
          status: "ready",
          files: [],
          capturedAt: "2026-11-04T00:00:00Z",
        },
      },
    },
  ]);
  await archiveQuery(
    `INSERT INTO foundry_instance.archive_threads(instance_id,operator_id,environment_id,thread_id,device_id,source_complete,confirmed_cursor,confirmed_source_sequence,source_head) VALUES('${networkBinding.identity.instanceId}','${networkBinding.identity.operatorId}','${networkBinding.identity.environmentId}','archive-thread','${networkBinding.identity.deviceId}',true,2,2,2)`,
  );
  await run(
    Effect.gen(function* () {
      const sql = yield* InstanceDatabase.InstanceDatabase;
      const encode = Schema.encodeEffect(Schema.toCodecJson(FoundryArchiveEvent));
      for (const event of archiveEvents)
        yield* sql`INSERT INTO foundry_instance.archive_events(instance_id,environment_id,thread_id,sequence,source_sequence,event) VALUES(${networkBinding.identity.instanceId},${networkBinding.identity.environmentId},'archive-thread',${event.sequence},${event.sourceSequence},${sql.json(yield* encode(event))})`;
    }).pipe(Effect.provide(archiveDb("fixture_admin"))),
  );
  const realArchive = ThreadArchive.layer.pipe(
    Layer.provide(archiveDb("archive_runtime")),
    Layer.provide(
      Layer.succeed(ArtifactFiles.ArtifactFiles, {
        read: unused,
        write: unused,
        publish: unused,
        abort: unused,
      }),
    ),
  );
  await run(
    ThreadArchive.ThreadArchive.pipe(
      Effect.flatMap((service) =>
        service.read(
          {
            instanceId: networkBinding.identity.instanceId,
            operatorId: networkBinding.identity.operatorId,
            deviceId: networkBinding.identity.deviceId,
            deviceEnvironmentId: networkBinding.identity.environmentId,
            generation: networkBinding.identity.deviceGeneration,
          },
          {
            owner: {
              environmentId: networkBinding.identity.environmentId,
              threadId: archiveEvents[0]!.event.threadId,
            },
            limit: 50,
          },
        ),
      ),
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => NodeAssert.equal(error.code, "forbidden"))),
      Effect.provide(realArchive),
    ),
  );
  const preparedArchiveAttempt = (await dispatchCall((store) => store.read("p19", "p19-network")))
    .attempts[0]!;
  const archiveExecution = Schema.decodeSync(FoundryWorkerExecution)({
    receipt: {
      commandId: preparedArchiveAttempt.commandId,
      threadId: "archive-thread",
      acceptedAt: "2026-11-04T00:00:00Z",
      sequence: 1,
    },
    run: { id: "archive-native-run", status: "completed", checkpointId: "archive-checkpoint" },
    lifecycle: {
      generation: 1,
      expiresAt: 1,
      state: "completed",
      writerEnded: true,
      manifest: {
        generation: 1,
        runId: "archive-native-run",
        outcome: "completed",
        checkpointId: "archive-checkpoint",
        checkpointRef: "refs/checkpoints/archive-fixture",
        archive: {
          instanceId: networkBinding.identity.instanceId,
          deviceId: networkBinding.identity.deviceId,
          deviceGeneration: 1,
          owner: {
            environmentId: networkBinding.identity.environmentId,
            threadId: "archive-thread",
          },
          cursor: 2,
          sourceSequence: 2,
        },
      },
    },
  });
  await run(
    Scheduler.Scheduler.pipe(
      Effect.flatMap((scheduler) => scheduler.tick),
      Effect.provide(
        Scheduler.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              DispatchStore.layer.pipe(
                Layer.provide(Workflows.layer.pipe(Layer.provideMerge(Factories.layer))),
                Layer.provide(db("automation_runtime")),
              ),
              Layer.mock(Publish.Publish)({ prepareEvidence: () => Effect.succeed(null) }),
              Layer.mock(McpBindings.McpBindings)({ authorize: () => Effect.succeed([]) }),
              Layer.succeed(WorkerTransport.WorkerTransport, {
                ...networkWorker,
                read: Effect.fn("Fixture.readArchivedExecution")(() =>
                  Effect.succeed(archiveExecution),
                ),
              }),
              realArchive,
              Layer.succeed(Artifacts.Artifacts, {
                ...networkArtifacts,
                list: Effect.fn("Fixture.listArchivedArtifacts")(() =>
                  Effect.succeed({ items: [], nextCursor: null }),
                ),
              }),
              Layer.succeed(Scheduler.SchedulerConfig, {
                deviceId: networkBinding.identity.deviceId,
                environmentId: networkBinding.identity.environmentId,
                allowedRunIds: ["p19-network"],
              }),
              NodeCrypto.layer,
            ),
          ),
        ),
      ),
    ),
  );
  const archivedStep = (await dispatchCall((store) => store.read("p19", "p19-network")))
    .attempts[0]!;
  NodeAssert.equal(archivedStep.state, "succeeded");
  NodeAssert.equal(archivedStep.reason, null);
  await run(
    Console.log(
      "PASS G4 archive principal: real separate instance PostgreSQL archive authorizes the Scheduler's central read and confirms the completed worker-shaped result/checkpoint; no native provider was executed.",
    ),
  );
  for (const statement of [
    "UPDATE foundry_automation.step_attempts SET request='{}'",
    "DELETE FROM foundry_automation.dispatch_outbox",
  ])
    await NodeAssert.rejects(query(statement, "automation_runtime"));
  const controlBinding = Schema.decodeSync(Scheduler.DispatchBinding)({
    ...networkBinding,
    identity: { ...networkBinding.identity, deviceId: "33333333-3333-4333-8333-333333333333" },
  });
  let controlIdentity = controlBinding.identity;
  let canOperate = true;
  let controlWorkerOnline = true;
  const controlWorker = WorkerTransport.WorkerTransport.of({
    ...networkWorker,
    identityForRead: Effect.fn("fixture.controlIdentityRead")(() =>
      Effect.succeed(controlIdentity),
    ),
    identityForWrite: Effect.fn("fixture.controlIdentityWrite")(function* () {
      if (!canOperate)
        return yield* new WorkerTransport.WorkerTransportError({ reason: "forbidden" });
      return controlIdentity;
    }),
    authorize: Effect.fn("fixture.controlAuthorize")(function* () {
      if (!controlWorkerOnline)
        return yield* new WorkerTransport.WorkerTransportError({ reason: "unavailable" });
      if (!canOperate)
        return yield* new WorkerTransport.WorkerTransportError({ reason: "forbidden" });
      return controlIdentity;
    }),
  });
  const controlCall = <A, E>(f: (service: Control.Control["Service"]) => Effect.Effect<A, E>) =>
    run(
      Control.Control.pipe(
        Effect.flatMap(f),
        Effect.provide(
          Control.layer.pipe(
            Layer.provide(DispatchStore.layer),
            Layer.provide(Workflows.layer),
            Layer.provide(Factories.layer),
            Layer.provide(db("automation_runtime")),
            Layer.provide(Layer.succeed(WorkerTransport.WorkerTransport, controlWorker)),
            Layer.provide(
              Layer.succeed(Scheduler.SchedulerConfig, { ...controlIdentity, allowedRunIds: [] }),
            ),
            Layer.provide(NodeCrypto.layer),
          ),
        ),
      ),
    );
  const controlRequest = HttpServerRequest.fromWeb(new Request("http://127.0.0.1/"));
  const preparedControls = new Map<string, Promise<typeof StartAutomationRun.Type>>();
  const controlInput = (id: string, workflowVersionId = "p19-flow") => {
    let prepared = preparedControls.get(id);
    if (!prepared) {
      prepared = (async () => {
        const workflow = await workflowCall((service) =>
          service.readVersion("p19", workflowVersionId),
        );
        const current = await definitionCall((service) => service.active("p19"));
        const definition = await definitionCall((service) =>
          service.activate({
            commandId: `${id}:activate`,
            factoryId: "p19",
            scopeVersionId: "p19-version",
            expectedVersionId: Option.isSome(current) ? current.value.id : null,
            files: exportFactoryFiles({
              schemaVersion: 1,
              factoryId: "p19",
              repositories: ["fixture"],
              workflows: [{ id: "main", steps: workflow.steps }],
            }),
            source: { kind: "files", reference: "p20-own-fixture" },
          }),
        );
        return {
          commandId: id,
          id,
          factoryId: "p19",
          workItemId: "p19-work",
          workflowVersionId: definition.workflowVersions[0]!.versionId,
          revision: "input-v1",
        };
      })();
      preparedControls.set(id, prepared);
    }
    return prepared;
  };
  const startControl = async (id: string, workflowVersionId = "p19-flow") => {
    const input = await controlInput(id, workflowVersionId);
    return dispatchCall((service) =>
      service.startManual(input, controlIdentity.deviceId, controlBinding, controlIdentity),
    );
  };
  const executeControl = (input: AutomationControlCommand) =>
    controlCall((s) => s.execute(controlRequest, input));
  const readControl = (runId: string) => controlCall((s) => s.read(controlRequest, "p19", runId));
  const command = (
    runId: string,
    commandId: string,
    expectedRevision: number,
    action: "pause" | "resume" | "cancel" | "retry",
  ) => ({ factoryId: "p19", runId, commandId, expectedRevision, action });
  const inactiveStart = {
    commandId: "inactive-product-start",
    id: "inactive-product-start",
    factoryId: "p19",
    workItemId: "p19-work",
    workflowVersionId: "p19-flow",
    revision: "pinned",
  };
  await failure(
    dispatchCall((service) =>
      service.startManual(inactiveStart, controlIdentity.deviceId, controlBinding, controlIdentity),
    ),
    "conflict",
  );
  NodeAssert.equal(
    (await query("SELECT id FROM foundry_automation.runs WHERE id='inactive-product-start'"))
      .length,
    0,
  );
  NodeAssert.equal(
    (await query("SELECT id FROM foundry_automation.commands WHERE id='inactive-product-start'"))
      .length,
    0,
  );
  await failure(
    dispatchCall((service) =>
      service.startManual(
        { ...inactiveStart, commandId: "p19-inactive", id: "p19-inactive" },
        controlIdentity.deviceId,
        controlBinding,
        controlIdentity,
      ),
    ),
    "conflict",
  );
  await Promise.all(Array.from({ length: 4 }, () => startControl("p20-pause")));
  NodeAssert.equal(
    (await query("SELECT * FROM foundry_automation.manual_admissions WHERE run_id='p20-pause'"))
      .length,
    1,
  );
  NodeAssert.equal(await dispatchCall((s) => s.permitted("p19-inactive")), false);
  NodeAssert.equal(await dispatchCall((s) => s.permitted("p20-pause")), true);
  const firstControlInput = await controlInput("p20-pause");
  NodeAssert.equal(
    (
      await dispatchCall((s) =>
        s.replayManual(
          firstControlInput,
          controlIdentity.deviceId,
          controlBinding,
          controlIdentity,
        ),
      )
    )?.run.id,
    "p20-pause",
  );
  await failure(
    dispatchCall((s) =>
      s.replayManual(
        { ...firstControlInput, revision: "changed" },
        controlIdentity.deviceId,
        controlBinding,
        controlIdentity,
      ),
    ),
    "conflict",
  );
  await failure(
    dispatchCall((s) =>
      s.replayManual(firstControlInput, controlIdentity.deviceId, controlBinding, {
        ...controlIdentity,
        operatorId: "other",
      }),
    ),
    "conflict",
  );

  await failure(
    dispatchCall((s) =>
      s.startManual(
        firstControlInput,
        controlIdentity.deviceId,
        { ...controlBinding, model: "different" },
        controlIdentity,
      ),
    ),
    "conflict",
  );
  const pausedClaim = await dispatchCall((s) =>
    s.claimNext({ workerId: controlIdentity.deviceId, owner: "p20-owner", leaseMillis: 60000 }),
  );
  NodeAssert.ok(pausedClaim);
  const pauseCommand = command("p20-pause", "pause-1", 0, "pause");
  const paused = await Promise.all(Array.from({ length: 4 }, () => executeControl(pauseCommand)));
  NodeAssert.ok(paused.every((result) => result.state === "paused" && result.revision === 1));
  await NodeAssert.rejects(executeControl(command("p20-pause", "stale-resume", 0, "resume")));
  await NodeAssert.rejects(executeControl({ ...pauseCommand, action: "cancel" }));
  NodeAssert.equal(await dispatchCall((s) => s.canLaunch(pausedClaim)), false);
  await failure(
    dispatchCall((s) =>
      s.prepare(pausedClaim, { ordinal: 0, commandId: "pause-launch", request: {} }),
    ),
    "invalid_step",
  );
  await dispatchCall((s) => s.release(pausedClaim));
  NodeAssert.equal(
    await dispatchCall((s) =>
      s.claimNext({ workerId: controlIdentity.deviceId, owner: "p20-idle", leaseMillis: 60000 }),
    ),
    null,
  );
  await stop();
  await start();
  NodeAssert.deepEqual(await executeControl(pauseCommand), paused[0]);
  canOperate = false;
  await NodeAssert.rejects(executeControl(command("p20-pause", "revoked-resume", 1, "resume")));
  canOperate = true;
  controlIdentity = { ...controlIdentity, automationGeneration: 2 };
  await NodeAssert.rejects(executeControl(command("p20-pause", "old-generation", 1, "resume")));
  controlIdentity = controlBinding.identity;
  NodeAssert.equal(
    (await executeControl(command("p20-pause", "resume-1", 1, "resume"))).state,
    "running",
  );
  controlWorkerOnline = false;
  controlIdentity = Schema.decodeSync(WorkerTransport.WorkerIdentity)({
    ...controlIdentity,
    clientSessionId: "fresh-cancel-session",
    foundrySessionHash: "b".repeat(43),
  });
  NodeAssert.equal(
    (await executeControl(command("p20-pause", "cancel-1", 2, "cancel"))).state,
    "cancel_requested",
  );
  const cancellationBinding = async () =>
    decodeDispatchBinding((await dispatchCall((s) => s.read("p19", "p20-pause"))).binding);
  NodeAssert.deepEqual((await cancellationBinding()).identity, controlBinding.identity);
  controlWorkerOnline = true;
  controlIdentity = { ...controlIdentity, automationGeneration: 2 };
  await NodeAssert.rejects(
    executeControl(command("p20-pause", "cancel-new-generation", 3, "cancel")),
  );
  controlIdentity = { ...controlIdentity, automationGeneration: 1 };
  const recoveredCancel = command("p20-pause", "cancel-fresh-session", 3, "cancel");
  const recoveredReceipt = await executeControl(recoveredCancel);
  NodeAssert.equal(recoveredReceipt.state, "cancel_requested");
  NodeAssert.deepEqual((await cancellationBinding()).identity, controlIdentity);
  controlIdentity = Schema.decodeSync(WorkerTransport.WorkerIdentity)({
    ...controlIdentity,
    clientSessionId: "newer-session",
  });
  NodeAssert.deepEqual(await executeControl(recoveredCancel), recoveredReceipt);
  NodeAssert.deepEqual((await cancellationBinding()).identity, {
    ...controlIdentity,
    clientSessionId: "fresh-cancel-session",
  });
  controlIdentity = controlBinding.identity;
  const cancellationClaim = await dispatchCall((s) =>
    s.claimNext({ workerId: controlIdentity.deviceId, owner: "p20-owner", leaseMillis: 60000 }),
  );
  NodeAssert.ok(cancellationClaim);
  NodeAssert.equal(await dispatchCall((s) => s.confirmCancel(cancellationClaim)), true);
  NodeAssert.equal((await readControl("p20-pause")).state, "cancelled");
  await startControl("p20-delivery");
  const deliveryClaim = await dispatchCall((s) =>
    s.claimNext({
      workerId: controlIdentity.deviceId,
      owner: "delivery-owner",
      leaseMillis: 60000,
    }),
  );
  NodeAssert.ok(deliveryClaim);
  const launchRequest = {
    commandId: "p20-native-launch",
    projectId: controlBinding.projectId,
    title: "P20 own fixture",
    model: "fixture",
    prompt: "test",
  };
  await dispatchCall((s) =>
    s.prepare(deliveryClaim, {
      ordinal: 0,
      commandId: launchRequest.commandId,
      request: launchRequest,
    }),
  );
  NodeAssert.equal(
    await dispatchCall((s) => s.beginDelivery(deliveryClaim, launchRequest.commandId)),
    true,
  );
  await executeControl(command("p20-delivery", "delivery-cancel", 0, "cancel"));
  NodeAssert.equal(await dispatchCall((s) => s.confirmCancel(deliveryClaim)), false);
  NodeAssert.equal((await readControl("p20-delivery")).state, "cancel_requested");
  const stoppedResult = {
    execution: {
      receipt: {
        commandId: launchRequest.commandId,
        threadId: "p20-thread",
        acceptedAt: "2026-11-04T00:00:00Z",
        sequence: 1,
      },
      run: { id: "p20-native", status: "cancelled", checkpointId: null },
      lifecycle: {
        generation: 1,
        expiresAt: 0,
        state: "stopped",
        writerEnded: true,
        manifest: {
          generation: 1,
          runId: "p20-native",
          checkpointId: null,
          checkpointRef: null,
          outcome: "stopped",
        },
      },
    },
    artifacts: [],
  };
  await dispatchCall((s) =>
    s.record(deliveryClaim, {
      commandId: launchRequest.commandId,
      state: "failed",
      reason: "cancelled",
      receipt: null,
      result: stoppedResult,
    }),
  );
  NodeAssert.equal(await dispatchCall((s) => s.confirmCancel(deliveryClaim)), true);
  await workflowCall((s) =>
    s.createVersion({
      commandId: "p20-final-flow",
      id: "p20-final-flow",
      factoryId: "p19",
      factoryVersionId: "p19-version",
      steps: [{ id: "final", kind: "agent", prompt: "finish", dependsOn: [] }],
    }),
  );
  for (const action of ["pause", "cancel"] as const) {
    const id = `p20-final-${action}`;
    await startControl(id, "p20-final-flow");
    const terminalClaim = await dispatchCall((s) =>
      s.claimNext({
        workerId: controlIdentity.deviceId,
        owner: `terminal-${action}`,
        leaseMillis: 60000,
      }),
    );
    NodeAssert.ok(terminalClaim);
    await dispatchCall((s) =>
      s.prepare(terminalClaim, {
        ordinal: 0,
        commandId: id,
        request: { ...launchRequest, commandId: id },
      }),
    );
    await executeControl(command(id, `terminal-control-${action}`, 0, action));
    await dispatchCall((s) =>
      s.record(terminalClaim, {
        commandId: id,
        state: "succeeded",
        reason: null,
        receipt: null,
        result: stoppedResult,
      }),
    );
    if (action === "cancel") {
      NodeAssert.equal((await readControl(id)).state, "cancel_requested");
      NodeAssert.equal(
        (
          await query(
            `SELECT run_id FROM foundry_automation.dispatch_workers WHERE worker_id='${controlIdentity.deviceId}'`,
          )
        )[0]?.run_id,
        id,
      );
      NodeAssert.equal(await dispatchCall((s) => s.confirmCancel(terminalClaim)), true);
      NodeAssert.equal((await readControl(id)).state, "cancelled");
    } else NodeAssert.equal((await readControl(id)).state, "succeeded");
  }
  await workflowCall((s) =>
    s.createVersion({
      commandId: "p20-approval-flow",
      id: "p20-approval-flow",
      factoryId: "p19",
      factoryVersionId: "p19-version",
      steps: [
        { id: "approve", kind: "approval", prompt: "Review revision", dependsOn: [] },
        { id: "handoff", kind: "approval", prompt: "Review handoff", dependsOn: ["approve"] },
      ],
    }),
  );
  await startControl("p20-approval", "p20-approval-flow");
  const oldProductRun = await startControl("p20-pause");
  NodeAssert.equal(oldProductRun.run.workflowVersionId, firstControlInput.workflowVersionId);
  await failure(
    dispatchCall((service) =>
      service.startManual(
        { ...firstControlInput, id: "stale-product-start", commandId: "stale-product-start" },
        controlIdentity.deviceId,
        controlBinding,
        controlIdentity,
      ),
    ),
    "conflict",
  );
  NodeAssert.equal(
    (await query("SELECT id FROM foundry_automation.runs WHERE id='stale-product-start'")).length,
    0,
  );
  await run(
    Console.log(
      "PASS P20 manual activation: never-activated and superseded workflow versions reject atomically; existing inactive runs remain unadmitted; accepted start receipts replay against pinned versions after reactivation.",
    ),
  );
  const approvalCommand = {
    factoryId: "p19",
    runId: "p20-approval",
    commandId: "approval-1",
    expectedRevision: 0,
    action: "approve" as const,
    stepId: "approve",
    resultRevision: 0,
  };
  NodeAssert.equal((await executeControl(approvalCommand)).revision, 1);
  NodeAssert.equal((await executeControl(approvalCommand)).revision, 1);
  const approvalClaim = await dispatchCall((s) =>
    s.claimNext({
      workerId: controlIdentity.deviceId,
      owner: "approval-owner",
      leaseMillis: 60000,
    }),
  );
  NodeAssert.ok(approvalClaim);
  NodeAssert.equal(await dispatchCall((s) => s.approved(approvalClaim, "approve")), true);
  await executeControl(command("p20-approval", "approval-pause", 1, "pause"));
  NodeAssert.equal(await dispatchCall((s) => s.approved(approvalClaim, "approve")), true);
  NodeAssert.equal(
    await dispatchCall((s) => s.completeApproval(approvalClaim, 0, "paused-approval")),
    false,
  );
  await executeControl(command("p20-approval", "approval-resume", 2, "resume"));
  NodeAssert.equal(await dispatchCall((s) => s.approved(approvalClaim, "approve")), true);
  await query(
    "UPDATE foundry_automation.run_controls SET revision=revision+1,result_revision=result_revision+1 WHERE run_id='p20-approval'",
    "automation_migrator",
  );
  NodeAssert.equal(await dispatchCall((s) => s.approved(approvalClaim, "approve")), false);
  NodeAssert.equal(
    await dispatchCall((s) => s.completeApproval(approvalClaim, 0, "changed-approval")),
    false,
  );
  await NodeAssert.rejects(executeControl({ ...approvalCommand, commandId: "stale-approval" }));
  await executeControl(command("p20-approval", "approval-cancel", 4, "cancel"));
  NodeAssert.equal(await dispatchCall((s) => s.confirmCancel(approvalClaim)), true);
  await workflowCall((s) =>
    s.createVersion({
      commandId: "p20-double-flow",
      id: "p20-double-flow",
      factoryId: "p19",
      factoryVersionId: "p19-version",
      steps: [
        { id: "first-review", kind: "approval", prompt: "First reviewer", dependsOn: [] },
        {
          id: "second-review",
          kind: "approval",
          prompt: "Second reviewer",
          dependsOn: ["first-review"],
        },
        {
          id: "implementation",
          kind: "agent",
          prompt: "Implement after both reviews",
          dependsOn: ["second-review"],
        },
      ],
    }),
  );
  await startControl("p20-double", "p20-double-flow");
  const doubleClaim = await dispatchCall((s) =>
    s.claimNext({ workerId: controlIdentity.deviceId, owner: "double-owner", leaseMillis: 60000 }),
  );
  NodeAssert.ok(doubleClaim);
  const doubleDecision = (
    commandId: string,
    stepId: string,
    expectedRevision: number,
    action: "approve" | "reject" = "approve",
  ) => ({
    factoryId: "p19",
    runId: "p20-double",
    commandId,
    stepId,
    expectedRevision,
    action,
    resultRevision: 0,
  });
  await executeControl(doubleDecision("double-first", "first-review", 0));
  NodeAssert.equal(
    await dispatchCall((s) => s.completeApproval(doubleClaim, 0, "double-first-attempt")),
    true,
  );
  await executeControl(doubleDecision("double-second", "second-review", 1));
  NodeAssert.equal(await dispatchCall((s) => s.approved(doubleClaim, "first-review")), true);
  NodeAssert.equal(await dispatchCall((s) => s.approved(doubleClaim, "second-review")), true);
  await executeControl(doubleDecision("double-second-reject", "second-review", 2, "reject"));
  NodeAssert.equal(
    await dispatchCall((s) => s.completeApproval(doubleClaim, 1, "double-second-attempt")),
    false,
  );
  NodeAssert.equal(
    (
      await query(
        "SELECT command_id FROM foundry_automation.step_attempts WHERE command_id='double-second-attempt'",
      )
    ).length,
    0,
  );
  await executeControl(doubleDecision("double-second-again", "second-review", 3));
  await query(
    "CREATE FUNCTION foundry_automation.reject_approval_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected approval completion failure'; END $$",
    "automation_migrator",
  );
  await query(
    "CREATE TRIGGER reject_approval_finish BEFORE UPDATE ON foundry_automation.step_attempts FOR EACH ROW EXECUTE FUNCTION foundry_automation.reject_approval_finish()",
    "automation_migrator",
  );
  await NodeAssert.rejects(
    dispatchCall((s) => s.completeApproval(doubleClaim, 1, "double-second-attempt")),
  );
  NodeAssert.equal(
    (
      await query(
        "SELECT command_id FROM foundry_automation.step_attempts WHERE command_id='double-second-attempt'",
      )
    ).length,
    0,
  );
  NodeAssert.equal(
    (
      await query(
        "SELECT command_id FROM foundry_automation.dispatch_outbox WHERE command_id='double-second-attempt'",
      )
    ).length,
    0,
  );
  await query(
    "DROP TRIGGER reject_approval_finish ON foundry_automation.step_attempts",
    "automation_migrator",
  );
  await query("DROP FUNCTION foundry_automation.reject_approval_finish()", "automation_migrator");
  NodeAssert.equal(
    await dispatchCall((s) => s.completeApproval(doubleClaim, 1, "double-second-attempt")),
    true,
  );
  NodeAssert.equal(
    await dispatchCall((s) => s.completeApproval(doubleClaim, 1, "double-second-attempt")),
    true,
  );
  const doubleLaunch = { ...launchRequest, commandId: "double-launch" };
  await dispatchCall((s) =>
    s.prepare(doubleClaim, {
      ordinal: 2,
      commandId: doubleLaunch.commandId,
      request: doubleLaunch,
    }),
  );
  await executeControl(doubleDecision("double-first-reject", "first-review", 4, "reject"));
  NodeAssert.equal(
    await dispatchCall((s) => s.beginDelivery(doubleClaim, doubleLaunch.commandId)),
    false,
  );
  await executeControl(doubleDecision("double-first-again", "first-review", 5));
  NodeAssert.equal(
    await dispatchCall((s) => s.beginDelivery(doubleClaim, doubleLaunch.commandId)),
    true,
  );
  await dispatchCall((s) =>
    s.record(doubleClaim, {
      commandId: doubleLaunch.commandId,
      state: "succeeded",
      reason: null,
      receipt: null,
      result: stoppedResult,
    }),
  );
  await run(
    Console.log(
      "PASS P20 consecutive approvals: independent reviewed-result approvals survive another decision; newest rejection fences atomic consumption and prepared dispatch; injected completion failure rolls back approval attempt and outbox; duplicate consumption is idempotent.",
    ),
  );
  await startControl("p20-retry");
  const retryClaim = await dispatchCall((s) =>
    s.claimNext({ workerId: controlIdentity.deviceId, owner: "retry-owner", leaseMillis: 60000 }),
  );
  NodeAssert.ok(retryClaim);
  await dispatchCall((s) =>
    s.prepare(retryClaim, {
      ordinal: 0,
      commandId: "retry-original",
      request: { ...launchRequest, commandId: "retry-original" },
    }),
  );
  await dispatchCall((s) =>
    s.record(retryClaim, {
      commandId: "retry-original",
      state: "failed",
      reason: "worker_failed",
      receipt: null,
      result: {
        ...stoppedResult,
        execution: {
          ...stoppedResult.execution,
          receipt: { ...stoppedResult.execution.receipt, commandId: "retry-original" },
        },
      },
    }),
  );
  const beforeRetry = await readControl("p20-retry");
  await executeControl(command("p20-retry", "retry-1", beforeRetry.revision, "retry"));
  const retried = await dispatchCall((s) => s.read("p19", "p20-retry"));
  NodeAssert.equal(retried.attempts.length, 2);
  NodeAssert.equal(retried.attempts[0]?.state, "failed");
  NodeAssert.equal(retried.attempts[1]?.attemptNumber, 1);
  NodeAssert.equal(retried.attempts[1]?.state, "pending");
  NodeAssert.notEqual(retried.attempts[0]?.commandId, retried.attempts[1]?.commandId);
  await executeControl(command("p20-retry", "retry-1", beforeRetry.revision, "retry"));
  NodeAssert.equal((await dispatchCall((s) => s.read("p19", "p20-retry"))).attempts.length, 2);
  NodeAssert.equal(
    DispatchStore.writerEnded({
      ...stoppedResult,
      execution: {
        ...stoppedResult.execution,
        lifecycle: { ...stoppedResult.execution.lifecycle, writerEnded: false },
      },
    }),
    false,
  );
  NodeAssert.equal(
    DispatchStore.writerEnded({
      ...stoppedResult,
      execution: {
        ...stoppedResult.execution,
        lifecycle: {
          ...stoppedResult.execution.lifecycle,
          manifest: { ...stoppedResult.execution.lifecycle.manifest, generation: 2 },
        },
      },
    }),
    false,
  );
  await run(
    Console.log(
      "PASS P20 PostgreSQL: atomic persistent manual admission; conflicting start binding; four concurrent command retries; stale revision/conflicting command; pause suppresses prepare; restart receipt; revoked auth and old generations; cancel before delivery and lost-response sending; positive writer-stop fence; revision-bound approval invalidation; explicit retry retains failed history and creates exactly one new attempt.",
    ),
  );
  const questionEvents = Schema.decodeSync(Schema.Array(FoundryArchiveEvent))([
    {
      sequence: 1,
      sourceSequence: 1,
      event: {
        id: "q-request",
        threadId: "p20-thread",
        occurredAt: "2026-11-04T00:00:00Z",
        type: "runtime-request.updated",
        payload: {
          id: "p20-question",
          nodeId: "q-node",
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: "2026-11-04T00:00:00Z",
          resolvedAt: null,
        },
      },
    },
    {
      sequence: 2,
      sourceSequence: 2,
      event: {
        id: "q-item",
        threadId: "p20-thread",
        occurredAt: "2026-11-04T00:00:00Z",
        type: "turn-item.updated",
        payload: {
          id: "q-item",
          threadId: "p20-thread",
          runId: "p20-native",
          nodeId: "q-node",
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "running",
          title: null,
          startedAt: null,
          completedAt: null,
          updatedAt: "2026-11-04T00:00:00Z",
          type: "user_input_request",
          requestId: "p20-question",
          questions: [
            {
              id: "choice",
              header: "Choice",
              question: "Choose explicitly",
              options: [{ label: "yes", description: "Proceed" }],
              allowCustomAnswer: false,
              required: true,
            },
          ],
        },
      },
    },
  ]);
  const answerLaunch = retried.attempts[1]!.commandId;
  await dispatchCall((store) =>
    store.record(retryClaim, {
      commandId: answerLaunch,
      state: "running",
      reason: "worker_result_pending",
      receipt: {
        receipt: { ...stoppedResult.execution.receipt, commandId: answerLaunch },
        generation: 1,
        runId: stoppedResult.execution.run.id,
      },
      result: null,
    }),
  );
  const beforeQuestion = await readControl("p20-retry");
  await dispatchCall((s) => s.projectQuestions(retryClaim, answerLaunch, questionEvents));
  const questionRevision = await readControl("p20-retry");
  NodeAssert.equal(questionRevision.revision, beforeQuestion.revision + 1);
  NodeAssert.equal(await dispatchCall((s) => s.archiveCursor(answerLaunch)), 2);
  await dispatchCall((s) => s.projectQuestions(retryClaim, answerLaunch, questionEvents));
  NodeAssert.equal((await readControl("p20-retry")).revision, questionRevision.revision);
  const answerCommand = {
    factoryId: "p19",
    runId: "p20-retry",
    commandId: "answer-1",
    expectedRevision: questionRevision.revision,
    action: "answer" as const,
    requestId: "p20-question",
    resultRevision: questionRevision.resultRevision,
    answers: { choice: "yes" },
  };
  await NodeAssert.rejects(
    executeControl({ ...answerCommand, expectedRevision: beforeQuestion.revision }),
  );
  await NodeAssert.rejects(
    executeControl({ ...answerCommand, commandId: "invalid-answer", answers: { choice: "other" } }),
  );
  await executeControl(answerCommand);
  NodeAssert.equal((await dispatchCall((s) => s.answers("p20-retry"))).length, 1);
  await stop();
  await start();
  await executeControl(answerCommand);
  NodeAssert.equal((await dispatchCall((s) => s.answers("p20-retry"))).length, 1);
  await dispatchCall((s) => s.answerDelivered("p20-retry", "p20-question"));
  NodeAssert.equal((await dispatchCall((s) => s.answers("p20-retry"))).length, 0);
  const rollbackRevision = await readControl("p20-retry");
  await query(
    "CREATE FUNCTION foundry_automation.reject_control_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected control receipt failure'; END $$",
    "automation_migrator",
  );
  await query(
    "CREATE TRIGGER reject_control_receipt BEFORE INSERT ON foundry_automation.control_commands FOR EACH ROW EXECUTE FUNCTION foundry_automation.reject_control_receipt()",
    "automation_migrator",
  );
  await NodeAssert.rejects(
    executeControl(command("p20-retry", "atomic-pause", rollbackRevision.revision, "pause")),
  );
  NodeAssert.deepEqual(await readControl("p20-retry"), rollbackRevision);
  NodeAssert.equal(
    (await query("SELECT id FROM foundry_automation.commands WHERE id='atomic-pause'")).length,
    0,
  );
  await query(
    "DROP TRIGGER reject_control_receipt ON foundry_automation.control_commands",
    "automation_migrator",
  );
  await query("DROP FUNCTION foundry_automation.reject_control_receipt()", "automation_migrator");
  await run(
    Console.log(
      "PASS P20 questions: ordered archive projection, duplicate delivery, revision invalidation, rejected invalid answer, durable answer intent/restart/receipt, separate native delivery acknowledgement; injected receipt failure rolls back control revision and intent atomically.",
    ),
  );
  await query(
    "INSERT INTO foundry_automation.run_questions(run_id,request_id,thread_id,payload,status,source_sequence) SELECT run_id,'old-question',thread_id,jsonb_set(payload,'{request,id}','\"old-question\"'),'pending',source_sequence+1 FROM foundry_automation.run_questions WHERE run_id='p20-retry' AND request_id='p20-question'",
    "automation_migrator",
  );
  await dispatchCall((store) =>
    store.record(retryClaim, {
      commandId: answerLaunch,
      state: "failed",
      reason: "worker_failed",
      receipt: null,
      result: {
        ...stoppedResult,
        execution: {
          ...stoppedResult.execution,
          receipt: { ...stoppedResult.execution.receipt, commandId: answerLaunch },
        },
      },
    }),
  );
  const failedQuestion = await readControl("p20-retry");
  await NodeAssert.rejects(
    executeControl({
      ...answerCommand,
      commandId: "answer-ended-attempt",
      requestId: "old-question",
      expectedRevision: failedQuestion.revision,
      resultRevision: failedQuestion.resultRevision,
    }),
  );
  await executeControl(
    command("p20-retry", "retry-after-question", failedQuestion.revision, "retry"),
  );
  const nextQuestion = await readControl("p20-retry");
  await NodeAssert.rejects(
    executeControl({
      ...answerCommand,
      commandId: "answer-old-attempt",
      requestId: "old-question",
      expectedRevision: nextQuestion.revision,
      resultRevision: nextQuestion.resultRevision,
    }),
  );
  const newestAttempt = (await dispatchCall((store) => store.read("p19", "p20-retry"))).attempts.at(
    -1,
  )!;
  await dispatchCall((store) =>
    store.record(retryClaim, {
      commandId: newestAttempt.commandId,
      state: "running",
      reason: "worker_result_pending",
      receipt: {
        receipt: {
          ...stoppedResult.execution.receipt,
          commandId: newestAttempt.commandId,
          threadId: "p20-retry-new-thread",
        },
        generation: 1,
        runId: stoppedResult.execution.run.id,
      },
      result: null,
    }),
  );
  await NodeAssert.rejects(
    executeControl({
      ...answerCommand,
      commandId: "answer-other-thread",
      requestId: "old-question",
      expectedRevision: nextQuestion.revision,
      resultRevision: nextQuestion.resultRevision,
    }),
  );
  NodeAssert.equal(
    (
      await query(
        "SELECT answer FROM foundry_automation.run_questions WHERE run_id='p20-retry' AND request_id='old-question'",
      )
    )[0]?.answer,
    null,
  );
  await run(
    Console.log(
      "PASS P20 stale questions: ended attempt, unaccepted retry and replacement thread cannot receive an answer to the previous attempt's question.",
    ),
  );
  await run(
    definitionSourceGates(
      db("automation_runtime"),
      Effect.tryPromise({
        try: async () => {
          await stop();
          await start();
        },
        catch: () => new AutomationTriggerError({ code: "unavailable" }),
      }),
    ),
  );
  await run(
    Console.log(
      "PASS P48 PostgreSQL: explicit drift recovery, permanent Git ownership, immutable snapshots, exact revision activation, late sync fencing, revoked reads and pause, idempotent rollback; functional G11 import/change/invalid commit, two pinned manual admissions and Inbox decisions across restart.",
    ),
  );
  await query("CREATE DATABASE handoff_archive_fixture OWNER fixture_admin");
  await query("REVOKE ALL ON DATABASE handoff_archive_fixture FROM PUBLIC");
  await run(
    handoffGates(
      db("automation_runtime"),
      Effect.tryPromise({
        try: async () => {
          await stop();
          await start();
        },
        catch: () => new AutomationTriggerError({ code: "unavailable" }),
      }),
      InstanceDatabase.layer({
        path,
        username: "fixture_admin",
        database: "handoff_archive_fixture",
      }),
    ),
  );
  await run(
    Console.log(
      "PASS P51 isolated PostgreSQL: takeover/dispatch fencing, lost acknowledgement and restart, explicit reopen, revision and grant conflicts, confirmed return and paused continuation; Worker transport fixture and real archive authorization, no native provider turn.",
    ),
  );
  await run(
    parallelGates(
      db("automation_runtime"),
      Effect.tryPromise({
        try: async () => {
          await stop();
          await start();
        },
        catch: () => new AutomationTriggerError({ code: "unavailable" }),
      }),
    ),
  );
  await run(
    Console.log(
      "PASS P29/P32 PostgreSQL: competing capacity reservations, independent ready branches, dependency-gated join, paused worker admission, idempotent repair across PostgreSQL restart, stale-claim fencing, bounded repair exhaustion, and cancellation retains uncertain sends until writer end. This tests persistence, not native execution overlap.",
    ),
  );
  await run(
    v4Gates(
      db("automation_runtime"),
      Effect.tryPromise({
        try: async () => {
          await stop();
          await start();
        },
        catch: () => new AutomationTriggerError({ code: "unavailable" }),
      }),
    ),
  );
  await run(
    Console.log(
      "PASS v4 PostgreSQL: pinned modular snapshot, duplicate reservation, review/fix checkpoint and carry, restart, stale claim fencing and durable execution budget.",
    ),
  );
  await run(applicationGates(db("automation_runtime")));
  await run(
    triggerGates(
      db("automation_runtime"),
      Effect.tryPromise({
        try: async () => {
          await stop();
          await start();
        },
        catch: () => new AutomationTriggerError({ code: "unavailable" }),
      }),
    ),
  );
  await run(
    Console.log(
      "PASS P18a/P18b/P47 isolated PostgreSQL: idempotent factories/workflows/runs; pinned versions/repository/revisions; atomic run/outbox and definition activation; canonical import/export; hash/provenance; version conflicts; invalid definitions preserve active version; v1/v2/v3 upgrades and PostgreSQL restart; immutable runtime history. P19 opt-in enrollment, concurrent claims, restart and stale-lease fencing, immutable requests/receipts, atomic attempt/outbox rollback, reconciliation, failed-step blocking and sequential completion; claim locks released before transport. No live runtime activation.",
    ),
  );
} finally {
  await stop();
  await NodeFSP.rm(root, { recursive: true, force: true });
}

await import("./test-automation-session-reference.ts");
