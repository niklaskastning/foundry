import { FoundryGatewayError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AutomationDatabase from "./AutomationDatabase.ts";
import type { UnattendedGatewayIdentity } from "../foundry/GatewayGrants.ts";

export class Unattended extends Context.Service<
  Unattended,
  {
    readonly validate: (
      identity: UnattendedGatewayIdentity,
      operation?: {
        readonly commandId: string;
        readonly projectId?: string;
        readonly previousCommandId?: string;
      },
    ) => Effect.Effect<void, FoundryGatewayError>;
  }
>()("t3/automation/Unattended") {}

export const layer = Layer.effect(
  Unattended,
  Effect.gen(function* () {
    const sql = yield* AutomationDatabase.AutomationDatabase;
    const validate = Effect.fn("Unattended.validate")(
      function* (
        identity: UnattendedGatewayIdentity,
        operation?: {
          readonly commandId: string;
          readonly projectId?: string;
          readonly previousCommandId?: string;
        },
      ) {
        const rows =
          yield* sql`SELECT binding_id FROM foundry_automation.unattended_grants WHERE binding_id=${identity.bindingId} AND generation=${identity.bindingGeneration} AND enabled AND identity=${sql.json(identity)}::jsonb`;
        if (
          !rows.length ||
          (operation?.projectId !== undefined && operation.projectId !== identity.projectId)
        )
          return yield* new FoundryGatewayError({ code: "forbidden" });
        if (operation) {
          const commands =
            yield* sql`SELECT a.command_id FROM foundry_automation.step_attempts a JOIN foundry_automation.trigger_admissions t ON t.run_id=a.run_id WHERE a.command_id=${operation.commandId} AND t.binding_id=${identity.bindingId} AND t.generation=${identity.bindingGeneration} AND (${operation.previousCommandId ?? null}::text IS NULL OR EXISTS (SELECT 1 FROM foundry_automation.step_attempts previous WHERE previous.command_id=${operation.previousCommandId ?? null} AND previous.run_id=a.run_id))`;
          if (!commands.length) return yield* new FoundryGatewayError({ code: "forbidden" });
        }
      },
      Effect.mapError(() => new FoundryGatewayError({ code: "forbidden" })),
    );
    return Unattended.of({ validate });
  }),
);
