import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { FoundrySandboxError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import * as Supervisor from "../foundry/sandboxes/Supervisor.ts";
import * as Transport from "../foundry/sandboxes/Transport.ts";
import * as OciSupervisor from "../foundry/sandboxes/OciSupervisor.ts";
const decodeConfiguration = Schema.decodeEffect(Schema.fromJsonString(Transport.Configuration));

export const sandboxSupervisorCommand = Command.make("sandbox-supervise", {
  configuration: Flag.String("configuration"),
  lockHeld: Flag.Boolean("lock-held").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withDescription(
    "Run the dedicated Linux sandbox provisioner using its own enrolled device identity.",
  ),
  Command.withHandler(
    Effect.fn("foundry.sandboxSupervise")(function* (flags) {
      if ((yield* HostProcess.Platform) !== "linux")
        return yield* new FoundrySandboxError({ code: "invalid_request" });
      const fs = yield* FileSystem.FileSystem;
      if (!flags.lockHeld) {
        const invocation = yield* resolveSelfInvocation();
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        yield* fs.makeDirectory("/var/lib/foundry-sandbox", { recursive: true });
        // The inherited kernel lock survives re-exec and is released only when the provisioner exits.
        const code = yield* spawner.exitCode(
          ChildProcess.make(
            "/usr/bin/flock",
            [
              "--nonblock",
              "--no-fork",
              "/var/lib/foundry-sandbox/provisioner.lock",
              invocation.command,
              ...selfInvocationArgs(invocation, [
                "foundry",
                "sandbox-supervise",
                "--configuration",
                flags.configuration,
                "--lock-held",
              ]),
            ],
            { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
          ),
        );
        if (code !== 0) return yield* new FoundrySandboxError({ code: "unavailable" });
        return;
      }
      if ((yield* fs.stat(flags.configuration)).size > 65536n)
        return yield* new FoundrySandboxError({ code: "invalid_request" });
      const configuration = yield* decodeConfiguration(
        yield* fs.readFileString(flags.configuration),
      );
      return yield* Supervisor.Supervisor.pipe(
        Effect.flatMap((service) => service.run),
        Effect.provide(
          Supervisor.layer.pipe(
            Layer.provide(
              Layer.merge(Transport.layer(configuration), OciSupervisor.layer(configuration)),
            ),
            Layer.provide(ProcessRunner.layer),
            Layer.provide(FetchHttpClient.layer),
          ),
        ),
      );
    }),
  ),
);
