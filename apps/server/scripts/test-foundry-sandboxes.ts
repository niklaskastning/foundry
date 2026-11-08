import { artifactSha256 } from "@t3tools/shared/foundryArtifacts";
import * as Schema from "effect/Schema";
import { verifyProviderConnections } from "./foundry-provider-connections-integration.ts";
// @effect-diagnostics nodeBuiltinImport:off -- This integration harness owns its isolated PostgreSQL child and temporary files.
// @effect-diagnostics globalProcess:off -- Only the PostgreSQL binary directory is read from the environment.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  FoundryDeviceId,
  FoundryArtifactId,
  ThreadId,
  FoundryInstanceId,
  type FoundrySandboxAllocation,
  type FoundrySandboxProfile,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as Layer from "effect/Layer";
import * as Allocations from "../src/foundry/sandboxes/Allocations.ts";
import * as AutomationDatabase from "../src/automation/AutomationDatabase.ts";
import * as SandboxTargets from "../src/automation/SandboxTargets.ts";
import * as WorkerTransport from "../src/automation/WorkerTransport.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as InstanceDatabase from "../src/foundry/InstanceDatabase.ts";
import * as InstanceMigrations from "../src/foundry/InstanceMigrations.ts";
import * as InstancePostgres from "../src/foundry/InstancePostgres.ts";
import * as ServerEnvironment from "../src/environment/ServerEnvironment.ts";
import * as ServerConfig from "../src/config.ts";

const encodeWire = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const wireBytes = (value: unknown) => new TextEncoder().encode(encodeWire(value)).byteLength;
const bin = process.env.FOUNDRY_TEST_PG_BIN;
NodeAssert.ok(
  bin,
  "Set FOUNDRY_TEST_PG_BIN to PostgreSQL 17+ binaries; no existing database is used.",
);
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "foundry-sandboxes-pg-"));
const data = NodePath.join(root, "data");
let child: NodeChildProcess.ChildProcess | undefined;
const start = async () => {
  const server = NodeChildProcess.spawn(
    NodePath.join(bin, "postgres"),
    ["-D", data, "-k", root, "-c", "listen_addresses=", "-c", "fsync=on"],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" } },
  );
  child = server;
  await new Promise<void>((resolve, reject) => {
    let output = "";
    server.once("error", reject);
    server.once("exit", (code) =>
      reject(new Error(`Fixture PostgreSQL exited (${code}): ${output}`)),
    );
    server.stderr!.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4000);
      if (output.includes("database system is ready to accept connections")) resolve();
    });
  });
};
const stop = async () => {
  if (!child || child.exitCode !== null) return;
  const server = child;
  const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
  server.kill("SIGQUIT");
  await exited;
  child = undefined;
};
const db = (username = "foundry_runtime", database = "sandbox_fixture") =>
  InstanceDatabase.layer({ path: NodePath.join(root, ".s.PGSQL.5432"), username, database });
const query = (statement: string, username = "fixture_admin", database = "sandbox_fixture") =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* InstanceDatabase.InstanceDatabase;
      return yield* sql.unsafe(statement);
    }).pipe(Effect.provide(db(username, database))),
  );
const instanceId = FoundryInstanceId.make("ec767f76-a37e-46ea-92c5-a617ce4fbdb4");
const operatorId = "06213e6e-1d5b-4e8b-8dab-bc38192055eb";
const mainEnvironmentId = EnvironmentId.make("sandbox-fixture-main");
const environment = Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
  getEnvironmentId: Effect.succeed(mainEnvironmentId),
});
const profile: FoundrySandboxProfile = {
  profileId: "fixture",
  revision: "020c5be4-b8c3-41a2-83ac-06545fb918b7",
  label: "Fixture",
  image: `example.invalid/foundry@sha256:${"a".repeat(64)}`,
  architecture: "amd64",
  resources: { cpuMillis: 1000, memoryMiB: 512, pids: 128 },
  lifetimeSeconds: 300,
  maxLifetimeSeconds: 600,
  network: "none",
  checkout: { repository: "https://example.invalid/foundry.git", commit: "b".repeat(40) },
  setup: [["true"]],
  tools: [{ command: "git", version: "2" }],
  providerConnectionId: "fixture-codex",
  enabled: true,
};
const sandboxPolicy = {
  supervisorDeviceId: FoundryDeviceId.make("6970d80d-d7d0-408f-a99d-2080362d6892"),
  maxAllocations: 2,
  maxCpuMillis: 2000,
  maxMemoryMiB: 1024,
  allowedImages: [profile.image],
  allowedRepositories: [profile.checkout.repository],
};
const policy = Layer.succeed(Allocations.SandboxPolicy, sandboxPolicy);
const runtimeFor = (policyLayer: typeof policy) =>
  Allocations.layer.pipe(
    Layer.provide(InstancePostgres.layer),
    Layer.provideMerge(db()),
    Layer.provide(policyLayer),
    Layer.provide(environment),
    Layer.provide(ServerConfig.layerTest(root, `${root}/home`)),
    Layer.provide(NodeServices.layer),
  );
const runtime = runtimeFor(policy);
const run = <A, E>(
  effect: Effect.Effect<A, E, Allocations.Allocations | InstanceDatabase.InstanceDatabase>,
) => Effect.runPromise(effect.pipe(Effect.provide(runtime)));
let first: FoundrySandboxAllocation | undefined;
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
    "CREATE DATABASE sandbox_fixture OWNER foundry_migrate",
  ])
    await query(statement, "fixture_admin", "postgres");
  await query("REVOKE ALL ON DATABASE sandbox_fixture FROM PUBLIC");
  await query("GRANT CONNECT ON DATABASE sandbox_fixture TO foundry_runtime");
  await query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
  await Effect.runPromise(
    InstanceMigrations.InstanceMigrations.pipe(
      Effect.flatMap((service) =>
        service.migrate({ instanceId, mainEnvironmentId, runtimeRole: "foundry_runtime" }),
      ),
      Effect.provide(InstanceMigrations.layer.pipe(Layer.provide(db("foundry_migrate")))),
    ),
  );
  await query(
    `INSERT INTO foundry_instance.operator_binding(operator_id,issuer,subject) VALUES ('${operatorId}','fixture','operator')`,
  );
  await Effect.runPromise(
    verifyProviderConnections({ instanceId, operatorId }).pipe(
      Effect.provide(
        Layer.merge(InstancePostgres.layer.pipe(Layer.provide(db())), db("fixture_admin")).pipe(
          Layer.provide(environment),
          Layer.provide(ServerConfig.layerTest(root, `${root}/home`)),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
  first = await run(
    Effect.gen(function* () {
      const service = yield* Allocations.Allocations;
      yield* service.publishProfile(operatorId, profile);
      yield* service.publishProfile(operatorId, profile);
      NodeAssert.equal(
        (yield* service
          .publishProfile(operatorId, { ...profile, label: "drift" })
          .pipe(Effect.flip)).code,
        "conflict",
      );
      const input = {
        commandId: "duplicate",
        profileId: profile.profileId,
        revision: profile.revision,
        owner: { kind: "interactive" as const },
      };
      const duplicates = yield* Effect.all(
        Array.from({ length: 8 }, () => service.request(operatorId, input)),
        { concurrency: 8 },
      );
      NodeAssert.equal(new Set(duplicates.map((allocation) => allocation.allocationId)).size, 1);
      const allocation = duplicates[0]!;
      NodeAssert.equal(
        (yield* service
          .request(operatorId, {
            ...input,
            owner: { kind: "workflow", factoryId: "f", runId: "r", attemptId: "a" },
          })
          .pipe(Effect.flip)).code,
        "conflict",
      );
      const nextProfile = {
        ...profile,
        revision: "a5ab6cd6-11b1-412c-b187-ce11cad09a68",
        setup: [["false"]],
      };
      yield* service.publishProfile(operatorId, nextProfile);
      NodeAssert.deepEqual(
        (yield* service.get(operatorId, allocation.allocationId)).allocation.profile,
        profile,
      );
      const competing = yield* Effect.forEach(
        ["second", "third"],
        (commandId) => service.request(operatorId, { ...input, commandId }).pipe(Effect.result),
        { concurrency: 2 },
      );
      NodeAssert.equal(competing.filter((result) => result._tag === "Success").length, 1);
      NodeAssert.equal(competing.filter((result) => result._tag === "Failure").length, 1);
      NodeAssert.equal((yield* service.list(operatorId)).allocations.length, 2);
      const lease = "62257363-5ac3-4d18-8b4e-cf17695c2ec7";
      NodeAssert.equal((yield* service.claim(operatorId, lease)).length, 2);
      NodeAssert.equal(
        (yield* service.claim(operatorId, "a8a4bce3-96f4-43dc-a631-3890f826be55")).length,
        0,
      );
      yield* service.checkLease(operatorId, allocation.allocationId, lease, 1);
      yield* Effect.promise(() =>
        query(
          `UPDATE foundry_instance.sandbox_allocations SET claim_until=0 WHERE allocation_id='${allocation.allocationId}'`,
        ),
      );
      const expiredMutation = yield* Allocations.withSandboxAllocationLock(
        Effect.gen(function* () {
          yield* service.checkLease(operatorId, allocation.allocationId, lease, 1);
          return yield* service.transition(operatorId, allocation.allocationId, 1, "provisioning");
        }),
      ).pipe(Effect.result);
      NodeAssert.equal(expiredMutation._tag, "Failure");
      NodeAssert.equal(
        (yield* service.get(operatorId, allocation.allocationId)).allocation.state,
        "requested",
      );
      yield* service.claim(operatorId, lease);

      yield* service.control(
        operatorId,
        allocation.allocationId,
        "extend",
        allocation.createdAt + 500000,
      );
      NodeAssert.equal(
        (yield* service
          .control(operatorId, allocation.allocationId, "extend", allocation.createdAt + 700000)
          .pipe(Effect.flip)).code,
        "conflict",
      );
      yield* service.transition(operatorId, allocation.allocationId, 1, "provisioning");
      yield* service.transition(operatorId, allocation.allocationId, 1, "setup");
      yield* service.transition(operatorId, allocation.allocationId, 1, "failed", {
        failure: "setup",
      });
      const retry = yield* service.control(operatorId, allocation.allocationId, "retry");
      NodeAssert.equal(retry.generation, 2);
      NodeAssert.equal(
        (yield* service
          .transition(operatorId, allocation.allocationId, 1, "setup")
          .pipe(Effect.flip)).code,
        "conflict",
      );
      const cancelled = yield* service.control(operatorId, allocation.allocationId, "delete");
      NodeAssert.equal(cancelled.generation, 3);
      NodeAssert.equal(cancelled.state, "draining");
      NodeAssert.equal(
        (yield* service.checkLease(operatorId, allocation.allocationId, lease, 2).pipe(Effect.flip))
          .code,
        "conflict",
      );
      NodeAssert.deepEqual(
        yield* service.control(operatorId, allocation.allocationId, "delete"),
        cancelled,
      );
      yield* service.transition(operatorId, allocation.allocationId, 3, "stopped");
      yield* service.transition(operatorId, allocation.allocationId, 3, "archiving");
      NodeAssert.equal(
        (yield* service
          .transition(operatorId, allocation.allocationId, 3, "deleting")
          .pipe(Effect.flip)).code,
        "archive_required",
      );
      NodeAssert.equal(
        (yield* service
          .request(operatorId, {
            ...input,
            commandId: "resume-premature",
            resumeAllocationId: allocation.allocationId,
          })
          .pipe(Effect.flip)).code,
        "archive_required",
      );
      NodeAssert.equal(
        (yield* service.request("ad42a1e3-6e84-45e8-87dc-adc6922de631", input).pipe(Effect.flip))
          .code,
        "forbidden",
      );
      return (yield* service.get(operatorId, allocation.allocationId)).allocation;
    }),
  );
  for (const statement of [
    "CREATE SCHEMA foundry_automation",
    "CREATE TABLE foundry_automation.dispatch_runs(run_id text PRIMARY KEY,state text NOT NULL)",
    "CREATE TABLE foundry_automation.run_controls(run_id text PRIMARY KEY,mode text NOT NULL)",
  ])
    await query(statement);
  const cleanupRuns = [
    { runId: "succeeded", state: "succeeded", mode: "active" },
    { runId: "failed", state: "failed", mode: "active" },
    { runId: "cancelled", state: "failed", mode: "cancelled" },
    { runId: "retry-active", state: "running", mode: "active" },
    { runId: "setup-pending", state: "waiting", mode: "active" },
    { runId: "cancel-pending", state: "waiting", mode: "cancel_requested" },
  ];
  for (const { runId, state, mode } of cleanupRuns) {
    await query(`INSERT INTO foundry_automation.dispatch_runs VALUES ('${runId}','${state}')`);
    await query(`INSERT INTO foundry_automation.run_controls VALUES ('${runId}','${mode}')`);
  }
  const workflowAllocations = cleanupRuns.map(({ runId }, index) => ({
    operatorId,
    allocation: {
      ...first!,
      allocationId: `dd5ee09b-5735-4333-bfa0-${String(index).padStart(12, "0")}`,
      request: {
        ...first!.request,
        owner: { kind: "workflow" as const, factoryId: "fixture", runId },
      },
    },
  }));
  const deletedRuns: string[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const targets = yield* SandboxTargets.SandboxTargets;
      NodeAssert.ok(targets);
      yield* targets.reconcileCleanup;
      NodeAssert.deepEqual(deletedRuns, ["succeeded", "failed", "cancelled"]);
    }).pipe(
      Effect.provide(
        SandboxTargets.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              AutomationDatabase.layer({
                path: NodePath.join(root, ".s.PGSQL.5432"),
                username: "fixture_admin",
                database: "sandbox_fixture",
              }),
              Layer.mock(Allocations.Allocations)({
                activeWorkflowAllocations: Effect.succeed(workflowAllocations),
                control: (operator, allocationId, action) =>
                  Effect.sync(() => {
                    NodeAssert.equal(operator, operatorId);
                    NodeAssert.equal(action, "delete");
                    const owned = workflowAllocations.find(
                      ({ allocation }) => allocation.allocationId === allocationId,
                    )!;
                    deletedRuns.push(owned.allocation.request.owner.runId);
                    return owned.allocation;
                  }),
              }),
              Layer.mock(WorkerTransport.WorkerTransport)({}),
              NodeCrypto.layer,
            ),
          ),
        ),
      ),
    ),
  );
  for (const revoked of [{ allowedImages: [] }, { allowedRepositories: [] }]) {
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Allocations.Allocations;
        const catalog = yield* service.list(operatorId);
        NodeAssert.ok(catalog.profiles.every((entry) => !entry.enabled));
        NodeAssert.deepEqual(
          (yield* service.get(operatorId, first!.allocationId)).allocation,
          first,
        );
        NodeAssert.equal(
          catalog.allocations.find((entry) => entry.allocationId === first!.allocationId)!.profile
            .enabled,
          true,
        );
        NodeAssert.equal(
          (yield* service
            .request(operatorId, {
              commandId: "revoked-resource",
              profileId: profile.profileId,
              revision: profile.revision,
              owner: { kind: "interactive" },
            })
            .pipe(Effect.flip)).code,
          "forbidden",
        );
      }).pipe(
        Effect.provide(
          runtimeFor(Layer.succeed(Allocations.SandboxPolicy, { ...sandboxPolicy, ...revoked })),
        ),
      ),
    );
  }
  await stop();
  await start();
  await run(
    Effect.gen(function* () {
      const service = yield* Allocations.Allocations;
      NodeAssert.deepEqual((yield* service.get(operatorId, first!.allocationId)).allocation, first);
      const active = (yield* service.list(operatorId)).allocations.find(
        (item) => item.state === "requested",
      )!;
      yield* service.transition(operatorId, active.allocationId, active.generation, "provisioning");
      yield* service.transition(operatorId, active.allocationId, active.generation, "setup");
      yield* service.transition(operatorId, active.allocationId, active.generation, "failed", {
        failure: "setup",
      });
      yield* queryExpiry(active.allocationId);
      NodeAssert.equal(
        (yield* service
          .control(operatorId, active.allocationId, "extend", active.createdAt + 550000)
          .pipe(Effect.flip)).code,
        "conflict",
      );
      const claimed = yield* service.claim(operatorId, "62257363-5ac3-4d18-8b4e-cf17695c2ec7");
      NodeAssert.equal(new Set(claimed.map((item) => item.allocationId)).size, 2);
      const expiredSetup = claimed.find((item) => item.allocationId === active.allocationId)!;
      NodeAssert.equal(expiredSetup.state, "draining");
      NodeAssert.equal(expiredSetup.generation, active.generation + 1);
      NodeAssert.equal(expiredSetup.deleteRequested, true);
      yield* service.transition(operatorId, first!.allocationId, first!.generation, "failed", {
        failure: "archive",
      });
      yield* queryExpiry(first!.allocationId);
      yield* service.claim(operatorId, "62257363-5ac3-4d18-8b4e-cf17695c2ec7");
      const failedCleanup = (yield* service.get(operatorId, first!.allocationId)).allocation;
      NodeAssert.equal(failedCleanup.state, "failed");
      NodeAssert.equal(failedCleanup.generation, first!.generation);
      NodeAssert.equal(failedCleanup.failure, "archive");
      NodeAssert.deepEqual(
        yield* service.control(operatorId, first!.allocationId, "delete"),
        failedCleanup,
      );
      const retriedCleanup = yield* service.control(operatorId, first!.allocationId, "retry");
      NodeAssert.equal(retriedCleanup.state, "archiving");
      NodeAssert.equal(retriedCleanup.generation, first!.generation);
      const receipt = {
        archive: {
          kind: "setup" as const,
          allocationId: first!.allocationId,
          fence: first!.generation,
          artifact: {
            reference: {
              instanceId,
              artifactId: FoundryArtifactId.make("e0870844-03d4-481c-8021-210c518df016"),
              owner: {
                environmentId: mainEnvironmentId,
                threadId: ThreadId.make(first!.allocationId),
              },
            },
            name: "setup.json",
            mimeType: "application/json",
            sizeBytes: 0,
            sha256: "a".repeat(64),
          },
        },
        digest: "b".repeat(64),
      };
      yield* service.transition(
        operatorId,
        first!.allocationId,
        first!.generation,
        "deleting",
        {},
        receipt,
      );
      yield* service.transition(operatorId, first!.allocationId, first!.generation, "deleted");
      NodeAssert.equal(
        (yield* service.control(operatorId, first!.allocationId, "delete")).state,
        "deleted",
      );
      NodeAssert.deepEqual(
        (yield* service.get(operatorId, first!.allocationId)).archive_receipt,
        receipt,
      );
      NodeAssert.equal(
        (yield* service
          .request(operatorId, {
            commandId: "setup-resume",
            profileId: profile.profileId,
            revision: profile.revision,
            owner: { kind: "interactive" },
            resumeAllocationId: first!.allocationId,
          })
          .pipe(Effect.flip)).code,
        "archive_required",
      );
      const replacement = yield* service.request(operatorId, {
        commandId: "after-cleanup",
        profileId: profile.profileId,
        revision: profile.revision,
        owner: { kind: "interactive" },
      });
      NodeAssert.equal(replacement.state, "requested");
      NodeAssert.notEqual(replacement.allocationId, first!.allocationId);
      const expired = (yield* service.get(operatorId, active.allocationId)).allocation;
      NodeAssert.equal(expired.state, "draining");
      yield* service.transition(operatorId, expired.allocationId, expired.generation, "stopped");
      yield* service.claim(operatorId, "62257363-5ac3-4d18-8b4e-cf17695c2ec7");
      const stopped = (yield* service.get(operatorId, expired.allocationId)).allocation;
      NodeAssert.equal(stopped.state, "stopped");
      NodeAssert.equal(stopped.generation, expired.generation);
    }),
  );
  const largeRuntime = Allocations.layer.pipe(
    Layer.provide(InstancePostgres.layer),
    Layer.provideMerge(db()),
    Layer.provide(
      Layer.succeed(Allocations.SandboxPolicy, {
        supervisorDeviceId: FoundryDeviceId.make("6970d80d-d7d0-408f-a99d-2080362d6892"),
        maxAllocations: 32,
        maxCpuMillis: 32000,
        maxMemoryMiB: 16384,
        allowedImages: [profile.image],
        allowedRepositories: [profile.checkout.repository],
      }),
    ),
    Layer.provide(environment),
    Layer.provide(ServerConfig.layerTest(root, `${root}/home`)),
    Layer.provide(NodeServices.layer),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* Allocations.Allocations;
      const content = "x".repeat(180000);
      const heavy = {
        ...profile,
        profileId: "large-skills",
        skills: [
          {
            id: "large",
            directory: "skills/large",
            name: "large",
            description: "large",
            files: [
              {
                path: "skills/large/SKILL.md",
                content,
                encoding: "utf8" as const,
                mode: "100644" as const,
                sha256: artifactSha256(new TextEncoder().encode(content)),
              },
            ],
          },
        ],
      };
      yield* service.publishProfile(operatorId, heavy);
      const full = [];
      for (let i = 0; i < 16; i++)
        full.push(
          yield* service.request(operatorId, {
            commandId: `large-${i}`,
            profileId: heavy.profileId,
            revision: heavy.revision,
            owner: { kind: "interactive" },
          }),
        );
      NodeAssert.ok(wireBytes(full) > 2 * 1024 * 1024);
      const claims = yield* service.claim(operatorId, "66a4201c-5f1e-43b0-bd44-cf9bc331357f");
      NodeAssert.ok(wireBytes(claims) < 2 * 1024 * 1024);
      NodeAssert.ok(claims.every((row) => !("skills" in row.profile) && !("setup" in row.profile)));
      const catalog = yield* service.list(operatorId);
      NodeAssert.ok(wireBytes(catalog) < 3 * 1024 * 1024);
      NodeAssert.ok(catalog.profiles.every((row) => !("skills" in row) && !("setup" in row)));
      const pinned = yield* service.get(operatorId, full[0]!.allocationId);
      NodeAssert.equal(pinned.allocation.profile.skills?.[0]?.files[0]?.content, content);
      const oversized = yield* service
        .publishProfile(operatorId, {
          ...heavy,
          profileId: "oversized",
          setup: Array.from({ length: 32 }, () => ["x".repeat(4096), "x".repeat(4096)]),
        })
        .pipe(Effect.result);
      NodeAssert.equal(oversized._tag, "Failure");
      const oversizedMetadata = yield* service
        .publishProfile(operatorId, {
          ...profile,
          profileId: "oversized-metadata",
          tools: Array.from({ length: 32 }, () => ({
            command: "x".repeat(128),
            version: "1".repeat(128),
          })),
        })
        .pipe(Effect.result);
      NodeAssert.equal(oversizedMetadata._tag, "Failure");
    }).pipe(Effect.provide(largeRuntime)),
  );
  await Effect.runPromise(
    Console.log(
      "PASS sandbox PostgreSQL: concurrent idempotency/quota, immutable profiles, setup retry, stale-generation fencing, cancellation, lifetime extension, archive-required deletion, terminal workflow cleanup, process restart; isolated fixtures removed.",
    ),
  );
} finally {
  await stop();
  await NodeFSP.rm(root, { recursive: true, force: true });
}
function queryExpiry(allocationId: string) {
  return Effect.promise(() =>
    query(
      `UPDATE foundry_instance.sandbox_allocations SET allocation=jsonb_set(allocation,'{expiresAt}','1'::jsonb) WHERE allocation_id='${allocationId}'`,
    ),
  );
}
