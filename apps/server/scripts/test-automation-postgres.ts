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
    "DROP TABLE foundry_automation.definition_heads,foundry_automation.definition_versions,foundry_automation.outbox,foundry_automation.runs,foundry_automation.workflow_versions",
    "ALTER TABLE foundry_automation.work_items DROP CONSTRAINT work_items_factory_id_id_key",
    "UPDATE foundry_automation.schema_version SET version=1",
  ])
    await query(statement, "automation_migrator");
  await run(Effect.all([migration, migration], { concurrency: "unbounded" }));
  NodeAssert.deepEqual(await call((s) => s.readWorkItem("a", "w1")), beforeUpgrade);
  NodeAssert.equal(
    (await query("SELECT version FROM foundry_automation.schema_version"))[0]?.version,
    3,
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
    "DROP TABLE foundry_automation.definition_heads,foundry_automation.definition_versions",
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
  const edits = await Promise.allSettled(
    ["left", "right"].map((edit) =>
      definitionCall((s) =>
        s.activate({
          ...activation,
          commandId: "edit-" + edit,
          expectedVersionId: roundtrip.id,
          files: exportFactoryFiles({
            ...initialDefinition.definition,
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
  await query("UPDATE foundry_automation.schema_version SET version=3", "automation_migrator");
  await run(migration);
  await run(
    Console.log(
      "PASS P18a/P18b/P47 isolated PostgreSQL: idempotent factories/workflows/runs; pinned versions/repository/revisions; atomic run/outbox and definition activation; canonical import/export; hash/provenance; version conflicts; invalid definitions preserve active version; v1/v2 upgrades and PostgreSQL restart; immutable runtime history. No runtime activation or dispatch.",
    ),
  );
} finally {
  await stop();
  await NodeFSP.rm(root, { recursive: true, force: true });
}
