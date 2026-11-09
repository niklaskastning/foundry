import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export class ParentSessionAuthority extends Context.Reference<{
  readonly validate: (subject: string) => Effect.Effect<boolean>;
  readonly awaitInvalidation: (subject: string) => Effect.Effect<void>;
}>("t3/auth/ParentSessionAuthority", {
  defaultValue: () => ({
    validate: (subject) => Effect.succeed(!subject.startsWith("foundry:")),
    awaitInvalidation: () => Effect.never,
  }),
}) {}
