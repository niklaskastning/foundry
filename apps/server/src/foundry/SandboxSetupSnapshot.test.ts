import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { FoundrySandboxSetupLocalIndex, FOUNDRY_SETUP_PART_BYTES } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Base64 from "effect/encoding/Base64";
import { artifactSha256 } from "@t3tools/shared/foundryArtifacts";
import * as Snapshot from "./SandboxSetupSnapshot.ts";

const decodeIndex = Schema.decodeEffect(Schema.fromJsonString(FoundrySandboxSetupLocalIndex));
const decodePart = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      entries: Schema.Array(
        Schema.Struct({
          path: Schema.String,
          content: Schema.String,
          kind: Schema.String,
          offset: Schema.Number,
          size: Schema.Number,
        }),
      ),
    }),
  ),
);

it.live(
  "captures setup files without following links or including runtime credentials and rejects hardlinks",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const service = yield* Snapshot.SandboxSetupSnapshot;
      const root = yield* fs.makeTempDirectoryScoped();
      const cwd = `${root}/repo`;
      yield* fs.makeDirectory(`${cwd}/.git`, { recursive: true });
      yield* fs.makeDirectory(`${root}/.foundry`);
      yield* fs.writeFileString(`${cwd}/work.txt`, "work");
      yield* fs.writeFileString(`${cwd}/.git/config`, "private git metadata");
      yield* fs.writeFileString(`${root}/.foundry/private`, "fixture-secret-never-archived");
      yield* fs.writeFileString(`${root}/.foundry/setup.log`, "setup exited 1");
      yield* fs.symlink(`${root}/.foundry/private`, `${cwd}/link`);
      const input = {
        cwd,
        setupLog: `${root}/.foundry/setup.log`,
        output: `${root}/snapshot.json`,
      };
      yield* fs.makeDirectory(`${cwd}/node_modules`);
      yield* fs.writeFile(
        `${cwd}/node_modules/generated.bin`,
        new Uint8Array(34 * 1024 * 1024).fill(73),
      );
      yield* Effect.forEach(
        Array.from({ length: 10010 }, (_, index) => index),
        (index) => fs.writeFileString(`${cwd}/node_modules/file-${index}`, `generated-${index}`),
        { concurrency: 32, discard: true },
      );
      const result = yield* service.capture(input);
      assert.isAbove(result.sizeBytes, 0);
      const index = yield* decodeIndex(yield* fs.readFileString(input.output));
      assert.isAbove(index.parts.length, 1);
      let largeFileBytes = 0;
      const paths = new Set<string>();
      let symlink = false;
      for (const [partIndex, metadata] of index.parts.entries()) {
        const bytes = yield* fs.readFile(`${input.output}.part-${partIndex}`);
        assert.equal(artifactSha256(bytes), metadata.sha256);
        assert.equal(bytes.byteLength, metadata.sizeBytes);
        assert.isAtMost(bytes.byteLength, FOUNDRY_SETUP_PART_BYTES);
        const text = new TextDecoder().decode(bytes);
        assert.notInclude(text, "fixture-secret-never-archived");
        assert.notInclude(text, "Zml4dHVyZS1zZWNyZXQtbmV2ZXItYXJjaGl2ZWQ=");
        assert.notInclude(text, ".git/config");
        for (const entry of (yield* decodePart(text)).entries) {
          paths.add(entry.path);
          symlink ||= entry.kind === "symlink";
          if (entry.path === "repo/node_modules/generated.bin") {
            assert.equal(entry.offset, largeFileBytes);
            assert.equal(entry.size, 34 * 1024 * 1024);
            const content = yield* Effect.fromResult(Base64.decode(entry.content));
            assert.isTrue(content.every((byte) => byte === 73));
            largeFileBytes += content.byteLength;
          }
        }
      }
      assert.isTrue(symlink);
      assert.equal(largeFileBytes, 34 * 1024 * 1024);
      assert.isTrue(paths.has("repo/work.txt"));
      assert.equal(
        [...paths].filter((path) => path.startsWith("repo/node_modules/file-")).length,
        10010,
      );
      yield* fs.link(`${root}/.foundry/private`, `${cwd}/hardlink`);
      assert.equal((yield* service.capture(input).pipe(Effect.flip)).code, "incomplete");
      const absent = {
        cwd: `${root}/absent`,
        setupLog: `${root}/absent.log`,
        output: `${root}/absent-snapshot.json`,
      };
      yield* service.capture(absent);
      const absentPart = yield* decodePart(yield* fs.readFileString(`${absent.output}.part-0`));
      assert.deepEqual(
        absentPart.entries.map((entry) => entry.kind),
        ["missing", "missing"],
      );
    }).pipe(
      Effect.provide(Snapshot.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      Effect.scoped,
    ),
);
