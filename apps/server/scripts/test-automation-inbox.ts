// @effect-diagnostics nodeBuiltinImport:off -- This harness owns an isolated PostgreSQL cluster and its temporary files.
// @effect-diagnostics globalProcess:off -- PostgreSQL binary location is the only environment input.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { FoundryInstanceId } from "@t3tools/contracts";
import * as Database from "../src/automation/AutomationDatabase.ts";
import * as Migrations from "../src/automation/AutomationMigrations.ts";
import * as Inbox from "../src/automation/Inbox.ts";
import * as WorkerTransport from "../src/automation/WorkerTransport.ts";

const bin = process.env.FOUNDRY_TEST_PG_BIN;
NodeAssert.ok(bin, "Set FOUNDRY_TEST_PG_BIN; only a new isolated PostgreSQL cluster is used.");
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "foundry-inbox-pg-"));
const data = NodePath.join(root, "data");
const socket = NodePath.join(root, ".s.PGSQL.5432");
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
      reject(new Error(`Isolated PostgreSQL exited (${code}): ${output}`)),
    );
    server.stderr!.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4000);
      if (output.includes("database system is ready to accept connections")) resolve();
    });
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
  child.kill("SIGQUIT");
  await exited;
  child = undefined;
}
const db = (username = "automation_runtime") =>
  Database.layer({ path: socket, username, database: "postgres" });
const sql = (statement: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* Database.AutomationDatabase;
      return yield* client.unsafe<Record<string, unknown>>(statement);
    }).pipe(Effect.provide(db("fixture_admin"))),
  );
const instanceId = FoundryInstanceId.make("00000000-0000-4000-8000-000000000001");
const request = HttpServerRequest.fromWeb(new Request("http://localhost"));
const unexpected = Effect.fn("InboxFixture.unexpected")(() =>
  Effect.die("Unexpected worker operation"),
);
const transport = (operatorId: string) =>
  Layer.succeed(
    WorkerTransport.WorkerTransport,
    WorkerTransport.WorkerTransport.of({
      evaluate: Effect.fn("Fixture.evaluate")(() => Effect.die("unused")),
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
      identityForRead: Effect.fn("InboxFixture.identityForRead")(function* () {
        if (operatorId === "denied")
          return yield* new WorkerTransport.WorkerTransportError({ reason: "forbidden" });
        return { instanceId, operatorId };
      }),
      identityForWrite: unexpected,
      authorize: unexpected,
      status: unexpected,
      launch: unexpected,
      read: unexpected,
      renew: unexpected,
      cancel: unexpected,
      answer: unexpected,
    }),
  );
const call = <A, E>(
  f: (service: Inbox.Inbox["Service"]) => Effect.Effect<A, E>,
  operatorId = "owner",
) =>
  Effect.runPromise(
    Inbox.Inbox.pipe(
      Effect.flatMap(f),
      Effect.provide(Inbox.layer.pipe(Layer.provide(db()), Layer.provide(transport(operatorId)))),
    ),
  );
const fail = (promise: Promise<unknown>, reason: string) =>
  NodeAssert.rejects(
    promise,
    (error: unknown) =>
      typeof error === "object" && error !== null && "reason" in error && error.reason === reason,
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
  ])
    await sql(statement);
  await Effect.runPromise(
    Migrations.AutomationMigrations.pipe(
      Effect.flatMap((service) => service.migrate("automation_runtime")),
      Effect.provide(Migrations.layer.pipe(Layer.provide(db("automation_migrator")))),
    ),
  );
  for (const statement of `INSERT INTO foundry_automation.factories(id,name) VALUES('factory','Inbox fixture');
    INSERT INTO foundry_automation.versions(id,factory_id,repositories) VALUES('version','factory',ARRAY['repo']);
    INSERT INTO foundry_automation.work_items(id,factory_id,version_id,repository,title,source) VALUES('work','factory','version','repo','Fixture task','{"kind":"manual","reference":"fixture"}');
    INSERT INTO foundry_automation.workflow_versions(id,factory_id,factory_version_id,steps) VALUES('workflow','factory','version','[{"id":"approve","kind":"approval","dependsOn":[],"prompt":"Review fixture result"}]');
    INSERT INTO foundry_automation.runs(id,factory_id,work_item_id,workflow_version_id,factory_version_id,repository,revision,state) VALUES('run','factory','work','workflow','version','repo','input-revision','pending');
    INSERT INTO foundry_automation.dispatch_runs(run_id,worker_id,binding,state,reason) VALUES('run','worker','{"identity":{"instanceId":"${instanceId}","operatorId":"owner","environmentId":"worker-environment"}}','waiting','approval_required');
    INSERT INTO foundry_automation.run_controls(run_id) VALUES('run');`
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean))
    await sql(statement);
  const page = await call((service) => service.query(request, {}));
  NodeAssert.equal(page.items.length, 1);
  const approval = page.items[0]!;
  NodeAssert.equal(approval.kind, "approval");
  const mark = {
    commandId: "done",
    itemId: approval.id,
    sourceRevision: approval.sourceRevision,
    action: "done" as const,
  };
  const done = await Promise.all([
    call((service) => service.mark(request, mark)),
    call((service) => service.mark(request, mark)),
  ]);
  NodeAssert.deepEqual(done[0], done[1]);
  NodeAssert.equal(done[0]!.isDone, true);
  NodeAssert.equal(
    (await sql("SELECT count(*)::int AS count FROM foundry_automation.run_decisions"))[0]?.count,
    0,
  );
  NodeAssert.equal((await call((service) => service.query(request, {}))).items.length, 0);
  NodeAssert.equal(
    (await call((service) => service.query(request, { status: "done" }))).items[0]?.isDone,
    true,
  );
  await fail(
    call((service) => service.mark(request, { ...mark, action: "read" })),
    "command_conflict",
  );
  NodeAssert.equal((await call((service) => service.query(request, {}), "other")).items.length, 0);
  await fail(
    call((service) => service.mark(request, { ...mark, commandId: "foreign" }), "other"),
    "not_found",
  );
  await fail(
    call((service) => service.query(request, {}), "denied"),
    "forbidden",
  );
  await call((service) =>
    service.mark(request, { ...mark, commandId: "reopen", action: "reopen" }),
  );
  NodeAssert.equal((await call((service) => service.query(request, {}))).items[0]?.isDone, false);
  NodeAssert.equal((await call((service) => service.mark(request, mark))).isDone, true);
  NodeAssert.equal((await call((service) => service.query(request, {}))).items[0]?.isDone, false);
  await sql(
    "UPDATE foundry_automation.run_controls SET revision=revision+1,result_revision=result_revision+1 WHERE run_id='run'",
  );
  await fail(
    call((service) => service.mark(request, { ...mark, commandId: "stale" })),
    "stale_revision",
  );
  const revised = (await call((service) => service.query(request, {}))).items[0]!;
  NodeAssert.notEqual(revised.sourceRevision, approval.sourceRevision);
  NodeAssert.equal(revised.expectedRevision, 1);
  await sql(
    `INSERT INTO foundry_automation.run_questions(run_id,request_id,thread_id,payload,status,source_sequence) VALUES('run','question','thread','{"questions":[{"id":"choice","header":"Choose","question":"Which fixture?","options":[]}]}','pending',1)`,
  );
  NodeAssert.equal(
    (await call((service) => service.query(request, { kind: "question" }))).items.length,
    0,
  );
  await sql(
    `INSERT INTO foundry_automation.step_attempts(command_id,run_id,ordinal,request,state,receipt) VALUES('question-attempt','run',0,'{}','waiting','{"receipt":{"threadId":"thread"}}')`,
  );
  NodeAssert.equal(
    (await call((service) => service.query(request, { kind: "question" }))).items.length,
    0,
  );
  await sql(
    `UPDATE foundry_automation.run_questions SET payload=payload || '{"request":{"kind":"user_input","status":"pending","responseCapability":{"type":"not_resumable"}}}'::jsonb WHERE request_id='question'`,
  );
  NodeAssert.equal(
    (await call((service) => service.query(request, { kind: "question" }))).items.length,
    0,
  );
  await sql(
    `UPDATE foundry_automation.run_questions SET payload=jsonb_set(payload,'{request,responseCapability,type}','"live"'::jsonb) WHERE request_id='question'`,
  );
  const question = (await call((service) => service.query(request, { kind: "question" })))
    .items[0]!;
  NodeAssert.equal(question.questions[0]?.id, "choice");
  NodeAssert.equal(question.status, "pending");
  NodeAssert.equal(question.attemptCommandId, "question-attempt");
  NodeAssert.equal(question.questionRevision, "1");
  await sql(
    `INSERT INTO foundry_automation.step_attempts(command_id,run_id,ordinal,request,state,receipt) VALUES('parallel-attempt','run',1,'{}','running','{"receipt":{"threadId":"parallel-thread"}}')`,
  );
  NodeAssert.equal(
    (await call((service) => service.query(request, { kind: "question" }))).items[0]?.requestId,
    "question",
  );
  await sql("DELETE FROM foundry_automation.step_attempts WHERE command_id='parallel-attempt'");
  await sql(
    `UPDATE foundry_automation.step_attempts SET result='{"execution":{"lifecycle":{"writerEnded":true}}}' WHERE command_id='question-attempt'`,
  );
  NodeAssert.equal(
    (await call((service) => service.query(request, { kind: "question" }))).items.length,
    0,
  );
  NodeAssert.equal(
    (await call((service) => service.query(request, { kind: "question", status: "all" }))).items[0]
      ?.active,
    false,
  );
  await sql(
    "UPDATE foundry_automation.step_attempts SET state='failed',result=NULL WHERE command_id='question-attempt'",
  );
  NodeAssert.equal(
    (await call((service) => service.query(request, { kind: "question" }))).items.length,
    0,
  );
  await sql(
    `INSERT INTO foundry_automation.step_attempts(command_id,run_id,ordinal,attempt_number,request,state) VALUES('question-retry-attempt','run',0,1,'{}','pending')`,
  );
  NodeAssert.equal(
    (await call((service) => service.query(request, { kind: "question" }))).items.length,
    0,
  );
  await sql(
    `UPDATE foundry_automation.step_attempts SET state='waiting',receipt='{"receipt":{"threadId":"retry-thread"}}' WHERE command_id='question-retry-attempt'`,
  );
  NodeAssert.equal(
    (await call((service) => service.query(request, { kind: "question" }))).items.length,
    0,
  );
  await sql(
    `INSERT INTO foundry_automation.run_questions(run_id,request_id,thread_id,payload,status,source_sequence) SELECT run_id,'question-retry','retry-thread',payload,'pending',2 FROM foundry_automation.run_questions WHERE request_id='question'`,
  );
  await sql(
    `UPDATE foundry_automation.step_attempts SET receipt='{"receipt":{"threadId":"thread"}}' WHERE command_id='question-retry-attempt'`,
  );
  NodeAssert.equal(
    (await call((service) => service.query(request, { kind: "question" }))).items.length,
    0,
  );
  await sql(
    `UPDATE foundry_automation.run_questions SET thread_id='thread',payload=payload || '{"attemptCommandId":"question-retry-attempt"}'::jsonb WHERE request_id='question-retry'`,
  );
  NodeAssert.equal(
    (await call((service) => service.query(request, { kind: "question" }))).items[0]?.requestId,
    "question-retry",
  );
  await sql(
    `UPDATE foundry_automation.step_attempts SET receipt='{"receipt":{"threadId":"retry-thread"}}' WHERE command_id='question-retry-attempt'`,
  );
  await sql(
    "UPDATE foundry_automation.run_questions SET thread_id='retry-thread' WHERE request_id='question-retry'",
  );
  const currentQuestions = await call((service) => service.query(request, { kind: "question" }));
  NodeAssert.equal(currentQuestions.items.length, 1);
  NodeAssert.equal(currentQuestions.items[0]?.requestId, "question-retry");

  await sql(
    `UPDATE foundry_automation.run_questions SET status='answered',answer='{"commandId":"answer","answers":{"choice":"Fixture A"},"identity":{"secret":"must-not-leak"}}',source_sequence=3 WHERE request_id='question-retry'`,
  );
  NodeAssert.equal(
    (await call((service) => service.query(request, { kind: "question" }))).items.length,
    0,
  );
  const answer = (await call((service) => service.query(request, { kind: "answer" }))).items[0]!;
  NodeAssert.deepEqual(answer.answer, { choice: "Fixture A" });
  const answeredQuestion = (
    await call((service) => service.query(request, { kind: "question", status: "done" }))
  ).items[0]!;
  NodeAssert.equal(answeredQuestion.status, "answered");
  NodeAssert.equal(answeredQuestion.isDone, true);
  NodeAssert.deepEqual(answeredQuestion.answer, { choice: "Fixture A" });
  NodeAssert.equal(JSON.stringify(answer).includes("must-not-leak"), false);
  await sql(
    "UPDATE foundry_automation.run_controls SET mode='cancel_requested' WHERE run_id='run'",
  );
  const cancelled = (
    await call((service) => service.query(request, { kind: "question", status: "all" }))
  ).items;
  NodeAssert.equal(cancelled.find((item) => item.requestId === "question")?.status, "cancelled");
  NodeAssert.equal(
    cancelled.find((item) => item.requestId === "question-retry")?.status,
    "answered",
  );
  await sql("UPDATE foundry_automation.run_controls SET mode='active' WHERE run_id='run'");
  await sql(
    `UPDATE foundry_automation.run_questions SET payload=jsonb_set(payload,'{request,status}','"cancelled"') WHERE request_id='question'`,
  );
  NodeAssert.equal(
    (
      await call((service) => service.query(request, { kind: "question", status: "all" }))
    ).items.find((item) => item.requestId === "question")?.status,
    "cancelled",
  );
  await sql(
    `UPDATE foundry_automation.run_questions SET payload=jsonb_set(payload,'{request,status}','"resolved"') WHERE request_id='question'`,
  );
  NodeAssert.equal(
    (
      await call((service) => service.query(request, { kind: "question", status: "done" }))
    ).items.find((item) => item.requestId === "question")?.status,
    "resolved",
  );
  const first = await call((service) => service.query(request, { status: "all", limit: 1 }));
  NodeAssert.ok(first.nextCursor);
  const second = await call((service) =>
    service.query(request, { status: "all", limit: 1, cursor: first.nextCursor! }),
  );
  NodeAssert.notEqual(first.items[0]?.id, second.items[0]?.id);
  await sql(
    `CREATE FUNCTION foundry_automation.reject_inbox_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected receipt failure'; END $$`,
  );
  await sql(
    `CREATE TRIGGER reject_inbox_receipt BEFORE INSERT ON foundry_automation.inbox_commands FOR EACH ROW EXECUTE FUNCTION foundry_automation.reject_inbox_receipt()`,
  );
  await fail(
    call((service) =>
      service.mark(request, {
        commandId: "rollback",
        itemId: answer.id,
        sourceRevision: answer.sourceRevision,
        action: "done",
      }),
    ),
    "unavailable",
  );
  NodeAssert.equal(
    (await call((service) => service.query(request, { kind: "answer" }))).items[0]?.isDone,
    false,
  );
  await sql("DROP TRIGGER reject_inbox_receipt ON foundry_automation.inbox_commands");
  await call((service) =>
    service.mark(request, {
      commandId: "read-answer",
      itemId: answer.id,
      sourceRevision: answer.sourceRevision,
      action: "read",
    }),
  );
  await stop();
  await start();
  const restored = (await call((service) => service.query(request, { kind: "answer" }))).items[0]!;
  NodeAssert.equal(restored.isRead, true);
  NodeAssert.deepEqual(restored.answer, { choice: "Fixture A" });
  NodeAssert.equal(
    (await sql("SELECT count(*)::int AS count FROM foundry_automation.run_decisions"))[0]?.count,
    0,
  );
  await sql(
    "INSERT INTO foundry_automation.commands(id,kind,payload) VALUES('approval','fixture','{}')",
  );
  await sql(
    "INSERT INTO foundry_automation.run_decisions(command_id,run_id,step_id,revision,result_revision,approved) VALUES('approval','run','approve',1,1,true)",
  );
  NodeAssert.equal(
    (await call((service) => service.query(request, { kind: "approval" }))).items.length,
    0,
  );
  await sql("UPDATE foundry_automation.run_controls SET revision=2 WHERE run_id='run'");
  NodeAssert.equal(
    (await call((service) => service.query(request, { kind: "approval" }))).items.length,
    0,
  );
  await sql("UPDATE foundry_automation.run_controls SET result_revision=2 WHERE run_id='run'");
  NodeAssert.equal(
    (await call((service) => service.query(request, { kind: "approval" }))).items.length,
    1,
  );
  await sql(
    "INSERT INTO foundry_automation.commands(id,kind,payload) VALUES('new-approval','fixture','{}'),('new-rejection','fixture','{}')",
  );
  await sql(
    "INSERT INTO foundry_automation.run_decisions(command_id,run_id,step_id,revision,result_revision,approved) VALUES('new-approval','run','approve',3,2,true)",
  );
  await sql("UPDATE foundry_automation.run_controls SET revision=3 WHERE run_id='run'");
  NodeAssert.equal(
    (await call((service) => service.query(request, { kind: "approval" }))).items.length,
    0,
  );
  await sql(
    "INSERT INTO foundry_automation.run_decisions(command_id,run_id,step_id,revision,result_revision,approved) VALUES('new-rejection','run','approve',4,2,false)",
  );
  await sql("UPDATE foundry_automation.run_controls SET revision=4 WHERE run_id='run'");
  NodeAssert.equal(
    (await call((service) => service.query(request, { kind: "approval" }))).items.length,
    1,
  );
  await sql(
    "UPDATE foundry_automation.step_attempts SET state='succeeded' WHERE command_id='question-retry-attempt'",
  );
  await sql(
    "UPDATE foundry_automation.dispatch_runs SET reason='approval_revision_changed' WHERE run_id='run'",
  );
  NodeAssert.equal(
    (await call((service) => service.query(request, { kind: "approval" }))).items[0]?.stepId,
    "approve",
  );
  await Effect.runPromise(
    Console.log(
      "Inbox PostgreSQL gates passed: two clients, idempotent receipts, done/undo separate from approval, ownership, stale revisions, owner question/answer reconciliation, inactive old retry/writer-ended questions, pagination, rollback and database restart; zero worker/provider calls.",
    ),
  );
} finally {
  await stop();
  await NodeFSP.rm(root, { recursive: true, force: true });
}
