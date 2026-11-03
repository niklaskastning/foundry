// @effect-diagnostics nodeBuiltinImport:off -- This harness owns its PostgreSQL child, temporary database and blob files.
// @effect-diagnostics globalProcess:off -- Only the explicitly supplied isolated PostgreSQL binary path is read.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Console from "effect/Console";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import { HttpRouter, HttpClient, HttpClientResponse, FetchHttpClient } from "effect/http";
import {
  CommandId,
  EnvironmentId,
  ThreadId,
  FoundryInstanceId,
  FoundryArtifactError,
  FOUNDRY_ARTIFACT_CHUNK_BYTES,
  FoundryAuthError,
  type FoundryArtifactRequest,
  FoundryArtifactMachineRequest,
  FoundryArtifactManifest,
  FoundryArtifactId,
  ChatAttachmentId,
} from "@t3tools/contracts";
import { downloadArtifact } from "@t3tools/shared/foundryArtifacts";
import * as Database from "../src/foundry/InstanceDatabase.ts";
import * as Migrations from "../src/foundry/InstanceMigrations.ts";
import * as Identity from "../src/foundry/InstancePostgres.ts";
import * as Environment from "../src/environment/ServerEnvironment.ts";
import * as ServerConfig from "../src/config.ts";
import * as Files from "../src/foundry/ArtifactFiles.ts";
import * as Artifacts from "../src/foundry/Artifacts.ts";
import * as ArtifactAccess from "../src/foundry/ArtifactAccess.ts";
import * as ArtifactHttp from "../src/foundry/artifactHttp.ts";
import * as ArtifactPublication from "../src/foundry/ArtifactPublication.ts";
import * as DocumentText from "../src/provider/DocumentText.ts";
import * as AttachmentClaims from "../src/orchestration-v2/AttachmentClaims.ts";
import { createPendingAttachmentId } from "../src/attachmentStore.ts";
import * as DeviceConfig from "../src/foundry/DeviceConfig.ts";
import * as DeviceRegistry from "../src/foundry/DeviceRegistry.ts";
import * as FoundrySessions from "../src/foundry/FoundrySessions.ts";
import { generateDeviceKey, signEnrollment } from "../src/foundry/DeviceProof.ts";
import { signArtifactRequest } from "../src/foundry/ArtifactProof.ts";
import * as EnvironmentAuth from "../src/auth/EnvironmentAuth.ts";
import * as SessionStore from "../src/auth/SessionStore.ts";
import * as ServerSecretStore from "../src/auth/ServerSecretStore.ts";
import * as Sqlite from "../src/persistence/Sqlite.ts";

const bin = process.env.FOUNDRY_TEST_PG_BIN;
NodeAssert.ok(
  bin,
  "Set FOUNDRY_TEST_PG_BIN; this script never uses existing PostgreSQL databases.",
);
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "foundry-artifact-pg-"));
const data = NodePath.join(root, "pg");
const socket = NodePath.join(root, ".s.PGSQL.5432");
const directory = NodePath.join(root, "artifacts");
let child: NodeChildProcess.ChildProcess | undefined;
let failWrites = false;
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
const query = (sql: string, username = "fixture_admin") =>
  run(
    Effect.gen(function* () {
      const connection = yield* Database.InstanceDatabase;
      return yield* connection.unsafe<Record<string, unknown>>(sql);
    }).pipe(Effect.provide(db(username))),
  );
const instanceId = FoundryInstanceId.make("11111111-1111-4111-8111-111111111111");
const mainEnvironmentId = EnvironmentId.make("artifact-main");
const owner = {
  environmentId: EnvironmentId.make("artifact-worker"),
  threadId: ThreadId.make("artifact-thread"),
};
const principal: Artifacts.ArtifactPrincipal = {
  instanceId,
  operatorId: "22222222-2222-4222-8222-222222222222",
};
const storage = Files.layer.pipe(
  Layer.provide(Layer.succeed(Files.ArtifactDirectory, { path: directory })),
);
const faultStorage = Layer.effect(
  Files.ArtifactFiles,
  Effect.gen(function* () {
    const original = yield* Files.ArtifactFiles;
    return Files.ArtifactFiles.of({
      ...original,
      write: Effect.fn("ArtifactsFixture.write")((id, offset, bytes) =>
        failWrites
          ? Effect.fail(new FoundryArtifactError({ code: "capacity" }))
          : original.write(id, offset, bytes),
      ),
    });
  }),
).pipe(Layer.provide(storage));
const services = (files = faultStorage) =>
  Artifacts.layer.pipe(
    Layer.provide(files),
    Layer.provide(Identity.layer),
    Layer.provide(db("artifact_runtime")),
    Layer.provide(
      Layer.succeed(Environment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(mainEnvironmentId),
      }),
    ),
    Layer.provide(ServerConfig.layerTest(root, NodePath.join(root, "home"))),
    Layer.provide(NodeServices.layer),
  );
const call = <A, E>(f: (s: Artifacts.Artifacts["Service"]) => Effect.Effect<A, E>) =>
  run(Artifacts.Artifacts.pipe(Effect.flatMap(f), Effect.provide(services())));
const isArtifactError = Schema.is(FoundryArtifactError);
const failure = async (value: Promise<unknown>, code: FoundryArtifactError["code"]) =>
  NodeAssert.rejects(value, (error: unknown) => isArtifactError(error) && error.code === code);
const digest = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const decodeMachineRequest = Schema.decodeEffect(
  Schema.fromJsonString(FoundryArtifactMachineRequest),
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeArtifactManifest = Schema.decodeUnknownEffect(FoundryArtifactManifest);
try {
  const initialized = NodeChildProcess.spawnSync(
    NodePath.join(bin, "initdb"),
    ["-D", data, "-U", "fixture_admin", "--auth=trust", "--no-locale"],
    { encoding: "utf8" },
  );
  NodeAssert.equal(initialized.status, 0, initialized.stderr);
  await start();
  for (const statement of [
    "CREATE ROLE artifact_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    "CREATE ROLE artifact_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    "REVOKE ALL ON DATABASE postgres FROM PUBLIC",
    "REVOKE ALL ON SCHEMA public FROM PUBLIC",
    "GRANT CONNECT,CREATE ON DATABASE postgres TO artifact_migrator",
    "GRANT CONNECT ON DATABASE postgres TO artifact_runtime",
  ])
    await query(statement);
  const migrate = Migrations.InstanceMigrations.pipe(
    Effect.flatMap((service) =>
      service.migrate({ instanceId, mainEnvironmentId, runtimeRole: "artifact_runtime" }),
    ),
    Effect.provide(Migrations.layer.pipe(Layer.provide(db("artifact_migrator")))),
  );
  await run(migrate);
  await query(
    "INSERT INTO foundry_instance.operator_binding(operator_id,issuer,subject) VALUES('22222222-2222-4222-8222-222222222222','https://issuer.test','fixture')",
    "artifact_migrator",
  );
  const bound = await query("SELECT * FROM foundry_instance.operator_binding");
  await query("DROP TABLE foundry_instance.artifact_uploads", "artifact_migrator");
  await query("UPDATE foundry_instance.schema_version SET version=5", "artifact_migrator");
  await Promise.all([run(migrate), run(migrate)]);
  NodeAssert.deepEqual(await query("SELECT * FROM foundry_instance.operator_binding"), bound);
  NodeAssert.equal(
    (await query("SELECT version FROM foundry_instance.schema_version"))[0]?.version,
    6,
  );
  const bytes = Buffer.alloc(FOUNDRY_ARTIFACT_CHUNK_BYTES + 17, 42);
  const input = {
    instanceId,
    commandId: CommandId.make("artifact-begin"),
    owner,
    name: "fixture.bin",
    mimeType: "application/octet-stream",
    sizeBytes: bytes.length,
    sha256: digest(bytes),
  };
  const begins = await Promise.all(
    Array.from({ length: 6 }, () => call((s) => s.begin(principal, input))),
  );
  NodeAssert.equal(new Set(begins.map((value) => value.reference.artifactId)).size, 1);
  const reference = begins[0]!.reference;
  await failure(
    call((s) => s.begin(principal, { ...input, name: "changed" })),
    "command_conflict",
  );
  await failure(
    call((s) => s.metadata(principal, reference)),
    "incomplete",
  );
  await failure(
    call((s) => s.publish(principal, reference)),
    "incomplete",
  );
  const first = bytes.subarray(0, FOUNDRY_ARTIFACT_CHUNK_BYTES);
  const chunk = { reference, offset: 0, data: first.toString("base64"), sha256: digest(first) };
  const written = await call((s) => s.write(principal, chunk));
  NodeAssert.equal(written.offset, first.length);
  NodeAssert.deepEqual(await call((s) => s.write(principal, chunk)), written);
  const altered = Buffer.alloc(first.length, 43);
  await failure(
    call((s) =>
      s.write(principal, { ...chunk, data: altered.toString("base64"), sha256: digest(altered) }),
    ),
    "command_conflict",
  );
  await stop();
  await start();
  NodeAssert.equal((await call((s) => s.status(principal, reference))).offset, first.length);
  const tail = bytes.subarray(first.length);
  const last = {
    ...chunk,
    offset: first.length,
    data: tail.toString("base64"),
    sha256: digest(tail),
  };
  failWrites = true;
  await failure(
    call((s) => s.write(principal, last)),
    "capacity",
  );
  NodeAssert.equal((await call((s) => s.status(principal, reference))).offset, first.length);
  failWrites = false;
  await call((s) => s.write(principal, last));
  await query(
    "CREATE FUNCTION foundry_instance.fail_artifact_publish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='published' THEN RAISE EXCEPTION 'fixture commit failure'; END IF; RETURN NEW; END $$",
    "artifact_migrator",
  );
  await query(
    "CREATE TRIGGER fail_artifact_publish BEFORE UPDATE ON foundry_instance.artifact_uploads FOR EACH ROW EXECUTE FUNCTION foundry_instance.fail_artifact_publish()",
    "artifact_migrator",
  );
  await failure(
    call((s) => s.publish(principal, reference)),
    "unavailable",
  );
  NodeAssert.equal((await call((s) => s.status(principal, reference))).state, "uploading");
  NodeAssert.equal((await call((s) => s.list(principal, {}))).items.length, 0);
  NodeAssert.equal(
    await NodeFSP.readFile(NodePath.join(directory, "blobs", reference.artifactId)).then((value) =>
      digest(value),
    ),
    input.sha256,
  );
  await query(
    "DROP TRIGGER fail_artifact_publish ON foundry_instance.artifact_uploads",
    "artifact_migrator",
  );
  await query("DROP FUNCTION foundry_instance.fail_artifact_publish()", "artifact_migrator");
  const published = await call((s) => s.publish(principal, reference));
  NodeAssert.deepEqual(await call((s) => s.publish(principal, reference)), published);
  NodeAssert.deepEqual(await call((s) => s.metadata(principal, reference)), published);
  NodeAssert.equal((await call((s) => s.list(principal, {}))).items.length, 1);
  const read = await call((s) => s.read(principal, { reference, offset: 0 }));
  NodeAssert.equal(read.sha256, digest(first));
  const readLast = await call((s) => s.read(principal, { reference, offset: first.length }));
  NodeAssert.equal(
    digest(Buffer.concat([Buffer.from(read.data, "base64"), Buffer.from(readLast.data, "base64")])),
    input.sha256,
  );
  await failure(
    call((s) =>
      s.read(principal, {
        reference: { ...reference, owner: { ...owner, threadId: ThreadId.make("foreign-thread") } },
        offset: 0,
      }),
    ),
    "forbidden",
  );
  await failure(
    call((s) =>
      s.metadata({ ...principal, operatorId: "33333333-3333-4333-8333-333333333333" }, reference),
    ),
    "forbidden",
  );
  await failure(
    call((s) =>
      s.metadata(
        {
          ...principal,
          instanceId: FoundryInstanceId.make("44444444-4444-4444-8444-444444444444"),
        },
        reference,
      ),
    ),
    "forbidden",
  );
  await failure(
    call((s) =>
      s.metadata(
        { ...principal, deviceEnvironmentId: EnvironmentId.make("foreign-worker") },
        reference,
      ),
    ),
    "forbidden",
  );
  await failure(
    call((s) => s.list({ ...principal, deviceEnvironmentId: owner.environmentId }, {})),
    "forbidden",
  );
  await failure(
    call((s) => s.abort(principal, reference)),
    "forbidden",
  );
  const bad = await call((s) =>
    s.begin(principal, {
      ...input,
      commandId: CommandId.make("bad-digest"),
      sizeBytes: 1,
      sha256: "0".repeat(64),
    }),
  );
  const one = Buffer.from("x");
  await run(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const gated = Layer.effect(
        Files.ArtifactFiles,
        Effect.gen(function* () {
          const original = yield* Files.ArtifactFiles;
          return Files.ArtifactFiles.of({
            ...original,
            write: Effect.fn("ArtifactsFixture.gatedWrite")(function* (id, offset, data) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              yield* original.write(id, offset, data);
            }),
          });
        }),
      ).pipe(Layer.provide(storage));
      const context = yield* Layer.build(services(gated));
      const store = Context.get(context, Artifacts.Artifacts);
      const begun = yield* store.begin(principal, {
        ...input,
        commandId: CommandId.make("cancel-during-durable-write"),
        sizeBytes: 1,
        sha256: digest(one),
      });
      const writer = yield* store
        .write(principal, {
          reference: begun.reference,
          offset: 0,
          data: one.toString("base64"),
          sha256: digest(one),
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      writer.interruptUnsafe();
      yield* Deferred.succeed(release, undefined);
      NodeAssert.ok(Exit.hasInterrupts(yield* Fiber.await(writer)));
      NodeAssert.equal((yield* store.status(principal, begun.reference)).offset, 1);
      yield* store.abort(principal, begun.reference);
    }).pipe(Effect.scoped),
  );
  await call((s) =>
    s.write(principal, {
      reference: bad.reference,
      offset: 0,
      data: one.toString("base64"),
      sha256: digest(one),
    }),
  );
  await failure(
    call((s) => s.publish(principal, bad.reference)),
    "changed",
  );
  await call((s) => s.abort(principal, bad.reference));
  await call((s) => s.abort(principal, bad.reference));
  NodeAssert.equal((await call((s) => s.status(principal, bad.reference))).state, "aborted");
  await failure(
    call((s) => s.publish(principal, bad.reference)),
    "changed",
  );
  const empty = await call((s) =>
    s.begin(principal, {
      ...input,
      commandId: CommandId.make("empty"),
      sizeBytes: 0,
      sha256: digest(Buffer.alloc(0)),
    }),
  );
  await call((s) => s.publish(principal, empty.reference));
  NodeAssert.equal(
    (await call((s) => s.read(principal, { reference: empty.reference, offset: 0 }))).data,
    "",
  );
  await stop();
  await start();
  NodeAssert.deepEqual(await call((s) => s.publish(principal, reference)), published);
  NodeAssert.equal((await call((s) => s.list(principal, {}))).items.length, 2);
  for (const statement of [
    "UPDATE foundry_instance.artifact_uploads SET request='{}'",
    "UPDATE foundry_instance.artifact_uploads SET operator_id='33333333-3333-4333-8333-333333333333'",
    "DELETE FROM foundry_instance.artifact_uploads",
    "CREATE TABLE foundry_instance.forbidden(id int)",
  ])
    await NodeAssert.rejects(query(statement, "artifact_runtime"));
  await run(
    Effect.gen(function* () {
      const origin = "https://main.example.test";
      const csrf = "a".repeat(43);
      const expiresAt = (yield* Clock.currentTimeMillis) + 600_000;
      const context = yield* Layer.build(
        Layer.mergeAll(
          Artifacts.layer.pipe(Layer.provide(faultStorage)),
          DeviceRegistry.layer,
          EnvironmentAuth.layer,
        ).pipe(
          Layer.provideMerge(Identity.layer),
          Layer.provideMerge(db("artifact_runtime")),
          Layer.provide(Sqlite.layerMemory),
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(Layer.succeed(DeviceConfig.DeviceOrigin, { origin })),
          Layer.provide(
            Layer.succeed(Environment.ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(mainEnvironmentId),
            }),
          ),
          Layer.provide(ServerConfig.layerTest(root, NodePath.join(root, "http-home"))),
          Layer.provide(NodeServices.layer),
        ),
      );
      const registry = Context.get(context, DeviceRegistry.DeviceRegistry);
      const sessions = Context.get(context, SessionStore.SessionStore);
      const readerA = yield* sessions.issue({
        scopes: ["orchestration:read"],
        subject: "client-a",
        method: "bearer-access-token",
      });
      const readerB = yield* sessions.issue({
        scopes: ["orchestration:read"],
        subject: "client-b",
        method: "bearer-access-token",
      });
      const operator = yield* sessions.issue({
        scopes: ["orchestration:read", "orchestration:operate"],
        subject: "operator",
        method: "bearer-access-token",
      });
      const key = generateDeviceKey();
      const enrollment = yield* registry.approve({
        environmentId: owner.environmentId,
        publicKey: key.publicKey,
      });
      const device = yield* registry.enroll(signEnrollment(enrollment, key.privateKey));
      const handler = HttpRouter.toWebHandler(
        ArtifactHttp.layer.pipe(
          Layer.provide(ArtifactAccess.layer),
          Layer.provide(Layer.succeedContext(context)),
          Layer.provide(Layer.succeed(DeviceConfig.DeviceOrigin, { origin })),
          Layer.provide(
            Layer.succeed(FoundrySessions.FoundrySessions, {
              inspect: Effect.fn("ArtifactsFixture.inspectSession")(function* (
                token: string | undefined,
              ) {
                if (token !== "foundry-client-a" && token !== "foundry-client-b")
                  return yield* new FoundryAuthError({ code: "invalid_session" });
                return {
                  instanceId,
                  operatorId: principal.operatorId,
                  csrfToken: token === "foundry-client-a" ? csrf : "b".repeat(43),
                  expiresAt,
                };
              }),
              checkOrigin: Effect.fn("ArtifactsFixture.checkOrigin")(function* (
                value: string | undefined,
                contentType: string | undefined,
              ) {
                if (value !== origin || contentType !== "application/json")
                  return yield* new FoundryAuthError({ code: "origin_forbidden" });
              }),
              login: Effect.fn("ArtifactsFixture.login")(() => Effect.die("unused fixture login")),
              refresh: Effect.fn("ArtifactsFixture.refresh")(() =>
                Effect.die("unused fixture refresh"),
              ),
              logout: Effect.fn("ArtifactsFixture.logout")(() =>
                Effect.die("unused fixture logout"),
              ),
            }),
          ),
        ),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(() => handler.dispose()));
      const now = yield* Clock.currentTimeMillis;
      const signed = (request: FoundryArtifactRequest, issuedAt = now, signedOrigin = origin) =>
        signArtifactRequest(signedOrigin, device, issuedAt, request, key.privateKey);
      const metadataRequest: FoundryArtifactRequest = { op: "metadata", input: reference };
      const machineHeaders = {
        origin: "",
        cookie: "",
        authorization: "",
        "x-foundry-csrf": "",
      };
      const send = (
        body: unknown,
        headers: Record<string, string> = {},
        machine = false,
        raw = false,
      ) =>
        handler.handler(
          new Request(
            `${origin}${machine ? "/api/foundry/devices/channel" : "/api/foundry/artifacts"}`,
            {
              method: "POST",
              headers: {
                origin,
                host: "main.example.test",
                "x-forwarded-proto": "https",
                "content-type": "application/json",
                cookie: `${FoundrySessions.FOUNDRY_SESSION_COOKIE}=foundry-client-a`,
                "x-foundry-csrf": csrf,
                authorization: `Bearer ${readerA.token}`,
                ...headers,
              },
              body: raw ? String(body) : JSON.stringify(body),
            },
          ),
        );
      const lost = new Set(["begin", "write", "publish"]);
      let substituteReference = false;
      const adapter = HttpClient.make((request, url) =>
        Effect.gen(function* () {
          NodeAssert.equal(url.origin, origin);
          NodeAssert.equal(url.pathname, "/api/foundry/devices/channel");
          NodeAssert.equal(request.headers["cf-access-client-id"], "fixture-access-id");
          NodeAssert.equal(request.headers["cf-access-client-secret"], "fixture-access-secret");
          const options = yield* Effect.serviceOption(FetchHttpClient.RequestInit);
          if (options._tag !== "Some") return yield* Effect.die("Missing request policy");
          NodeAssert.equal(options.value.redirect, "manual");
          NodeAssert.equal(options.value.credentials, "omit");
          NodeAssert.equal(request.body._tag, "Uint8Array");
          if (request.body._tag !== "Uint8Array") return yield* Effect.die("Fixture requires JSON");
          const body = new TextDecoder().decode(request.body.body);
          const envelope = yield* decodeMachineRequest(body).pipe(Effect.orDie);
          const response = yield* Effect.promise(() =>
            handler.handler(
              new Request(url, {
                method: request.method,
                headers: request.headers,
                body,
              }),
            ),
          );
          if (
            substituteReference &&
            envelope.request.op === "metadata" &&
            response.status === 200
          ) {
            const metadata = yield* Effect.promise(() => response.json()).pipe(
              Effect.flatMap(decodeArtifactManifest),
              Effect.orDie,
            );
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                ...metadata,
                reference: {
                  ...metadata.reference,
                  artifactId: FoundryArtifactId.make("77777777-7777-4777-8777-777777777777"),
                },
              }),
            );
          }
          if (response.status === 200 && lost.delete(envelope.request.op)) {
            yield* Effect.promise(() => response.arrayBuffer());
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ code: "unavailable" }, { status: 503 }),
            );
          }
          return HttpClientResponse.fromWeb(request, response);
        }),
      );
      const bindingFile = NodePath.join(root, "worker-artifact-binding.json");
      const registrationFile = NodePath.join(root, "artifact-registration.json");
      const keyFile = NodePath.join(root, "artifact-device-key.json");
      const accessFile = NodePath.join(root, "artifact-access.json");
      for (const [path, data] of [
        [bindingFile, { origin, registrationFile, keyFile, accessFile }],
        [registrationFile, device],
        [keyFile, { privateKey: key.privateKey }],
        [
          accessFile,
          { origin, clientId: "fixture-access-id", clientSecret: "fixture-access-secret" },
        ],
      ] as const) {
        const text = yield* encodeJson(data).pipe(Effect.orDie);
        yield* Effect.promise(() => NodeFSP.writeFile(path, text, { mode: 0o600 }));
      }
      const workerContext = yield* Layer.build(
        Layer.merge(ArtifactPublication.layer, DocumentText.layer).pipe(
          Layer.provideMerge(
            ServerConfig.layerTest(root, NodePath.join(root, "artifact-worker-home")),
          ),
          Layer.provideMerge(NodeServices.layer),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, adapter)),
          Layer.provide(
            Layer.succeed(Environment.ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(owner.environmentId),
            }),
          ),
          Layer.provide(
            Layer.succeed(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({ FOUNDRY_WORKER_ARTIFACT_BINDING_FILE: bindingFile }),
            ),
          ),
        ),
      );
      const worker = Context.get(workerContext, ArtifactPublication.ArtifactPublication);
      NodeAssert.ok(worker);
      const workerConfig = Context.get(workerContext, ServerConfig.ServerConfig);
      const pendingId = createPendingAttachmentId("txt");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(workerConfig.attachmentsDir, `${pendingId}.txt`), bytes),
      );
      const claimInput = {
        threadId: owner.threadId,
        attachments: [
          {
            type: "file" as const,
            id: ChatAttachmentId.make(pendingId),
            name: "worker-note.txt",
            mimeType: "text/plain",
            sizeBytes: bytes.byteLength,
          },
        ],
      };
      const claimed = yield* AttachmentClaims.claimPendingAttachments(claimInput).pipe(
        Effect.provide(workerContext),
      );
      const central = claimed.attachments[0]?.foundryArtifact;
      NodeAssert.ok(central);
      NodeAssert.equal(lost.size, 0);
      NodeAssert.deepEqual(Buffer.from((yield* worker.download(central.reference)).bytes), bytes);
      yield* AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths).pipe(
        Effect.provide(workerContext),
      );
      const reclaimed = yield* AttachmentClaims.claimPendingAttachments(claimInput).pipe(
        Effect.provide(workerContext),
      );
      NodeAssert.notEqual(reclaimed.attachments[0]?.id, claimed.attachments[0]?.id);
      NodeAssert.deepEqual(reclaimed.attachments[0]?.foundryArtifact, central);
      substituteReference = true;
      const differentReference = yield* worker
        .publishAttachment(owner.threadId, reclaimed.attachments[0]!)
        .pipe(Effect.result);
      NodeAssert.equal(differentReference._tag, "Failure");
      if (differentReference._tag === "Failure")
        NodeAssert.equal(differentReference.failure.code, "changed");
      substituteReference = false;
      yield* Effect.promise(async () => {
        NodeAssert.deepEqual(await (await send(metadataRequest)).json(), published);
        for (const headers of [
          { authorization: "Bearer invalid" },
          { authorization: "" },
          { cookie: "" },
          { "x-foundry-csrf": "b".repeat(43) },
          { origin: "https://foreign.example.test" },
          { host: "foreign.example.test" },
        ]) {
          const denied = await send(metadataRequest, headers);
          NodeAssert.equal(denied.status, 403);
          const body = await denied.text();
          NodeAssert.ok(!body.includes(readerA.token) && !body.includes(csrf));
        }
        NodeAssert.equal(
          (await send({ op: "begin", input: { ...input, commandId: "http-scope" } })).status,
          403,
        );
        const begun = await send(
          { op: "begin", input: { ...input, commandId: "http-scope" } },
          { authorization: `Bearer ${operator.token}` },
        );
        NodeAssert.equal(begun.status, 200);
        for (const [body, headers, status] of [
          ["<html>Access</html>", {}, 400],
          ["{}", { "content-type": "text/html" }, 400],
          ["x".repeat(FOUNDRY_ARTIFACT_CHUNK_BYTES * 2 + 1), {}, 507],
        ] as const)
          NodeAssert.equal((await send(body, headers, false, true)).status, status);
        NodeAssert.equal(
          (await send({ ...metadataRequest, operatorId: principal.operatorId })).status,
          400,
        );
        const machineRead = await send(signed(metadataRequest), machineHeaders, true);
        NodeAssert.equal(machineRead.status, 200);
        NodeAssert.deepEqual(await machineRead.json(), published);
        const good = signed(metadataRequest);
        for (const envelope of [
          { ...good, signature: "a".repeat(86) },
          { ...good, request: { op: "status", input: reference } },
          { ...good, generation: good.generation + 1 },
          signed(metadataRequest, now - 120_001),
          signed(metadataRequest, now + 300_000),
          signed(metadataRequest, now, "https://foreign.example.test"),
          signed({ op: "list", input: {} }),
          signed({
            op: "metadata",
            input: {
              ...reference,
              owner: { ...owner, environmentId: EnvironmentId.make("foreign-worker") },
            },
          }),
        ])
          NodeAssert.equal((await send(envelope, machineHeaders, true)).status, 403);
        NodeAssert.equal((await send(metadataRequest, machineHeaders)).status, 403);
      });
      yield* registry.revoke(device.deviceId);
      const beforeFailedClaim = yield* Effect.promise(() =>
        NodeFSP.readdir(workerConfig.attachmentsDir),
      );
      const refused = yield* AttachmentClaims.claimPendingAttachments(claimInput).pipe(
        Effect.provide(workerContext),
        Effect.result,
      );
      NodeAssert.equal(refused._tag, "Failure");
      NodeAssert.deepEqual(
        (yield* Effect.promise(() => NodeFSP.readdir(workerConfig.attachmentsDir))).sort(),
        beforeFailedClaim.sort(),
      );
      NodeAssert.equal(
        (yield* worker.download(central.reference).pipe(Effect.flip)).code,
        "forbidden",
      );
      const clientTransport = Effect.fn("ArtifactsFixture.clientRead")(function* (
        request: FoundryArtifactRequest,
      ) {
        const response = yield* Effect.promise(() =>
          send(request, {
            cookie: `${FoundrySessions.FOUNDRY_SESSION_COOKIE}=foundry-client-b`,
            authorization: `Bearer ${readerB.token}`,
            "x-foundry-csrf": "b".repeat(43),
          }),
        );
        NodeAssert.equal(response.status, 200);
        return yield* Effect.promise(() => response.json());
      });
      NodeAssert.deepEqual(
        Buffer.from((yield* downloadArtifact(clientTransport, central.reference)).bytes),
        bytes,
      );
      NodeAssert.equal(
        (yield* downloadArtifact(clientTransport, empty.reference)).bytes.byteLength,
        0,
      );
      yield* Effect.promise(async () => {
        NodeAssert.equal((await send(signed(metadataRequest), machineHeaders, true)).status, 403);
        const secondClient = {
          cookie: `${FoundrySessions.FOUNDRY_SESSION_COOKIE}=foundry-client-b`,
          authorization: `Bearer ${readerB.token}`,
          "x-foundry-csrf": "b".repeat(43),
        };
        const response = await send(metadataRequest, secondClient);
        NodeAssert.equal(response.status, 200);
        NodeAssert.equal(response.headers.get("cache-control"), "no-store");
        NodeAssert.equal(response.headers.get("x-content-type-options"), "nosniff");
        NodeAssert.equal(response.headers.get("set-cookie"), null);
        NodeAssert.deepEqual(await response.json(), published);
        const responseBytes = await send(
          { op: "read", input: { reference, offset: 0 } },
          secondClient,
        );
        NodeAssert.equal(responseBytes.status, 200);
        NodeAssert.deepEqual(await responseBytes.json(), read);
      });
    }).pipe(Effect.scoped),
  );
  await run(
    Console.log(
      "PASS P38a storage/worker/HTTP: durable resume and rename/commit recovery; immutable publication; real Main T3 sessions/scopes; cookie/CSRF/origin boundary; signed device identity/generation/revocation; worker claims converge after lost begin/write/publish replies and changed local claim ID; changed response reference refused; failed claim cleans local copies; bounded verified worker download; second authenticated client downloads the full original bytes after source revocation. Integrated client UI and live gate remain pending.",
    ),
  );
} finally {
  await stop();
  await NodeFSP.rm(root, { recursive: true, force: true });
}
