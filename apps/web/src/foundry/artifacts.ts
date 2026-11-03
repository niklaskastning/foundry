import { FoundryArtifacts, FoundryOnboarding } from "@t3tools/client-runtime/connection";
import {
  FoundryArtifactManifest,
  FoundryArtifactError,
  type AssetCreateUrlResult,
  type FoundryArtifactList,
} from "@t3tools/contracts";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import { artifactPreviewMime } from "@t3tools/shared/foundryArtifacts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { appAtomRuntime } from "../lib/runtime";
import { layerFoundryInstanceSession } from "./instanceSession";
import { initialState } from "./onboarding";

const decodeKey = Schema.decodeUnknownSync(
  Schema.Tuple([Schema.NullOr(FoundryOnboarding.InstanceBinding), FoundryArtifactManifest]),
);
const urlFamily = Atom.family((key: string) => {
  const [binding, manifest] = decodeKey(JSON.parse(key));
  return appAtomRuntime
    .atom(
      Effect.gen(function* () {
        if (!binding) return yield* new FoundryArtifactError({ code: "forbidden" });
        const client = yield* FoundryArtifacts.make();
        const result = yield* client.download(binding, manifest);
        const url = yield* Effect.acquireRelease(
          Effect.sync(() =>
            URL.createObjectURL(
              new Blob([result.bytes], { type: artifactPreviewMime(result.bytes) }),
            ),
          ),
          (value) => Effect.sync(() => URL.revokeObjectURL(value)),
        );
        return {
          relativeUrl: url,
          expiresAt: Number.MAX_SAFE_INTEGER,
        } satisfies AssetCreateUrlResult;
      }).pipe(Effect.provide(layerFoundryInstanceSession)),
    )
    .pipe(Atom.setIdleTTL(0));
});

export function artifactUrl(manifest: FoundryArtifactManifest) {
  return urlFamily(JSON.stringify([initialState().binding, manifest]));
}

export const artifactListCommand = createRuntimeCommand(appAtomRuntime, {
  label: "foundry:files:list",
  concurrency: { mode: "serial", key: () => "foundry-files" },
  execute: Effect.fn("FoundryFiles.list")(function* (input: FoundryArtifactList) {
    const binding = initialState().binding;
    if (!binding) return yield* new FoundryArtifactError({ code: "forbidden" });
    const client = yield* FoundryArtifacts.make();
    return yield* client.list(binding, input);
  }, Effect.provide(layerFoundryInstanceSession)),
});
