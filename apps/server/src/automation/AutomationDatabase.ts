import * as PgClient from "@effect/sql-pg/PgClient";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

export class AutomationDatabase extends Context.Service<AutomationDatabase, PgClient.PgClient>()(
  "t3/automation/AutomationDatabase",
) {}

export const layer = (config: PgClient.PgPoolConfig) =>
  Layer.effect(AutomationDatabase, PgClient.PgClient).pipe(
    Layer.provide(
      PgClient.layer({
        maxConnections: 4,
        minConnections: 0,
        connectTimeout: "2 seconds",
        applicationName: "foundry-automation",
        startupParameters: {
          statement_timeout: "5000",
          idle_in_transaction_session_timeout: "15000",
        },
        ...config,
      }),
    ),
  );
