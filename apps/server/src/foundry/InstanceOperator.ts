import { FoundryAuthError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as InstanceDatabase from "./InstanceDatabase.ts";
import * as InstancePostgres from "./InstancePostgres.ts";

export class InstanceOperator extends Context.Service<
  InstanceOperator,
  {
    readonly bind: (issuer: string, subject: string) => Effect.Effect<void, FoundryAuthError>;
  }
>()("t3/foundry/InstanceOperator") {}
const make = Effect.gen(function* () {
  const sql = yield* InstanceDatabase.InstanceDatabase;
  const identity = yield* InstancePostgres.InstancePostgres;
  const crypto = yield* Crypto.Crypto;
  const bind = Effect.fn("InstanceOperator.bind")(
    function* (issuer: string, subject: string) {
      if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) || !subject.trim())
        return yield* new FoundryAuthError({ code: "operator_mismatch" });
      yield* identity.readIdentity;
      const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO foundry_instance.operator_binding (operator_id, issuer, subject) VALUES (${id}, ${issuer}, ${subject}) ON CONFLICT (singleton) DO NOTHING`;
          const rows = yield* sql<{
            issuer: string;
            subject: string;
          }>`SELECT issuer, subject FROM foundry_instance.operator_binding FOR UPDATE`;
          if (rows[0]?.issuer !== issuer || rows[0]?.subject !== subject)
            return yield* new FoundryAuthError({ code: "operator_mismatch" });
        }),
      );
    },
    Effect.catchTags({
      InstanceDatabaseError: () => Effect.fail(new FoundryAuthError({ code: "unavailable" })),
      SqlError: () => Effect.fail(new FoundryAuthError({ code: "unavailable" })),
    }),
  );
  return InstanceOperator.of({ bind });
});
export const layer = Layer.effect(InstanceOperator, make);
