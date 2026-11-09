import { FoundryMain } from "@t3tools/client-runtime/connection";
import { FoundryArchive } from "@t3tools/client-runtime/connection";
import {
  FoundryArchiveError,
  type FoundryArchiveList,
  type FoundryArchiveRead,
} from "@t3tools/contracts";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { appAtomRuntime } from "../lib/runtime";
import { layerFoundryInstanceSession } from "./instanceSession";
import { initialState } from "./onboarding";

export const archiveListCommand = createRuntimeCommand(appAtomRuntime, {
  label: "foundry:archive:list",
  execute: Effect.fn("FoundryArchive.list")(function* (input: FoundryArchiveList) {
    const binding = initialState().binding;
    if (!binding) return yield* new FoundryArchiveError({ code: "forbidden" });
    const client = yield* FoundryArchive.make({ ...FoundryMain.nativeHttpPolicy });
    return yield* client.list(binding, input);
  }, Effect.provide(layerFoundryInstanceSession)),
});
export const archiveReadCommand = createRuntimeCommand(appAtomRuntime, {
  label: "foundry:archive:read",
  execute: Effect.fn("FoundryArchive.read")(function* (input: FoundryArchiveRead) {
    const binding = initialState().binding;
    if (!binding) return yield* new FoundryArchiveError({ code: "forbidden" });
    const client = yield* FoundryArchive.make({ ...FoundryMain.nativeHttpPolicy });
    return yield* client.read(binding, input);
  }, Effect.provide(layerFoundryInstanceSession)),
});
