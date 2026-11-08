import type { FoundryArchiveError, FoundryArchiveRequest, FoundryDevice } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export class ArchiveTransport extends Context.Reference<
  | {
      readonly device: FoundryDevice;
      readonly send: (
        request: FoundryArchiveRequest,
      ) => Effect.Effect<unknown, FoundryArchiveError>;
    }
  | undefined
>("t3/foundry/ArchiveTransport", { defaultValue: () => undefined }) {}
