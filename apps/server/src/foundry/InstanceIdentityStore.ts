import { FoundryInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";

export class InstanceIdentityError extends Schema.TaggedError<InstanceIdentityError>()(
  "InstanceIdentityError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Foundry instance identity could not be loaded. Check the configured identity store and readiness before retrying.";
  }
}

export class InstanceIdentityStore extends Context.Service<
  InstanceIdentityStore,
  {
    readonly getOrCreate: Effect.Effect<FoundryInstanceId, InstanceIdentityError>;
  }
>()("t3/foundry/InstanceIdentityStore") {}

const decodeInstanceId = Schema.decodeUnknownEffect(FoundryInstanceId);

const makeFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const identityPath = path.join(config.stateDir, "foundry-instance-id");
  const getOrCreate = Effect.fn("InstanceIdentityStore.getOrCreate")(
    function* () {
      if (!(yield* fs.exists(identityPath))) {
        const temporary = yield* fs.makeTempFileScoped({
          directory: config.stateDir,
          prefix: ".foundry-instance-",
        });
        const id = yield* crypto.randomUUIDv4();
        yield* fs.writeFileString(temporary, `${id}\n`);
        // Publish only a complete file, without replacing another initializer's winner.
        yield* fs.link(temporary, identityPath).pipe(
          Effect.catchIf(
            (error) => error.reason._tag === "AlreadyExists",
            () => Effect.void,
          ),
        );
      }
      const raw = yield* fs.readFileString(identityPath);
      // Invalid existing identities fail closed; regenerating would break future registry bindings.
      return yield* decodeInstanceId(raw.trim());
    },
    Effect.scoped,
    Effect.mapError((cause) => new InstanceIdentityError({ cause })),
  );
  return InstanceIdentityStore.of({ getOrCreate: getOrCreate() });
});

export const layerFile = Layer.effect(InstanceIdentityStore, makeFile);
