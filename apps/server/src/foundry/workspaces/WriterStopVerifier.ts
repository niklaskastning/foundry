import { FoundryWorkspaceError, type FoundryWorkspaceReservation } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// P16 must durably fence pending/future starts and prove all bound writers stopped.
// A run label, cancel acknowledgement, disconnection or expired lease is insufficient.
export class WriterStopVerifier extends Context.Service<
  WriterStopVerifier,
  {
    readonly confirmStopped: (
      reservation: FoundryWorkspaceReservation,
    ) => Effect.Effect<void, FoundryWorkspaceError>;
  }
>()("t3/foundry/workspaces/WriterStopVerifier") {}

export const layer = Layer.succeed(WriterStopVerifier, {
  confirmStopped: Effect.fn("WriterStopVerifier.confirmStopped")(() =>
    Effect.fail(new FoundryWorkspaceError({ code: "stop_unconfirmed" })),
  ),
});
