import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE foundry_executions (
    generation INTEGER PRIMARY KEY AUTOINCREMENT,
    command_id TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    state TEXT NOT NULL,
    provider_thread_id TEXT,
    run_ordinal INTEGER,
    writer_ended INTEGER NOT NULL DEFAULT 0,
    stop_requested INTEGER NOT NULL DEFAULT 0,
    manifest TEXT
  )`;
});
