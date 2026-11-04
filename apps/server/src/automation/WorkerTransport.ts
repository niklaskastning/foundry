import {
  FoundryGatewayError,
  AuthOrchestrationOperateScope,
  type CommandId,
  type ThreadId,
  type RuntimeRequestId,
  type ProviderUserInputAnswers,
  type FoundryWorkerCancelInput,
  type FoundryWorkerCancellation,
  FoundryWorkerLaunchError,
  type FoundryWorkerExecution,
  type FoundryWorkerLaunchInput,
  type FoundryWorkerLaunchReceipt,
  type FoundryWorkerReadInput,
  type FoundryWorkerRenewInput,
  type FoundryWorkerStatus,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import * as GatewayGrants from "../foundry/GatewayGrants.ts";

export class WorkerTransportError extends Schema.TaggedError<WorkerTransportError>()(
  "WorkerTransportError",
  {
    reason: Schema.Literals(["forbidden", "unavailable", "worker_rejected"]),
    workerCode: Schema.optional(FoundryWorkerLaunchError.fields.code),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Automation worker access failed (${this.reason}).`;
  }
}

export const WorkerIdentity = GatewayGrants.AutomationGatewayIdentity;
export type WorkerIdentity = typeof WorkerIdentity.Type;
type Target = Pick<WorkerIdentity, "deviceId" | "environmentId">;

export class WorkerTransport extends Context.Service<
  WorkerTransport,
  {
    readonly identityForWrite: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<Pick<WorkerIdentity, "instanceId" | "operatorId">, WorkerTransportError>;
    readonly identityForRead: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<Pick<WorkerIdentity, "instanceId" | "operatorId">, WorkerTransportError>;
    readonly authorize: (
      request: HttpServerRequest.HttpServerRequest,
      target: Target,
    ) => Effect.Effect<WorkerIdentity, WorkerTransportError>;
    readonly status: (
      identity: WorkerIdentity,
    ) => Effect.Effect<FoundryWorkerStatus, WorkerTransportError>;
    readonly launch: (
      identity: WorkerIdentity,
      input: FoundryWorkerLaunchInput,
    ) => Effect.Effect<FoundryWorkerLaunchReceipt, WorkerTransportError>;
    readonly read: (
      identity: WorkerIdentity,
      input: FoundryWorkerReadInput,
    ) => Effect.Effect<FoundryWorkerExecution | null, WorkerTransportError>;
    readonly answer: (
      identity: WorkerIdentity,
      input: {
        commandId: CommandId;
        threadId: ThreadId;
        requestId: RuntimeRequestId;
        answers: ProviderUserInputAnswers;
      },
    ) => Effect.Effect<void, WorkerTransportError>;
    readonly cancel: (
      identity: WorkerIdentity,
      input: FoundryWorkerCancelInput,
    ) => Effect.Effect<FoundryWorkerCancellation, WorkerTransportError>;
    readonly renew: (
      identity: WorkerIdentity,
      input: FoundryWorkerRenewInput,
    ) => Effect.Effect<void, WorkerTransportError>;
  }
>()("t3/automation/WorkerTransport") {}

const unavailable = (cause: unknown) => new WorkerTransportError({ reason: "unavailable", cause });
const isWorkerTransportError = Schema.is(WorkerTransportError);
const isGatewayError = Schema.is(FoundryGatewayError);
const isLaunchError = Schema.is(FoundryWorkerLaunchError);
const transportError = (cause: unknown) =>
  isWorkerTransportError(cause)
    ? cause
    : isGatewayError(cause) && cause.code === "forbidden"
      ? new WorkerTransportError({ reason: "forbidden", cause })
      : isLaunchError(cause)
        ? new WorkerTransportError({ reason: "worker_rejected", workerCode: cause.code, cause })
        : unavailable(cause);

const socketPair = Effect.fn("WorkerTransport.socketPair")(function* () {
  const left = yield* Queue.bounded<string | Uint8Array, Socket.SocketError>(16);
  const right = yield* Queue.bounded<string | Uint8Array, Socket.SocketError>(16);
  const closed = new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1000 }) });
  const close = Effect.all([Queue.fail(left, closed), Queue.fail(right, closed)]).pipe(
    Effect.asVoid,
  );
  yield* Effect.addFinalizer(() => close);
  const side = (incoming: typeof left, outgoing: typeof right) => {
    const write: Socket.Writer["write"] = (frame) => {
      if (Socket.isCloseEvent(frame)) return close;
      if (
        (typeof frame === "string" ? new TextEncoder().encode(frame).length : frame.length) > 262144
      )
        return Effect.fail(
          new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause: "Frame limit" }) }),
        );
      return Queue.offer(outgoing, frame).pipe(Effect.asVoid);
    };
    return Socket.make({
      reader: Effect.acquireRelease(
        Effect.succeed({
          pull: Queue.take(incoming).pipe(Effect.map((frame) => [frame] as const)),
          upgrade: () => Effect.void,
        }),
        () => close,
      ),
      writer: Effect.succeed({
        write,
        writeAll: (frames) => Effect.forEach(frames, write, { discard: true }),
      }),
    });
  };
  return { client: side(left, right), gateway: side(right, left) };
});

const makeClient = RpcClient.make(WsRpcGroup);
type Client = Effect.Success<typeof makeClient>;
const make = Effect.gen(function* () {
  const gateway = yield* GatewayGrants.GatewayGrants;
  const authorize = Effect.fn("WorkerTransport.authorize")(
    (request: HttpServerRequest.HttpServerRequest, target: Target) =>
      gateway.authorizeAutomation(request, target),
    Effect.mapError(transportError),
  );
  const call = Effect.fn("WorkerTransport.call")(
    function* <A, E>(identity: WorkerIdentity, operation: (client: Client) => Effect.Effect<A, E>) {
      const sockets = yield* socketPair();
      const protocol = Layer.effect(
        RpcClient.Protocol,
        RpcClient.makeProtocolSocket({
          retryTransientErrors: false,
          retryPolicy: Schedule.recurs(0),
        }),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(Layer.succeed(Socket.Socket, sockets.client), RpcSerialization.layerJson),
        ),
      );
      const context = yield* Layer.build(protocol);
      const client = yield* makeClient.pipe(Effect.provide(context));
      return yield* operation(client).pipe(
        Effect.raceFirst(
          gateway
            .openAutomation(identity, sockets.gateway)
            .pipe(Effect.andThen(Effect.fail(new FoundryGatewayError({ code: "unavailable" })))),
        ),
      );
    },
    Effect.scoped,
    Effect.timeout("20 seconds"),
    Effect.mapError(transportError),
  );
  return WorkerTransport.of({
    identityForWrite: Effect.fn("WorkerTransport.identityForWrite")(
      (request) => gateway.identityForWrite(request, AuthOrchestrationOperateScope),
      Effect.mapError(transportError),
    ),
    identityForRead: Effect.fn("WorkerTransport.identityForRead")(
      (request) => gateway.identityForRead(request),
      Effect.mapError(transportError),
    ),
    authorize,
    status: Effect.fn("WorkerTransport.status")((identity) =>
      call(identity, (client) => client["foundry.workerStatus"]({})),
    ),
    launch: Effect.fn("WorkerTransport.launch")((identity, input) =>
      call(identity, (client) => client["foundry.workerLaunch"](input)),
    ),
    read: Effect.fn("WorkerTransport.read")((identity, input) =>
      call(identity, (client) =>
        client["foundry.workerRead"](input).pipe(
          Effect.catchTags({
            FoundryWorkerReadError: (error) =>
              error.code === "not_found" ? Effect.succeed(null) : Effect.fail(error),
          }),
        ),
      ),
    ),
    answer: Effect.fn("WorkerTransport.answer")((identity, input) =>
      call(identity, (client) =>
        client["orchestration.dispatchCommand"]({ ...input, type: "runtime-request.respond" }),
      ).pipe(Effect.asVoid),
    ),
    cancel: Effect.fn("WorkerTransport.cancel")((identity, input) =>
      call(identity, (client) => client["foundry.workerCancel"](input)),
    ),
    renew: Effect.fn("WorkerTransport.renew")((identity, input) =>
      call(identity, (client) => client["foundry.workerRenew"](input)),
    ),
  });
});

export const layer = Layer.effect(WorkerTransport, make);
