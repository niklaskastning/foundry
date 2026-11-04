import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  CommandId,
  ProjectId,
  EnvironmentId,
  FoundryDeviceId,
  FoundryGatewayError,
  FoundryInstanceId,
  FoundryWorkerExecution,
  FoundryWorkerReadError,
  FoundryWorkerReadInput,
  FoundryWorkerStatus,
  FoundryWorkerLaunchInput,
  FoundryWorkerLaunchReceipt,
  FoundryWorkerLaunchError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as SocketServer from "effect/socket/SocketServer";
import * as GatewayGrants from "../foundry/GatewayGrants.ts";
import * as WorkerTransport from "./WorkerTransport.ts";

it.effect("uses one serialized RPC per explicit delivery and preserves worker not-found", () =>
  Effect.gen(function* () {
    const identity: WorkerTransport.WorkerIdentity = {
      instanceId: FoundryInstanceId.make("22222222-2222-4222-8222-222222222222"),
      operatorId: "operator",
      deviceId: FoundryDeviceId.make("11111111-1111-4111-8111-111111111111"),
      environmentId: EnvironmentId.make("worker"),
      deviceGeneration: 1,
      accessGeneration: 1,
      automationGeneration: 1,
      clientSessionId: AuthSessionId.make("client"),
      foundrySessionHash: "h".repeat(43),
    };
    const worker = RpcGroup.make(
      Rpc.make("foundry.workerStatus", {
        payload: Schema.Struct({}),
        success: FoundryWorkerStatus,
      }),
      Rpc.make("foundry.workerRead", {
        payload: FoundryWorkerReadInput,
        success: FoundryWorkerExecution,
        error: FoundryWorkerReadError,
      }),
      Rpc.make("foundry.workerLaunch", {
        payload: FoundryWorkerLaunchInput,
        success: FoundryWorkerLaunchReceipt,
        error: FoundryWorkerLaunchError,
      }),
    );
    let calls = 0;
    let opens = 0;
    let authorized = true;
    const serve = Effect.fn("WorkerTransportFixture.serve")(function* (socket: Socket.Socket) {
      const socketServer = SocketServer.SocketServer.of({
        address: NetAddress.inetAddressFromStringUnsafe("127.0.0.1:0"),
        run: (handler) => handler(socket).pipe(Effect.orDie, Effect.andThen(Effect.never)),
      });
      return yield* RpcServer.make(worker).pipe(
        Effect.provide(
          Layer.mergeAll(
            worker.toLayer({
              "foundry.workerLaunch": () =>
                Effect.fail(new FoundryWorkerLaunchError({ code: "handoff_changed" })),
              "foundry.workerStatus": () =>
                Effect.sync(() => {
                  calls++;
                  return {
                    online: true as const,
                    providerInstanceId: null,
                    providerReady: false,
                    providerState: "unbound" as const,
                    version: null,
                    checkedAt: "2026-11-03T00:00:00.000Z",
                    capacityAvailable: true,
                    activeRuns: 0,
                  };
                }),
              "foundry.workerRead": ({ commandId }) => {
                expect(commandId).toBe("persisted-command");
                calls++;
                return Effect.fail(new FoundryWorkerReadError({ code: "not_found" }));
              },
            }),
            RpcServer.layerProtocolSocketServer.pipe(
              Layer.provide(Layer.succeed(SocketServer.SocketServer, socketServer)),
              Layer.provide(RpcSerialization.layerJson),
            ),
          ),
        ),
      );
    });
    const gateway = GatewayGrants.GatewayGrants.of({
      identityForWrite: () => Effect.succeed(identity),
      identityForRead: () => Effect.succeed(identity),
      authorizeAutomation: () => Effect.succeed(identity),
      openAutomation: (binding, socket) =>
        Effect.suspend(() => {
          expect(binding).toEqual(identity);
          opens++;
          return authorized
            ? serve(socket).pipe(
                Effect.mapError(() => new FoundryGatewayError({ code: "unavailable" })),
              )
            : Effect.fail(new FoundryGatewayError({ code: "forbidden" }));
        }),
      create: () => Effect.die("unused"),
      inspect: () => Effect.die("unused"),
      remove: () => Effect.die("unused"),
      catalog: () => Effect.die("unused"),
      approveDevice: () => Effect.die("unused"),
      revokeDevice: () => Effect.die("unused"),
      readAccess: () => Effect.die("unused"),
      updateAccess: () => Effect.die("unused"),
      ticket: () => Effect.die("unused"),
      stream: () => Effect.die("unused"),
      projects: () => Effect.die("unused"),
    });
    const context = yield* Layer.build(
      WorkerTransport.layer.pipe(
        Layer.provide(Layer.succeed(GatewayGrants.GatewayGrants, gateway)),
      ),
    );
    const transport = Context.get(context, WorkerTransport.WorkerTransport);
    expect(yield* transport.status(identity)).toMatchObject({ online: true, providerReady: false });
    expect(
      yield* transport.read(identity, { commandId: CommandId.make("persisted-command") }),
    ).toBeNull();
    expect(calls).toBe(2);
    expect(opens).toBe(2);
    authorized = false;
    const denied = yield* transport.status(identity).pipe(Effect.result);
    expect(denied).toMatchObject({ _tag: "Failure", failure: { reason: "forbidden" } });
    expect(calls).toBe(2);
    expect(opens).toBe(3);
    authorized = true;
    const rejected = yield* transport
      .launch(identity, {
        commandId: CommandId.make("persisted-command"),
        projectId: ProjectId.make("fixture"),
        title: "Fixture",
        model: "fixture",
        prompt: "Fixture",
      })
      .pipe(Effect.result);
    expect(rejected).toMatchObject({
      _tag: "Failure",
      failure: { reason: "worker_rejected", workerCode: "handoff_changed" },
    });
  }).pipe(Effect.scoped),
);
