import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Command } from "effect/cli";
import { connectDeviceCommand } from "./foundryConnectDevice.ts";

it.effect("keeps the existing HTTPS invocation valid and requires explicit loopback opt-in", () =>
  Effect.gen(function* () {
    for (const enabled of [false, true]) {
      const received: boolean[] = [];
      const command = connectDeviceCommand.pipe(
        Command.withHandler((flags) =>
          Effect.sync(() => {
            received.push(flags.developmentLoopback);
          }),
        ),
      );
      yield* Command.runWith(command, { version: "0.0.0" })([
        "--base-dir",
        "/fixture",
        "--origin",
        enabled ? "http://localhost:1234" : "https://foundry.example",
        "--registration",
        "/fixture/registration.json",
        "--key-file",
        "/fixture/key.json",
        "--streams",
        ...(enabled ? ["--development-loopback"] : []),
      ]);
      expect(received).toEqual([enabled]);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
