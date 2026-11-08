import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { sandboxSupervisorCommand } from "./foundrySandboxSupervisor.ts";

it.effect("enters the host lock without an internal flag and refuses a busy provisioner", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const calls: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command))
          return yield* Effect.die("Unexpected pipeline");
        calls.push([command.command, ...command.args]);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    const result = yield* Command.runWith(sandboxSupervisorCommand, { version: "0.0.0" })([
      "--configuration",
      "/fixture/configuration.json",
    ]).pipe(
      Effect.provideService(FileSystem.FileSystem, { ...fs, makeDirectory: () => Effect.void }),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.ExecutablePath, "/fixture/node"),
      Effect.provideService(HostProcess.Arguments, ["node", "/fixture/bin.mjs"]),
      Effect.provideService(HostProcess.IsExecutable, false),
      Effect.result,
    );
    expect(calls).toEqual([
      [
        "/usr/bin/flock",
        "--nonblock",
        "--no-fork",
        "/var/lib/foundry-sandbox/provisioner.lock",
        "/fixture/node",
        "/fixture/bin.mjs",
        "foundry",
        "sandbox-supervise",
        "--configuration",
        "/fixture/configuration.json",
        "--lock-held",
      ],
    ]);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "FoundrySandboxError", code: "unavailable" },
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);
