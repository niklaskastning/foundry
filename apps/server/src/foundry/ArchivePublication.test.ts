import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  FoundryDeviceId,
  FoundryInstanceId,
  FoundryArchiveError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FoundryArchiveStatus,
  type FoundryArchiveRequest,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ArchivePublication from "./ArchivePublication.ts";
import * as ArchiveTransport from "./ArchiveTransport.ts";
import { archiveEvent } from "./archiveEvent.ts";

const device = {
  deviceId: FoundryDeviceId.make("11111111-1111-4111-8111-111111111111"),
  instanceId: FoundryInstanceId.make("22222222-2222-4222-8222-222222222222"),
  environmentId: EnvironmentId.make("archive-worker"),
  publicKey: "a".repeat(43),
  generation: 1,
  revoked: false,
};
const layerStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const create = (name: string): Extract<OrchestrationV2DomainEvent, { type: "thread.created" }> => {
  const threadId = ThreadId.make(name);
  const now = DateTime.makeUnsafe("2026-11-03T00:00:00Z");
  const providerInstanceId = ProviderInstanceId.make("replay");
  return {
    id: EventId.make(`${name}-create`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project"),
      title: name,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "replay" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/private/worker/worktree",
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  };
};

it.effect(
  "resumes from Main's committed cursor after a lost ack and worker reconstruction, preserving source gaps",
  () =>
    Effect.gen(function* () {
      const store = yield* EventStore.EventStoreV2;
      const old = create("old");
      yield* store.append({ events: [old] });
      const statuses = new Map<string, FoundryArchiveStatus>();
      const batches: Extract<FoundryArchiveRequest, { op: "ingest" }>["input"][] = [];
      let loseAck = false;
      const send = Effect.fn("test.archiveTransport")(function* (request: FoundryArchiveRequest) {
        if (request.op !== "cursor" && request.op !== "ingest")
          throw new Error("unexpected request");
        const owner = request.op === "cursor" ? request.input : request.input.owner;
        const previous = statuses.get(owner.threadId) ?? {
          owner,
          confirmedCursor: 0,
          confirmedSourceSequence: 0,
          sourceHead: 0,
          sourceComplete: false,
          complete: false,
          missingArtifacts: [],
          missingAttachmentCount: 0,
        };
        if (request.op === "cursor") return previous;
        batches.push(request.input);
        const last = request.input.events.at(-1);
        const status = {
          ...previous,
          sourceHead: request.input.sourceHead,
          sourceComplete: request.input.sourceComplete,
          confirmedCursor: last?.sequence ?? previous.confirmedCursor,
          confirmedSourceSequence: last?.sourceSequence ?? previous.confirmedSourceSequence,
          complete:
            request.input.sourceComplete &&
            (last?.sequence ?? previous.confirmedCursor) === request.input.sourceHead,
        };
        statuses.set(owner.threadId, status);
        if (loseAck) {
          loseAck = false;
          return yield* new FoundryArchiveError({ code: "unavailable" });
        }
        return status;
      });
      const transport = Layer.succeed(ArchiveTransport.ArchiveTransport, { device, send });
      const publisher = ArchivePublication.layer.pipe(Layer.provide(transport));
      const next = create("new");
      yield* Effect.gen(function* () {
        const publication = yield* ArchivePublication.ArchivePublication;
        assert.isDefined(publication);
        assert.isFalse((yield* publication!.reconcile(old.threadId)).complete);
        yield* store.append({
          events: [
            next,
            { ...old, id: EventId.make("old-update"), type: "thread.metadata-updated" },
            { ...next, id: EventId.make("new-update"), type: "thread.metadata-updated" },
          ],
        });
        loseAck = true;
        assert.isTrue(
          (yield* Effect.result(publication!.reconcile(next.threadId)))._tag === "Failure",
        );
      }).pipe(Effect.provide(publisher));
      yield* Effect.gen(function* () {
        const publication = yield* ArchivePublication.ArchivePublication;
        const last = {
          ...next,
          id: EventId.make("new-final"),
          type: "thread.metadata-updated" as const,
        };
        yield* store.append({ events: [last] });
        assert.isTrue((yield* publication!.reconcile(next.threadId)).complete);
        assert.deepEqual(
          batches
            .filter((batch) => batch.owner.threadId === next.threadId)
            .map((batch) => batch.events.map((event) => [event.sequence, event.sourceSequence])),
          [
            [
              [1, 2],
              [2, 4],
            ],
            [[3, 5]],
          ],
        );
        assert.isTrue(
          batches
            .filter((batch) => batch.owner.threadId === next.threadId)
            .every((batch) => batch.sourceComplete),
        );
        const sql = yield* SqlClient.SqlClient;
        assert.equal((yield* sql`SELECT * FROM foundry_archive_activation`).length, 1);
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        assert.equal((yield* maintenance.compactEventStore()).deletedEventCount, 0);
        assert.equal((yield* store.read().pipe(Stream.runCollect)).length, 5);
        const large = create("oversized");
        yield* store.append({
          events: [{ ...large, payload: { ...large.payload, title: "x".repeat(1024 * 1024) } }],
        });
        assert.isTrue(
          (yield* Effect.result(publication!.reconcile(large.threadId)))._tag === "Failure",
        );
        assert.deepInclude(statuses.get(large.threadId), {
          sourceHead: 1,
          confirmedCursor: 0,
          complete: false,
        });
        assert.deepEqual(
          batches
            .filter((batch) => batch.owner.threadId === large.threadId)
            .map((batch) => batch.events),
          [[]],
        );
      }).pipe(Effect.provide(Layer.mergeAll(Layer.fresh(publisher), ProjectionMaintenance.layer)));
      assert.deepEqual(archiveEvent(next).payload, { ...next.payload, worktreePath: null });
    }).pipe(Effect.provide(layerStores)),
);
