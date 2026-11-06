import {
  FOUNDRY_SETUP_PART_BYTES,
  FOUNDRY_SETUP_MAX_PARTS,
  FoundrySandboxSetupLocalIndex,
  FoundrySandboxArchiveError,
} from "@t3tools/contracts";
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
  kind: Schema.Literals(["file", "directory", "symlink", "missing"]),
  mode: Schema.Number,
  content: Schema.String,
  offset: Schema.Number,
  size: Schema.Number,
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
const encodeEntry = Schema.encodeEffect(Schema.fromJsonString(Entry));
const encodeIndex = Schema.encodeEffect(Schema.fromJsonString(FoundrySandboxSetupLocalIndex));
export const layer = Layer.effect(
  SandboxSetupSnapshot,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return SandboxSetupSnapshot.of({
      capture: Effect.fn("SandboxSetupSnapshot.capture")(
        function* (input) {
          const staging = yield* fs.makeTempDirectoryScoped({
            directory: path.dirname(input.output),
            prefix: ".snapshot-",
          });
          const parts: Array<{ sizeBytes: number; sha256: string }> = [];
          let entries: string[] = [];
          let size = 0;
          const prefix = '{"format":"foundry-setup-part-2","entries":[';
          const flush = Effect.fn("SandboxSetupSnapshot.flush")(function* () {
            if (!entries.length) return;
            if (parts.length >= FOUNDRY_SETUP_MAX_PARTS)
              return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
            const bytes = new TextEncoder().encode(`${prefix}${entries.join(",")}]}`);
            const temporary = path.join(staging, "part");
            yield* fs.writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
            yield* fs.rename(temporary, `${input.output}.part-${parts.length}`);
            parts.push({ sizeBytes: bytes.byteLength, sha256: artifactSha256(bytes) });
            entries = [];
            size = 0;
          });
          const append = Effect.fn("SandboxSetupSnapshot.append")(function* (
            entry: typeof Entry.Type,
          ) {
            const text = yield* encodeEntry(entry);
            const bytes = new TextEncoder().encode(text).byteLength;
            if (bytes + prefix.length + 2 > FOUNDRY_SETUP_PART_BYTES)
              return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
            if (size + bytes + entries.length + prefix.length + 2 > FOUNDRY_SETUP_PART_BYTES)
              yield* flush();
            entries.push(text);
            size += bytes;
          });
          const queue = [
            { physical: input.cwd, logical: "repo", depth: 0 },
            { physical: input.setupLog, logical: "setup.log", depth: 0 },
          ];
          while (queue.length > 0) {
            const item = queue.pop()!;
            if (item.depth > 64)
              return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
            const link = yield* fs.readLink(item.physical).pipe(Effect.option);
            if (Option.isSome(link)) {
              yield* append({
                path: item.logical,
                kind: "symlink",
                mode: 0,
                content: link.value,
                offset: 0,
                size: 0,
              });
              continue;
            }
            if (!(yield* fs.exists(item.physical))) {
              yield* append({
                path: item.logical,
                kind: "missing",
                mode: 0,
                content: "",
                offset: 0,
                size: 0,
              });
              continue;
            }
            const info = yield* fs.stat(item.physical);
            if (info.type === "Directory") {
              yield* append({
                path: item.logical,
                kind: "directory",
                mode: info.mode,
                content: "",
                offset: 0,
                size: 0,
              });
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
                info.size > BigInt(Number.MAX_SAFE_INTEGER)
              )
                return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const file = yield* fs.open(item.physical, { flag: "r" });
                  const buffer = new Uint8Array(1024 * 1024);
                  let offset = 0;
                  do {
                    const length = yield* file.read(buffer);
                    if (length === 0 && offset > 0) break;
                    yield* append({
                      path: item.logical,
                      kind: "file",
                      mode: info.mode,
                      content: Base64.encode(buffer.subarray(0, length)),
                      offset,
                      size: Number(info.size),
                    });
                    offset += length;
                    if (length === 0) break;
                  } while (true);
                  if (offset !== Number(info.size))
                    return yield* new FoundrySandboxArchiveError({ code: "changed" });
                }),
              );
            } else return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
          }
          yield* flush();
          const bytes = new TextEncoder().encode(
            yield* encodeIndex({ format: "foundry-setup-local-2", parts }),
          );
          const temporary = path.join(staging, "index");
          yield* fs.writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
          yield* fs.rename(temporary, input.output);
          return { sizeBytes: bytes.byteLength, sha256: artifactSha256(bytes) };
        },
        Effect.scoped,
        Effect.mapError((cause) =>
          isArchiveError(cause) ? cause : new FoundrySandboxArchiveError({ code: "unavailable" }),
        ),
      ),
    });
  }),
);
