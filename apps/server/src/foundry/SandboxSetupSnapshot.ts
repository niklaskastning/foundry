import { FOUNDRY_ARTIFACT_MAX_BYTES, FoundrySandboxArchiveError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Base64 from "effect/encoding/Base64";
import { artifactSha256 } from "@t3tools/shared/foundryArtifacts";

const Entry = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["file", "directory", "symlink"]),
  mode: Schema.Number,
  content: Schema.String,
});
const Snapshot = Schema.Struct({
  format: Schema.Literal("foundry-setup-snapshot-1"),
  entries: Schema.Array(Entry),
});
export class SandboxSetupSnapshot extends Context.Service<
  SandboxSetupSnapshot,
  {
    readonly capture: (input: {
      readonly cwd: string;
      readonly setupLog: string;
      readonly output: string;
    }) => Effect.Effect<
      { readonly sizeBytes: number; readonly sha256: string },
      FoundrySandboxArchiveError
    >;
  }
>()("t3/foundry/SandboxSetupSnapshot") {}

const isArchiveError = Schema.is(FoundrySandboxArchiveError);
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(Snapshot));

export const layer = Layer.effect(
  SandboxSetupSnapshot,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return SandboxSetupSnapshot.of({
      capture: Effect.fn("SandboxSetupSnapshot.capture")(
        function* (input) {
          const entries: Array<typeof Entry.Type> = [];
          let size = 0;
          const queue = [
            { physical: input.cwd, logical: "repo", depth: 0 },
            { physical: input.setupLog, logical: "setup.log", depth: 0 },
          ];
          while (queue.length > 0) {
            const item = queue.pop()!;
            if (entries.length + queue.length >= 10000 || item.depth > 64)
              return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
            const link = yield* fs.readLink(item.physical).pipe(Effect.option);
            if (Option.isSome(link)) {
              entries.push({ path: item.logical, kind: "symlink", mode: 0, content: link.value });
              continue;
            }
            if (!(yield* fs.exists(item.physical))) continue;
            const info = yield* fs.stat(item.physical);
            if (info.type === "Directory") {
              entries.push({ path: item.logical, kind: "directory", mode: info.mode, content: "" });
              const children = yield* fs.readDirectory(item.physical);
              for (const name of children.sort().reverse()) {
                if (name === ".git") continue;
                queue.push({
                  physical: path.join(item.physical, name),
                  logical: `${item.logical}/${name}`,
                  depth: item.depth + 1,
                });
              }
            } else if (info.type === "File") {
              if (
                Option.getOrElse(info.nlink, () => 0n) !== 1n ||
                info.size > BigInt(32 * 1024 * 1024 - size)
              )
                return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
              const bytes = yield* fs.readFile(item.physical);
              size += bytes.byteLength;
              if (size > 32 * 1024 * 1024)
                return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
              entries.push({
                path: item.logical,
                kind: "file",
                mode: info.mode,
                content: Base64.encode(bytes),
              });
            } else return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
          }
          const text = yield* encodeSnapshot({
            format: "foundry-setup-snapshot-1",
            entries,
          });
          const bytes = new TextEncoder().encode(text);
          if (bytes.byteLength > FOUNDRY_ARTIFACT_MAX_BYTES)
            return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
          yield* fs.writeFile(input.output, bytes, { mode: 0o600 });
          return { sizeBytes: bytes.byteLength, sha256: artifactSha256(bytes) };
        },
        Effect.mapError((cause) =>
          isArchiveError(cause) ? cause : new FoundrySandboxArchiveError({ code: "unavailable" }),
        ),
      ),
    });
  }),
);
