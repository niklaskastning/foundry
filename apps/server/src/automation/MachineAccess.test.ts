import { expect, it } from "@effect/vitest";
import { AutomationMachineCredentialError, FoundryInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as MachineAccess from "./MachineAccess.ts";
import * as MachineCredentials from "../foundry/MachineCredentials.ts";
import * as GatewayGrants from "../foundry/GatewayGrants.ts";
import * as Factories from "./Factories.ts";

it.effect(
  "enforces factory and operation scopes, reauthenticates revocation and denies credential administration",
  () =>
    Effect.gen(function* () {
      let revoked = false;
      const owner = {
        instanceId: FoundryInstanceId.make("00000000-0000-4000-8000-000000000001"),
        operatorId: "owner",
      };
      const access = yield* MachineAccess.MachineAccess.pipe(
        Effect.provide(
          MachineAccess.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(MachineCredentials.MachineCredentials)({
                  authenticate: (token) =>
                    revoked
                      ? Effect.fail(new AutomationMachineCredentialError({ code: "forbidden" }))
                      : Effect.succeed({
                          ...owner,
                          factoryIds: ["allowed"],
                          credentialId: "credential",
                          scope:
                            token === "fmc_start"
                              ? ("automation:start" as const)
                              : ("automation:control" as const),
                        }),
                }),
                Layer.mock(GatewayGrants.GatewayGrants)({}),
                Layer.mock(Factories.Factories)({}),
              ),
            ),
          ),
        ),
      );
      const request = (token: string, path = token === "fmc_control" ? "control" : "command") =>
        HttpServerRequest.fromWeb(
          new Request(`http://localhost/api/foundry/v1/automation/${path}`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
          }),
        );
      for (const scope of ["automation:start", "automation:control"] as const) {
        const token = scope === "automation:start" ? "fmc_start" : "fmc_control";
        expect(yield* access.write(request(token), "allowed", scope)).toMatchObject(owner);
        expect((yield* access.write(request(token), "other", scope).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(
          (yield* access
            .write(
              request(token),
              "allowed",
              scope === "automation:start" ? "automation:control" : "automation:start",
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }
      expect((yield* access.list(request("fmc_start")).pipe(Effect.result))._tag).toBe("Failure");
      expect(
        (yield* access
          .write(request("fmc_start", "../command"), "allowed", "automation:start")
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      revoked = true;
      expect(
        (yield* access
          .write(request("fmc_start"), "allowed", "automation:start")
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }),
);
