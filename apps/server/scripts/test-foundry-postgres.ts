import * as Schema from "effect/Schema";
import * as ConfigProvider from "effect/ConfigProvider";
import * as FoundryRuntime from "../src/foundry/Runtime.ts";
// @effect-diagnostics nodeBuiltinImport:off -- This standalone integration harness owns its temporary PostgreSQL child and filesystem.
// @effect-diagnostics globalProcess:off -- The harness accepts a PostgreSQL binary directory, never connection credentials.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, FoundryInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import * as AccessConfig from "../src/foundry/AccessConfig.ts";
import * as AccessVerifier from "../src/foundry/AccessVerifier.ts";
import * as FoundrySessions from "../src/foundry/FoundrySessions.ts";
import * as AuthHttp from "../src/foundry/authHttp.ts";
import * as InstanceOperator from "../src/foundry/InstanceOperator.ts";
import { FoundrySession, FoundryDescriptor } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import * as InstanceDatabase from "../src/foundry/InstanceDatabase.ts";
import * as InstanceMigrations from "../src/foundry/InstanceMigrations.ts";
import * as InstancePostgres from "../src/foundry/InstancePostgres.ts";
import * as InstanceIdentityStore from "../src/foundry/InstanceIdentityStore.ts";
import * as InstanceDescriptor from "../src/foundry/InstanceDescriptor.ts";
import * as FoundryHttp from "../src/foundry/http.ts";
import * as ServerConfig from "../src/config.ts";
import * as ServerEnvironment from "../src/environment/ServerEnvironment.ts";
import * as EnvironmentAuthPolicy from "../src/auth/EnvironmentAuthPolicy.ts";
import * as DeviceRegistry from "../src/foundry/DeviceRegistry.ts";
import * as DeviceConfig from "../src/foundry/DeviceConfig.ts";
import * as DeviceHttp from "../src/foundry/deviceHttp.ts";
import { generateDeviceKey, signEnrollment } from "../src/foundry/DeviceProof.ts";
import { FoundryDevice, FoundryEnrollmentRequest } from "@t3tools/contracts";

const decodeDescriptor = Schema.decodeUnknownSync(FoundryDescriptor);
const decodeSession = Schema.decodeUnknownSync(FoundrySession);
const bin = process.env.FOUNDRY_TEST_PG_BIN;
NodeAssert.ok(
  bin,
  "Set FOUNDRY_TEST_PG_BIN to a PostgreSQL 17+ bin directory; no existing database is used.",
);
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "foundry-pg-"));
const data = NodePath.join(root, "data");
const home = NodePath.join(root, "home");
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

const db = (username: string, database = "fork_connect") =>
  InstanceDatabase.layer({ path, username, database });
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const report = (...messages: ReadonlyArray<unknown>) => run(Console.log(...messages));
const query = (statement: string, username = "fixture_admin", database = "fork_connect") =>
  run(
    Effect.gen(function* () {
      const sql = yield* InstanceDatabase.InstanceDatabase;
      return yield* sql.unsafe<Record<string, unknown>>(statement);
    }).pipe(Effect.provide(db(username, database))),
  );
const mainEnvironmentId = EnvironmentId.make("p02-main");
const environment = Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
  getEnvironmentId: Effect.succeed(mainEnvironmentId),
});
const migrationLayer = (database = "fork_connect") =>
  InstanceMigrations.layer.pipe(Layer.provide(db("foundry_migrate", database)));
const identityLayer = InstancePostgres.layer.pipe(
  Layer.provide(db("foundry_runtime")),
  Layer.provide(environment),
  Layer.provide(ServerConfig.layerTest(root, home)),
  Layer.provide(NodeServices.layer),
);
const readIdentity = InstancePostgres.InstancePostgres.pipe(
  Effect.flatMap((service) => service.readIdentity),
  Effect.provide(identityLayer),
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
    "CREATE ROLE foundry_migrate LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    "CREATE ROLE foundry_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    "CREATE DATABASE fork_connect OWNER foundry_migrate",
    "CREATE DATABASE fork_unknown OWNER foundry_migrate",
  ])
    await query(statement, "fixture_admin", "postgres");
  for (const name of ["fork_connect", "fork_unknown"]) {
    await query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`, "fixture_admin", name);
    await query(`GRANT CONNECT ON DATABASE ${name} TO foundry_runtime`, "fixture_admin", name);
    await query("REVOKE ALL ON SCHEMA public FROM PUBLIC", "fixture_admin", name);
  }
  const instanceId = await run(
    InstanceIdentityStore.InstanceIdentityStore.pipe(
      Effect.flatMap((store) => store.getOrCreate),
      Effect.provide(
        InstanceIdentityStore.layerFile.pipe(
          Layer.provide(ServerConfig.layerTest(root, home)),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
  const input = { instanceId, mainEnvironmentId, runtimeRole: "foundry_runtime" };
  const migrate = (overrides: Partial<typeof input> = {}, database = "fork_connect") =>
    InstanceMigrations.InstanceMigrations.pipe(
      Effect.flatMap((service) => service.migrate({ ...input, ...overrides })),
      Effect.provide(migrationLayer(database)),
    );
  const expectFailure = async <A, E>(effect: Effect.Effect<A, E>) =>
    NodeAssert.equal((await run(Effect.result(effect)))._tag, "Failure");
  await expectFailure(readIdentity);
  await run(
    Effect.all(
      Array.from({ length: 4 }, () => migrate()),
      { concurrency: "unbounded" },
    ),
  );
  await run(migrate());
  NodeAssert.equal(await run(readIdentity), instanceId);
  await NodeFSP.writeFile(
    NodePath.join(home, "userdata", "foundry-instance-id"),
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n",
  );
  await expectFailure(readIdentity);
  await NodeFSP.writeFile(
    NodePath.join(home, "userdata", "foundry-instance-id"),
    `${instanceId}\n`,
  );
  NodeAssert.equal(
    (await NodeFSP.readFile(NodePath.join(home, "userdata", "foundry-instance-id"), "utf8")).trim(),
    instanceId,
  );
  NodeAssert.equal((await query("SELECT * FROM foundry_instance.operator_binding")).length, 0);
  await report(
    "PASS fresh schema, concurrent migration, idempotent repeat, P01 identity preserved, operator unbound",
  );

  await expectFailure(
    migrate({ instanceId: FoundryInstanceId.make("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") }),
  );
  await expectFailure(migrate({ mainEnvironmentId: EnvironmentId.make("foreign-main") }));
  await query("CREATE SCHEMA pgcustom", "fixture_admin", "fork_unknown");
  await expectFailure(migrate({}, "fork_unknown"));
  await query("DROP SCHEMA pgcustom", "fixture_admin", "fork_unknown");
  await query("CREATE TABLE public.existing_data (value text)", "fixture_admin", "fork_unknown");
  await expectFailure(migrate({}, "fork_unknown"));
  NodeAssert.equal(
    (
      await query(
        "SELECT * FROM pg_namespace WHERE nspname='foundry_instance'",
        "fixture_admin",
        "fork_unknown",
      )
    ).length,
    0,
  );
  await report("PASS identity conflicts and unknown database rejected without schema publication");

  for (const statement of [
    "CREATE TABLE foundry_instance.forbidden (id int)",
    "CREATE TABLE public.forbidden (id int)",
    "CREATE SCHEMA forbidden",
    "CREATE TEMP TABLE forbidden (id int)",
    "ALTER TABLE foundry_instance.instance ADD COLUMN forbidden int",
    "DROP TABLE foundry_instance.instance",
    "UPDATE foundry_instance.schema_version SET version=99",
    "UPDATE foundry_instance.instance SET instance_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'",
  ]) {
    const result = await query(statement, "foundry_runtime").then(
      () => "success",
      () => "failure",
    );
    NodeAssert.equal(result, "failure", statement);
  }
  const transaction = Effect.gen(function* () {
    const sql = yield* InstanceDatabase.InstanceDatabase;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE foundry_instance.instance SET access_generation = access_generation + 1`;
        yield* sql`INSERT INTO foundry_instance.operator_binding (operator_id, issuer, subject)
          VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'https://issuer.example.test', 'fixture-operator')`;
        return yield* Effect.fail("rollback-fixture");
      }),
    );
  }).pipe(Effect.provide(db("foundry_runtime")));
  await expectFailure(transaction);
  NodeAssert.equal(
    (await query("SELECT access_generation::text AS generation FROM foundry_instance.instance"))[0]
      ?.generation,
    "0",
  );
  NodeAssert.equal((await query("SELECT * FROM foundry_instance.operator_binding")).length, 0);
  await query("UPDATE foundry_instance.instance SET access_generation=1", "foundry_runtime");
  await report(
    "PASS runtime DDL/identity/schema writes denied; allowed generation update and transaction rollback",
  );

  const routes = FoundryHttp.layer.pipe(
    Layer.provide(
      InstanceDescriptor.layer.pipe(
        Layer.provide(InstancePostgres.layerIdentity.pipe(Layer.provide(identityLayer))),
        Layer.provide(EnvironmentAuthPolicy.layer),
        Layer.provide(environment),
        Layer.provide(ServerConfig.layerTest(root, home)),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  const handler = HttpRouter.toWebHandler(routes, { disableLogger: true });
  try {
    const ready = () => handler.handler(new Request("http://localhost/api/foundry/ready"));
    NodeAssert.equal((await ready()).status, 200);
    await query("UPDATE foundry_instance.schema_version SET version=99", "foundry_migrate");
    NodeAssert.equal((await ready()).status, 503);
    await expectFailure(migrate());
    await query("UPDATE foundry_instance.schema_version SET version=3", "foundry_migrate");
    NodeAssert.equal((await ready()).status, 200);
    await query("GRANT CREATE ON SCHEMA public TO foundry_runtime");
    NodeAssert.equal((await ready()).status, 503);
    await query("REVOKE CREATE ON SCHEMA public FROM foundry_runtime");
    await stop();
    await expectFailure(readIdentity);
    NodeAssert.equal((await ready()).status, 503);
    NodeAssert.equal(
      (await handler.handler(new Request("http://localhost/.well-known/foundry?protocolVersion=1")))
        .status,
      503,
    );
    await start();
    NodeAssert.equal((await ready()).status, 200);
    NodeAssert.equal(await run(readIdentity), instanceId);
    NodeAssert.equal(
      (
        await query("SELECT access_generation::text AS generation FROM foundry_instance.instance")
      )[0]?.generation,
      "1",
    );
    await report(
      "PASS readiness 200 -> incompatible schema/unsafe role/DB down 503 -> DB restart 200, unchanged identity",
    );
  } finally {
    await handler.dispose();
  }
  const accessConfig = {
    issuer: "https://fixture.cloudflareaccess.com",
    audience: "fixture-app",
    origin: "https://foundry.example.test",
  };
  const bind = (subject = "operator-subject") =>
    InstanceOperator.InstanceOperator.pipe(
      Effect.flatMap((operator) => operator.bind(accessConfig.issuer, subject)),
      Effect.provide(
        InstanceOperator.layer.pipe(
          Layer.provide(identityLayer),
          Layer.provide(db("foundry_runtime")),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  const keys = await generateKeyPair("RS256");
  const jwk = await exportJWK(keys.publicKey);
  let now = 1_800_000_000_000;
  const clock = await run(Clock.Clock);
  const testContext = Context.make(Clock.Clock, {
    ...clock,
    sleep: clock.sleep.bind(clock),
    currentTimeMillis: Effect.sync(() => now),
    currentTimeMillisUnsafe: () => now,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
  });
  const sign = (subject = "operator-subject", seconds = 3600) =>
    new SignJWT({ type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer(accessConfig.issuer)
      .setAudience(accessConfig.audience)
      .setSubject(subject)
      .setIssuedAt(now / 1000)
      .setExpirationTime(now / 1000 + seconds)
      .sign(keys.privateKey);
  const authRoutes = AuthHttp.layer.pipe(
    Layer.provide(FoundrySessions.layer),
    Layer.provide(AccessVerifier.layer),
    Layer.provide(
      Layer.succeed(
        AccessVerifier.AccessSigningKeys,
        createLocalJWKSet({ keys: [{ ...jwk, kid: "fixture", alg: "RS256" }] }),
      ),
    ),
    Layer.provide(Layer.succeed(AccessConfig.AccessConfig, accessConfig)),
    Layer.provide(identityLayer),
    Layer.provide(db("foundry_runtime")),
    Layer.provide(NodeServices.layer),
  );
  let authHandler = HttpRouter.toWebHandler(authRoutes, { disableLogger: true });
  const post = (operation: string, headers: Record<string, string> = {}) =>
    authHandler.handler(
      new Request(`${accessConfig.origin}/api/foundry/auth/${operation}`, {
        method: "POST",
        headers: { origin: accessConfig.origin, "content-type": "application/json", ...headers },
      }),
      testContext,
    );
  const issued = async (response: Response) => {
    NodeAssert.equal(response.status, 200);
    NodeAssert.equal(response.headers.get("cache-control"), "no-store");
    const cookie = response.headers.get("set-cookie")!;
    NodeAssert.match(cookie, /HttpOnly/);
    NodeAssert.match(cookie, /Secure/);
    NodeAssert.match(cookie, /SameSite=Strict/i);
    NodeAssert.match(cookie, /Path=\//);
    NodeAssert.doesNotMatch(cookie, /Domain=/i);
    const credential = cookie.split(";", 1)[0]!;
    const body = decodeSession(await response.json());
    NodeAssert.equal(body.instanceId, instanceId);
    NodeAssert.equal(JSON.stringify(body).includes(credential.split("=", 2)[1]!), false);
    return { cookie: credential, csrf: body.csrfToken, expiresAt: body.expiresAt };
  };
  try {
    const assertion = await sign();
    const accessHeader = { "cf-access-jwt-assertion": assertion };
    NodeAssert.equal((await post("login", accessHeader)).status, 403);
    await run(bind());
    await run(bind());
    await expectFailure(bind("foreign-operator"));
    const operatorBefore = await query("SELECT * FROM foundry_instance.operator_binding");
    await query(
      "DROP TABLE foundry_instance.device_enrollments, foundry_instance.devices",
      "foundry_migrate",
    );
    await query("DROP TABLE foundry_instance.sessions", "foundry_migrate");
    await query("UPDATE foundry_instance.schema_version SET version=1", "foundry_migrate");
    await expectFailure(readIdentity);
    await expectFailure(
      migrate({ instanceId: FoundryInstanceId.make("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") }),
    );
    NodeAssert.equal(
      (await query("SELECT version FROM foundry_instance.schema_version"))[0]?.version,
      1,
    );
    NodeAssert.equal(
      (await query("SELECT to_regclass('foundry_instance.sessions') AS table_name"))[0]?.table_name,
      null,
    );
    await run(Effect.all([migrate(), migrate()], { concurrency: "unbounded" }));
    NodeAssert.deepEqual(
      await query("SELECT * FROM foundry_instance.operator_binding"),
      operatorBefore,
    );
    NodeAssert.equal(await run(readIdentity), instanceId);
    for (const headers of [
      { origin: "https://evil.example.test" },
      { origin: "null" },
      { origin: "" },
      { "content-type": "text/plain" },
      {
        origin: "https://evil.example.test",
        "x-forwarded-host": "foundry.example.test",
        "x-forwarded-proto": "https",
      },
    ])
      NodeAssert.equal((await post("login", { ...accessHeader, ...headers })).status, 403);
    NodeAssert.equal(
      (
        await post("login", {
          "cf-access-authenticated-user-email": "owner@example.test",
          "x-forwarded-user": "operator-subject",
        })
      ).status,
      401,
    );
    NodeAssert.equal((await post("login", { "cf-access-jwt-assertion": "forged" })).status, 401);
    NodeAssert.equal(
      (await post("login", { "cf-access-jwt-assertion": await sign("foreign-operator") })).status,
      403,
    );
    let session = await issued(await post("login", accessHeader));
    NodeAssert.equal(session.expiresAt, now + 15 * 60 * 1000);
    const persisted = JSON.stringify(
      await query(
        "SELECT token_hash, instance_id, operator_id, audience FROM foundry_instance.sessions",
      ),
    );
    NodeAssert.equal(persisted.includes(assertion), false);
    NodeAssert.equal(persisted.includes(session.cookie.split("=", 2)[1]!), false);
    NodeAssert.equal((await post("session", { cookie: session.cookie })).status, 200);
    NodeAssert.equal(
      (await post("session", { cookie: `${FoundrySessions.FOUNDRY_SESSION_COOKIE}=${assertion}` }))
        .status,
      401,
    );
    NodeAssert.equal(
      (await post("session", { cookie: session.cookie, origin: "https://evil.example.test" }))
        .status,
      403,
    );
    NodeAssert.equal(
      (await post("refresh", { ...accessHeader, cookie: session.cookie })).status,
      403,
    );
    NodeAssert.equal(
      (await post("logout", { cookie: session.cookie, "x-foundry-csrf": "wrong" })).status,
      403,
    );
    NodeAssert.equal(
      (
        await post("refresh", {
          cookie: session.cookie,
          "x-foundry-csrf": session.csrf,
          "cf-access-jwt-assertion": "forged",
        })
      ).status,
      401,
    );
    NodeAssert.equal((await post("session", { cookie: session.cookie })).status, 200);
    const old = session;
    const refreshed = await Promise.all([
      post("refresh", { ...accessHeader, cookie: session.cookie, "x-foundry-csrf": session.csrf }),
      post("refresh", { ...accessHeader, cookie: session.cookie, "x-foundry-csrf": session.csrf }),
    ]);
    NodeAssert.deepEqual(refreshed.map((response) => response.status).sort(), [200, 401]);
    session = await issued(refreshed.find((response) => response.status === 200)!);
    NodeAssert.equal((await post("session", { cookie: old.cookie })).status, 401);
    await authHandler.dispose();
    authHandler = HttpRouter.toWebHandler(authRoutes, { disableLogger: true });
    NodeAssert.equal((await post("session", { cookie: session.cookie })).status, 200);
    await stop();
    NodeAssert.equal((await post("session", { cookie: session.cookie })).status, 503);
    await start();
    NodeAssert.equal((await post("session", { cookie: session.cookie })).status, 200);
    const loggedOut = await post("logout", {
      cookie: session.cookie,
      "x-foundry-csrf": session.csrf,
    });
    NodeAssert.equal(loggedOut.status, 204);
    NodeAssert.match(loggedOut.headers.get("set-cookie")!, /Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    await authHandler.dispose();
    authHandler = HttpRouter.toWebHandler(authRoutes, { disableLogger: true });
    NodeAssert.equal((await post("session", { cookie: session.cookie })).status, 401);
    NodeAssert.equal(
      (await post("logout", { cookie: session.cookie, "x-foundry-csrf": session.csrf })).status,
      204,
    );
    session = await issued(await post("login", accessHeader));
    now = session.expiresAt;
    NodeAssert.equal((await post("session", { cookie: session.cookie })).status, 401);
    NodeAssert.equal(
      (
        await post("refresh", {
          ...accessHeader,
          cookie: session.cookie,
          "x-foundry-csrf": session.csrf,
        })
      ).status,
      401,
    );
    session = await issued(
      await post("login", { "cf-access-jwt-assertion": await sign("operator-subject", 60) }),
    );
    NodeAssert.equal(session.expiresAt, now + 60_000);
    now += 60_000;
    NodeAssert.equal((await post("session", { cookie: session.cookie })).status, 401);
    session = await issued(await post("login", { "cf-access-jwt-assertion": await sign() }));
    await query(
      "UPDATE foundry_instance.instance SET access_generation=access_generation+1",
      "foundry_runtime",
    );
    NodeAssert.equal((await post("session", { cookie: session.cookie })).status, 401);
    session = await issued(await post("login", { "cf-access-jwt-assertion": await sign() }));
    await query(
      "UPDATE foundry_instance.operator_binding SET access_generation=access_generation+1",
      "foundry_runtime",
    );
    NodeAssert.equal((await post("session", { cookie: session.cookie })).status, 401);
    await report(
      "PASS P03: v1 upgrade preserves identity/operator; signed login, origin/CSRF, header spoofing, atomic refresh, durable logout, expiry, generations and DB outage",
    );
  } finally {
    await authHandler.dispose();
  }
  const sessionsBeforeUpgrade = await query(
    "SELECT * FROM foundry_instance.sessions ORDER BY token_hash",
  );
  await query(
    "DROP TABLE foundry_instance.device_enrollments, foundry_instance.devices",
    "foundry_migrate",
  );
  await query("UPDATE foundry_instance.schema_version SET version=2", "foundry_migrate");
  await expectFailure(readIdentity);
  await run(Effect.all([migrate(), migrate()], { concurrency: "unbounded" }));
  NodeAssert.equal(await run(readIdentity), instanceId);
  NodeAssert.deepEqual(
    await query("SELECT * FROM foundry_instance.sessions ORDER BY token_hash"),
    sessionsBeforeUpgrade,
  );
  const registryLayer = DeviceRegistry.layer.pipe(
    Layer.provide(Layer.succeed(DeviceConfig.DeviceOrigin, { origin: accessConfig.origin })),
    Layer.provide(identityLayer),
    Layer.provide(db("foundry_runtime")),
    Layer.provide(NodeServices.layer),
  );
  const deviceHandler = HttpRouter.toWebHandler(
    DeviceHttp.layer.pipe(Layer.provide(registryLayer)),
    { disableLogger: true },
  );
  try {
    const deviceCall = <A>(
      f: (
        registry: DeviceRegistry.DeviceRegistry["Service"],
      ) => Effect.Effect<A, import("@t3tools/contracts").FoundryDeviceError>,
    ) =>
      run(
        DeviceRegistry.DeviceRegistry.pipe(
          Effect.flatMap(f),
          Effect.provide(registryLayer),
          Effect.provide(testContext),
        ),
      );
    const enroll = (input: FoundryEnrollmentRequest) =>
      deviceHandler.handler(
        new Request(`${accessConfig.origin}/api/foundry/devices/enroll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
        testContext,
      );
    const keyFile = NodePath.join(root, "device-key.json");
    const invitationFile = NodePath.join(root, "invitation.json");
    const requestFile = NodePath.join(root, "request.json");
    const cli = (...args: string[]) =>
      NodeChildProcess.spawnSync(
        process.execPath,
        [NodePath.join(import.meta.dirname, "../src/bin.ts"), "foundry", ...args],
        { encoding: "utf8" },
      );
    NodeAssert.equal(cli("device-keygen", "--output", keyFile).status, 0, "device-keygen failed");
    const keyContent = await NodeFSP.readFile(keyFile, "utf8");
    const key = Schema.decodeUnknownSync(
      Schema.Struct({ publicKey: Schema.String, privateKey: Schema.String }),
    )(JSON.parse(keyContent));
    NodeAssert.equal((await NodeFSP.stat(keyFile)).mode & 0o777, 0o600);
    NodeAssert.notEqual(cli("device-keygen", "--output", keyFile).status, 0);
    NodeAssert.equal((await NodeFSP.readFile(keyFile, "utf8")) === keyContent, true);
    const invitation = await deviceCall((registry) =>
      registry.approve({
        environmentId: EnvironmentId.make("p06-worker"),
        publicKey: key.publicKey,
      }),
    );
    await NodeFSP.writeFile(invitationFile, JSON.stringify(invitation), { mode: 0o600 });
    NodeAssert.equal(
      cli(
        "sign-enrollment",
        "--invitation",
        invitationFile,
        "--key-file",
        keyFile,
        "--output",
        requestFile,
      ).status,
      0,
      "sign-enrollment failed",
    );
    const proof = Schema.decodeUnknownSync(FoundryEnrollmentRequest)(
      JSON.parse(await NodeFSP.readFile(requestFile, "utf8")),
    );
    NodeAssert.equal((await NodeFSP.stat(requestFile)).mode & 0o777, 0o600);
    const initial = await Promise.all(Array.from({ length: 8 }, () => enroll(proof)));
    const devices: FoundryDevice[] = [];
    for (const response of initial) {
      NodeAssert.equal(response.status, 200);
      devices.push(Schema.decodeUnknownSync(FoundryDevice)(await response.json()));
    }
    for (const device of devices) NodeAssert.deepEqual(device, devices[0]);
    const oversized = await deviceHandler.handler(
      new Request(`${accessConfig.origin}/api/foundry/devices/enroll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `${JSON.stringify(proof)}${" ".repeat(8192)}`,
      }),
      testContext,
    );
    NodeAssert.equal(oversized.status, 403);
    const registered = devices[0]!;
    NodeAssert.equal((await query("SELECT * FROM foundry_instance.devices")).length, 1);
    NodeAssert.equal(
      JSON.stringify(
        await query("SELECT token_hash FROM foundry_instance.device_enrollments"),
      ).includes(invitation.token),
      false,
    );
    NodeAssert.deepEqual(await (await enroll(proof)).json(), registered);
    const otherKey = generateDeviceKey();
    for (const changed of [
      { ...invitation, instanceId: FoundryInstanceId.make("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") },
      { ...invitation, origin: "https://foreign.example.test" },
      { ...invitation, environmentId: EnvironmentId.make("foreign-environment") },
      { ...invitation, expiresAt: invitation.expiresAt + 1000 },
    ])
      NodeAssert.equal((await enroll(signEnrollment(changed, key.privateKey))).status, 403);
    NodeAssert.equal(
      (
        await enroll(
          signEnrollment({ ...invitation, publicKey: otherKey.publicKey }, otherKey.privateKey),
        )
      ).status,
      403,
    );
    NodeAssert.equal((await enroll({ ...proof, signature: "A".repeat(86) })).status, 403);
    const duplicate = await deviceCall((registry) =>
      registry.approve({ environmentId: invitation.environmentId, publicKey: otherKey.publicKey }),
    );
    NodeAssert.equal((await enroll(signEnrollment(duplicate, otherKey.privateKey))).status, 409);
    const expired = await deviceCall((registry) =>
      registry.approve({
        environmentId: EnvironmentId.make("expired-worker"),
        publicKey: otherKey.publicKey,
      }),
    );
    const beforeExpiry = now;
    now = expired.expiresAt;
    const denied = await enroll(signEnrollment(expired, otherKey.privateKey));
    NodeAssert.equal(denied.status, 403);
    NodeAssert.equal(
      Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }))(await denied.json()).code,
      "expired_enrollment",
    );
    now = beforeExpiry;
    await deviceCall((registry) => registry.revoke(registered.deviceId));
    await deviceCall((registry) => registry.revoke(registered.deviceId));
    await stop();
    await start();
    const revoked = await deviceCall((registry) => registry.get(registered.deviceId));
    NodeAssert.equal(revoked.revoked, true);
    NodeAssert.equal(revoked.generation, 2);
    NodeAssert.equal((await enroll(proof)).status, 403);
    for (const statement of [
      "UPDATE foundry_instance.devices SET public_key='replacement'",
      "DELETE FROM foundry_instance.devices",
      "UPDATE foundry_instance.device_enrollments SET expires_at=9999999999999",
    ])
      await NodeAssert.rejects(query(statement, "foundry_runtime"));
    await report(
      "PASS P06: v2 upgrade preserves sessions/identity; concurrent key-bound enrollment and lost-answer retry; foreign proof, identity, expiry and duplicate rejection; revocation survives PostgreSQL restart; runtime grants restricted",
    );
  } finally {
    await deviceHandler.dispose();
  }
  await NodeFSP.writeFile(NodePath.join(home, "userdata", "environment-id"), mainEnvironmentId);
  for (const [enabled, enrollmentEnabled] of [
    [false, false],
    [true, false],
    [true, true],
  ] as const) {
    const runtimeRoutes = FoundryRuntime.layer.pipe(
      Layer.provide(environment),
      Layer.provide(ServerConfig.layerTest(root, home)),
      Layer.provide(NodeServices.layer),
      Layer.provide(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            FOUNDRY_ACCESS_ENABLED: String(enabled),
            FOUNDRY_DEVICE_ENROLLMENT_ENABLED: String(enrollmentEnabled),
            FOUNDRY_INSTANCE_STORE: "postgres",
            FOUNDRY_INSTANCE_DATABASE_URL: `postgresql://foundry_runtime@localhost/fork_connect?host=${encodeURIComponent(root)}`,
            FOUNDRY_ACCESS_ISSUER: accessConfig.issuer,
            FOUNDRY_ACCESS_AUDIENCE: accessConfig.audience,
            FOUNDRY_PUBLIC_ORIGIN: accessConfig.origin,
          }),
        ),
      ),
    );
    const runtimeHandler = HttpRouter.toWebHandler(runtimeRoutes, { disableLogger: true });
    try {
      const metadata = await runtimeHandler.handler(
        new Request(`${accessConfig.origin}/.well-known/foundry?protocolVersion=1`),
      );
      NodeAssert.equal(metadata.status, 200);
      const descriptor = decodeDescriptor(await metadata.json());
      NodeAssert.equal(Object.hasOwn(descriptor, "instanceAuth"), enabled);
      NodeAssert.equal(
        descriptor.capabilities.includes("foundry.device-enrollment"),
        enrollmentEnabled,
      );
      const enrollment = await runtimeHandler.handler(
        new Request(`${accessConfig.origin}/api/foundry/devices/enroll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
      NodeAssert.equal(enrollment.status, enrollmentEnabled ? 403 : 404);
      const login = await runtimeHandler.handler(
        new Request(`${accessConfig.origin}/api/foundry/auth/login`, {
          method: "POST",
          headers: { origin: accessConfig.origin, "content-type": "application/json" },
        }),
      );
      NodeAssert.equal(login.status, enabled ? 401 : 404);
    } finally {
      await runtimeHandler.dispose();
    }
  }
  await report(
    "PASS production runtime composition: opt-in auth routes and descriptor capability, no JWKS request without an assertion",
  );
  await report(
    "Gates P02/P03 passed on isolated PostgreSQL:",
    NodeChildProcess.spawnSync(NodePath.join(bin, "postgres"), ["--version"], {
      encoding: "utf8",
    }).stdout.trim(),
  );
} finally {
  await stop();
  await NodeFSP.rm(root, { recursive: true, force: true });
}
