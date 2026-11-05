import { expect, it } from "@effect/vitest";
import {
  AUTOMATION_API_V1,
  AutomationApiOperations,
  AutomationApplicationError,
  AutomationInboxError,
  AutomationMachineCredentialError,
  FoundryInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as MachineAccess from "./MachineAccess.ts";
import * as ApiHttp from "./ApiHttp.ts";
import * as Application from "./Application.ts";
import * as Control from "./Control.ts";
import * as Inbox from "./Inbox.ts";
import * as Triggers from "./Triggers.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeBranches = Schema.decodeUnknownSync(
  Schema.Struct({
    anyOf: Schema.Array(
      Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Unknown) }),
    ),
  }),
);
const decodeContract = Schema.decodeUnknownSync(
  Schema.Struct({
    version: Schema.String,
    operations: Schema.Record(
      Schema.String,
      Schema.Struct({
        path: Schema.String,
        input: Schema.Record(Schema.String, Schema.Unknown),
        output: Schema.Record(Schema.String, Schema.Unknown),
      }),
    ),
  }),
);

const fixture = Effect.fn("ApiHttpTest.fixture")(function* () {
  const requests: Array<{
    path: string;
    authorization: string | undefined;
    csrf: string | undefined;
    input: unknown;
  }> = [];
  let denied = false;
  const handler = HttpRouter.toWebHandler(
    ApiHttp.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Application.Application)({
            query: (request, input) =>
              Effect.sync(() => {
                requests.push({
                  path: request.url,
                  authorization: request.headers.authorization,
                  csrf: request.headers["x-foundry-csrf"],
                  input,
                });
                return { kind: "factories" as const, items: [], next: null };
              }),
            command: (_, input) =>
              Effect.fail(
                new AutomationApplicationError({
                  code: input.op === "createFactory" ? "forbidden" : "conflict",
                }),
              ),
          }),
          Layer.mock(Control.Control)({}),
          Layer.mock(Inbox.Inbox)({
            mark: () => Effect.fail(new AutomationInboxError({ reason: "stale_revision" })),
          }),
          Layer.mock(Triggers.Triggers)({}),
          Layer.mock(MachineAccess.MachineAccess)({
            issue: () => Effect.fail(new AutomationMachineCredentialError({ code: "conflict" })),
            read: () =>
              denied
                ? Effect.fail(new AutomationMachineCredentialError({ code: "forbidden" }))
                : Effect.succeed({
                    instanceId: FoundryInstanceId.make("00000000-0000-4000-8000-000000000001"),
                    operatorId: "operator",
                  }),
          }),
        ),
      ),
    ),
    { disableLogger: true },
  );
  yield* Effect.addFinalizer(() => Effect.promise(() => handler.dispose()));
  const send = (path: string, body: string, method = "POST") =>
    Effect.promise(() =>
      handler.handler(
        new Request(`http://localhost${path}`, {
          method,
          headers: {
            "content-type": "application/json",
            authorization: "Bearer fixture-only",
            "x-foundry-csrf": "fixture-csrf",
          },
          ...(method === "GET" ? {} : { body }),
        }),
      ),
    );
  return {
    send,
    requests,
    deny: () => {
      denied = true;
    },
  };
});

it.live(
  "keeps the caller request and strictly rejects malformed, excess, oversized and unknown-version requests",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const input = { op: "factories", limit: 10 };
      const response = yield* f.send(`${AUTOMATION_API_V1}/query`, json(input));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(yield* Effect.promise(() => response.json())).toEqual({
        kind: "factories",
        items: [],
        next: null,
      });
      expect(f.requests).toEqual([
        {
          path: `${AUTOMATION_API_V1}/query`,
          authorization: "Bearer fixture-only",
          csrf: "fixture-csrf",
          input,
        },
      ]);
      for (const body of [
        "{",
        json({ ...input, injected: true }),
        " ".repeat(3 * 1024 * 1024) + json(input),
      ]) {
        const rejected = yield* f.send(`${AUTOMATION_API_V1}/query`, body);
        expect(rejected.status).toBe(400);
        expect(yield* Effect.promise(() => rejected.json())).toEqual({ code: "invalid_input" });
      }
      const largeDefinition = yield* f.send(
        `${AUTOMATION_API_V1}/command`,
        " ".repeat(3 * 1024 * 1024) +
          json({
            op: "activateDefinition",
            input: {
              commandId: "definition",
              factoryId: "factory",
              scopeVersionId: "scope",
              expectedVersionId: null,
              files: [{ path: "factory.yaml", content: "schemaVersion: 4" }],
              source: { kind: "files", reference: "fixture" },
            },
          }),
      );
      expect(largeDefinition.status).toBe(409);
      expect(yield* Effect.promise(() => largeDefinition.json())).toEqual({ code: "conflict" });
      const largeOrdinary = yield* f.send(
        `${AUTOMATION_API_V1}/command`,
        " ".repeat(3 * 1024 * 1024) +
          json({
            op: "createFactory",
            commandId: "command",
            id: "factory",
            name: "Factory",
            scopeVersionId: "scope",
            repositories: ["repo"],
          }),
      );
      expect(largeOrdinary.status).toBe(400);
      for (const method of ["POST", "GET"]) {
        const missing = yield* f.send("/api/foundry/v99/automation/command", json(input), method);
        expect(missing.status).toBe(404);
        expect(yield* Effect.promise(() => missing.json())).toEqual({ code: "not_found" });
      }
      const root = yield* f.send("/api/foundry/v99/automation", "{}", "GET");
      expect(root.status).toBe(404);
      expect(yield* Effect.promise(() => root.json())).toEqual({ code: "not_found" });
      expect(f.requests).toHaveLength(1);
    }).pipe(Effect.scoped),
);

it.live("returns safe domain errors and protects the complete machine-readable contract", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const rejected = yield* f.send(
      `${AUTOMATION_API_V1}/command`,
      json({
        op: "createFactory",
        commandId: "command",
        id: "factory",
        name: "Factory",
        scopeVersionId: "scope",
        repositories: ["acme/app"],
      }),
    );
    expect(rejected.status).toBe(403);
    expect(yield* Effect.promise(() => rejected.json())).toEqual({ code: "forbidden" });
    const credential = {
      id: "00000000-0000-4000-8000-000000000002",
      label: "Fixture reader",
      factoryIds: ["factory"],
      expiresAt: 1,
    };
    const conflict = yield* f.send(`${AUTOMATION_API_V1}/credentials/issue`, json(credential));
    expect(conflict.status).toBe(409);
    expect(yield* Effect.promise(() => conflict.json())).toEqual({ code: "conflict" });
    for (const extra of [{ scope: "access:write" }, { factoryIds: [] }]) {
      const invalid = yield* f.send(
        `${AUTOMATION_API_V1}/credentials/issue`,
        json({ ...credential, ...extra }),
      );
      expect(invalid.status).toBe(400);
    }
    const stale = yield* f.send(
      `${AUTOMATION_API_V1}/inbox/mark`,
      json({ commandId: "mark", itemId: "item", sourceRevision: "old", action: "done" }),
    );
    expect(stale.status).toBe(409);
    expect(yield* Effect.promise(() => stale.json())).toEqual({ code: "stale_revision" });
    const response = yield* f.send(`${AUTOMATION_API_V1}/contract`, "{}");
    expect(response.status).toBe(200);
    const contract = decodeContract(yield* Effect.promise(() => response.json()));
    expect(contract.version).toBe("1");
    const branches = decodeBranches(contract.operations.query!.input).anyOf;
    const search = branches.find((branch) => "search" in branch.properties)!.properties.search;
    expect(json(search)).not.toContain('"type":"null"');
    expect(json(contract.operations.control!.output)).toContain('"type":"null"');
    const nullSearch = yield* f.send(
      `${AUTOMATION_API_V1}/query`,
      json({ op: "factories", limit: 10, search: null }),
    );
    expect(nullSearch.status).toBe(400);
    expect(Object.keys(contract.operations)).toEqual(Object.keys(AutomationApiOperations));
    for (const [name, operation] of Object.entries(AutomationApiOperations)) {
      expect(contract.operations[name]!.path).toBe(`${AUTOMATION_API_V1}/${operation.path}`);
      for (const kind of ["input", "output"] as const) {
        const schema = contract.operations[name]![kind];
        expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
        const refs = json(schema).matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g);
        for (const [, key] of refs) expect(schema.$defs).toHaveProperty(key!);
      }
    }
    f.deny();
    const forbidden = yield* f.send(`${AUTOMATION_API_V1}/contract`, "{}");
    expect(forbidden.status).toBe(403);
    expect(yield* Effect.promise(() => forbidden.json())).toEqual({ code: "forbidden" });
  }).pipe(Effect.scoped),
);
