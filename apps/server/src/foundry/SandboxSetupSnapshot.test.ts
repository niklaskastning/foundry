import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Snapshot from "./SandboxSetupSnapshot.ts";

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
      const result = yield* service.capture(input);
      assert.isAbove(result.sizeBytes, 0);
      const text = yield* fs.readFileString(input.output);
      assert.include(text, '"kind":"symlink"');
      assert.include(text, "repo/work.txt");
      assert.notInclude(text, "fixture-secret-never-archived");
      assert.notInclude(text, "Zml4dHVyZS1zZWNyZXQtbmV2ZXItYXJjaGl2ZWQ=");
      assert.notInclude(text, ".git/config");
      yield* fs.link(`${root}/.foundry/private`, `${cwd}/hardlink`);
      assert.equal((yield* service.capture(input).pipe(Effect.flip)).code, "incomplete");
    }).pipe(
      Effect.provide(Snapshot.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      Effect.scoped,
    ),
);
