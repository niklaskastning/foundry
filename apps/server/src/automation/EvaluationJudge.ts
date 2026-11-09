import { type EvaluationInput, type EvaluationJudgment } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as WorkerTransport from "./WorkerTransport.ts";

export class EvaluationJudgeError extends Schema.TaggedError<EvaluationJudgeError>()(
  "EvaluationJudgeError",
  { reason: Schema.Literals(["invalid_judgment", "judge_unavailable"]) },
) {}
export class EvaluationJudge extends Context.Service<
  EvaluationJudge,
  {
    readonly judge: (
      input: EvaluationInput,
      authority?: WorkerTransport.WorkerIdentity,
    ) => Effect.Effect<EvaluationJudgment, EvaluationJudgeError>;
  }
>()("t3/automation/EvaluationJudge") {}

export const layer = Layer.effect(
  EvaluationJudge,
  Effect.gen(function* () {
    const worker = yield* WorkerTransport.WorkerTransport;
    return EvaluationJudge.of({
      judge: Effect.fn("EvaluationJudge.judge")(
        function* (input, authority) {
          if (!authority) return yield* new EvaluationJudgeError({ reason: "judge_unavailable" });
          return yield* worker.evaluate(authority, input);
        },
        Effect.mapError(() => new EvaluationJudgeError({ reason: "judge_unavailable" })),
      ),
    });
  }),
);
