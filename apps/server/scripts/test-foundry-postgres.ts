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
    "UPDATE foundry_instance.schema_version SET version=2",
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
    await query("UPDATE foundry_instance.schema_version SET version=2", "foundry_migrate");
    NodeAssert.equal((await ready()).status, 503);
    await expectFailure(migrate());
    await query("UPDATE foundry_instance.schema_version SET version=1", "foundry_migrate");
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
  await report(
    "Gate P02 passed on isolated PostgreSQL:",
    NodeChildProcess.spawnSync(NodePath.join(bin, "postgres"), ["--version"], {
      encoding: "utf8",
    }).stdout.trim(),
  );
} finally {
  await stop();
  await NodeFSP.rm(root, { recursive: true, force: true });
}
