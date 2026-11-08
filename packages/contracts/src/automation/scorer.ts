import * as Schema from "effect/Schema";

const Id = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/));
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000));
const Unit = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
export const FactoryV4Scorer = Schema.Struct({
  id: Id,
  name: Text,
  criteria: Schema.Array(Schema.Struct({
    id: Id,
    instructions: Text,
    threshold: Unit,
  })).check(Schema.isMinLength(1), Schema.isMaxLength(100), Schema.makeFilter(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
  )),
  judge: Schema.Struct({
    provider: Schema.Literal("codex"),
    model: Schema.Literal("gpt-6.1-sol"),
    reasoningEffort: Schema.Literal("medium"),
  }),
  sampling: Schema.Struct({
    rate: Unit,
    automatic: Schema.Boolean,
  }),
});
export type FactoryV4Scorer = typeof FactoryV4Scorer.Type;
