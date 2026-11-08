import * as Config from "effect/Config";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as ParentSessionAuthority from "../auth/ParentSessionAuthority.ts";
import * as AccessConfig from "./AccessConfig.ts";
import * as InstanceDatabase from "./InstanceDatabase.ts";

export const layerAuthority = Layer.effect(
  ParentSessionAuthority.ParentSessionAuthority,
  Effect.gen(function* () {
    const sql = yield* InstanceDatabase.InstanceDatabase;
    const config = yield* AccessConfig.AccessConfig;
    const validate = Effect.fn("MainSessionAuthority.validate")(
      function* (subject: string) {
        if (!subject.startsWith("foundry:")) return true;
        const hash = subject.slice(8);
        if (!/^[A-Za-z0-9_-]{43}$/.test(hash)) return false;
        const now = yield* Clock.currentTimeMillis;
        const rows = yield* sql`SELECT 1 FROM foundry_instance.sessions s
        JOIN foundry_instance.instance i ON i.instance_id=s.instance_id AND i.access_generation=s.instance_generation
        JOIN foundry_instance.operator_binding o ON o.operator_id=s.operator_id AND o.access_generation=s.operator_generation
        WHERE s.token_hash=${hash} AND s.expires_at>${now} AND s.audience=${config.audience}
        AND (${config.mode === "native"} OR o.issuer=${config.issuer})`;
        return rows.length === 1;
      },
      Effect.orElseSucceed(() => false),
    );
    return {
      validate,
      // Generations can also change through the local operator CLI outside this process.
      awaitInvalidation: Effect.fn("MainSessionAuthority.awaitInvalidation")((subject: string) =>
        subject.startsWith("foundry:")
          ? validate(subject).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("1 second"),
                until: (valid) => !valid,
              }),
              Effect.asVoid,
            )
          : Effect.never,
      ),
    };
  }),
);

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const enabled = yield* Config.Boolean("FOUNDRY_ACCESS_ENABLED").pipe(Config.withDefault(false));
    if (!enabled) return Layer.empty;
    const url = yield* Config.Redacted("FOUNDRY_INSTANCE_DATABASE_URL");
    return layerAuthority.pipe(
      Layer.provide(AccessConfig.layer),
      Layer.provide(InstanceDatabase.layer({ url })),
    );
  }),
);
