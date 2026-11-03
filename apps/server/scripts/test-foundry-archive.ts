// @effect-diagnostics nodeBuiltinImport:off -- This harness owns the isolated PostgreSQL process and temporary blob directory.
// @effect-diagnostics globalProcess:off -- PostgreSQL binaries are explicitly supplied; no existing databases are accessed.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  FoundryArchiveEvent,
  FoundryArchiveError,
  FoundryInstanceId,
  EnvironmentId,
  ThreadId,
  FoundryDeviceId,
  CommandId,
  type FoundryArchiveIngest,
} from "@t3tools/contracts";
import * as Archive from "../src/foundry/ThreadArchive.ts";
import * as Database from "../src/foundry/InstanceDatabase.ts";
import * as Migrations from "../src/foundry/InstanceMigrations.ts";
import * as Files from "../src/foundry/ArtifactFiles.ts";
import * as Artifacts from "../src/foundry/Artifacts.ts";
import * as Identity from "../src/foundry/InstancePostgres.ts";
import * as Environment from "../src/environment/ServerEnvironment.ts";
import * as Config from "../src/config.ts";

const bin = process.env.FOUNDRY_TEST_PG_BIN;
NodeAssert.ok(bin, "FOUNDRY_TEST_PG_BIN must identify isolated PostgreSQL binaries");
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "foundry-archive-pg-"));
const data = NodePath.join(root, "pg");
const socket = NodePath.join(root, ".s.PGSQL.5432");
const directory = NodePath.join(root, "artifacts");
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
    server.once("exit", () => reject(new Error("Owned PostgreSQL exited before readiness")));
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
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const db = (username: string) => Database.layer({ path: socket, database: "postgres", username });
const query = (statement: string, username = "fixture_admin") =>
  run(
    Effect.gen(function* () {
      const sql = yield* Database.InstanceDatabase;
      return yield* sql.unsafe<Record<string, unknown>>(statement);
    }).pipe(Effect.provide(db(username))),
  );
const instanceId = FoundryInstanceId.make("11111111-1111-4111-8111-111111111111");
const operatorId = "22222222-2222-4222-8222-222222222222";
const deviceId = FoundryDeviceId.make("33333333-3333-4333-8333-333333333333");
const mainEnvironmentId = EnvironmentId.make("archive-main");
const owner = {
  environmentId: EnvironmentId.make("archive-worker"),
  threadId: ThreadId.make("archive-thread"),
};
const principal = { instanceId, operatorId };
const machine = { ...principal, deviceId, generation: 1, deviceEnvironmentId: owner.environmentId };
const storage = Files.layer.pipe(
  Layer.provide(Layer.succeed(Files.ArtifactDirectory, { path: directory })),
);
const services = Layer.merge(Archive.layer, Artifacts.layer).pipe(
  Layer.provide(storage),
  Layer.provide(Identity.layer),
  Layer.provide(db("archive_runtime")),
  Layer.provide(
    Layer.succeed(Environment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(mainEnvironmentId),
    }),
  ),
  Layer.provide(Config.layerTest(root, NodePath.join(root, "home"))),
  Layer.provide(NodeServices.layer),
);
const call = <A, E>(f: (s: Archive.ThreadArchive["Service"]) => Effect.Effect<A, E>) =>
  run(Archive.ThreadArchive.pipe(Effect.flatMap(f), Effect.provide(services)));
const artifact = <A, E>(f: (s: Artifacts.Artifacts["Service"]) => Effect.Effect<A, E>) =>
  run(Artifacts.Artifacts.pipe(Effect.flatMap(f), Effect.provide(services)));
const isError = Schema.is(FoundryArchiveError);
const failure = (promise: Promise<unknown>, code: FoundryArchiveError["code"]) =>
  NodeAssert.rejects(promise, (error: unknown) => isError(error) && error.code === code);
const decodeEvent = Schema.decodeUnknownSync(FoundryArchiveEvent);
const encodeStoredEvent = Schema.encodeSync(Schema.fromJsonString(FoundryArchiveEvent));
const now = "2026-11-03T00:00:00.000Z";
const created = decodeEvent({
  sequence: 1,
  sourceSequence: 10,
  event: {
    id: "event:created",
    threadId: owner.threadId,
    type: "thread.created",
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: owner.threadId,
      projectId: "project:archive",
      title: "Manual archive fixture",
      providerInstanceId: "replay",
      modelSelection: { instanceId: "replay", model: "replay" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: owner.threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  },
});
const message = (sequence: number, sourceSequence: number, attachments: readonly unknown[] = []) =>
  decodeEvent({
    sequence,
    sourceSequence,
    event: {
      id: `event:${sequence}`,
      threadId: owner.threadId,
      type: "message.updated",
      occurredAt: now,
      payload: {
        id: `message:${sequence}`,
        runId: null,
        nodeId: null,
        createdBy: "user",
        creationSource: "web",
        threadId: owner.threadId,
        role: "user",
        text: `confirmed content ${sequence}`,
        attachments,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
const input = (events: readonly FoundryArchiveEvent[], sourceHead = 3): FoundryArchiveIngest => ({
  instanceId,
  owner,
  sourceHead,
  sourceComplete: true,
  events,
});
try {
  const initialized = NodeChildProcess.spawnSync(
    NodePath.join(bin, "initdb"),
    ["-D", data, "-U", "fixture_admin", "--auth=trust", "--no-locale"],
    { encoding: "utf8" },
  );
  NodeAssert.equal(initialized.status, 0, initialized.stderr);
  await start();
  for (const statement of [
    "CREATE ROLE archive_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    "CREATE ROLE archive_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    "REVOKE ALL ON DATABASE postgres FROM PUBLIC",
    "REVOKE ALL ON SCHEMA public FROM PUBLIC",
    "GRANT CONNECT,CREATE ON DATABASE postgres TO archive_migrator",
    "GRANT CONNECT ON DATABASE postgres TO archive_runtime",
  ])
    await query(statement);
  const migrate = Migrations.InstanceMigrations.pipe(
    Effect.flatMap((s) =>
      s.migrate({ instanceId, mainEnvironmentId, runtimeRole: "archive_runtime" }),
    ),
    Effect.provide(Migrations.layer.pipe(Layer.provide(db("archive_migrator")))),
  );
  await run(migrate);
  await query(
    `INSERT INTO foundry_instance.operator_binding(operator_id,issuer,subject) VALUES('${operatorId}','https://issuer.test','archive')`,
    "archive_migrator",
  );
  await query(
    `INSERT INTO foundry_instance.devices(device_id,instance_id,operator_id,environment_id,public_key) VALUES('${deviceId}','${instanceId}','${operatorId}','${owner.environmentId}','${"x".repeat(43)}')`,
    "archive_migrator",
  );
  await query(
    "DROP TABLE foundry_instance.archive_artifacts,foundry_instance.archive_events,foundry_instance.archive_threads",
    "archive_migrator",
  );
  await query("UPDATE foundry_instance.schema_version SET version=6", "archive_migrator");
  await Promise.all([run(migrate), run(migrate)]);
  NodeAssert.equal(
    (await query("SELECT operator_id FROM foundry_instance.operator_binding"))[0]?.operator_id,
    operatorId,
  );
  NodeAssert.equal(
    (await query("SELECT version FROM foundry_instance.schema_version"))[0]?.version,
    7,
  );
  const gap = await call((s) => s.ingest(machine, input([created, message(3, 30)])));
  NodeAssert.equal(gap.confirmedCursor, 1);
  NodeAssert.equal(gap.sourceHead, 3);
  NodeAssert.equal(gap.complete, false);
  // The first response is deliberately discarded; duplicate delivery must recover its committed cursor.
  await call((s) => s.ingest(machine, input([message(2, 20)])));
  const duplicate = await call((s) => s.ingest(machine, input([created, message(2, 20)])));
  NodeAssert.equal(duplicate.confirmedCursor, 2);
  await failure(
    call((s) => s.ingest(machine, input([message(2, 21)]))),
    "conflict",
  );
  await failure(
    call((s) => s.ingest({ ...machine, generation: 2 }, input([message(3, 30)]))),
    "forbidden",
  );
  await failure(
    call((s) =>
      s.ingest(
        { ...machine, operatorId: "44444444-4444-4444-8444-444444444444" },
        input([message(3, 30)]),
      ),
    ),
    "forbidden",
  );
  await failure(
    call((s) =>
      s.ingest(
        { ...machine, instanceId: FoundryInstanceId.make("55555555-5555-4555-8555-555555555555") },
        input([message(3, 30)]),
      ),
    ),
    "forbidden",
  );
  await failure(
    call((s) =>
      s.ingest(machine, {
        ...input([message(3, 30)]),
        owner: { ...owner, environmentId: EnvironmentId.make("foreign-worker") },
      }),
    ),
    "forbidden",
  );
  await failure(
    call((s) => s.ingest(machine, input([message(3, 30), message(4, 29)], 4))),
    "conflict",
  );
  NodeAssert.equal((await call((s) => s.cursor(machine, owner))).confirmedCursor, 2);
  NodeAssert.equal(
    (await query("SELECT count(*)::int AS count FROM foundry_instance.archive_events"))[0]?.count,
    2,
  );
  await query(
    "CREATE FUNCTION foundry_instance.fail_archive_cursor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$",
    "archive_migrator",
  );
  await query(
    "CREATE TRIGGER fail_archive_cursor BEFORE UPDATE ON foundry_instance.archive_threads FOR EACH ROW EXECUTE FUNCTION foundry_instance.fail_archive_cursor()",
    "archive_migrator",
  );
  await failure(
    call((s) => s.ingest(machine, input([message(3, 30)]))),
    "unavailable",
  );
  NodeAssert.equal(
    (await query("SELECT count(*)::int AS count FROM foundry_instance.archive_events"))[0]?.count,
    2,
  );
  NodeAssert.equal((await call((s) => s.cursor(machine, owner))).confirmedCursor, 2);
  await query(
    "DROP TRIGGER fail_archive_cursor ON foundry_instance.archive_threads",
    "archive_migrator",
  );
  const repeated = message(3, 30);
  await failure(
    call((s) =>
      s.ingest(
        machine,
        input([{ ...repeated, event: { ...repeated.event, id: created.event.id } }]),
      ),
    ),
    "conflict",
  );
  const concurrent = await Promise.all([
    call((s) => s.ingest(machine, input([message(3, 30)]))),
    call((s) => s.ingest(machine, input([message(3, 30)]))),
  ]);
  NodeAssert.ok(concurrent.every((x) => x.confirmedCursor === 3 && x.complete));
  const first = await call((s) => s.read(principal, { owner, limit: 2 }));
  NodeAssert.equal(first.nextCursor, 2);
  NodeAssert.equal(first.events.length, 2);
  const last = await call((s) => s.read(principal, { owner, after: first.nextCursor!, limit: 2 }));
  NodeAssert.equal(last.events[0]?.event.type, "message.updated");
  NodeAssert.equal(last.nextCursor, null);
  await stop();
  await start();
  NodeAssert.equal((await call((s) => s.cursor(machine, owner))).confirmedCursor, 3);
  NodeAssert.equal(
    (await call((s) => s.ingest(machine, input([message(3, 30)])))).confirmedCursor,
    3,
  );
  await failure(
    call((s) => s.ingest(machine, { ...input([]), sourceComplete: false })),
    "conflict",
  );
  if (created.event.type !== "thread.created") throw new Error("fixture thread event");
  const threadEvent = created.event;
  const oldOwner = { ...owner, threadId: ThreadId.make("archive-pre-existing") };
  const oldCreated = {
    ...created,
    event: {
      ...threadEvent,
      threadId: oldOwner.threadId,
      payload: {
        ...threadEvent.payload,
        id: oldOwner.threadId,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: oldOwner.threadId,
        },
      },
    },
  };
  const historical = await call((s) =>
    s.ingest(machine, {
      instanceId,
      owner: oldOwner,
      sourceHead: 1,
      sourceComplete: false,
      events: [oldCreated],
    }),
  );
  NodeAssert.equal(historical.confirmedCursor, 1);
  NodeAssert.equal(historical.complete, false);
  const largeOwner = { ...owner, threadId: ThreadId.make("archive-page-bytes") };
  const largeCreated = {
    ...created,
    event: {
      ...threadEvent,
      threadId: largeOwner.threadId,
      payload: {
        ...threadEvent.payload,
        id: largeOwner.threadId,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: largeOwner.threadId,
        },
      },
    },
  };
  await call((s) =>
    s.ingest(machine, {
      instanceId,
      owner: largeOwner,
      sourceHead: 3,
      sourceComplete: true,
      events: [largeCreated],
    }),
  );
  for (const ordinal of [2, 3]) {
    const source = message(ordinal, ordinal * 10);
    if (source.event.type !== "message.updated") throw new Error("fixture message type");
    const event = {
      ...source,
      event: {
        ...source.event,
        threadId: largeOwner.threadId,
        payload: {
          ...source.event.payload,
          threadId: largeOwner.threadId,
          text: "x".repeat(600_000),
        },
      },
    };
    await call((s) =>
      s.ingest(machine, {
        instanceId,
        owner: largeOwner,
        sourceHead: 3,
        sourceComplete: true,
        events: [event],
      }),
    );
  }
  const bounded = await call((s) => s.read(principal, { owner: largeOwner }));
  NodeAssert.equal(bounded.events.length, 2);
  NodeAssert.equal(bounded.nextCursor, 2);
  NodeAssert.equal(
    (await call((s) => s.read(principal, { owner: largeOwner, after: 2 }))).events.length,
    1,
  );
  const bytes = new TextEncoder().encode("durable P38a attachment");
  const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  const begun = await artifact((s) =>
    s.begin(principal, {
      instanceId,
      owner,
      commandId: CommandId.make("archive-attachment"),
      name: "proof.txt",
      mimeType: "text/plain",
      sizeBytes: bytes.length,
      sha256,
    }),
  );
  await artifact((s) =>
    s.write(principal, {
      reference: begun.reference,
      offset: 0,
      data: Buffer.from(bytes).toString("base64"),
      sha256,
    }),
  );
  const missing = message(4, 40, [
    {
      type: "file",
      id: "archive-thread_attachment",
      name: "proof.txt",
      mimeType: "text/plain",
      sizeBytes: bytes.length,
      foundryArtifact: {
        reference: begun.reference,
        name: "proof.txt",
        mimeType: "text/plain",
        sizeBytes: bytes.length,
        sha256,
      },
    },
  ]);
  NodeAssert.equal((await call((s) => s.ingest(machine, input([missing], 4)))).complete, false);
  await artifact((s) => s.publish(principal, begun.reference));
  NodeAssert.equal((await call((s) => s.cursor(principal, owner))).complete, true);
  const localResources = decodeEvent({
    sequence: 5,
    sourceSequence: 50,
    event: {
      id: "event:local-resources",
      type: "turn-item.updated",
      threadId: owner.threadId,
      occurredAt: now,
      payload: {
        id: "tool:resources",
        threadId: owner.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
        type: "dynamic_tool",
        toolName: "asset-fixture",
        input: { path: "literal call argument" },
        viewedImagePath: "/srv/foundry-worker/private/image.png",
        output: {
          content: [
            { type: "image", mimeType: "image/png" },
            { type: "resource_link", uri: "file:///srv/foundry-worker/private/output.bin" },
            { type: "text", text: "Literal transcript /srv/foundry-worker/private stays readable" },
          ],
          htmlRender: { attachmentId: "worker-html", title: "HTML", height: 320 },
          resourceURL: "blob:worker-temporary",
          gatewayTicket: "temporary-ticket",
        },
      },
    },
  });
  const resourceStatus = await call((s) => s.ingest(machine, input([localResources], 5)));
  NodeAssert.equal(resourceStatus.complete, false);
  NodeAssert.ok(resourceStatus.missingAttachmentCount >= 5);
  const resourceRead = await call((s) => s.read(principal, { owner, after: 4 }));
  const archivedTool = resourceRead.events[0]?.event;
  NodeAssert.equal(archivedTool?.type, "turn-item.updated");
  if (archivedTool?.type !== "turn-item.updated" || archivedTool.payload.type !== "dynamic_tool")
    throw new Error("fixture tool event");
  NodeAssert.equal(archivedTool.payload.viewedImagePath, "foundry-archive:unavailable");
  const serialized = encodeStoredEvent(resourceRead.events[0]!);
  NodeAssert.ok(!serialized.includes("/srv/foundry-worker/private/image.png"));
  NodeAssert.ok(!serialized.includes("blob:worker-temporary"));
  NodeAssert.ok(!serialized.includes("temporary-ticket"));
  NodeAssert.ok(
    serialized.includes("Literal transcript /srv/foundry-worker/private stays readable"),
  );
  const blobs = await NodeFSP.readdir(NodePath.join(directory, "blobs"));
  NodeAssert.equal(blobs.length, 1);
  await NodeFSP.unlink(NodePath.join(directory, "blobs", blobs[0]!));
  NodeAssert.equal((await call((s) => s.cursor(principal, owner))).complete, false);
  await query(
    `UPDATE foundry_instance.devices SET revoked=true,generation=2 WHERE device_id='${deviceId}'`,
    "archive_migrator",
  );
  await failure(
    call((s) => s.cursor(machine, owner)),
    "forbidden",
  );
  await query(
    `DELETE FROM foundry_instance.devices WHERE device_id='${deviceId}'`,
    "archive_migrator",
  );
  const fresh = await call((s) => s.read({ ...principal }, { owner }));
  NodeAssert.equal(fresh.confirmedCursor, 5);
  NodeAssert.equal(fresh.events.length, 5);
  NodeAssert.equal(fresh.events[1]?.event.type, "message.updated");
  NodeAssert.equal((await call((s) => s.list(principal, {}))).items.length, 3);
  await failure(
    call((s) =>
      s.read({ ...principal, operatorId: "44444444-4444-4444-8444-444444444444" }, { owner }),
    ),
    "forbidden",
  );
  await NodeAssert.rejects(
    query("UPDATE foundry_instance.archive_events SET event='{}'", "archive_runtime"),
  );
  await run(
    Console.log(
      "P38b PostgreSQL: gap/prefix, lost ack, duplicate/concurrent delivery, rollback, owner/instance/generation, restart, pagination, P38a missing blob, fresh offline read passed.",
    ),
  );
} finally {
  await stop();
  await NodeFSP.rm(root, { recursive: true, force: true });
}
