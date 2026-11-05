import * as Schema from "effect/Schema";

export const FactoryAgentExecution = Schema.Struct({
  provider: Schema.optional(Schema.Literal("codex")),
  model: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  options: Schema.optional(
    Schema.Struct({
      reasoningEffort: Schema.optional(
        Schema.Literals(["minimal", "low", "medium", "high", "xhigh"]),
      ),
    }),
  ),
});
