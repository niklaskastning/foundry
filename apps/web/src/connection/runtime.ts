import { Connection, ConnectionBlockedError } from "@t3tools/client-runtime/connection";
import { ShellSnapshotLoader } from "@t3tools/client-runtime/state/shell";
import {
  BoundedThreadSnapshotLoader,
  ThreadHistoryController,
} from "@t3tools/client-runtime/state/threads";
import { PullRequestDiffLoader } from "@t3tools/client-runtime/state/pull-requests";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Atom } from "effect/reactivity";

import { verifySavedInstance } from "../foundry/onboarding";
import { isGuestPage } from "../guestPage";

import * as Runtime from "../lib/runtime";
import * as BackgroundActivityReporter from "../lib/backgroundActivityReporter";
import * as ConnectionPlatform from "./platform";

const layerProvidedConnectionPlatform = ConnectionPlatform.layer.pipe(Layer.provide(Runtime.layer));

const layerSnapshotLoader = Layer.mergeAll(
  BoundedThreadSnapshotLoader.layer,
  ShellSnapshotLoader.layer,
  ThreadHistoryController.layer,
  PullRequestDiffLoader.layer,
);

type ConnectionLayerSource =
  | typeof Connection.layer
  | typeof layerSnapshotLoader
  | typeof Runtime.layer
  | typeof ConnectionPlatform.layer
  | typeof BackgroundActivityReporter.layerObserver
  | typeof BackgroundActivityReporter.layer;

const layerProvidedClientConnection = layerSnapshotLoader.pipe(
  Layer.provideMerge(
    Connection.layerWithOptions({
      environmentThemes: true,
      usageLimitSources: true,
      usageLimitsCommand: true,
    }),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      Runtime.layer,
      layerProvidedConnectionPlatform,
      BackgroundActivityReporter.layerObserver,
    ),
  ),
);

const layerConnection = BackgroundActivityReporter.layer.pipe(
  Layer.provideMerge(layerProvidedClientConnection),
);

// Guest viewing and Foundry sign-in must not open the origin or saved T3 environments.
const layerForPage = Layer.unwrap(
  Effect.suspend(() =>
    isGuestPage() || window.location.pathname === "/foundry"
      ? Effect.die(new Error("This standalone page has no environment connection."))
      : Effect.tryPromise({
          try: verifySavedInstance,
          catch: () =>
            new ConnectionBlockedError({
              reason: "configuration",
              detail:
                "Saved Foundry identity could not be verified. Open /foundry to inspect the binding.",
            }),
        }).pipe(Effect.as(layerConnection)),
  ),
);

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = Atom.runtime(layerForPage);
