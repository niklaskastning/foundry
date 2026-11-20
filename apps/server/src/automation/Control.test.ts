import { AutomationMachineCredentialError } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as AutomationDatabase from "./AutomationDatabase.ts";
import * as Control from "./Control.ts";
import * as DispatchStore from "./DispatchStore.ts";
import * as MachineAccess from "./MachineAccess.ts";
import * as WorkerTransport from "./WorkerTransport.ts";

const unused = (): never => {
  throw new Error("Control authorization must reject before accessing SQL");
};

it.effect.each(["forbidden", "unavailable"] as const)(
  "preserves machine authorization failure %s before reading or changing a run",
  (code) =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const request = HttpServerRequest.fromWeb(
        new Request("http://fixture.invalid/api/foundry/v1/automation/control", {
          method: "POST",
          headers: { authorization: "Bearer fmc_fixture" },
        }),
      );
      const error = yield* control
        .execute(request, {
          commandId: "pause",
          factoryId: "factory",
          runId: "run",
          expectedRevision: 0,
          action: "pause",
        })
        .pipe(Effect.flip);
      expect(error.code).toBe(code);
    }).pipe(
      Effect.provide(
        Control.layer.pipe(
          Layer.provide(
            Layer.mock(MachineAccess.MachineAccess)({
              write: () => Effect.fail(new AutomationMachineCredentialError({ code })),
            }),
          ),
          Layer.provide(
            Layer.mock(AutomationDatabase.AutomationDatabase)({
              "~effect/sql/SqlClient": "~effect/sql/SqlClient",
              "~@effect/sql-pg/PgClient": "~@effect/sql-pg/PgClient",
              config: {},
              literal: unused,
              in: unused,
              insert: unused,
              update: unused,
              updateValues: unused,
              and: unused,
              or: unused,
              csv: unused,
              join: unused,
              onDialect: unused,
              onDialectOrElse: unused,
              json: unused,
              listen: unused,
              withoutTransforms: unused,
            }),
          ),
          Layer.provide(Layer.mock(DispatchStore.DispatchStore)({})),
          Layer.provide(Layer.mock(WorkerTransport.WorkerTransport)({})),
          Layer.provide(NodeCrypto.layer),
        ),
      ),
    ),
);
