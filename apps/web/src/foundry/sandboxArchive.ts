import { FoundryArtifacts } from "@t3tools/client-runtime/connection";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import {
  FoundryArtifactError,
  FoundrySandboxSetupIndex,
  type FoundryArtifactManifest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { appAtomRuntime } from "../lib/runtime";
import { layerFoundryInstanceSession } from "./instanceSession";
import { initialState } from "./onboarding";

const decodeIndex = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Union([
      FoundrySandboxSetupIndex,
      Schema.Struct({ format: Schema.Literal("foundry-setup-snapshot-1") }),
    ]),
  ),
);

export const sandboxSetupArchiveCommand = createRuntimeCommand(appAtomRuntime, {
  label: "foundry:sandbox:setup-archive",
  execute: Effect.fn("FoundrySandboxSetupArchive.read")(function* (
    manifest: FoundryArtifactManifest,
  ) {
    const binding = initialState().binding;
    if (!binding) return yield* new FoundryArtifactError({ code: "forbidden" });
    const client = yield* FoundryArtifacts.make({ allowLoopback: import.meta.env.DEV });
    const downloaded = yield* client.download(binding, manifest);
    const index = yield* decodeIndex(new TextDecoder().decode(downloaded.bytes)).pipe(
      Effect.mapError(() => new FoundryArtifactError({ code: "changed" })),
    );
    const parts = index.format === "foundry-setup-snapshot-2" ? index.parts : [manifest];
    if (
      parts.some(
        (part) =>
          part.reference.instanceId !== manifest.reference.instanceId ||
          part.reference.owner.environmentId !== manifest.reference.owner.environmentId ||
          part.reference.owner.threadId !== manifest.reference.owner.threadId,
      )
    )
      return yield* new FoundryArtifactError({ code: "changed" });
    return { format: index.format, parts };
  }, Effect.provide(layerFoundryInstanceSession)),
});
