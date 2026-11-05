import { FactoryMcpBinding, SetFactoryMcpBinding, type FactoryV4Mcp } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as AutomationDatabase from "./AutomationDatabase.ts";

export class McpBindingError extends Schema.TaggedError<McpBindingError>()("McpBindingError", {
  reason: Schema.Literals([
    "invalid_input",
    "not_found",
    "version_conflict",
    "command_conflict",
    "permission_denied",
    "unavailable",
  ]),
}) {}

const decode = Schema.decodeUnknownSync(FactoryMcpBinding, { onExcessProperty: "error" });
const decodeSet = Schema.decodeUnknownEffect(SetFactoryMcpBinding, { onExcessProperty: "error" });
const encodeDefinition = Schema.encodeSync(
  Schema.fromJsonString(FactoryMcpBinding.fields.definition),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
function sortJson(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson((value as Readonly<Record<string, Schema.Json>>)[key]!)]),
    );
  return value;
}
export const canonicalResourceJson = (value: Schema.Json) => encodeJson(sortJson(value));
export function mcpBindingMatches(
  binding: FactoryMcpBinding,
  factoryId: string,
  resource: FactoryV4Mcp,
) {
  return (
    binding.enabled &&
    binding.factoryId === factoryId &&
    binding.resourceId === resource.id &&
    canonicalResourceJson(decodeJson(encodeDefinition(binding.definition))) ===
      canonicalResourceJson(decodeJson(encodeDefinition(resource))) &&
    resource.allowedTools.every((tool) => binding.allowedTools.includes(tool))
  );
}
export class McpBindings extends Context.Service<
  McpBindings,
  {
    readonly list: (
      factoryId: string,
    ) => Effect.Effect<readonly FactoryMcpBinding[], McpBindingError>;
    readonly set: (
      input: SetFactoryMcpBinding,
    ) => Effect.Effect<FactoryMcpBinding, McpBindingError>;
    readonly authorize: (
      factoryId: string,
      resources: readonly FactoryV4Mcp[],
    ) => Effect.Effect<readonly FactoryMcpBinding[], McpBindingError>;
  }
>()("t3/automation/McpBindings") {}

const isMcpBindingError = Schema.is(McpBindingError);
const mapError = (error: unknown) =>
  isMcpBindingError(error) ? error : new McpBindingError({ reason: "unavailable" });
export const layer = Layer.effect(
  McpBindings,
  Effect.gen(function* () {
    const sql = yield* AutomationDatabase.AutomationDatabase;
    const list = Effect.fn("McpBindings.list")(function* (factoryId: string) {
      const rows = yield* sql<{
        binding: unknown;
      }>`SELECT binding FROM foundry_automation.mcp_bindings WHERE factory_id=${factoryId} ORDER BY resource_id`;
      return yield* Effect.try({
        try: () => rows.map((row) => decode(row.binding)),
        catch: mapError,
      });
    }, Effect.mapError(mapError));
    const set = Effect.fn("McpBindings.set")(function* (raw: SetFactoryMcpBinding) {
      const input = yield* decodeSet(raw).pipe(
        Effect.mapError(() => new McpBindingError({ reason: "invalid_input" })),
      );
      if (
        input.resourceId !== input.definition.id ||
        input.generation !== (input.expectedGeneration ?? 0) + 1 ||
        new Set(input.allowedTools).size !== input.allowedTools.length ||
        input.allowedTools.some((tool) => !input.definition.allowedTools.includes(tool))
      )
        return yield* new McpBindingError({ reason: "invalid_input" });
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const factory =
            yield* sql`SELECT id FROM foundry_automation.factories WHERE id=${input.factoryId} AND NOT archived FOR UPDATE`;
          if (factory.length !== 1) return yield* new McpBindingError({ reason: "not_found" });
          const prior = yield* sql<{
            same: boolean;
          }>`SELECT kind='mcp.binding' AND payload=${sql.json(input)} AS same FROM foundry_automation.commands WHERE id=${input.commandId}`;
          const {
            commandId: _commandId,
            expectedGeneration: _expectedGeneration,
            ...binding
          } = input;
          if (prior[0]) {
            if (!prior[0].same) return yield* new McpBindingError({ reason: "command_conflict" });
            return binding;
          }
          const rows = yield* sql<{
            generation: number;
          }>`SELECT generation FROM foundry_automation.mcp_bindings WHERE factory_id=${input.factoryId} AND resource_id=${input.resourceId} FOR UPDATE`;
          if ((rows[0]?.generation ?? null) !== input.expectedGeneration)
            return yield* new McpBindingError({ reason: "version_conflict" });
          yield* sql`INSERT INTO foundry_automation.mcp_bindings(factory_id,resource_id,generation,binding) VALUES(${input.factoryId},${input.resourceId},${input.generation},${sql.json(binding)}) ON CONFLICT(factory_id,resource_id) DO UPDATE SET generation=EXCLUDED.generation,binding=EXCLUDED.binding`;
          yield* sql`INSERT INTO foundry_automation.commands(id,kind,payload) VALUES(${input.commandId},'mcp.binding',${sql.json(input)})`;
          return binding;
        }),
      );
    }, Effect.mapError(mapError));
    const authorize = Effect.fn("McpBindings.authorize")(function* (
      factoryId: string,
      resources: readonly FactoryV4Mcp[],
    ) {
      const bindings = yield* list(factoryId);
      const authorized: FactoryMcpBinding[] = [];
      for (const resource of resources) {
        const binding = bindings.find((binding) => mcpBindingMatches(binding, factoryId, resource));
        if (!binding) return yield* new McpBindingError({ reason: "permission_denied" });
        authorized.push(binding);
      }
      return authorized;
    });
    return McpBindings.of({ list, set, authorize });
  }),
);
