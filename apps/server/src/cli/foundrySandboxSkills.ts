import { FactoryV4Skill, FoundrySandboxError } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { prepareSandboxSkills } from "../foundry/WorkerResources.ts";
const decodeSkills = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(FactoryV4Skill)));

export const sandboxSkillsCommand = Command.make("sandbox-skills", {
  input: Flag.String("input"),
  cwd: Flag.String("cwd"),
}).pipe(
  Command.withHandler(
    Effect.fn("foundry.sandboxSkills")(function* (flags) {
      const fs = yield* FileSystem.FileSystem;
      if ((yield* fs.stat(flags.input)).size > 16n * 1024n * 1024n)
        return yield* new FoundrySandboxError({ code: "invalid_request" });
      const skills = yield* decodeSkills(yield* fs.readFileString(flags.input));
      yield* prepareSandboxSkills(flags.cwd, skills);
      yield* Console.log("Sandbox skill bundles verified.");
    }),
  ),
);
