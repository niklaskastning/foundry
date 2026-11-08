import * as McpBindings from "./McpBindings.ts";
import * as MachineAccess from "./MachineAccess.ts";
import * as Handoffs from "./Handoffs.ts";
import * as DefinitionSources from "./DefinitionSources.ts";
import * as DefinitionSync from "./DefinitionSync.ts";
import * as Triggers from "./Triggers.ts";
import * as Unattended from "./Unattended.ts";
import * as GitHubPolling from "./GitHubPolling.ts";
import * as GitHubApp from "./GitHubApp.ts";
import * as Publish from "./Publish.ts";
import * as ScheduleTriggers from "./ScheduleTriggers.ts";
import { nextScheduleOccurrence } from "./Schedule.ts";
import * as DateTime from "effect/DateTime";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { AutomationTriggerError } from "@t3tools/contracts";
import * as AutomationHttp from "./Http.ts";
import * as ApiHttp from "./ApiHttp.ts";
import * as Application from "./Application.ts";
import * as Control from "./Control.ts";
import * as Inbox from "./Inbox.ts";
import * as Definitions from "./Definitions.ts";
import { EnvironmentId, FoundryDeviceId } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import * as ByteSize from "effect/ByteSize";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as AutomationDatabase from "./AutomationDatabase.ts";
import * as DispatchStore from "./DispatchStore.ts";
import * as Factories from "./Factories.ts";
import * as Workflows from "./Workflows.ts";
import * as Scheduler from "./Scheduler.ts";
import * as WorkerTransport from "./WorkerTransport.ts";

const Target = Schema.Struct({
  deviceId: FoundryDeviceId,
  environmentId: EnvironmentId,
  workers: Schema.optional(
    Schema.Array(Schema.Struct({ deviceId: FoundryDeviceId, environmentId: EnvironmentId })).check(
      Schema.isMaxLength(8),
    ),
  ),
  allowedRunIds: Schema.Array(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  ).check(Schema.isMaxLength(100)),
});
const Request = Schema.Union([
  Schema.Struct({ op: Schema.Literal("enroll"), input: Scheduler.EnrollDispatch }),
  Schema.Struct({ op: Schema.Literal("read"), factoryId: Schema.String, runId: Schema.String }),
]);
const databaseIdentity = Effect.fn("AutomationRuntime.databaseIdentity")(
  (value: Redacted.Redacted<string>) =>
    Effect.try({
      try: () => {
        const url = new URL(Redacted.value(value));
        return {
          database: decodeURIComponent(url.pathname),
          role: decodeURIComponent(url.username),
        };
      },
      catch: () => new Scheduler.SchedulerError({ reason: "invalid_binding" }),
    }),
);

const routes = Layer.unwrap(
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    return HttpRouter.add(
      "POST",
      "/api/foundry/automation/dispatch",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const input = yield* HttpServerRequest.schemaBodyJson(Request);
        const result =
          input.op === "enroll"
            ? yield* scheduler.enroll(request, input.input)
            : yield* scheduler.read(request, input.factoryId, input.runId);
        return HttpServerResponse.jsonUnsafe(
          {
            run: result.run,
            state: result.state,
            reason: result.reason,
            workerId: result.workerId,
            attempts: result.attempts,
          },
          { headers: { "cache-control": "no-store" } },
        );
      }).pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(256 * 1024)),
        Effect.orElseSucceed(() =>
          HttpServerResponse.jsonUnsafe(
            { code: "dispatch_unavailable" },
            { status: 409, headers: { "cache-control": "no-store" } },
          ),
        ),
      ),
    );
  }),
);
export const reconciliationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const triggers = yield* Triggers.Triggers;
    const polling = yield* GitHubPolling.GitHubPolling;
    const definitionSync = yield* DefinitionSync.DefinitionSync;
    const schedules = yield* ScheduleTriggers.ScheduleTriggers;
    const start = Effect.fn("AutomationRuntime.reconcile")(<A, E>(tick: Effect.Effect<A, E>) =>
      tick.pipe(
        Effect.catch(() => Effect.logWarning("Automation reconciliation unavailable")),
        Effect.repeat(Schedule.spaced("5 seconds")),
        Effect.forkScoped,
      ),
    );
    // Slow external input must not delay the active writer's lease renewal.
    yield* start(polling.tick);
    yield* start(definitionSync.tick);
    yield* start(schedules.tick);
    yield* start(triggers.tick);
    yield* start(scheduler.tick);
  }),
);

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const enabled = yield* Config.Boolean("FOUNDRY_AUTOMATION_ENABLED").pipe(
      Config.withDefault(false),
    );
    if (!enabled) return Layer.empty;
    const artifacts = yield* Config.Boolean("FOUNDRY_ARTIFACTS_ENABLED").pipe(
      Config.withDefault(false),
    );
    if (!artifacts) return yield* new Scheduler.SchedulerError({ reason: "invalid_binding" });
    const url = yield* Config.Redacted("FOUNDRY_AUTOMATION_DATABASE_URL");
    const instanceUrl = yield* Config.Redacted("FOUNDRY_INSTANCE_DATABASE_URL");
    const address = yield* databaseIdentity(url);
    const instance = yield* databaseIdentity(instanceUrl);
    if (address.database === instance.database || address.role === instance.role)
      return yield* new Scheduler.SchedulerError({ reason: "invalid_binding" });
    const target = yield* Config.String("FOUNDRY_AUTOMATION_TARGET").pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.fromJsonString(Target), { onExcessProperty: "error" }),
      ),
    );
    const database = AutomationDatabase.layer({ url });
    const ready = Layer.effectDiscard(
      Effect.gen(function* () {
        const sql = yield* AutomationDatabase.AutomationDatabase;
        const rows = yield* sql<{
          version: number;
          safe: boolean;
        }>`SELECT version, NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR has_schema_privilege(current_user,'foundry_automation','CREATE') OR has_database_privilege(current_user,current_database(),'CREATE')) AS safe FROM foundry_automation.schema_version,pg_roles r WHERE r.rolname=current_user`;
        if (rows.length !== 1 || rows[0]?.version !== 11 || !rows[0].safe)
          return yield* new Scheduler.SchedulerError({ reason: "invalid_binding" });
      }),
    ).pipe(Layer.provide(database));
    return Layer.mergeAll(routes, AutomationHttp.layer, ApiHttp.layer, reconciliationLayer)
      .pipe(
        Layer.provide(Application.layer.pipe(Layer.provide(Handoffs.layer))),
        Layer.provide(DefinitionSync.layer.pipe(Layer.provideMerge(DefinitionSources.layer))),
        Layer.provide(GitHubPolling.layer),
        Layer.provide(ScheduleTriggers.layer),
        Layer.provide(Triggers.layer),
        Layer.provide(Inbox.layer),
        Layer.provide(Control.layer),
        Layer.provide(Definitions.layer),
        Layer.provide(Scheduler.layer),
        Layer.provide(Publish.layer),
        Layer.provide(GitHubApp.layer),
        Layer.provide(WorkerTransport.layer),
        Layer.provide(Unattended.layer),
        Layer.provide(Layer.merge(DispatchStore.layer, McpBindings.layer)),
        Layer.provide(Workflows.layer),
        Layer.provide(MachineAccess.layer),
        Layer.provide(Factories.layer),
        Layer.provide(Layer.succeed(Scheduler.SchedulerConfig, target)),
        Layer.provide(
          Layer.succeed(Triggers.TriggerConfig, {
            ...target,
            nextSchedule: Effect.fn("Triggers.TriggerConfig.nextSchedule")((config, now) =>
              Effect.try({
                try: () =>
                  DateTime.toEpochMillis(
                    DateTime.makeUnsafe(nextScheduleOccurrence(config, DateTime.makeUnsafe(now))),
                  ),
                catch: () => new AutomationTriggerError({ code: "invalid_input" }),
              }),
            ),
          }),
        ),
        Layer.provide(FetchHttpClient.layer),
      )
      .pipe(Layer.provide(database), Layer.provide(ready));
  }),
);
