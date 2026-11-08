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
const isWorkspaceError = Schema.is(FoundryWorkspaceError);
const decodeBindings = Schema.decodeUnknownEffect(Schema.Array(WriterBinding));
const decodeReservation = Schema.decodeUnknownEffect(FoundryWorkspaceReservation);

export interface HandoffRow {
  readonly id: string;
  readonly threadId: string;
  readonly workspacePath: string;
  readonly state: "opening" | "open" | "closing" | "returned";
  readonly payload: string;
  readonly receipt: string | null;
  readonly result: string | null;
  readonly closingCommand: string | null;
}

export class ReservationStore extends Context.Service<
  ReservationStore,
  {
    readonly handoff: (id: string) => Effect.Effect<HandoffRow | null, FoundryWorkspaceError>;
    readonly hold: (input: HandoffRow) => Effect.Effect<boolean, FoundryWorkspaceError>;
    readonly transitionHandoff: (
      id: string,
      from: HandoffRow["state"],
      to: HandoffRow["state"],
      value?: {
        receipt?: string;
        result?: string;
        closingCommand?: string;
        command?: { id: string; payload: string; result: string };
      },
    ) => Effect.Effect<boolean, FoundryWorkspaceError>;
    readonly handoffAllowed: (
      threadId: string,
      cwd: string,
    ) => Effect.Effect<boolean, FoundryWorkspaceError>;
    readonly handoffCommand: (
      commandId: string,
      payload: string,
      result?: string,
    ) => Effect.Effect<string | null, FoundryWorkspaceError>;
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
      threadId?: string,
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
          CREATE TABLE IF NOT EXISTS handoffs (
            id TEXT PRIMARY KEY, thread_id TEXT NOT NULL UNIQUE, workspace_path TEXT NOT NULL,
            state TEXT NOT NULL, payload TEXT NOT NULL, receipt TEXT, result TEXT, closing_command TEXT);
          CREATE UNIQUE INDEX IF NOT EXISTS active_handoff ON handoffs(workspace_path) WHERE state != 'returned';
          CREATE UNIQUE INDEX IF NOT EXISTS single_handoff ON handoffs((1)) WHERE state != 'returned';
          CREATE TABLE IF NOT EXISTS handoff_commands (id TEXT PRIMARY KEY, payload TEXT NOT NULL, result TEXT);
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
          catch: (cause) =>
            isWorkspaceError(cause)
              ? cause
              : new FoundryWorkspaceError({ code: "storage_failed", cause }),
        }),
        (connection) => Effect.sync(() => connection.close()),
      );
      const io = <A>(operation: () => A) =>
        Effect.try({
          try: operation,
          catch: (cause) =>
            isWorkspaceError(cause)
              ? cause
              : new FoundryWorkspaceError({ code: "storage_failed", cause }),
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
      const handoff = Effect.fn("ReservationStore.handoff")((id: string) =>
        io(() => {
          const row = db
            .prepare(
              "SELECT id,thread_id AS threadId,workspace_path AS workspacePath,state,payload,receipt,result,closing_command AS closingCommand FROM handoffs WHERE id=?",
            )
            .get(id);
          return row ? (row as unknown as HandoffRow) : null;
        }),
      );
      return ReservationStore.of({
        handoff,
        hold: Effect.fn("ReservationStore.hold")((input) =>
          io(
            () =>
              db
                .prepare(
                  "INSERT OR IGNORE INTO handoffs SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM reservations WHERE state!='released')",
                )
                .run(
                  input.id,
                  input.threadId,
                  input.workspacePath,
                  input.state,
                  input.payload,
                  input.receipt,
                  input.result,
                  input.closingCommand,
                ).changes === 1,
          ),
        ),
        transitionHandoff: Effect.fn("ReservationStore.transitionHandoff")((id, from, to, value) =>
          io(() => {
            db.exec("BEGIN IMMEDIATE");
            try {
              const changed =
                db
                  .prepare(
                    "UPDATE handoffs SET state=?,receipt=COALESCE(?,receipt),result=COALESCE(?,result),closing_command=COALESCE(?,closing_command) WHERE id=? AND state=?",
                  )
                  .run(
                    to,
                    value?.receipt ?? null,
                    value?.result ?? null,
                    value?.closingCommand ?? null,
                    id,
                    from,
                  ).changes === 1;
              if (changed && value?.command) {
                const command = value.command;
                const recorded = db
                  .prepare(
                    "UPDATE handoff_commands SET result=? WHERE id=? AND payload=? AND result IS NULL",
                  )
                  .run(command.result, command.id, command.payload).changes;
                if (recorded !== 1) throw new FoundryWorkspaceError({ code: "request_conflict" });
              }
              db.exec("COMMIT");
              return changed;
            } catch (cause) {
              db.exec("ROLLBACK");
              throw cause;
            }
          }),
        ),
        handoffAllowed: Effect.fn("ReservationStore.handoffAllowed")((threadId, cwd) =>
          io(
            () =>
              !db
                .prepare(
                  "SELECT 1 FROM handoffs WHERE (thread_id=? AND (state!='open' OR workspace_path!=?)) OR (state!='returned' AND (thread_id!=? OR state!='open')) LIMIT 1",
                )
                .get(threadId, cwd, threadId),
          ),
        ),
        handoffCommand: Effect.fn("ReservationStore.handoffCommand")((commandId, payload, result) =>
          io(() => {
            db.prepare(
              "INSERT OR IGNORE INTO handoff_commands(id,payload,result) VALUES(?,?,NULL)",
            ).run(commandId, payload);
            const row = db
              .prepare("SELECT payload,result FROM handoff_commands WHERE id=?")
              .get(commandId);
            if (row?.payload !== payload)
              throw new FoundryWorkspaceError({ code: "request_conflict" });
            if (result !== undefined)
              db.prepare("UPDATE handoff_commands SET result=? WHERE id=? AND result IS NULL").run(
                result,
                commandId,
              );
            return row.result === null ? null : String(row.result);
          }),
        ),
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
            AND EXISTS(SELECT 1 FROM reservations WHERE request_id=? AND state='ready')
            AND NOT EXISTS(SELECT 1 FROM handoffs h JOIN reservations r ON r.request_id=writer_bindings.request_id
              WHERE (h.thread_id=writer_bindings.thread_id AND (h.state!='open' OR h.workspace_path!=r.workspace_path))
              OR (h.state!='returned' AND (h.thread_id!=writer_bindings.thread_id OR h.state!='open')))`)

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
        claim: Effect.fn("ReservationStore.claim")((reservation, threadId) =>
          io(
            () =>
              db
                .prepare(`INSERT OR IGNORE INTO reservations SELECT ?, ?, ?, ?
                  WHERE NOT EXISTS(SELECT 1 FROM handoffs WHERE (thread_id=? AND (state!='open' OR workspace_path!=?))
                    OR (state!='returned' AND (thread_id!=? OR state!='open')))`)
                .run(
                  reservation.requestId,
                  reservation.workspacePath,
                  reservation.state,
                  JSON.stringify(reservation),
                  threadId ?? "",
                  reservation.workspacePath,
                  threadId ?? "",
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
