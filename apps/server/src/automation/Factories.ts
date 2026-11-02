import {
  AutomationFactory,
  AutomationFactoryVersion,
  AutomationWorkItem,
  AutomationWorkItemState,
  CreateAutomationFactory,
  CreateAutomationVersion,
  CreateAutomationWorkItem,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as AutomationDatabase from "./AutomationDatabase.ts";

export class AutomationError extends Schema.TaggedError<AutomationError>()("AutomationError", {
  reason: Schema.Literals([
    "invalid_input",
    "not_found",
    "scope_mismatch",
    "archived",
    "command_conflict",
    "unavailable",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Automation operation failed (${this.reason}).`;
  }
}
const isAutomationError = Schema.is(AutomationError);
const decodeFactory = Schema.decodeEffect(CreateAutomationFactory);
const decodeVersion = Schema.decodeEffect(CreateAutomationVersion);
const decodeWorkItem = Schema.decodeEffect(CreateAutomationWorkItem);
const decodeState = Schema.decodeEffect(AutomationWorkItemState);
export class Factories extends Context.Service<
  Factories,
  {
    readonly createFactory: (
      input: typeof CreateAutomationFactory.Type,
    ) => Effect.Effect<AutomationFactory, AutomationError>;
    readonly createVersion: (
      input: typeof CreateAutomationVersion.Type,
    ) => Effect.Effect<AutomationFactoryVersion, AutomationError>;
    readonly createWorkItem: (
      input: typeof CreateAutomationWorkItem.Type,
    ) => Effect.Effect<AutomationWorkItem, AutomationError>;
    readonly readFactory: (id: string) => Effect.Effect<AutomationFactory, AutomationError>;
    readonly readVersion: (
      factoryId: string,
      id: string,
    ) => Effect.Effect<AutomationFactoryVersion, AutomationError>;
    readonly readWorkItem: (
      factoryId: string,
      id: string,
    ) => Effect.Effect<AutomationWorkItem, AutomationError>;
    readonly setArchived: (id: string, archived: boolean) => Effect.Effect<void, AutomationError>;
    readonly setWorkItemState: (
      factoryId: string,
      id: string,
      state: typeof AutomationWorkItemState.Type,
    ) => Effect.Effect<void, AutomationError>;
    // P18b must compose this guard and its durable start in the same database transaction.
    readonly withStartEligibility: <A, R>(
      factoryId: string,
      workItemId: string,
      start: Effect.Effect<A, AutomationError, R>,
    ) => Effect.Effect<A, AutomationError, R>;
  }
>()("t3/automation/Factories") {}
const make = Effect.gen(function* () {
  const sql = yield* AutomationDatabase.AutomationDatabase;
  const storageError = (cause: unknown) => new AutomationError({ reason: "unavailable", cause });
  const readFactory = Effect.fn("Factories.readFactory")(function* (id: string) {
    const rows =
      yield* sql<AutomationFactory>`SELECT id,name,archived FROM foundry_automation.factories WHERE id=${id}`.pipe(
        Effect.mapError(storageError),
      );
    if (!rows[0]) return yield* new AutomationError({ reason: "not_found" });
    return rows[0];
  });
  const lockFactory = Effect.fn("Factories.lockFactory")(function* (id: string) {
    yield* sql`SELECT id FROM foundry_automation.factories WHERE id=${id} FOR UPDATE`.pipe(
      Effect.mapError(storageError),
    );
    return yield* readFactory(id);
  });
  const readVersion = Effect.fn("Factories.readVersion")(function* (factoryId: string, id: string) {
    const rows =
      yield* sql<AutomationFactoryVersion>`SELECT id,factory_id AS "factoryId",repositories FROM foundry_automation.versions WHERE id=${id} AND factory_id=${factoryId}`.pipe(
        Effect.mapError(storageError),
      );
    if (!rows[0]) return yield* new AutomationError({ reason: "not_found" });
    return rows[0];
  });
  const readWorkItem = Effect.fn("Factories.readWorkItem")(function* (
    factoryId: string,
    id: string,
  ) {
    const rows =
      yield* sql<AutomationWorkItem>`SELECT id,factory_id AS "factoryId",version_id AS "versionId",repository,title,source,state FROM foundry_automation.work_items WHERE id=${id} AND factory_id=${factoryId}`.pipe(
        Effect.mapError(storageError),
      );
    if (!rows[0]) return yield* new AutomationError({ reason: "not_found" });
    return rows[0];
  });
  const claim = Effect.fn("Factories.claimCommand")(function* (
    commandId: string,
    kind: string,
    payload: unknown,
  ) {
    const inserted =
      yield* sql`INSERT INTO foundry_automation.commands(id,kind,payload) VALUES(${commandId},${kind},${sql.json(payload)}) ON CONFLICT DO NOTHING RETURNING id`.pipe(
        Effect.mapError(storageError),
      );
    const rows = yield* sql<{
      same: boolean;
    }>`SELECT kind=${kind} AND payload=${sql.json(payload)}::jsonb AS same FROM foundry_automation.commands WHERE id=${commandId}`.pipe(
      Effect.mapError(storageError),
    );
    if (rows[0]?.same !== true) return yield* new AutomationError({ reason: "command_conflict" });
    return inserted.length > 0;
  });
  const createFactory = Effect.fn("Factories.createFactory")(
    function* (raw: typeof CreateAutomationFactory.Type) {
      const input = yield* decodeFactory(raw).pipe(
        Effect.mapError((cause) => new AutomationError({ reason: "invalid_input", cause })),
      );
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          if (yield* claim(input.commandId, "factory", input))
            yield* sql`INSERT INTO foundry_automation.factories(id,name) VALUES(${input.id},${input.name})`.pipe(
              Effect.mapError(storageError),
            );
          return yield* readFactory(input.id);
        }),
      );
    },
    Effect.mapError((cause) => (isAutomationError(cause) ? cause : storageError(cause))),
  );
  const createVersion = Effect.fn("Factories.createVersion")(
    function* (raw: typeof CreateAutomationVersion.Type) {
      const input = yield* decodeVersion(raw).pipe(
        Effect.mapError((cause) => new AutomationError({ reason: "invalid_input", cause })),
      );
      if (
        !input.repositories.length ||
        new Set(input.repositories).size !== input.repositories.length
      )
        return yield* new AutomationError({ reason: "invalid_input" });
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          if (yield* claim(input.commandId, "version", input)) {
            yield* lockFactory(input.factoryId);
            yield* sql`INSERT INTO foundry_automation.versions(id,factory_id,repositories) VALUES(${input.id},${input.factoryId},${input.repositories})`.pipe(
              Effect.mapError(storageError),
            );
          }
          return yield* readVersion(input.factoryId, input.id);
        }),
      );
    },
    Effect.mapError((cause) => (isAutomationError(cause) ? cause : storageError(cause))),
  );
  const createWorkItem = Effect.fn("Factories.createWorkItem")(
    function* (raw: typeof CreateAutomationWorkItem.Type) {
      const input = yield* decodeWorkItem(raw).pipe(
        Effect.mapError((cause) => new AutomationError({ reason: "invalid_input", cause })),
      );
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          if (yield* claim(input.commandId, "workItem", input)) {
            yield* lockFactory(input.factoryId);
            const version = yield* readVersion(input.factoryId, input.versionId);
            if (!version.repositories.includes(input.repository))
              return yield* new AutomationError({ reason: "scope_mismatch" });
            yield* sql`INSERT INTO foundry_automation.work_items(id,factory_id,version_id,repository,title,source) VALUES(${input.id},${input.factoryId},${input.versionId},${input.repository},${input.title},${sql.json(input.source)})`.pipe(
              Effect.mapError(storageError),
            );
          }
          return yield* readWorkItem(input.factoryId, input.id);
        }),
      );
    },
    Effect.mapError((cause) => (isAutomationError(cause) ? cause : storageError(cause))),
  );
  const setArchived = Effect.fn("Factories.setArchived")(function* (id: string, archived: boolean) {
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* lockFactory(id);
          yield* sql`UPDATE foundry_automation.factories SET archived=${archived} WHERE id=${id}`.pipe(
            Effect.mapError(storageError),
          );
        }),
      )
      .pipe(Effect.mapError((cause) => (isAutomationError(cause) ? cause : storageError(cause))));
  });
  const setWorkItemState = Effect.fn("Factories.setWorkItemState")(function* (
    factoryId: string,
    id: string,
    raw: typeof AutomationWorkItemState.Type,
  ) {
    const state = yield* decodeState(raw).pipe(
      Effect.mapError((cause) => new AutomationError({ reason: "invalid_input", cause })),
    );
    const rows =
      yield* sql`UPDATE foundry_automation.work_items SET state=${state} WHERE id=${id} AND factory_id=${factoryId} RETURNING id`.pipe(
        Effect.mapError(storageError),
      );
    if (!rows.length) return yield* new AutomationError({ reason: "not_found" });
  });
  const withStartEligibility = Effect.fn("Factories.withStartEligibility")(function* <A, R>(
    factoryId: string,
    workItemId: string,
    start: Effect.Effect<A, AutomationError, R>,
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const factory = yield* lockFactory(factoryId);
          if (factory.archived) return yield* new AutomationError({ reason: "archived" });
          yield* readWorkItem(factoryId, workItemId);
          return yield* start;
        }),
      )
      .pipe(Effect.mapError((cause) => (isAutomationError(cause) ? cause : storageError(cause))));
  });
  return Factories.of({
    createFactory,
    createVersion,
    createWorkItem,
    readFactory,
    readVersion,
    readWorkItem,
    setArchived,
    setWorkItemState,
    withStartEligibility,
  });
});
export const layer = Layer.effect(Factories, make);
