import { FoundryAuthError, type FoundrySession } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { base64UrlEncode, signPayload, timingSafeEqualBase64Url } from "../auth/utils.ts";
import * as AccessConfig from "./AccessConfig.ts";
import * as AccessVerifier from "./AccessVerifier.ts";
import * as InstanceDatabase from "./InstanceDatabase.ts";
import * as InstancePostgres from "./InstancePostgres.ts";

const isToken = Schema.is(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)));
const csrfFor = (token: string) => signPayload("foundry-csrf-v1", new TextEncoder().encode(token));
export const FOUNDRY_SESSION_COOKIE = "__Host-foundry_session";
export class FoundrySessions extends Context.Service<
  FoundrySessions,
  {
    readonly login: (
      assertion: string | undefined,
      previousToken?: string,
    ) => Effect.Effect<
      { readonly token: string; readonly session: FoundrySession },
      FoundryAuthError
    >;
    readonly inspect: (
      token: string | undefined,
    ) => Effect.Effect<FoundrySession, FoundryAuthError>;
    readonly refresh: (
      token: string | undefined,
      csrf: string | undefined,
      assertion: string | undefined,
    ) => Effect.Effect<
      { readonly token: string; readonly session: FoundrySession },
      FoundryAuthError
    >;
    readonly logout: (
      token: string | undefined,
      csrf: string | undefined,
    ) => Effect.Effect<void, FoundryAuthError>;
    readonly checkOrigin: (
      origin: string | undefined,
      contentType: string | undefined,
    ) => Effect.Effect<void, FoundryAuthError>;
  }
>()("t3/foundry/FoundrySessions") {}

const make = Effect.gen(function* () {
  const sql = yield* InstanceDatabase.InstanceDatabase;
  const identity = yield* InstancePostgres.InstancePostgres;
  const access = yield* AccessVerifier.AccessVerifier;
  const config = yield* AccessConfig.AccessConfig;
  const crypto = yield* Crypto.Crypto;
  const hash = Effect.fn("FoundrySessions.hash")(function* (token: string) {
    return base64UrlEncode(
      yield* crypto.digest("SHA-256", new TextEncoder().encode(token)).pipe(Effect.orDie),
    );
  });
  const requireToken = Effect.fn("FoundrySessions.requireToken")(function* (
    token: string | undefined,
  ) {
    if (!isToken(token)) return yield* new FoundryAuthError({ code: "invalid_session" });
    return token;
  });
  const checkCsrf = Effect.fn("FoundrySessions.checkCsrf")(function* (
    token: string | undefined,
    csrf: string | undefined,
  ) {
    const value = yield* requireToken(token);
    if (!isToken(csrf) || !timingSafeEqualBase64Url(csrf, csrfFor(value)))
      return yield* new FoundryAuthError({ code: "csrf_invalid" });
    return value;
  });
  const inspect = Effect.fn("FoundrySessions.inspect")(
    function* (token: string | undefined) {
      const value = yield* requireToken(token);
      const instanceId = yield* identity.readIdentity;
      const now = yield* Clock.currentTimeMillis;
      const digest = yield* hash(value);
      const rows = yield* sql<{
        operator_id: string;
        expires_at: string;
      }>`SELECT s.operator_id, s.expires_at::text FROM foundry_instance.sessions s
      JOIN foundry_instance.instance i ON i.instance_id = s.instance_id AND i.access_generation = s.instance_generation
      JOIN foundry_instance.operator_binding o ON o.operator_id = s.operator_id AND o.access_generation = s.operator_generation
      WHERE s.token_hash = ${digest} AND s.expires_at > ${now} AND s.instance_id = ${instanceId}
        AND o.issuer = ${config.issuer} AND s.audience = ${config.audience}`;
      if (!rows[0]) return yield* new FoundryAuthError({ code: "invalid_session" });
      return {
        instanceId,
        operatorId: rows[0].operator_id,
        expiresAt: Number(rows[0].expires_at),
        csrfToken: csrfFor(value),
      } satisfies FoundrySession;
    },
    Effect.catchTags({
      InstanceDatabaseError: () => Effect.fail(new FoundryAuthError({ code: "unavailable" })),
      SqlError: () => Effect.fail(new FoundryAuthError({ code: "unavailable" })),
    }),
  );

  const issue = Effect.fn("FoundrySessions.issue")(
    function* (
      assertion: string | undefined,
      previousToken: string | undefined,
      renewing: boolean,
    ) {
      const proof = yield* access.verify(assertion);
      const instanceId = yield* identity.readIdentity;
      const token = base64UrlEncode(yield* crypto.randomBytes(32).pipe(Effect.orDie));
      const digest = yield* hash(token);
      const previousHash = isToken(previousToken) ? yield* hash(previousToken) : undefined;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const expiresAt = Math.min(now + 15 * 60 * 1000, proof.expiresAt);
          if (expiresAt <= now) return yield* new FoundryAuthError({ code: "invalid_access" });
          const operators = yield* sql<{
            operator_id: string;
            issuer: string;
            subject: string;
            instance_generation: string;
            operator_generation: string;
          }>`SELECT o.operator_id, o.issuer, o.subject, i.access_generation::text AS instance_generation, o.access_generation::text AS operator_generation
        FROM foundry_instance.operator_binding o JOIN foundry_instance.instance i USING (singleton)
        WHERE i.instance_id = ${instanceId} FOR SHARE OF i, o`;
          const operator = operators[0];
          if (!operator) return yield* new FoundryAuthError({ code: "operator_unbound" });
          if (operator.issuer !== proof.issuer || operator.subject !== proof.subject)
            return yield* new FoundryAuthError({ code: "operator_mismatch" });
          if (renewing) {
            const old =
              yield* sql`DELETE FROM foundry_instance.sessions WHERE token_hash = ${previousHash}
          AND instance_id = ${instanceId} AND operator_id = ${operator.operator_id} AND expires_at > ${now}
          AND instance_generation = ${operator.instance_generation}::bigint AND operator_generation = ${operator.operator_generation}::bigint
          AND audience = ${config.audience} RETURNING token_hash`;
            if (old.length !== 1) return yield* new FoundryAuthError({ code: "invalid_session" });
          } else if (previousHash) {
            yield* sql`DELETE FROM foundry_instance.sessions WHERE token_hash = ${previousHash}`;
          }
          yield* sql`DELETE FROM foundry_instance.sessions WHERE expires_at <= ${now}`;
          yield* sql`INSERT INTO foundry_instance.sessions (token_hash, instance_id, operator_id, instance_generation, operator_generation, audience, expires_at)
        VALUES (${digest}, ${instanceId}, ${operator.operator_id}, ${operator.instance_generation}::bigint, ${operator.operator_generation}::bigint, ${config.audience}, ${expiresAt})`;
          return {
            token,
            session: {
              instanceId,
              operatorId: operator.operator_id,
              expiresAt,
              csrfToken: csrfFor(token),
            } satisfies FoundrySession,
          };
        }),
      );
    },
    Effect.catchTags({
      InstanceDatabaseError: () => Effect.fail(new FoundryAuthError({ code: "unavailable" })),
      SqlError: () => Effect.fail(new FoundryAuthError({ code: "unavailable" })),
    }),
  );

  const login = Effect.fn("FoundrySessions.login")(
    (assertion: string | undefined, previousToken?: string) =>
      issue(assertion, previousToken, false),
  );
  const refresh = Effect.fn("FoundrySessions.refresh")(function* (
    token: string | undefined,
    csrf: string | undefined,
    assertion: string | undefined,
  ) {
    const value = yield* checkCsrf(token, csrf);
    return yield* issue(assertion, value, true);
  });
  const logout = Effect.fn("FoundrySessions.logout")(
    function* (token: string | undefined, csrf: string | undefined) {
      const value = yield* checkCsrf(token, csrf);
      yield* identity.readIdentity;
      const digest = yield* hash(value);
      yield* sql`DELETE FROM foundry_instance.sessions WHERE token_hash = ${digest}`;
    },
    Effect.catchTags({
      InstanceDatabaseError: () => Effect.fail(new FoundryAuthError({ code: "unavailable" })),
      SqlError: () => Effect.fail(new FoundryAuthError({ code: "unavailable" })),
    }),
  );
  const checkOrigin = Effect.fn("FoundrySessions.checkOrigin")(function* (
    origin: string | undefined,
    contentType: string | undefined,
  ) {
    if (
      origin !== config.origin ||
      contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
    ) {
      return yield* new FoundryAuthError({ code: "origin_forbidden" });
    }
  });
  return FoundrySessions.of({ login, inspect, refresh, logout, checkOrigin });
});
export const layer = Layer.effect(FoundrySessions, make);
