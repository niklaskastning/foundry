import {
  AutomationMachineCredential,
  AutomationMachineCredentialError,
  AutomationMachineCredentialIssue,
  type FoundryInstanceId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { base64UrlEncode } from "../auth/utils.ts";
import * as InstanceDatabase from "./InstanceDatabase.ts";
import * as InstancePostgres from "./InstancePostgres.ts";

export const machineBearerToken = (authorization: string | undefined) =>
  /^Bearer\s+(fmc_.*)$/i.exec(authorization ?? "")?.[1];

type Owner = { readonly instanceId: FoundryInstanceId; readonly operatorId: string };
const decodeIssue = Schema.decodeUnknownEffect(AutomationMachineCredentialIssue, {
  onExcessProperty: "error",
});
const decodeId = Schema.decodeUnknownEffect(AutomationMachineCredentialIssue.fields.id);
const decodeCredentials = Schema.decodeUnknownEffect(Schema.Array(AutomationMachineCredential));
const isToken = Schema.is(Schema.String.check(Schema.isPattern(/^fmc_[A-Za-z0-9_-]{43}$/)));
const forbidden = () => new AutomationMachineCredentialError({ code: "forbidden" });
const conflict = () => new AutomationMachineCredentialError({ code: "conflict" });
const invalid = () => new AutomationMachineCredentialError({ code: "invalid_input" });

export class MachineCredentials extends Context.Service<
  MachineCredentials,
  {
    readonly issue: (
      owner: Owner,
      input: AutomationMachineCredentialIssue,
    ) => Effect.Effect<
      { credential: AutomationMachineCredential; token: string | null },
      AutomationMachineCredentialError
    >;
    readonly list: (
      owner: Owner,
    ) => Effect.Effect<
      ReadonlyArray<AutomationMachineCredential>,
      AutomationMachineCredentialError
    >;
    readonly revoke: (
      owner: Owner,
      id: string,
    ) => Effect.Effect<void, AutomationMachineCredentialError>;
    readonly authenticateId: (id: string) => Effect.Effect<
      Owner & {
        readonly factoryIds: ReadonlyArray<string>;
        readonly credentialId: string;
        readonly scope: AutomationMachineCredential["scope"];
      },
      AutomationMachineCredentialError
    >;
    readonly authenticate: (token: string) => Effect.Effect<
      Owner & {
        readonly factoryIds: ReadonlyArray<string>;
        readonly credentialId: string;
        readonly scope: AutomationMachineCredential["scope"];
      },
      AutomationMachineCredentialError
    >;
  }
>()("t3/foundry/MachineCredentials") {}

const make = Effect.gen(function* () {
  const sql = yield* InstanceDatabase.InstanceDatabase;
  const identity = yield* InstancePostgres.InstancePostgres;
  const crypto = yield* Crypto.Crypto;
  const unavailable = () =>
    Effect.fail(new AutomationMachineCredentialError({ code: "unavailable" }));
  const failures = {
    SqlError: unavailable,
    InstanceDatabaseError: unavailable,
    SchemaError: unavailable,
  };
  const hash = Effect.fn("MachineCredentials.hash")(function* (token: string) {
    return base64UrlEncode(
      yield* crypto.digest("SHA-256", new TextEncoder().encode(token)).pipe(Effect.orDie),
    );
  });
  const checkOwner = Effect.fn("MachineCredentials.checkOwner")(function* (owner: Owner) {
    if ((yield* identity.readIdentity) !== owner.instanceId) return yield* forbidden();
    const rows =
      yield* sql`SELECT operator_id FROM foundry_instance.operator_binding WHERE operator_id=${owner.operatorId}`;
    if (!rows[0]) return yield* forbidden();
  });
  const columns = sql.literal(`c.id,c.label,c.factory_ids AS "factoryIds",
    c.scope AS scope,c.expires_at::double precision AS "expiresAt",
    (c.revoked OR c.instance_generation<>i.access_generation OR c.operator_generation<>o.access_generation) AS revoked`);
  const issue = Effect.fn("MachineCredentials.issue")(function* (
    owner: Owner,
    raw: AutomationMachineCredentialIssue,
  ) {
    const input = yield* decodeIssue(raw).pipe(Effect.mapError(invalid));
    yield* checkOwner(owner);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const generations = yield* sql<{
          instanceGeneration: string;
          operatorGeneration: string;
        }>`SELECT i.access_generation::text AS "instanceGeneration",o.access_generation::text AS "operatorGeneration"
            FROM foundry_instance.instance i JOIN foundry_instance.operator_binding o USING(singleton)
            WHERE i.instance_id=${owner.instanceId} AND o.operator_id=${owner.operatorId} FOR UPDATE OF i,o`;
        if (!generations[0]) return yield* forbidden();
        const previous = yield* sql`SELECT ${columns},
            c.instance_id=${owner.instanceId} AND c.operator_id=${owner.operatorId}
              AND c.label=${input.label} AND c.factory_ids=${sql.json(input.factoryIds)}::jsonb
              AND c.expires_at=${input.expiresAt} AND c.scope=${input.scope ?? "automation:read"} AS same
            FROM foundry_instance.machine_credentials c
            JOIN foundry_instance.instance i ON i.instance_id=c.instance_id
            JOIN foundry_instance.operator_binding o ON o.operator_id=c.operator_id
            WHERE c.id=${input.id}`;
        if (previous[0]) {
          if (!previous[0].same) return yield* conflict();
          return { credential: (yield* decodeCredentials(previous))[0]!, token: null };
        }
        const now = yield* Clock.currentTimeMillis;
        if (input.expiresAt <= now || input.expiresAt > now + 30 * 24 * 60 * 60 * 1000)
          return yield* invalid();
        const count = yield* sql<{ count: number }>`SELECT count(*)::int AS count
            FROM foundry_instance.machine_credentials WHERE instance_id=${owner.instanceId} AND operator_id=${owner.operatorId}
              AND NOT revoked AND expires_at>${now} AND instance_generation=${generations[0].instanceGeneration}::bigint
              AND operator_generation=${generations[0].operatorGeneration}::bigint`;
        if ((count[0]?.count ?? 100) >= 100) return yield* conflict();
        const token = `fmc_${base64UrlEncode(yield* crypto.randomBytes(32).pipe(Effect.orDie))}`;
        const digest = yield* hash(token);
        yield* sql`INSERT INTO foundry_instance.machine_credentials
            (id,token_hash,instance_id,operator_id,instance_generation,operator_generation,label,factory_ids,expires_at,scope)
            VALUES(${input.id},${digest},${owner.instanceId},${owner.operatorId},
              ${generations[0].instanceGeneration}::bigint,${generations[0].operatorGeneration}::bigint,
              ${input.label},${sql.json(input.factoryIds)},${input.expiresAt},${input.scope ?? "automation:read"})`;
        return {
          credential: {
            id: input.id,
            label: input.label,
            factoryIds: input.factoryIds,
            scope: input.scope ?? ("automation:read" as const),
            expiresAt: input.expiresAt,
            revoked: false,
          },
          token,
        };
      }),
    );
  }, Effect.catchTags(failures));
  const list = Effect.fn("MachineCredentials.list")(function* (owner: Owner) {
    yield* checkOwner(owner);
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* sql`SELECT ${columns} FROM foundry_instance.machine_credentials c
        JOIN foundry_instance.instance i ON i.instance_id=c.instance_id
        JOIN foundry_instance.operator_binding o ON o.operator_id=c.operator_id
        WHERE c.instance_id=${owner.instanceId} AND c.operator_id=${owner.operatorId} ORDER BY (NOT c.revoked AND c.expires_at>${now}
          AND c.instance_generation=i.access_generation AND c.operator_generation=o.access_generation) DESC,
          c.expires_at DESC,c.id LIMIT 100`;
    return yield* decodeCredentials(rows);
  }, Effect.catchTags(failures));
  const revoke = Effect.fn("MachineCredentials.revoke")(
    function* (owner: Owner, raw: string) {
      const id = yield* decodeId(raw).pipe(Effect.mapError(invalid));
      yield* checkOwner(owner);
      const rows = yield* sql`UPDATE foundry_instance.machine_credentials SET revoked=true
        WHERE id=${id} AND instance_id=${owner.instanceId} AND operator_id=${owner.operatorId} RETURNING id`;
      if (!rows[0]) return yield* forbidden();
    },
    Effect.catchTags({ SqlError: unavailable, InstanceDatabaseError: unavailable }),
  );
  const authenticateId = Effect.fn("MachineCredentials.authenticateId")(function* (id: string) {
    const instanceId = yield* identity.readIdentity;
    const now = yield* Clock.currentTimeMillis;
    const rows =
      yield* sql`SELECT ${columns},c.operator_id AS "operatorId" FROM foundry_instance.machine_credentials c JOIN foundry_instance.instance i ON i.instance_id=c.instance_id AND i.access_generation=c.instance_generation JOIN foundry_instance.operator_binding o ON o.operator_id=c.operator_id AND o.access_generation=c.operator_generation WHERE c.id=${id} AND c.instance_id=${instanceId} AND NOT c.revoked AND c.expires_at>${now}`;
    if (!rows[0]) return yield* forbidden();
    const credential = (yield* decodeCredentials(rows))[0]!;
    return {
      instanceId,
      operatorId: String(rows[0].operatorId),
      factoryIds: credential.factoryIds,
      credentialId: credential.id,
      scope: credential.scope,
    };
  }, Effect.catchTags(failures));
  const authenticate = Effect.fn("MachineCredentials.authenticate")(function* (token: string) {
    if (!isToken(token)) return yield* forbidden();
    const instanceId = yield* identity.readIdentity;
    const digest = yield* hash(token);
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* sql`SELECT ${columns},c.operator_id AS "operatorId"
        FROM foundry_instance.machine_credentials c
        JOIN foundry_instance.instance i ON i.instance_id=c.instance_id AND i.access_generation=c.instance_generation
        JOIN foundry_instance.operator_binding o ON o.operator_id=c.operator_id AND o.access_generation=c.operator_generation
        WHERE c.token_hash=${digest} AND c.instance_id=${instanceId} AND NOT c.revoked AND c.expires_at>${now}`;
    if (!rows[0]) return yield* forbidden();
    const credential = (yield* decodeCredentials(rows))[0]!;
    return {
      instanceId,
      operatorId: String(rows[0].operatorId),
      factoryIds: credential.factoryIds,
      credentialId: credential.id,
      scope: credential.scope,
    };
  }, Effect.catchTags(failures));
  return MachineCredentials.of({ issue, list, revoke, authenticate, authenticateId });
});

export const layer = Layer.effect(MachineCredentials, make);
