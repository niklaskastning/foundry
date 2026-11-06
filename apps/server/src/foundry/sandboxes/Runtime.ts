import { FoundrySandboxProfile, FoundryDeviceId, FoundrySandboxError } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Allocations from "./Allocations.ts";
import * as MachineAccess from "./MachineAccess.ts";
import * as SandboxArchive from "../SandboxArchive.ts";
import * as Http from "./Http.ts";
import * as InstanceDatabase from "../InstanceDatabase.ts";

const Configuration = Schema.Struct({
  supervisorDeviceId: FoundryDeviceId,
  maxAllocations: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
  maxCpuMillis: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 64000 })),
  maxMemoryMiB: Schema.Int.check(Schema.isBetween({ minimum: 128, maximum: 262144 })),
  allowedRepositories: Schema.Array(Schema.String).check(Schema.isMaxLength(32)),
  allowedImages: Schema.Array(Schema.String).check(Schema.isMaxLength(32)),
  profiles: Schema.Array(FoundrySandboxProfile).check(Schema.isMaxLength(32)),
});
const decodeConfiguration = Schema.decodeEffect(Schema.fromJsonString(Configuration));
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const enabled = yield* Config.Boolean("FOUNDRY_SANDBOXES_ENABLED").pipe(
      Config.withDefault(false),
    );
    if (!enabled) return Layer.empty;
    const file = yield* Config.String("FOUNDRY_SANDBOX_CONFIGURATION_FILE");
    const fs = yield* FileSystem.FileSystem;
    if ((yield* fs.stat(file)).size > 262144n)
      return yield* new FoundrySandboxError({ code: "invalid_request" });
    const config = yield* decodeConfiguration(yield* fs.readFileString(file));
    const allocationLayer = Allocations.layer.pipe(
      Layer.provide(Layer.succeed(Allocations.SandboxPolicy, config)),
    );
    const initialize = Layer.effectDiscard(
      Effect.gen(function* () {
        const sql = yield* InstanceDatabase.InstanceDatabase;
        const allocations = yield* Allocations.Allocations;
        const operators = yield* sql<{
          operator_id: string;
        }>`SELECT operator_id FROM foundry_instance.operator_binding`;
        if (!operators[0]) return yield* new FoundrySandboxError({ code: "forbidden" });
        yield* Effect.forEach(config.profiles, (profile) =>
          allocations.publishProfile(operators[0]!.operator_id, profile),
        );
      }),
    );
    return Layer.mergeAll(
      Http.layer,
      initialize,
      MachineAccess.layer.pipe(Layer.provide(SandboxArchive.layerConfirmation)),
    ).pipe(
      Layer.provideMerge(allocationLayer),
      Layer.provideMerge(Layer.succeed(Allocations.SandboxPolicy, config)),
    );
  }),
);
