// @effect-diagnostics nodeBuiltinImport:off -- Native password verification requires Node scrypt and constant-time byte comparison.
import * as NodeCrypto from "node:crypto";
import { FoundryAuthError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as InstanceDatabase from "./InstanceDatabase.ts";
import * as InstancePostgres from "./InstancePostgres.ts";
import * as AccessConfig from "./AccessConfig.ts";

const passwordHash = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    NodeCrypto.scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, hash) => (error ? reject(error) : resolve(hash)),
    ),
  );
export class NativeOperator extends Context.Service<
  NativeOperator,
  {
    readonly bootstrap: (
      username: string,
      password: string,
    ) => Effect.Effect<void, FoundryAuthError>;
    readonly verify: (
      input: unknown,
    ) => Effect.Effect<{ issuer: string; subject: string; expiresAt: number }, FoundryAuthError>;
  }
>()("t3/foundry/NativeOperator") {}
const make = Effect.gen(function* () {
  const sql = yield* InstanceDatabase.InstanceDatabase;
  const identity = yield* InstancePostgres.InstancePostgres;
  const config = yield* AccessConfig.AccessConfig;
  let attempts = 0;
  let windowEnd = 0;
  const unavailable = () => Effect.fail(new FoundryAuthError({ code: "unavailable" }));
  const bootstrap = Effect.fn("NativeOperator.bootstrap")(
    function* (username: string, password: string) {
      if (
        config.mode !== "native" ||
        !username.trim() ||
        username.length > 100 ||
        password.length < 12 ||
        password.length > 1024
      )
        return yield* new FoundryAuthError({ code: "invalid_access" });
      yield* identity.readIdentity;
      const salt = NodeCrypto.randomBytes(32).toString("hex");
      const hash = yield* Effect.tryPromise({
        try: async () => (await passwordHash(password, salt)).toString("hex"),
        catch: () => new FoundryAuthError({ code: "unavailable" }),
      });
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT pg_advisory_xact_lock(1179602514, 2)`;
          const existing = yield* sql`SELECT 1 FROM foundry_instance.native_operator`;
          if (existing.length) return yield* new FoundryAuthError({ code: "operator_mismatch" });
          yield* sql`INSERT INTO foundry_instance.operator_binding(operator_id, issuer, subject)
        VALUES (${NodeCrypto.randomUUID()}, ${config.issuer}, ${username}) ON CONFLICT(singleton) DO NOTHING`;
          yield* sql`INSERT INTO foundry_instance.native_operator(operator_id, username, salt, password_hash)
        SELECT operator_id, ${username}, ${salt}, ${hash} FROM foundry_instance.operator_binding`;
        }),
      );
    },
    Effect.catchTags({ SqlError: unavailable, InstanceDatabaseError: unavailable }),
  );
  const verify = Effect.fn("NativeOperator.verify")(
    function* (input: unknown) {
      if (config.mode !== "native") return yield* new FoundryAuthError({ code: "invalid_access" });
      const now = yield* Clock.currentTimeMillis;
      if (now >= windowEnd) {
        attempts = 0;
        windowEnd = now + 60_000;
      }
      if (++attempts > 10) return yield* new FoundryAuthError({ code: "invalid_access" });
      if (
        typeof input !== "object" ||
        input === null ||
        !("username" in input) ||
        !("password" in input) ||
        typeof input.username !== "string" ||
        typeof input.password !== "string" ||
        input.username.length > 100 ||
        input.password.length > 1024
      )
        return yield* new FoundryAuthError({ code: "invalid_access" });
      const password = input.password;
      const rows = yield* sql<{
        username: string;
        salt: string;
        password_hash: string;
        issuer: string;
        subject: string;
      }>`SELECT n.username,n.salt,n.password_hash,o.issuer,o.subject FROM foundry_instance.native_operator n JOIN foundry_instance.operator_binding o USING(operator_id)`;
      const row = rows[0];
      const hash = yield* Effect.tryPromise({
        try: () => passwordHash(password, row?.salt ?? "unconfigured-foundry-operator"),
        catch: () => new FoundryAuthError({ code: "unavailable" }),
      });
      if (
        !row ||
        row.username !== input.username ||
        !NodeCrypto.timingSafeEqual(hash, Buffer.from(row.password_hash, "hex"))
      )
        return yield* new FoundryAuthError({ code: "invalid_access" });
      return { issuer: row.issuer, subject: row.subject, expiresAt: now + 15 * 60_000 };
    },
    Effect.catchTags({ SqlError: unavailable }),
  );
  return NativeOperator.of({ bootstrap, verify });
});
export const layer = Layer.effect(NativeOperator, make);
