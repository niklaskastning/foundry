// @effect-diagnostics nodeBuiltinImport:off -- This standalone gate owns its temporary PostgreSQL process and filesystem.
// @effect-diagnostics globalProcess:off -- Only the PostgreSQL binary directory is accepted from the environment.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { EnvironmentId, FoundryInstanceId } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AccessConfig from "../src/foundry/AccessConfig.ts";
import * as AccessVerifier from "../src/foundry/AccessVerifier.ts";
import * as FoundrySessions from "../src/foundry/FoundrySessions.ts";
import * as InstanceDatabase from "../src/foundry/InstanceDatabase.ts";
import * as InstanceMigrations from "../src/foundry/InstanceMigrations.ts";
import * as InstanceOperator from "../src/foundry/InstanceOperator.ts";
import * as InstancePostgres from "../src/foundry/InstancePostgres.ts";

const bin = process.env.FOUNDRY_TEST_PG_BIN;
NodeAssert.ok(bin, "Set FOUNDRY_TEST_PG_BIN; only a temporary PostgreSQL cluster is used.");
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "automation-session-pg-"));
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
      reject(new Error(`Temporary PostgreSQL exited (${code}): ${output}`)),
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
const db = (username: string) => InstanceDatabase.layer({ path, username, database: "postgres" });
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const query = (statement: string) =>
  run(
    Effect.gen(function* () {
      const sql = yield* InstanceDatabase.InstanceDatabase;
      return yield* sql.unsafe<Record<string, unknown>>(statement);
    }).pipe(Effect.provide(db("fixture_admin"))),
  );
const instanceId = FoundryInstanceId.make("22222222-2222-4222-8222-222222222222");
const identity = Layer.succeed(InstancePostgres.InstancePostgres, {
  readIdentity: Effect.succeed(instanceId),
});
const config = {
  issuer: "https://fixture.cloudflareaccess.com",
  audience: "session-reference-fixture",
  origin: "https://fixture.example.test",
};
const sessionLayer = FoundrySessions.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      db("foundry_runtime"),
      identity,
      NodeCrypto.layer,
      Layer.succeed(AccessConfig.AccessConfig, config),
      Layer.succeed(AccessVerifier.AccessVerifier, {
        verify: Effect.fn("SessionFixture.verify")(() =>
          Effect.succeed({
            issuer: config.issuer,
            subject: "fixture",
            expiresAt: Number.MAX_SAFE_INTEGER,
          }),
        ),
      }),
    ),
  ),
);
const call = <A, E>(
  operation: (service: FoundrySessions.FoundrySessions["Service"]) => Effect.Effect<A, E>,
) =>
  run(
    FoundrySessions.FoundrySessions.pipe(Effect.flatMap(operation), Effect.provide(sessionLayer)),
  );
const rejected = async (tokenHash: string) => {
  await NodeAssert.rejects(
    call((service) => service.inspectReference(tokenHash)),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "invalid_session",
  );
};
try {
  const initialized = NodeChildProcess.spawnSync(
    NodePath.join(bin, "initdb"),
    ["-D", data, "-U", "fixture_admin", "--auth=trust", "--no-locale"],
    { encoding: "utf8" },
  );
  NodeAssert.equal(initialized.status, 0, initialized.stderr);
  await start();
  for (const statement of [
    "CREATE ROLE foundry_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    "CREATE ROLE foundry_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    "REVOKE ALL ON DATABASE postgres FROM PUBLIC",
    "GRANT CONNECT,CREATE ON DATABASE postgres TO foundry_migrator",
    "GRANT CONNECT ON DATABASE postgres TO foundry_runtime",
    "REVOKE ALL ON SCHEMA public FROM PUBLIC",
  ])
    await query(statement);
  await run(
    InstanceMigrations.InstanceMigrations.pipe(
      Effect.flatMap((service) =>
        service.migrate({
          instanceId,
          mainEnvironmentId: EnvironmentId.make("session-fixture-main"),
          runtimeRole: "foundry_runtime",
        }),
      ),
      Effect.provide(InstanceMigrations.layer.pipe(Layer.provide(db("foundry_migrator")))),
    ),
  );
  await run(
    InstanceOperator.InstanceOperator.pipe(
      Effect.flatMap((service) => service.bind(config.issuer, "fixture")),
      Effect.provide(
        InstanceOperator.layer.pipe(
          Layer.provide(Layer.mergeAll(db("foundry_runtime"), identity, NodeCrypto.layer)),
        ),
      ),
    ),
  );
  const issued = await call((service) => service.login("fixture-proof"));
  const tokenHash = await call((service) => service.reference(issued.token));
  NodeAssert.notEqual(tokenHash, issued.token);
  const expected = {
    instanceId,
    operatorId: issued.session.operatorId,
    expiresAt: issued.session.expiresAt,
  };
  NodeAssert.deepEqual(await call((service) => service.inspectReference(tokenHash)), expected);
  NodeAssert.equal(
    (await query("SELECT count(*)::int AS n FROM foundry_instance.sessions"))[0]?.n,
    1,
  );
  await NodeAssert.rejects(call((service) => service.inspect(tokenHash)));
  await stop();
  await start();
  NodeAssert.deepEqual(await call((service) => service.inspectReference(tokenHash)), expected);
  await call((service) => service.logout(issued.token, issued.session.csrfToken));
  await rejected(tokenHash);
  for (const statement of [
    "UPDATE foundry_instance.instance SET access_generation=access_generation+1",
    "UPDATE foundry_instance.operator_binding SET access_generation=access_generation+1",
    "UPDATE foundry_instance.sessions SET expires_at=1",
  ]) {
    const next = await call((service) => service.login("fixture-proof"));
    const reference = await call((service) => service.reference(next.token));
    await query(statement);
    await rejected(reference);
  }
  await run(
    Console.log(
      "PASS P19 session reference: no credential duplication; service and PostgreSQL restart; logout, instance/operator generation and expiry reject old authority. No worker/provider started.",
    ),
  );
} finally {
  await stop();
  await NodeFSP.rm(root, { recursive: true, force: true });
}
