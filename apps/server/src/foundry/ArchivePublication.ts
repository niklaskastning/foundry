import {
  FoundryArchiveError,
  FoundryArchiveStatus,
  FoundryArchiveEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ArchiveTransport from "./ArchiveTransport.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { archiveEvent } from "./archiveEvent.ts";

export class ArchivePublication extends Context.Reference<
  | {
      readonly reconcile: (
        threadId: ThreadId,
      ) => Effect.Effect<{ readonly complete: boolean }, FoundryArchiveError>;
    }
  | undefined
>("t3/foundry/ArchivePublication", { defaultValue: () => undefined }) {}

const isArchiveError = Schema.is(FoundryArchiveError);
const unavailable = () => new FoundryArchiveError({ code: "unavailable" });
const conflict = () => new FoundryArchiveError({ code: "conflict" });
const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(FoundryArchiveEvent));
const decodeStatus = Schema.decodeUnknownEffect(FoundryArchiveStatus);

export const layer = Layer.effect(
  ArchivePublication,
  Effect.gen(function* () {
    const transport = yield* ArchiveTransport.ArchiveTransport;
    if (!transport) return undefined;
    const sql = yield* SqlClient.SqlClient;
    const store = yield* EventStore.EventStoreV2;
    const identity = `${transport.device.instanceId}:${transport.device.deviceId}`;
    yield* sql`INSERT INTO foundry_archive_activation (binding, baseline)
    SELECT ${identity}, COALESCE(MAX(sequence), 0) FROM orchestration_events WHERE 1
    ON CONFLICT(binding) DO NOTHING`.pipe(Effect.mapError(unavailable));
    const activation = yield* sql<{
      baseline: number;
    }>`SELECT baseline FROM foundry_archive_activation WHERE binding=${identity}`.pipe(
      Effect.mapError(unavailable),
    );
    const baseline = activation[0]?.baseline;
    if (baseline === undefined) return yield* unavailable();
    const lane = yield* Semaphore.make(1);
    const reconcile = Effect.fn("ArchivePublication.reconcile")(
      function* (threadId: ThreadId) {
        const owner = { environmentId: transport.device.environmentId, threadId };
        const throughSequence = yield* store.latestSequence({ threadId });
        const rows = yield* sql<{
          count: number;
          first: number;
          created: number;
        }>`SELECT COUNT(*) AS count, COALESCE(MIN(sequence), 0) AS first,
      COALESCE(MIN(CASE WHEN event_type='thread.created' THEN sequence END), 0) AS created
      FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id=${threadId} AND sequence<=${throughSequence}`;
        const sourceHead = rows[0]?.count ?? 0;
        const sourceComplete =
          (rows[0]?.first ?? 0) > baseline && rows[0]?.created === rows[0]?.first;
        let status = yield* transport
          .send({ op: "cursor", input: owner })
          .pipe(Effect.flatMap(decodeStatus));
        if (status.confirmedCursor > sourceHead || status.confirmedSourceSequence > throughSequence)
          return yield* conflict();
        let sourceSequence = status.confirmedSourceSequence;
        let cursor = status.confirmedCursor;
        do {
          const stored = yield* store
            .read({ threadId, afterSequence: sourceSequence, throughSequence, limit: 50 })
            .pipe(Stream.runCollect);
          const events: FoundryArchiveEvent[] = [];
          let size = 0;
          for (const event of stored) {
            const next = {
              sequence: cursor + events.length + 1,
              sourceSequence: event.sequence,
              event: archiveEvent(event.event),
            };
            const bytes = new TextEncoder().encode(yield* encodeEvent(next)).byteLength;
            if (size + bytes > 1024 * 1024 - 16 * 1024) break;
            events.push(next);
            size += bytes;
          }
          status = yield* transport
            .send({
              op: "ingest",
              input: {
                instanceId: transport.device.instanceId,
                owner,
                sourceHead,
                sourceComplete,
                events,
              },
            })
            .pipe(Effect.flatMap(decodeStatus));
          const last = events.at(-1);
          if (
            last &&
            (status.confirmedCursor !== last.sequence ||
              status.confirmedSourceSequence !== last.sourceSequence)
          )
            return yield* conflict();
          if (!last && cursor < sourceHead) return yield* conflict();
          cursor = status.confirmedCursor;
          sourceSequence = status.confirmedSourceSequence;
        } while (cursor < sourceHead);
        return status;
      },
      Effect.mapError((error) => (isArchiveError(error) ? error : unavailable())),
      lane.withPermits(1),
    );
    return { reconcile };
  }),
);

export const layerWatch = Layer.effectDiscard(
  Effect.gen(function* () {
    const publication = yield* ArchivePublication;
    if (!publication) return;
    const { reconcile } = publication;
    const sql = yield* SqlClient.SqlClient;
    const store = yield* EventStore.EventStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const dirty = new Map<ThreadId, symbol>();
    const deliver = Effect.fn("ArchivePublication.deliver")(function* (threadId: ThreadId) {
      const delivery = Symbol();
      dirty.set(threadId, delivery);
      yield* reconcile(threadId).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (dirty.get(threadId) === delivery) dirty.delete(threadId);
          }),
        ),
        Effect.catchTags({
          FoundryArchiveError: (error) =>
            Effect.logWarning("Thread archive remains unconfirmed", { code: error.code }),
        }),
      );
    });
    // Capture before backfill: the existing replay/live handoff covers events committed meanwhile.
    const follow = Effect.gen(function* () {
      const highWater = yield* store.latestSequence();
      const threads = yield* sql<{ threadId: ThreadId }>`SELECT DISTINCT stream_id AS "threadId"
      FROM orchestration_events WHERE aggregate_kind='thread' AND application_event_version=2 AND sequence<=${highWater}`;
      yield* Effect.forEach(threads, (thread) => deliver(thread.threadId), { discard: true });
      yield* sink.stream({ afterSequence: highWater }).pipe(
        Stream.groupedWithin(50, "100 millis"),
        Stream.runForEach((batch) =>
          Effect.forEach(new Set(Array.from(batch, (stored) => stored.event.threadId)), deliver, {
            discard: true,
          }),
        ),
      );
    });
    yield* Effect.suspend(() =>
      Effect.forEach(Array.from(dirty.keys()), deliver, { discard: true }),
    ).pipe(Effect.repeat(Schedule.spaced("5 seconds")), Effect.forkScoped);
    yield* follow.pipe(Effect.retry(Schedule.spaced("5 seconds")), Effect.forkScoped);
  }),
);
