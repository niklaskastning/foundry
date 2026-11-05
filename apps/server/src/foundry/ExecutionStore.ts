import {
  CommandId,
  ThreadId,
  FoundryWorkerLifecycle,
  FoundryWorkerManifest,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ExecutionObserver from "./ExecutionObserver.ts";
import * as ArchivePublication from "./ArchivePublication.ts";

export class ExecutionStoreError extends Schema.TaggedError<ExecutionStoreError>()(
  "ExecutionStoreError",
  {
    cause: Schema.Defect(),
    code: Schema.optional(Schema.Literal("capacity_unavailable")),
  },
) {}
const isExecutionStoreError = Schema.is(ExecutionStoreError);
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(FoundryWorkerManifest));
const Row = Schema.Struct({
  generation: Schema.Number,
  commandId: CommandId,
  threadId: ThreadId,
  expiresAt: Schema.Number,
  state: FoundryWorkerLifecycle.fields.state,
  writerEnded: Schema.Number,
  stopRequested: Schema.Number,
  manifest: Schema.NullOr(Schema.String),
});
type Row = typeof Row.Type;
export class ExecutionStore extends Context.Service<
  ExecutionStore,
  {
    readonly reserve: (
      commandId: CommandId,
      threadId: ThreadId,
      capacity?: number,
    ) => Effect.Effect<Row, ExecutionStoreError>;
    readonly occupied: Effect.Effect<number, ExecutionStoreError>;
    readonly cancelUnstarted: (
      commandId: CommandId,
      launchCommandId: CommandId,
    ) => Effect.Effect<boolean, ExecutionStoreError>;
    readonly cancellation: (
      commandId: CommandId,
    ) => Effect.Effect<CommandId | null, ExecutionStoreError>;
    readonly read: (commandId: CommandId) => Effect.Effect<Row | undefined, ExecutionStoreError>;
    readonly renew: (
      commandId: CommandId,
      generation: number,
    ) => Effect.Effect<boolean, ExecutionStoreError>;
    readonly uncertain: (commandId: CommandId) => Effect.Effect<void, ExecutionStoreError>;
    readonly stop: (commandId: CommandId) => Effect.Effect<void, ExecutionStoreError>;
    readonly sweep: Effect.Effect<ReadonlyArray<Row>, ExecutionStoreError>;
    readonly finish: (
      commandId: CommandId,
      generation: number,
      manifest: FoundryWorkerManifest,
    ) => Effect.Effect<void, ExecutionStoreError>;
    readonly starting: Context.Service.Shape<
      typeof ExecutionObserver.ExecutionObserver
    >["starting"];
    readonly confirm: (
      commandId: CommandId,
      generation: number,
    ) => Effect.Effect<void, ExecutionStoreError>;
  }
>()("t3/foundry/ExecutionStore") {}

export const layer = Layer.effect(
  ExecutionStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const archive = yield* ArchivePublication.ArchivePublication;
    yield* sql`UPDATE foundry_executions SET state = 'uncertain', expires_at = 0, stop_requested = 1 WHERE writer_ended = 0 AND manifest IS NULL`;
    const columns = sql.literal(
      `generation, command_id AS "commandId", thread_id AS "threadId", expires_at AS "expiresAt", state, writer_ended AS "writerEnded", stop_requested AS "stopRequested", manifest`,
    );
    const rows = Schema.decodeUnknownEffect(Schema.Array(Row));
    const occupiedThreads = sql.literal(`
      SELECT thread_id FROM foundry_executions WHERE writer_ended = 0
      UNION SELECT thread_id FROM orchestration_v2_projection_runs
      WHERE status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
    `);
    const occupied = sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM (${occupiedThreads})`.pipe(
      Effect.map((result) => result[0]?.count ?? 0),
      Effect.mapError((cause) => new ExecutionStoreError({ cause })),
    );
    const read = Effect.fn("ExecutionStore.read")(
      function* (commandId: CommandId) {
        return (yield* rows(
          yield* sql`SELECT ${columns} FROM foundry_executions WHERE command_id = ${commandId}`,
        ))[0];
      },
      Effect.mapError((cause) => new ExecutionStoreError({ cause })),
    );
    const reserve = Effect.fn("ExecutionStore.reserve")(
      function* (commandId: CommandId, threadId: ThreadId, capacity = 1) {
        if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8)
          return yield* new ExecutionStoreError({ cause: "invalid_capacity" });
        const expires = (yield* Clock.currentTimeMillis) + 60_000;
        yield* sql`INSERT INTO foundry_executions(command_id, thread_id, expires_at, state)
      SELECT ${commandId}, ${threadId}, ${expires}, 'active'
      WHERE (SELECT COUNT(*) FROM (${occupiedThreads})) < ${capacity}
      AND NOT EXISTS(SELECT 1 FROM foundry_execution_cancellations WHERE launch_command_id=${commandId})
      ON CONFLICT(command_id) DO NOTHING`;
        const row = yield* read(commandId);
        if (!row)
          return yield* new ExecutionStoreError({
            code: "capacity_unavailable",
            cause: "capacity",
          });
        if (row.threadId !== threadId) return yield* new ExecutionStoreError({ cause: "binding" });
        return row;
      },
      Effect.mapError((cause) =>
        isExecutionStoreError(cause) ? cause : new ExecutionStoreError({ cause }),
      ),
    );
    const cancellation = Effect.fn("ExecutionStore.cancellation")(
      function* (commandId: CommandId) {
        const found = yield* sql<{
          launch_command_id: string;
        }>`SELECT launch_command_id FROM foundry_execution_cancellations WHERE command_id=${commandId}`;
        return found[0] ? CommandId.make(found[0].launch_command_id) : null;
      },
      Effect.mapError((cause) => new ExecutionStoreError({ cause })),
    );
    const cancelUnstarted = Effect.fn("ExecutionStore.cancelUnstarted")(
      function* (commandId: CommandId, launchCommandId: CommandId) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const prior = yield* cancellation(commandId);
            if (prior && prior !== launchCommandId)
              return yield* new ExecutionStoreError({ cause: "cancellation_conflict" });
            const entered =
              yield* sql`SELECT generation FROM foundry_executions WHERE command_id=${launchCommandId} AND provider_thread_id IS NOT NULL`;
            if (entered.length) return false;
            yield* sql`INSERT INTO foundry_execution_cancellations(command_id,launch_command_id) VALUES(${commandId},${launchCommandId}) ON CONFLICT DO NOTHING`;
            yield* sql`UPDATE foundry_executions SET stop_requested=1,writer_ended=1,state='stopped',expires_at=0 WHERE command_id=${launchCommandId} AND provider_thread_id IS NULL`;
            return true;
          }),
        );
      },
      Effect.mapError((cause) => new ExecutionStoreError({ cause })),
    );
    const renew = Effect.fn("ExecutionStore.renew")(
      function* (commandId: CommandId, generation: number) {
        const now = yield* Clock.currentTimeMillis;
        const changed = yield* sql`UPDATE foundry_executions SET expires_at = ${now + 60_000}
      WHERE command_id = ${commandId} AND generation = ${generation} AND expires_at > ${now}
      AND state IN ('active', 'finalizing') AND stop_requested = 0 RETURNING generation`;
        return changed.length === 1;
      },
      Effect.mapError((cause) => new ExecutionStoreError({ cause })),
    );
    const stop = Effect.fn("ExecutionStore.stop")(
      function* (commandId: CommandId) {
        yield* sql`UPDATE foundry_executions SET stop_requested = 1,
      writer_ended = CASE WHEN provider_thread_id IS NULL THEN 1 ELSE writer_ended END,
      state = CASE WHEN writer_ended = 1 OR provider_thread_id IS NULL THEN 'finalizing' ELSE 'stopping' END
      WHERE command_id = ${commandId} AND manifest IS NULL`;
      },
      Effect.mapError((cause) => new ExecutionStoreError({ cause })),
    );
    const uncertain = Effect.fn("ExecutionStore.uncertain")(
      function* (commandId: CommandId) {
        yield* sql`UPDATE foundry_executions SET state = 'uncertain' WHERE command_id = ${commandId} AND writer_ended = 0 AND manifest IS NULL`;
      },
      Effect.mapError((cause) => new ExecutionStoreError({ cause })),
    );
    const sweep = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* sql`UPDATE foundry_executions SET state = CASE WHEN writer_ended = 1 OR provider_thread_id IS NULL THEN 'finalizing' ELSE 'stopping' END, writer_ended = CASE WHEN provider_thread_id IS NULL THEN 1 ELSE writer_ended END, stop_requested = 1
      WHERE state IN ('active', 'finalizing') AND expires_at <= ${now} AND manifest IS NULL`;
      return yield* rows(
        yield* sql`SELECT ${columns} FROM foundry_executions WHERE manifest IS NULL AND state!='stopped'`,
      );
    }).pipe(Effect.mapError((cause) => new ExecutionStoreError({ cause })));
    const finish = Effect.fn("ExecutionStore.finish")(
      function* (commandId: CommandId, generation: number, manifest: FoundryWorkerManifest) {
        if (manifest.generation !== generation) return;
        const row = yield* read(commandId);
        if (!row || row.generation !== generation || row.writerEnded !== 1 || row.manifest !== null)
          return;
        let finalized = manifest;
        if (manifest.outcome === "completed") {
          if (manifest.checkpointId === null || manifest.checkpointRef === null) return;
          if (archive) {
            const status = yield* archive
              .reconcile(row.threadId)
              .pipe(Effect.orElseSucceed(() => null));
            if (
              !status?.complete ||
              !status.sourceComplete ||
              status.owner.threadId !== row.threadId ||
              status.confirmedCursor <= 0 ||
              status.confirmedCursor !== status.sourceHead ||
              status.confirmedSourceSequence <= 0 ||
              status.missingArtifacts.length !== 0 ||
              status.missingAttachmentCount !== 0
            )
              return;
            finalized = {
              ...manifest,
              archive: {
                instanceId: status.instanceId,
                deviceId: status.deviceId,
                deviceGeneration: status.deviceGeneration,
                owner: status.owner,
                cursor: status.confirmedCursor,
                sourceSequence: status.confirmedSourceSequence,
              },
            };
          }
        }
        yield* sql`UPDATE foundry_executions SET manifest = ${yield* encodeManifest(finalized)},
      state = ${manifest.outcome === "completed" ? "completed" : "stopped"}
      WHERE command_id = ${commandId} AND generation = ${generation} AND writer_ended = 1 AND manifest IS NULL AND (stop_requested = 0 OR ${manifest.outcome} = 'stopped')`;
      },
      Effect.mapError((cause) => new ExecutionStoreError({ cause })),
    );
    const starting = Effect.fn("ExecutionStore.starting")(
      function* (input: Parameters<ExecutionStore["Service"]["starting"]>[0]) {
        if (!input.threadId.startsWith("foundry-launch:")) return true;
        const now = yield* Clock.currentTimeMillis;
        const existing =
          yield* sql`SELECT generation FROM foundry_executions WHERE thread_id = ${input.threadId}`;
        if (existing.length === 0) return !input.threadId.startsWith("foundry-launch:");
        const changed =
          yield* sql`UPDATE foundry_executions SET provider_thread_id = ${input.providerThreadId}, run_ordinal = ${input.runOrdinal}
      WHERE thread_id = ${input.threadId} AND provider_thread_id IS NULL AND state = 'active'
      AND NOT EXISTS(SELECT 1 FROM foundry_execution_cancellations c WHERE c.launch_command_id=foundry_executions.command_id)
      AND expires_at > ${now} AND stop_requested = 0 RETURNING generation`;
        if (changed.length === 0)
          yield* sql`UPDATE foundry_executions SET writer_ended = 1, state = 'finalizing' WHERE thread_id = ${input.threadId} AND provider_thread_id IS NULL AND manifest IS NULL AND state!='stopped'`;
        return changed.length === 1;
      },
      Effect.orElseSucceed(() => false),
    );
    const confirm = Effect.fn("ExecutionStore.confirm")(
      function* (commandId: CommandId, generation: number) {
        yield* sql`UPDATE foundry_executions SET writer_ended = 1, state = 'finalizing' WHERE command_id = ${commandId} AND generation = ${generation} AND manifest IS NULL`;
      },
      Effect.mapError((cause) => new ExecutionStoreError({ cause })),
    );
    return {
      reserve,
      occupied,
      cancelUnstarted,
      cancellation,
      read,
      renew,
      stop,
      uncertain,
      sweep,
      finish,
      starting,
      confirm,
    };
  }),
);

export const layerObserver = Layer.effect(
  ExecutionObserver.ExecutionObserver,
  Effect.gen(function* () {
    const store = yield* ExecutionStore;
    return { starting: store.starting };
  }),
);
