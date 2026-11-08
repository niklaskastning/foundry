import * as Schema from "effect/Schema";
import { SecretReference } from "../secretReference.ts";
import { FactoryV4Id, FactoryV4Mcp } from "./definitionV4.ts";

const Key = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
export const FactoryMcpBinding = Schema.Struct({
  factoryId: Key,
  resourceId: FactoryV4Id,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  enabled: Schema.Boolean,
  definition: FactoryV4Mcp,
  allowedTools: Schema.Array(Schema.String).check(Schema.isMaxLength(100)),
  secrets: Schema.Record(FactoryV4Id, SecretReference),
});
export type FactoryMcpBinding = typeof FactoryMcpBinding.Type;
export const SetFactoryMcpBinding = Schema.Struct({
  commandId: Key,
  ...FactoryMcpBinding.fields,
  expectedGeneration: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type SetFactoryMcpBinding = typeof SetFactoryMcpBinding.Type;
