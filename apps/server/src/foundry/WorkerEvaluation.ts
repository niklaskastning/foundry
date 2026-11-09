import {
  EvaluationInput,
  EvaluationJudgment,
  FoundryWorkerError,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";

const decodeInput = Schema.decodeEffect(EvaluationInput);
const encodeInput = Schema.encodeEffect(Schema.fromJsonString(EvaluationInput));
const encodeJudgment = Schema.encodeEffect(Schema.fromJsonString(EvaluationJudgment));

export class WorkerEvaluation extends Context.Service<
  WorkerEvaluation,
  {
    readonly evaluate: (
      input: EvaluationInput,
    ) => Effect.Effect<EvaluationJudgment, FoundryWorkerError>;
  }
>()("t3/foundry/WorkerEvaluation") {}
export const layer = Layer.effect(
  WorkerEvaluation,
  Effect.gen(function* () {
    const enabled = yield* Config.Boolean("FOUNDRY_WORKER_ENABLED").pipe(Config.withDefault(false));
    const binding = yield* Config.String("FOUNDRY_WORKER_PROVIDER_INSTANCE_ID").pipe(
      Config.withDefault(""),
    );
    const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const config = yield* ServerConfig.ServerConfig;
    return WorkerEvaluation.of({
      evaluate: Effect.fn("WorkerEvaluation.evaluate")(
        function* (raw) {
          if (!enabled || !binding) return yield* new FoundryWorkerError({ code: "not_enabled" });
          const input = yield* decodeInput(raw);
          if (new TextEncoder().encode(yield* encodeInput(input)).length > 200_000)
            return yield* new FoundryWorkerError({ code: "probe_failed" });
          const instance = yield* registry.getInstance(ProviderInstanceId.make(binding));
          if (!instance?.enabled || instance.driverKind !== "codex" || !instance.generateEvaluation)
            return yield* new FoundryWorkerError({ code: "probe_failed" });
          const judgment = yield* instance.generateEvaluation({
            cwd: config.stateDir,
            evaluation: input,
          });
          if (new TextEncoder().encode(yield* encodeJudgment(judgment)).length > 200_000)
            return yield* new FoundryWorkerError({ code: "probe_failed" });
          return judgment;
        },
        Effect.mapError(() => new FoundryWorkerError({ code: "probe_failed" })),
      ),
    });
  }),
);
