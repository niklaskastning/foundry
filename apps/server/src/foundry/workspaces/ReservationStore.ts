import * as NodeSqlite from "node:sqlite";
import { FoundryWorkspaceError, FoundryWorkspaceReservation } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const decodeReservation = Schema.decodeUnknownEffect(FoundryWorkspaceReservation);

export class ReservationStore extends Context.Service<
  ReservationStore,
  {
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
          CREATE UNIQUE INDEX IF NOT EXISTS active_writer ON reservations(workspace_path) WHERE state != 'released';`);
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
      return ReservationStore.of({
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
