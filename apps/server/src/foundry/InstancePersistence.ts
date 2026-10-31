import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as InstanceDatabase from "./InstanceDatabase.ts";
import * as InstanceIdentityStore from "./InstanceIdentityStore.ts";
import * as InstancePostgres from "./InstancePostgres.ts";

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const store = yield* Config.Literals(["file", "postgres"], "FOUNDRY_INSTANCE_STORE").pipe(
      Config.withDefault("file"),
    );
    if (store === "file") return InstanceIdentityStore.layerFile;
    const url = yield* Config.Redacted("FOUNDRY_INSTANCE_DATABASE_URL");
    return InstancePostgres.layerIdentity.pipe(
      Layer.provide(InstancePostgres.layer),
      Layer.provide(ServerEnvironment.layerIdentity),
      Layer.provide(InstanceDatabase.layer({ url })),
    );
  }),
);
