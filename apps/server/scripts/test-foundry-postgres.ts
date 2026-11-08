import { verifyGateway } from "./foundry-gateway-integration.ts";
import * as Schema from "effect/Schema";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Option from "effect/Option";
import * as AutomationDatabase from "../src/automation/AutomationDatabase.ts";
import * as AutomationMigrations from "../src/automation/AutomationMigrations.ts";
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
import * as MachineCredentials from "../src/foundry/MachineCredentials.ts";
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
import * as EnvironmentAuth from "../src/auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../src/auth/ServerSecretStore.ts";
import * as SqlitePersistence from "../src/persistence/Sqlite.ts";
import * as DeviceGrants from "../src/foundry/DeviceGrants.ts";
import * as DeviceRegistry from "../src/foundry/DeviceRegistry.ts";
import * as DeviceConfig from "../src/foundry/DeviceConfig.ts";
import * as DeviceHttp from "../src/foundry/deviceHttp.ts";
import { generateDeviceKey, signEnrollment } from "../src/foundry/DeviceProof.ts";
import { FoundryDevice, FoundryEnrollmentRequest } from "@t3tools/contracts";
import * as FoundryOnboarding from "../../../packages/client-runtime/src/connection/foundry.ts";

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
    await query("UPDATE foundry_instance.schema_version SET version=9", "foundry_migrate");
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
      "DROP TABLE foundry_instance.provider_connections, foundry_instance.sandbox_allocations, foundry_instance.sandbox_profiles, foundry_instance.machine_credentials, foundry_instance.archive_artifacts, foundry_instance.archive_events, foundry_instance.archive_threads, foundry_instance.artifact_uploads, foundry_instance.device_grants, foundry_instance.device_enrollments, foundry_instance.devices",
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
    const descriptorHandler = HttpRouter.toWebHandler(
      routes.pipe(
        Layer.provide(Layer.succeed(AccessConfig.AccessEnabled, true)),
        Layer.provide(Layer.succeed(AccessConfig.AccessConfig, accessConfig)),
      ),
      { disableLogger: true },
    );
    try {
      const values = new Map<string, string>([["unrelated-profile", "preserved"]]);
      let cookie = "";
      const client = FoundryOnboarding.createInstanceClient({
        origin: accessConfig.origin,
        now: () => now,
        storage: {
          getItem: (key) => values.get(key) ?? null,
          setItem: (key, value) => {
            values.set(key, value);
          },
          removeItem: (key) => {
            values.delete(key);
          },
        },
        request: async (path, csrf) => {
          const response = path.startsWith("/.well-known/")
            ? await descriptorHandler.handler(new Request(`${accessConfig.origin}${path}`))
            : await post(path.slice("/api/foundry/auth/".length), {
                "cf-access-jwt-assertion": await sign(),
                cookie,
                ...(csrf ? { "x-foundry-csrf": csrf } : {}),
              });
          const issuedCookie = response.headers.get("set-cookie");
          if (issuedCookie) cookie = issuedCookie.split(";", 1)[0]!;
          return FoundryOnboarding.readResponse(response);
        },
      });
      const inspected = await client.execute("inspect");
      NodeAssert.equal(inspected.confirmed, false);
      NodeAssert.ok(inspected.binding);
      NodeAssert.equal(inspected.binding.instanceId, instanceId);
      NodeAssert.equal(inspected.binding.mainEnvironmentId, mainEnvironmentId);
      await client.execute("confirm", inspected.binding);
      NodeAssert.equal((await client.execute("login")).session?.instanceId, instanceId);
      const beforeRefresh = cookie;
      await client.execute("refresh");
      NodeAssert.notEqual(cookie, beforeRefresh);
      NodeAssert.equal((await post("session", { cookie: beforeRefresh })).status, 401);
      await authHandler.dispose();
      authHandler = HttpRouter.toWebHandler(authRoutes, { disableLogger: true });
      NodeAssert.equal((await client.execute("session")).session?.instanceId, instanceId);
      const beforeLogout = cookie;
      await client.execute("remove");
      NodeAssert.deepEqual([...values], [["unrelated-profile", "preserved"]]);
      await authHandler.dispose();
      authHandler = HttpRouter.toWebHandler(authRoutes, { disableLogger: true });
      NodeAssert.equal((await post("session", { cookie: beforeLogout })).status, 401);
      await client.execute("confirm", inspected.binding);
      await client.execute("login");
      await query(
        "UPDATE foundry_instance.instance SET access_generation=access_generation+1",
        "foundry_runtime",
      );
      await NodeAssert.rejects(client.execute("session"), { code: "invalid_session" });
      await client.execute("remove");
      NodeAssert.deepEqual([...values], [["unrelated-profile", "preserved"]]);
      await report(
        "PASS P05 client with real HTTP handlers/PostgreSQL: descriptor, confirmed login, cookie rotation, handler restart, durable logout, remote revocation and scoped removal",
      );
    } finally {
      await descriptorHandler.dispose();
    }
  } finally {
    await authHandler.dispose();
  }
  const sessionsBeforeUpgrade = await query(
    "SELECT * FROM foundry_instance.sessions ORDER BY token_hash",
  );
  await query(
    "DROP TABLE foundry_instance.provider_connections, foundry_instance.sandbox_allocations, foundry_instance.sandbox_profiles, foundry_instance.machine_credentials, foundry_instance.archive_artifacts, foundry_instance.archive_events, foundry_instance.archive_threads, foundry_instance.artifact_uploads, foundry_instance.device_grants, foundry_instance.device_enrollments, foundry_instance.devices",
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
    await query(
      "ALTER TABLE foundry_instance.devices DROP COLUMN channel_generation",
      "foundry_migrate",
    );
    await query(
      "DROP TABLE foundry_instance.provider_connections, foundry_instance.sandbox_allocations, foundry_instance.sandbox_profiles, foundry_instance.machine_credentials, foundry_instance.archive_artifacts, foundry_instance.archive_events, foundry_instance.archive_threads, foundry_instance.artifact_uploads, foundry_instance.device_grants",
      "foundry_migrate",
    );
    await query("UPDATE foundry_instance.schema_version SET version=3", "foundry_migrate");
    await expectFailure(readIdentity);
    await run(Effect.all([migrate(), migrate()], { concurrency: "unbounded" }));
    NodeAssert.deepEqual(
      await deviceCall((registry) => registry.get(registered.deviceId)),
      registered,
    );
    const operatorId = String(
      (await query("SELECT operator_id FROM foundry_instance.operator_binding"))[0]!.operator_id,
    );
    const grantLayer = DeviceGrants.layer.pipe(
      Layer.provide(identityLayer),
      Layer.provide(db("foundry_runtime")),
    );
    NodeAssert.deepEqual(await deviceCall((registry) => registry.list(operatorId)), [
      {
        deviceId: registered.deviceId,
        environmentId: registered.environmentId,
        revoked: false,
        clientAccess: { enabled: true, generation: 1 },
        automationExecution: { enabled: false, generation: 1 },
      },
    ]);
    NodeAssert.deepEqual(
      await deviceCall((registry) => registry.list("33333333-3333-4333-8333-333333333333")),
      [],
    );
    const grantCall = <A>(
      f: (
        service: DeviceGrants.DeviceGrants["Service"],
      ) => Effect.Effect<A, import("@t3tools/contracts").FoundryGatewayError>,
    ) => run(DeviceGrants.DeviceGrants.pipe(Effect.flatMap(f), Effect.provide(grantLayer)));
    const initialGrants = await grantCall((service) =>
      service.read(registered.deviceId, operatorId),
    );
    NodeAssert.deepEqual(initialGrants.map((g) => [g.kind, g.enabled]).sort(), [
      ["automationExecution", false],
      ["clientAccess", true],
      ["sandboxProvisioning", false],
    ]);
    const access = initialGrants.find((g) => g.kind === "clientAccess")!;
    const disabled = await grantCall((service) =>
      service.update({ ...access, enabled: false }, operatorId),
    );
    NodeAssert.equal(disabled.generation, access.generation + 1);
    NodeAssert.equal((await enroll(proof)).status, 200);
    await NodeAssert.rejects(
      grantCall((service) => service.check(registered.deviceId, operatorId)),
    );
    await NodeAssert.rejects(
      grantCall((service) => service.update({ ...access, enabled: true }, operatorId)),
    );
    await NodeAssert.rejects(
      grantCall((service) =>
        service.update({ ...access, kind: "sandboxProvisioning", enabled: true }, operatorId),
      ),
    );
    const provisioning = initialGrants.find((grant) => grant.kind === "sandboxProvisioning")!;
    const provisioningInput = {
      deviceId: registered.deviceId,
      environmentId: registered.environmentId,
      generation: provisioning.generation,
      enabled: true,
    };
    await NodeAssert.rejects(
      grantCall((service) =>
        service.updateProvisioning(provisioningInput, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      ),
    );
    await NodeAssert.rejects(
      grantCall((service) =>
        service.updateProvisioning(
          { ...provisioningInput, environmentId: EnvironmentId.make("other-environment") },
          operatorId,
        ),
      ),
    );
    const provisioningEnabled = await grantCall((service) =>
      service.updateProvisioning(provisioningInput, operatorId),
    );
    NodeAssert.equal(provisioningEnabled.kind, "sandboxProvisioning");
    NodeAssert.equal(provisioningEnabled.enabled, true);
    NodeAssert.equal(provisioningEnabled.generation, provisioning.generation + 1);
    await NodeAssert.rejects(
      grantCall((service) => service.updateProvisioning(provisioningInput, operatorId)),
    );
    const provisioningDisabled = await grantCall((service) =>
      service.updateProvisioning(
        { ...provisioningInput, generation: provisioningEnabled.generation, enabled: false },
        operatorId,
      ),
    );
    NodeAssert.equal(provisioningDisabled.enabled, false);
    const automation = initialGrants.find((grant) => grant.kind === "automationExecution")!;
    const automationEnabled = await grantCall((service) =>
      service.update({ ...automation, enabled: true }, operatorId),
    );
    NodeAssert.equal(automationEnabled.enabled, true);
    NodeAssert.equal(automationEnabled.generation, automation.generation + 1);
    await NodeAssert.rejects(
      grantCall((service) => service.update({ ...automation, enabled: false }, operatorId)),
    );
    await NodeAssert.rejects(
      grantCall((service) =>
        service.update(
          { ...automationEnabled, enabled: false },
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ),
      ),
    );
    const automationDisabled = await grantCall((service) =>
      service.update({ ...automationEnabled, enabled: false }, operatorId),
    );
    NodeAssert.equal(automationDisabled.generation, automationEnabled.generation + 1);
    NodeAssert.equal(automationDisabled.enabled, false);
    NodeAssert.equal(
      (await grantCall((service) => service.read(registered.deviceId, operatorId))).find(
        (grant) => grant.kind === "clientAccess",
      )?.generation,
      disabled.generation,
    );
    const restored = await grantCall((service) =>
      service.update({ ...disabled, enabled: true }, operatorId),
    );
    await NodeAssert.rejects(
      grantCall((service) => service.check(registered.deviceId, operatorId, access.generation)),
    );
    NodeAssert.equal(
      await grantCall((service) =>
        service.check(registered.deviceId, operatorId, restored.generation),
      ),
      restored.generation,
    );
    await NodeAssert.rejects(
      grantCall((service) =>
        service.read(registered.deviceId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      ),
    );
    await run(migrate());
    NodeAssert.equal(
      await grantCall((service) => service.check(registered.deviceId, operatorId)),
      restored.generation,
    );
    NodeAssert.deepEqual(
      (await grantCall((service) => service.read(registered.deviceId, operatorId))).filter(
        (g) => g.kind !== "clientAccess",
      ),
      initialGrants
        .filter((g) => g.kind !== "clientAccess")
        .map((grant) =>
          grant.kind === "automationExecution" ? automationDisabled : provisioningDisabled,
        ),
    );
    await report(
      "PASS P11 PostgreSQL: separated grant kinds, durable revoke/regrant generations, stale update rejection, operator isolation and idempotent migration",
    );
    const epochs = await Promise.all(
      Array.from({ length: 4 }, () => deviceCall((registry) => registry.claimChannel(registered))),
    );
    NodeAssert.equal(new Set(epochs).size, 4);
    const currentEpoch = Math.max(...epochs);
    await deviceCall((registry) => registry.checkChannel(registered, currentEpoch));
    for (const epoch of epochs.filter((value) => value !== currentEpoch)) {
      await NodeAssert.rejects(deviceCall((registry) => registry.checkChannel(registered, epoch)));
    }
    NodeAssert.equal((await query("SELECT * FROM foundry_instance.devices")).length, 1);
    const independentKey = generateDeviceKey();
    const independentInvitation = await deviceCall((registry) =>
      registry.approve({
        environmentId: EnvironmentId.make("p11-independent-worker"),
        publicKey: independentKey.publicKey,
      }),
    );
    const independentDevice = await deviceCall((registry) =>
      registry.enroll(signEnrollment(independentInvitation, independentKey.privateKey)),
    );
    const independentGrants = await grantCall((service) =>
      service.read(independentDevice.deviceId, operatorId),
    );
    await grantCall((service) => service.update({ ...restored, enabled: false }, operatorId));
    await NodeAssert.rejects(
      grantCall((service) => service.check(registered.deviceId, operatorId)),
    );
    NodeAssert.equal(
      await grantCall((service) => service.check(independentDevice.deviceId, operatorId)),
      1,
    );
    NodeAssert.deepEqual(
      await grantCall((service) => service.read(independentDevice.deviceId, operatorId)),
      independentGrants,
    );
    await report(
      "PASS P11 device isolation: revoking one device's client access preserves every grant of another device",
    );
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
    await NodeAssert.rejects(
      grantCall((service) =>
        service.updateProvisioning(
          { ...provisioningInput, generation: provisioningDisabled.generation },
          operatorId,
        ),
      ),
    );
    await NodeAssert.rejects(
      grantCall((service) => service.update({ ...automationDisabled, enabled: true }, operatorId)),
    );
    NodeAssert.equal(
      (await deviceCall((registry) => registry.list(operatorId))).find(
        (device) => device.deviceId === registered.deviceId,
      )?.clientAccess.enabled,
      false,
    );
    await NodeAssert.rejects(
      deviceCall((registry) => registry.checkChannel(registered, currentEpoch)),
    );
    await NodeAssert.rejects(deviceCall((registry) => registry.claimChannel(registered)));
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
  const machineOwner = {
    instanceId,
    operatorId: String(
      (await query("SELECT operator_id FROM foundry_instance.operator_binding"))[0]!.operator_id,
    ),
  };
  const machineLayer = MachineCredentials.layer.pipe(
    Layer.provide(identityLayer),
    Layer.provide(db("foundry_runtime")),
    Layer.provide(NodeServices.layer),
  );
  const machineCall = <A, E>(
    operation: (service: MachineCredentials.MachineCredentials["Service"]) => Effect.Effect<A, E>,
  ) =>
    run(
      MachineCredentials.MachineCredentials.pipe(
        Effect.flatMap(operation),
        Effect.provide(machineLayer),
        Effect.provide(testContext),
      ),
    );
  const machineInput = {
    id: "58000000-0000-4000-8000-000000000001",
    label: "Isolated machine reader",
    factoryIds: ["machine-factory-a", "machine-factory-b"],
    expiresAt: now + 60_000,
  };
  const issuedMachines = await Promise.all(
    Array.from({ length: 4 }, () =>
      machineCall((service) => service.issue(machineOwner, machineInput)),
    ),
  );
  NodeAssert.equal(issuedMachines.filter((result) => result.token !== null).length, 1);
  const machineToken = issuedMachines.find((result) => result.token !== null)!.token!;
  NodeAssert.match(machineToken, /^fmc_[A-Za-z0-9_-]{43}$/);
  const persistedMachines = await query(
    "SELECT row_to_json(c)::text AS serialized,token_hash FROM foundry_instance.machine_credentials c",
  );
  NodeAssert.equal(persistedMachines.length, 1);
  NodeAssert.equal(JSON.stringify(persistedMachines).includes(machineToken), false);
  NodeAssert.match(String(persistedMachines[0]!.token_hash), /^[A-Za-z0-9_-]{43}$/);
  NodeAssert.deepEqual(await machineCall((service) => service.authenticate(machineToken)), {
    ...machineOwner,
    factoryIds: machineInput.factoryIds,
    credentialId: machineInput.id,
  });
  NodeAssert.deepEqual(await machineCall((service) => service.list(machineOwner)), [
    { ...machineInput, scope: "automation:read", revoked: false },
  ]);
  for (const changed of [
    { label: "Changed label" },
    { factoryIds: ["other-factory"] },
    { expiresAt: machineInput.expiresAt + 1 },
  ])
    NodeAssert.equal(
      await machineCall((service) =>
        service.issue(machineOwner, { ...machineInput, ...changed }).pipe(
          Effect.match({
            onFailure: (error) => error.code,
            onSuccess: () => "unexpected_success",
          }),
        ),
      ),
      "conflict",
    );
  for (const owner of [
    { ...machineOwner, operatorId: "58000000-0000-4000-8000-000000000099" },
    { ...machineOwner, instanceId: FoundryInstanceId.make("58000000-0000-4000-8000-000000000099") },
  ]) {
    await NodeAssert.rejects(machineCall((service) => service.issue(owner, machineInput)));
    await NodeAssert.rejects(machineCall((service) => service.list(owner)));
    await NodeAssert.rejects(machineCall((service) => service.revoke(owner, machineInput.id)));
  }
  for (const invalidToken of ["", "fmc_invalid", machineToken.slice(4), `fmc_${"A".repeat(43)}`])
    await NodeAssert.rejects(machineCall((service) => service.authenticate(invalidToken)));
  await expectFailure(
    MachineCredentials.MachineCredentials.pipe(
      Effect.flatMap((service) => service.authenticate(machineToken)),
      Effect.provide(
        MachineCredentials.layer.pipe(
          Layer.provide(
            Layer.succeed(InstancePostgres.InstancePostgres, {
              readIdentity: Effect.succeed(
                FoundryInstanceId.make("58000000-0000-4000-8000-000000000099"),
              ),
            }),
          ),
          Layer.provide(db("foundry_runtime")),
          Layer.provide(NodeServices.layer),
        ),
      ),
      Effect.provide(testContext),
    ),
  );
  await stop();
  await start();
  NodeAssert.equal(
    (await machineCall((service) => service.authenticate(machineToken))).credentialId,
    machineInput.id,
  );
  const beforeMachineExpiry = now;
  now = machineInput.expiresAt;
  await NodeAssert.rejects(machineCall((service) => service.authenticate(machineToken)));
  NodeAssert.equal(
    (await machineCall((service) => service.issue(machineOwner, machineInput))).token,
    null,
  );
  now = beforeMachineExpiry;
  await machineCall((service) => service.revoke(machineOwner, machineInput.id));
  await machineCall((service) => service.revoke(machineOwner, machineInput.id));
  await NodeAssert.rejects(machineCall((service) => service.authenticate(machineToken)));
  const revokedRetry = await machineCall((service) => service.issue(machineOwner, machineInput));
  NodeAssert.equal(revokedRetry.token, null);
  NodeAssert.equal(revokedRetry.credential.revoked, true);
  for (const expiresAt of [now, now - 1, now + 30 * 24 * 60 * 60 * 1000 + 1])
    NodeAssert.equal(
      await machineCall((service) =>
        service
          .issue(machineOwner, {
            ...machineInput,
            id: "58000000-0000-4000-8000-000000000002",
            expiresAt,
          })
          .pipe(
            Effect.match({
              onFailure: (error) => error.code,
              onSuccess: () => "unexpected_success",
            }),
          ),
      ),
      "invalid_input",
    );
  for (const [table, id] of [
    ["instance", "58000000-0000-4000-8000-000000000002"],
    ["operator_binding", "58000000-0000-4000-8000-000000000003"],
  ]) {
    const input = { ...machineInput, id: id!, expiresAt: now + 30 * 24 * 60 * 60 * 1000 };
    const credential = await machineCall((service) => service.issue(machineOwner, input));
    NodeAssert.ok(credential.token);
    await machineCall((service) => service.authenticate(credential.token!));
    await query(
      `UPDATE foundry_instance.${table} SET access_generation=access_generation+1`,
      "foundry_runtime",
    );
    await NodeAssert.rejects(machineCall((service) => service.authenticate(credential.token!)));
    const retry = await machineCall((service) => service.issue(machineOwner, input));
    NodeAssert.equal(retry.token, null);
    NodeAssert.equal(retry.credential.revoked, true);
  }
  await query(`INSERT INTO foundry_instance.machine_credentials
    (id,token_hash,instance_id,operator_id,instance_generation,operator_generation,label,factory_ids,expires_at,revoked)
    SELECT ('58000000-0000-4000-8001-' || lpad(n::text,12,'0'))::uuid,'history-fixture-' || n,
      i.instance_id,o.operator_id,i.access_generation,o.access_generation,'Historical reader','["machine-factory-a"]'::jsonb,
      CASE WHEN n%2=0 THEN ${now - 1} ELSE ${now + 172_800_000} END,n%2=1
    FROM foundry_instance.instance i JOIN foundry_instance.operator_binding o USING(singleton),generate_series(1,100) n`);
  const replacementInput = {
    ...machineInput,
    id: "58000000-0000-4000-8000-000000000004",
  };
  const replacement = await machineCall((service) => service.issue(machineOwner, replacementInput));
  NodeAssert.ok(replacement.token);
  const visibleMachines = await machineCall((service) => service.list(machineOwner));
  NodeAssert.equal(visibleMachines.length, 100);
  NodeAssert.equal(visibleMachines[0]!.id, replacementInput.id);
  await query(`INSERT INTO foundry_instance.machine_credentials
    (id,token_hash,instance_id,operator_id,instance_generation,operator_generation,label,factory_ids,expires_at)
    SELECT ('58000000-0000-4000-8002-' || lpad(n::text,12,'0'))::uuid,'active-fixture-' || n,
      i.instance_id,o.operator_id,i.access_generation,o.access_generation,'Active reader','["machine-factory-a"]'::jsonb,${now + 172_800_000}
    FROM foundry_instance.instance i JOIN foundry_instance.operator_binding o USING(singleton),generate_series(1,99) n`);
  NodeAssert.equal(
    await machineCall((service) =>
      service
        .issue(machineOwner, { ...machineInput, id: "58000000-0000-4000-8000-000000000005" })
        .pipe(
          Effect.match({ onFailure: (error) => error.code, onSuccess: () => "unexpected_success" }),
        ),
    ),
    "conflict",
  );
  NodeAssert.equal(
    (await machineCall((service) => service.list(machineOwner))).some(
      (credential) => credential.id === replacementInput.id,
    ),
    true,
  );
  await machineCall((service) => service.revoke(machineOwner, replacementInput.id));
  NodeAssert.ok(
    (
      await machineCall((service) =>
        service.issue(machineOwner, {
          ...machineInput,
          id: "58000000-0000-4000-8000-000000000005",
        }),
      )
    ).token,
  );
  await report(
    "PASS machine credentials: concurrent hash-only issuance, retry/conflict, metadata-only listing, owner/instance isolation, layer and PostgreSQL restart, deterministic expiry, durable revoke, 30-day bounds, current instance/operator generations and active-only quota/list priority after 100 historical credentials",
  );
  await NodeFSP.writeFile(NodePath.join(home, "userdata", "environment-id"), mainEnvironmentId);
  for (const statement of [
    "CREATE ROLE automation_migrate LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    "CREATE ROLE automation_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    "CREATE DATABASE fork_automation OWNER automation_migrate",
    "REVOKE ALL ON DATABASE fork_automation FROM PUBLIC",
    "GRANT CONNECT ON DATABASE fork_automation TO automation_runtime",
  ])
    await query(statement, "fixture_admin", "postgres");
  await query("REVOKE ALL ON SCHEMA public FROM PUBLIC", "fixture_admin", "fork_automation");
  await run(
    AutomationMigrations.AutomationMigrations.pipe(
      Effect.flatMap((service) => service.migrate("automation_runtime")),
      Effect.provide(
        AutomationMigrations.layer.pipe(
          Layer.provide(
            AutomationDatabase.layer({
              path,
              username: "automation_migrate",
              database: "fork_automation",
            }),
          ),
        ),
      ),
    ),
  );
  await query("ALTER ROLE automation_migrate NOLOGIN", "fixture_admin", "postgres");
  NodeAssert.equal(
    (
      await query(
        "SELECT version FROM foundry_automation.schema_version",
        "automation_runtime",
        "fork_automation",
      )
    )[0]?.version,
    11,
  );

  await NodeFSP.writeFile(
    NodePath.join(root, "sandbox-policy.json"),
    JSON.stringify({
      supervisorDeviceId: "99999999-9999-4999-8999-999999999999",
      maxAllocations: 2,
      maxCpuMillis: 2000,
      maxMemoryMiB: 2048,
      allowedRepositories: [],
      allowedImages: [],
      profiles: [],
    }),
  );

  for (const [
    enabled,
    enrollmentEnabled,
    channelEnabled,
    grantsEnabled,
    gatewayEnabled,
    streamsEnabled,
    artifactsEnabled,
    automationEnabled,
    sandboxesEnabled,
  ] of [
    [false, false, false, false, false, false, false, false, false],
    [true, false, false, false, false, false, false, false, false],
    [true, true, false, false, false, false, false, false, false],
    [true, true, true, false, false, false, false, false, false],
    [true, true, true, true, false, false, false, false, false],
    [true, true, true, true, true, false, false, false, false],
    [true, true, true, true, true, true, false, false, false],
    [true, true, true, true, true, true, true, false, false],
    [true, true, true, true, true, true, true, true, false],
    [true, true, true, true, true, true, true, true, true],
  ] as const) {
    const runtimeClients: EnvironmentAuth.IssuedBearerSession[] = [];
    const sessionFixture = automationEnabled
      ? Layer.effectDiscard(
          Effect.gen(function* () {
            const auth = yield* EnvironmentAuth.EnvironmentAuth;
            const secrets = yield* ServerSecretStore.ServerSecretStore;
            NodeAssert.equal(Option.isNone(yield* secrets.get("foundry-github-app")), true);
            runtimeClients.push(
              yield* auth.issueSession({ subject: "runtime-read", scopes: ["orchestration:read"] }),
            );
            runtimeClients.push(
              yield* auth.issueSession({
                subject: "runtime-management",
                scopes: ["orchestration:read", "orchestration:operate", "access:write"],
              }),
            );
          }),
        )
      : Layer.empty;
    const runtimeRoutes = Layer.merge(FoundryRuntime.layer, sessionFixture).pipe(
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(
        EnvironmentAuth.layer.pipe(
          Layer.provide(SqlitePersistence.layerMemory),
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(ServerEnvironment.layerIdentity),
        ),
      ),
      Layer.provide(environment),
      Layer.provide(ServerConfig.layerTest(root, home)),
      Layer.provide(NodeServices.layer),
      Layer.provide(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            FOUNDRY_ACCESS_ENABLED: String(enabled),
            FOUNDRY_DEVICE_ENROLLMENT_ENABLED: String(enrollmentEnabled),
            FOUNDRY_DEVICE_CHANNEL_ENABLED: String(channelEnabled),
            FOUNDRY_GATEWAY_GRANTS_ENABLED: String(grantsEnabled),
            FOUNDRY_HTTP_GATEWAY_ENABLED: String(gatewayEnabled),
            FOUNDRY_STREAM_GATEWAY_ENABLED: String(streamsEnabled),
            FOUNDRY_ARTIFACTS_ENABLED: String(artifactsEnabled),
            FOUNDRY_AUTOMATION_ENABLED: String(automationEnabled),
            FOUNDRY_SANDBOXES_ENABLED: String(sandboxesEnabled),
            FOUNDRY_SANDBOX_CONFIGURATION_FILE: NodePath.join(root, "sandbox-policy.json"),
            FOUNDRY_AUTOMATION_DATABASE_URL: `postgresql://automation_runtime@localhost/fork_automation?host=${encodeURIComponent(root)}`,
            FOUNDRY_AUTOMATION_TARGET: JSON.stringify({
              deviceId: "99999999-9999-4999-8999-999999999999",
              environmentId: "runtime-worker-not-connected",
              allowedRunIds: [],
            }),
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
      const sandboxAnonymous = await runtimeHandler.handler(
        new Request(`${accessConfig.origin}/api/foundry/sandboxes`, {
          method: "POST",
          headers: { origin: accessConfig.origin, "content-type": "application/json" },
          body: JSON.stringify({ action: "list" }),
        }),
      );
      NodeAssert.equal(sandboxAnonymous.status, sandboxesEnabled ? 403 : 404);
      const metadata = await runtimeHandler.handler(
        new Request(`${accessConfig.origin}/.well-known/foundry?protocolVersion=1`),
      );
      NodeAssert.equal(metadata.status, 200);
      const grant = await runtimeHandler.handler(
        new Request(`${accessConfig.origin}/api/foundry/gateway/grants/create`, {
          method: "POST",
          headers: { origin: accessConfig.origin, "content-type": "application/json" },
          body: "{}",
        }),
      );
      NodeAssert.equal(grant.status, grantsEnabled ? 403 : 404);
      const projectRead = await runtimeHandler.handler(
        new Request(`${accessConfig.origin}/api/foundry/gateway/projects`, {
          method: "POST",
          headers: { origin: accessConfig.origin, "content-type": "application/json" },
          body: "{}",
        }),
      );
      NodeAssert.equal(projectRead.status, gatewayEnabled ? 400 : 404);
      const streamTicket = await runtimeHandler.handler(
        new Request(`${accessConfig.origin}/api/foundry/gateway/grants/ticket`, {
          method: "POST",
          headers: { origin: accessConfig.origin, "content-type": "application/json" },
          body: "{}",
        }),
      );
      NodeAssert.equal(streamTicket.status, streamsEnabled ? 400 : 404);
      const descriptor = decodeDescriptor(await metadata.json());
      NodeAssert.equal(Object.hasOwn(descriptor, "artifactTransfer"), artifactsEnabled);
      const artifact = await runtimeHandler.handler(
        new Request(`${accessConfig.origin}/api/foundry/artifacts`, {
          method: "POST",
          headers: { origin: accessConfig.origin, "content-type": "application/json" },
          body: JSON.stringify({ op: "list", input: {} }),
        }),
      );
      NodeAssert.equal(artifact.status, artifactsEnabled ? 403 : 404);
      const machineArtifact = await runtimeHandler.handler(
        new Request(`${accessConfig.origin}/api/foundry/devices/channel`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
      NodeAssert.equal(machineArtifact.status, artifactsEnabled ? 400 : 404);
      NodeAssert.equal(descriptor.capabilities.includes("foundry.http-gateway"), gatewayEnabled);
      NodeAssert.equal(descriptor.capabilities.includes("foundry.rpc-streams"), streamsEnabled);
      NodeAssert.equal(descriptor.capabilities.includes("foundry.device-catalog"), streamsEnabled);
      NodeAssert.equal(Object.hasOwn(descriptor, "instanceAuth"), enabled);
      if (enabled) {
        const verified = FoundryOnboarding.verifyDescriptor(descriptor, accessConfig.origin, {
          instanceId,
          mainEnvironmentId,
          issuer: accessConfig.issuer,
        });
        NodeAssert.equal(verified.binding.origin, accessConfig.origin);
      }
      NodeAssert.equal(descriptor.capabilities.includes("foundry.device-channel"), channelEnabled);
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
      const triggerQuery = await runtimeHandler.handler(
        new Request(`${accessConfig.origin}/api/foundry/automation/triggers/query`, {
          method: "POST",
          headers: { origin: accessConfig.origin, "content-type": "application/json" },
          body: JSON.stringify({ op: "bindings", limit: 50 }),
        }),
      );
      NodeAssert.equal(triggerQuery.status, automationEnabled ? 409 : 404);
      if (automationEnabled) {
        now = Math.floor((await run(Clock.currentTimeMillis)) / 1000) * 1000;
        const provision = HttpRouter.toWebHandler(authRoutes, { disableLogger: true });
        let currentSession: Awaited<ReturnType<typeof issued>>;
        try {
          currentSession = await issued(
            await provision.handler(
              new Request(`${accessConfig.origin}/api/foundry/auth/login`, {
                method: "POST",
                headers: {
                  origin: accessConfig.origin,
                  "content-type": "application/json",
                  "cf-access-jwt-assertion": await sign(),
                },
              }),
              testContext,
            ),
          );
        } finally {
          await provision.dispose();
        }
        NodeAssert.equal(runtimeClients.length, 2);
        const authenticated = (
          endpoint: string,
          payload: unknown,
          clientIndex = 0,
          extra: Record<string, string> = {},
        ) =>
          runtimeHandler.handler(
            new Request(
              endpoint === "sandboxes"
                ? `${accessConfig.origin}/api/foundry/sandboxes`
                : `${accessConfig.origin}/api/foundry/automation/${endpoint}`,
              {
                method: "POST",
                headers: {
                  origin: accessConfig.origin,
                  host: new URL(accessConfig.origin).host,
                  "x-forwarded-proto": "https",
                  "content-type": "application/json",
                  cookie: currentSession.cookie,
                  "x-foundry-csrf": currentSession.csrf,
                  authorization: `Bearer ${runtimeClients[clientIndex]!.token}`,
                  ...extra,
                },
                body: JSON.stringify(payload),
              },
            ),
          );
        if (sandboxesEnabled) {
          const listed = await authenticated("sandboxes", { action: "list" });
          NodeAssert.equal(listed.status, 200);
          NodeAssert.deepEqual(await listed.json(), { profiles: [], allocations: [] });
          const mutation = {
            action: "request",
            request: {
              commandId: "sandbox-runtime",
              profileId: "missing",
              revision: "77777777-7777-4777-8777-777777777777",
              owner: { kind: "interactive" },
            },
          };
          NodeAssert.equal((await authenticated("sandboxes", mutation)).status, 403);
          NodeAssert.equal((await authenticated("sandboxes", mutation, 1)).status, 409);
          NodeAssert.equal(
            (
              await authenticated("sandboxes", { action: "list" }, 0, {
                "x-foundry-csrf": "invalid",
              })
            ).status,
            403,
          );
          await report(
            "PASS sandbox enabled Runtime layers, session+scope+CSRF enforcement; disabled route absent; no OCI or provider execution.",
          );
        }
        const bindings = await authenticated("triggers/query", { op: "bindings", limit: 50 });
        NodeAssert.equal(bindings.status, 200);
        NodeAssert.deepEqual(await bindings.json(), { kind: "bindings", items: [], next: null });
        const factories = await authenticated("query", { op: "factories", limit: 50 });
        NodeAssert.equal(factories.status, 200);
        NodeAssert.deepEqual(await factories.json(), { kind: "factories", items: [], next: null });
        const denied = await authenticated("triggers/command", {
          op: "revoke",
          commandId: "runtime-denied",
          bindingId: "missing",
          generation: 1,
        });
        NodeAssert.equal(denied.status, 409);
        NodeAssert.deepEqual(await denied.json(), {
          _tag: "AutomationTriggerError",
          code: "forbidden",
        });
        const authorized = await authenticated(
          "triggers/command",
          { op: "revoke", commandId: "runtime-authorized", bindingId: "missing", generation: 1 },
          1,
        );
        NodeAssert.equal(authorized.status, 409);
        NodeAssert.deepEqual(await authorized.json(), {
          _tag: "AutomationTriggerError",
          code: "not_found",
        });
        NodeAssert.equal(
          (
            await authenticated("triggers/query", { op: "bindings", limit: 50 }, 0, {
              "x-foundry-csrf": "invalid",
            })
          ).status,
          409,
        );
        NodeAssert.equal(
          (
            await query(
              "SELECT count(*)::int AS count FROM foundry_automation.trigger_events",
              "automation_runtime",
              "fork_automation",
            )
          )[0]?.count,
          0,
        );
        NodeAssert.equal(
          (
            await query(
              "SELECT count(*)::int AS count FROM foundry_automation.runs",
              "automation_runtime",
              "fork_automation",
            )
          )[0]?.count,
          0,
        );
        await report(
          "PASS enabled production Automation runtime: separate schema-11 database and restricted roles; current Foundry/T3 sessions read empty bindings/factories; read scope cannot mutate, management scope reaches domain validation; invalid CSRF rejected; no GitHub App configuration, worker or provider execution.",
        );
      }
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
  await verifyGateway({ root, mainHome: home, databaseSocket: path });
  await report(
    "PASS integrated gateway: real connector CLI with local TLS/machine headers, channel reconnect and Main service restart invalidate old grants; HTTP enrollment/retry/proof rejection, offline catalog, separate session/CSRF/origin/target checks; two clients, real worker HTTP/RPC, idempotent Replay launch, file/diff, attachment hash/resume, terminal, access revoke/regrant and registration revoke; direct T3 access preserved",
  );
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
