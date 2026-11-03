import {
  FoundryArchiveError,
  FoundryArchiveListPage,
  FoundryArchivePage,
  type FoundryArchiveList,
  type FoundryArchiveRead,
  type FoundryArchiveRequest,
  type FoundryArchiveEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { verifyDescriptor, type InstanceBinding } from "./foundry.ts";
import * as FoundryMain from "./foundryMain.ts";
import { applyOrchestrationV2ProjectionEvent } from "../state/orchestrationV2Projection.ts";

const isArchiveError = Schema.is(FoundryArchiveError);
const decodeFailure = Schema.decodeUnknownEffect(
  Schema.Struct({ code: FoundryArchiveError.fields.code }),
);
const decodeListPage = Schema.decodeUnknownEffect(FoundryArchiveListPage);
const decodePage = Schema.decodeUnknownEffect(FoundryArchivePage);
const failure = (error: unknown) =>
  isArchiveError(error) ? error : new FoundryArchiveError({ code: "unavailable" });
export const make = Effect.fn("FoundryArchiveClient.make")(function* (
  options = { allowLoopback: false },
) {
  const main = yield* FoundryMain.make(options);
  const request = Effect.fn("FoundryArchiveClient.request")(function* (
    binding: InstanceBinding,
    input: FoundryArchiveRequest,
  ) {
    const connection = yield* main.prepare(binding);
    const descriptor = yield* connection.request("/.well-known/foundry?protocolVersion=1").pipe(
      Effect.flatMap((value) =>
        Effect.try({
          try: () => verifyDescriptor(value, connection.origin, binding),
          catch: () => new FoundryArchiveError({ code: "forbidden" }),
        }),
      ),
    );
    if (descriptor.descriptor.threadArchive?.protocolVersion !== "1")
      return yield* new FoundryArchiveError({ code: "unavailable" });
    const response = yield* connection.response("/api/foundry/archives", input, true);
    if (response.status !== 200) {
      const value = yield* decodeFailure(response.value);
      return yield* new FoundryArchiveError({ code: value.code });
    }
    return response.value;
  }, Effect.mapError(failure));
  return {
    list: Effect.fn("FoundryArchiveClient.list")(
      (binding: InstanceBinding, input: FoundryArchiveList) =>
        request(binding, { op: "list", input }).pipe(
          Effect.flatMap(decodeListPage),
          Effect.mapError(failure),
        ),
    ),
    read: Effect.fn("FoundryArchiveClient.read")(function* (
      binding: InstanceBinding,
      input: FoundryArchiveRead,
    ) {
      const page = yield* request(binding, { op: "read", input }).pipe(Effect.flatMap(decodePage));
      if (
        page.owner.environmentId !== input.owner.environmentId ||
        page.owner.threadId !== input.owner.threadId ||
        page.events.some((row) => row.event.threadId !== input.owner.threadId)
      )
        return yield* new FoundryArchiveError({ code: "forbidden" });
      return page;
    }, Effect.mapError(failure)),
  };
});

export function applyArchivePage(
  projection: OrchestrationV2ThreadProjection | null,
  after: number,
  events: ReadonlyArray<FoundryArchiveEvent>,
) {
  let cursor = after;
  let next = projection;
  for (const row of events) {
    if (row.sequence !== cursor + 1) throw new FoundryArchiveError({ code: "incomplete" });
    const event = row.event;
    if (next === null) {
      if (event.type !== "thread.created") throw new FoundryArchiveError({ code: "incomplete" });
      next = {
        thread: event.payload,
        runs: [],
        attempts: [],
        nodes: [],
        subagents: [],
        providerSessions: [],
        providerThreads: [],
        providerTurns: [],
        runtimeRequests: [],
        messages: [],
        plans: [],
        turnItems: [],
        checkpointScopes: [],
        checkpoints: [],
        contextHandoffs: [],
        contextTransfers: [],
        visibleTurnItems: [],
        updatedAt: event.occurredAt,
      };
    } else {
      if (event.threadId !== next.thread.id) throw new FoundryArchiveError({ code: "forbidden" });
      next = applyOrchestrationV2ProjectionEvent(next, event);
    }
    cursor = row.sequence;
  }
  return { projection: next, cursor };
}
