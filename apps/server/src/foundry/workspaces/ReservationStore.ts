import * as NodeSqlite from "node:sqlite";
import { FoundryWorkspaceError, FoundryWorkspaceReservation } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const WriterBinding = Schema.Struct({
  requestId: Schema.String,
  threadId: Schema.String,
  commandId: Schema.NullOr(Schema.String),
  generation: Schema.NullOr(Schema.Number),
  runId: Schema.NullOr(Schema.String),
  attemptId: Schema.NullOr(Schema.String),
  closed: Schema.Number,
  verified: Schema.Number,
});
export type WriterBinding = typeof WriterBinding.Type;
const decodeBindings = Schema.decodeUnknownEffect(Schema.Array(WriterBinding));
const decodeReservation = Schema.decodeUnknownEffect(FoundryWorkspaceReservation);

export class ReservationStore extends Context.Service<
  ReservationStore,
  {
    readonly bindings: Effect.Effect<ReadonlyArray<WriterBinding>, FoundryWorkspaceError>;
    readonly bind: (
      binding: Omit<WriterBinding, "runId" | "attemptId" | "closed" | "verified">,
    ) => Effect.Effect<void, FoundryWorkspaceError>;
    readonly enter: (
      requestId: string,
      threadId: string,
      runId: string,
      attemptId?: string,
    ) => Effect.Effect<boolean, FoundryWorkspaceError>;
    readonly confirm: (requestId: string) => Effect.Effect<void, FoundryWorkspaceError>;
    readonly read: (
      requestId: string,
    ) => Effect.Effect<FoundryWorkspaceReservation, FoundryWorkspaceError>;
    readonly claim: (
      reservation: FoundryWorkspaceReservation,
    ) => Effect.Effect<boolean, FoundryWorkspaceError>;
    readonly setState: (
      requestId: string,
      state: "ready" | "released",
    ) => Effect.Effect<void, FoundryWorkspaceError>;
  }
>()("t3/foundry/workspaces/ReservationStore") {}

// A dedicated worker-local journal, never the T3 database or central Automation store.
export const layer = (filename: string) =>
  Layer.effect(
    ReservationStore,
    Effect.gen(function* () {
      const db = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            const connection = new NodeSqlite.DatabaseSync(filename);
            try {
              const id = connection.prepare("PRAGMA application_id").get()?.application_id;
              const tables = connection
                .prepare("SELECT name FROM sqlite_master WHERE type='table'")
                .all();
              if (id !== 1179797335 && (id !== 0 || tables.length !== 0))
                throw new Error("Foreign database");
              connection.exec(`PRAGMA application_id=1179797335;
          CREATE TABLE IF NOT EXISTS reservations (
            request_id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('allocating','ready','released')), payload TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS writer_bindings (
            request_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, command_id TEXT, generation INTEGER,
            run_id TEXT, attempt_id TEXT, closed INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0);
          CREATE UNIQUE INDEX IF NOT EXISTS active_writer ON reservations(workspace_path) WHERE state != 'released';`);
              if (
                !connection
                  .prepare("PRAGMA table_info(writer_bindings)")
                  .all()
                  .some((column) => column.name === "attempt_id")
              )
                connection.exec("ALTER TABLE writer_bindings ADD COLUMN attempt_id TEXT");
              return connection;
            } catch (cause) {
              connection.close();
              throw cause;
            }
          },
          catch: (cause) => new FoundryWorkspaceError({ code: "storage_failed", cause }),
        }),
        (connection) => Effect.sync(() => connection.close()),
      );
      const io = <A>(operation: () => A) =>
        Effect.try({
          try: operation,
          catch: (cause) => new FoundryWorkspaceError({ code: "storage_failed", cause }),
        });
      const read = Effect.fn("ReservationStore.read")(function* (requestId: string) {
        const row = yield* io(() =>
          db.prepare("SELECT payload, state FROM reservations WHERE request_id=?").get(requestId),
        );
        if (!row) return yield* new FoundryWorkspaceError({ code: "not_found" });
        return yield* decodeReservation(
          yield* io(() => ({ ...JSON.parse(String(row.payload)), state: row.state })),
        ).pipe(
          Effect.mapError((cause) => new FoundryWorkspaceError({ code: "storage_failed", cause })),
        );
      });
      const bindings = io(() =>
        db
          .prepare(`SELECT b.request_id AS requestId, b.thread_id AS threadId,
        b.command_id AS commandId, b.generation, b.run_id AS runId, b.attempt_id AS attemptId, b.closed, b.verified
        FROM writer_bindings b JOIN reservations r ON r.request_id=b.request_id WHERE r.state!='released'`)
          .all(),
      ).pipe(
        Effect.flatMap(decodeBindings),
        Effect.mapError((cause) => new FoundryWorkspaceError({ code: "storage_failed", cause })),
      );
      return ReservationStore.of({
        bindings,
        bind: Effect.fn("ReservationStore.bind")((binding) =>
          io(() => {
            db.prepare(
              "INSERT OR IGNORE INTO writer_bindings(request_id,thread_id,command_id,generation) VALUES(?,?,?,?)",
            ).run(binding.requestId, binding.threadId, binding.commandId, binding.generation);
            const row = db
              .prepare(
                "SELECT thread_id, command_id, generation, closed FROM writer_bindings WHERE request_id=?",
              )
              .get(binding.requestId);
            if (
              !row ||
              row.thread_id !== binding.threadId ||
              row.command_id !== binding.commandId ||
              row.generation !== binding.generation ||
              row.closed !== 0
            )
              throw new Error("Writer binding conflict");
          }),
        ),
        enter: Effect.fn("ReservationStore.enter")((requestId, threadId, runId, attemptId) =>
          io(
            () =>
              db
                .prepare(`UPDATE writer_bindings SET run_id=?, attempt_id=? WHERE request_id=? AND thread_id=? AND run_id IS NULL AND closed=0
            AND EXISTS(SELECT 1 FROM reservations WHERE request_id=? AND state='ready')`)
                .run(runId, attemptId ?? null, requestId, threadId, requestId).changes === 1,
          ),
        ),
        confirm: Effect.fn("ReservationStore.confirm")((requestId) =>
          io(() => {
            db.prepare("UPDATE writer_bindings SET closed=1, verified=1 WHERE request_id=?").run(
              requestId,
            );
          }),
        ),
        read,
        claim: Effect.fn("ReservationStore.claim")((reservation) =>
          io(
            () =>
              db
                .prepare("INSERT OR IGNORE INTO reservations VALUES (?, ?, ?, ?)")
                .run(
                  reservation.requestId,
                  reservation.workspacePath,
                  reservation.state,
                  JSON.stringify(reservation),
                ).changes === 1,
          ),
        ),
        setState: Effect.fn("ReservationStore.setState")((requestId, state) =>
          io(() => {
            db.prepare(
              "UPDATE reservations SET state=? WHERE request_id=? AND state != 'released'",
            ).run(state, requestId);
          }),
        ),
      });
    }),
  );
