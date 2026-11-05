// @effect-diagnostics nodeBuiltinImport:off -- This gate verifies binding authorization and command replay in real PostgreSQL.
import * as NodeAssert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Database from "../src/automation/AutomationDatabase.ts";
import * as Factories from "../src/automation/Factories.ts";
import * as McpBindings from "../src/automation/McpBindings.ts";

export const v4McpGates = Effect.fn("AutomationV4.mcpGates")(function* <E>(
  database: Layer.Layer<Database.AutomationDatabase, E>,
) {
  const services = McpBindings.layer.pipe(
    Layer.provideMerge(Factories.layer),
    Layer.provide(database),
  );
  yield* Effect.gen(function* () {
    const factories = yield* Factories.Factories;
    const bindings = yield* McpBindings.McpBindings;
    yield* factories.createFactory({
      commandId: "mcp-v4-factory",
      id: "mcp-v4",
      name: "MCP v4",
    });
    const definition = {
      id: "docs",
      name: "Docs",
      transport: "streamable-http" as const,
      url: "https://fixture.invalid/mcp",
      allowedTools: ["read"],
    };
    const input = {
      commandId: "mcp-grant",
      factoryId: "mcp-v4",
      resourceId: "docs",
      generation: 1,
      expectedGeneration: null,
      enabled: true,
      definition,
      allowedTools: ["read"],
      secrets: {},
    };
    const first = yield* bindings.set(input);
    NodeAssert.deepEqual(yield* bindings.set(input), first);
    NodeAssert.deepEqual(yield* bindings.authorize("mcp-v4", [definition]), [first]);
    const wrongTarget = yield* bindings
      .authorize("mcp-v4", [{ ...definition, url: "https://other.invalid/mcp" }])
      .pipe(Effect.result);
    NodeAssert.equal(wrongTarget._tag, "Failure");
    if (wrongTarget._tag === "Failure")
      NodeAssert.equal(wrongTarget.failure.reason, "permission_denied");
    const deniedTool = yield* bindings
      .authorize("mcp-v4", [{ ...definition, allowedTools: ["write"] }])
      .pipe(Effect.result);
    NodeAssert.equal(deniedTool._tag, "Failure");
    const conflict = yield* bindings.set({ ...input, enabled: false }).pipe(Effect.result);
    NodeAssert.equal(conflict._tag, "Failure");
    if (conflict._tag === "Failure") NodeAssert.equal(conflict.failure.reason, "command_conflict");
    const results = yield* Effect.all(
      [
        bindings
          .set({
            ...input,
            commandId: "mcp-revoke-a",
            generation: 2,
            expectedGeneration: 1,
            enabled: false,
          })
          .pipe(Effect.result),
        bindings
          .set({
            ...input,
            commandId: "mcp-revoke-b",
            generation: 2,
            expectedGeneration: 1,
            enabled: false,
          })
          .pipe(Effect.result),
      ],
      { concurrency: 2 },
    );
    NodeAssert.equal(results.filter((result) => result._tag === "Success").length, 1);
    const conflictRace = results.find((result) => result._tag === "Failure");
    NodeAssert.equal(
      conflictRace?._tag === "Failure" ? conflictRace.failure.reason : undefined,
      "version_conflict",
    );
    NodeAssert.deepEqual(yield* bindings.set(input), first);
    NodeAssert.equal(
      (yield* bindings.authorize("mcp-v4", [definition]).pipe(Effect.result))._tag,
      "Failure",
    );
    NodeAssert.equal((yield* bindings.list("mcp-v4"))[0]?.generation, 2);
  }).pipe(Effect.provide(services));
});
