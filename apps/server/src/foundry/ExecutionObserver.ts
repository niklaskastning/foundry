import { ThreadId, ProviderThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export class ExecutionObserver extends Context.Reference<{
  readonly starting: (input: {
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
    readonly runOrdinal: number;
  }) => Effect.Effect<boolean>;
}>("t3/foundry/ExecutionObserver", {
  defaultValue: () => ({ starting: () => Effect.succeed(true) }),
}) {}
