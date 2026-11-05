import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE foundry_execution_cancellations (
    command_id TEXT PRIMARY KEY,
    launch_command_id TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX foundry_cancelled_launch ON foundry_execution_cancellations(launch_command_id)`;
});
