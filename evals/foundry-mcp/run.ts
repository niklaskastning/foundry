// @effect-diagnostics nodeBuiltinImport:off -- The eval owns its output artifact and local proxy configuration.
// @effect-diagnostics globalProcess:off -- Command-line options select the output directory.
import * as NodeFSP from "node:fs/promises";
import { foundryMcpTools } from "../../apps/server/src/automation/mcpTools.ts";
import { proxyConfig } from "../shared/proxy.ts";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import { FetchHttpClient, HttpClient, HttpBody } from "effect/http";
import * as Schema from "effect/Schema";

const decode = Schema.decodeUnknownSync(
  Schema.Struct({
    output: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        name: Schema.optional(Schema.String),
        arguments: Schema.optional(Schema.String),
      }),
    ),
  }),
);
const out = process.argv[process.argv.indexOf("--out") + 1];
if (!process.argv.includes("--out") || !out) throw new Error("--out directory required");
const cases = [
  {
    id: "discover-before-swarm",
    prompt:
      "Start the configured review swarm in my allowed Factory. You have not read any Factory or workflow yet. Choose the next tool call.",
    tool: "foundry_query",
    op: "factories",
  },
  {
    id: "retry-preserves-command",
    prompt:
      'The createWorkItem response was lost. Repeat exactly the pending request: {"op":"createWorkItem","input":{"commandId":"ci-42","id":"work-42","factoryId":"factory","title":"Fix parser","versionId":"factory-v1","source":{"kind":"manual","reference":"ci-42"},"repository":"acme/app"}}. Choose the next tool call.',
    tool: "foundry_start",
    op: "createWorkItem",
    commandId: "ci-42",
  },
  {
    id: "read-before-control",
    prompt:
      "Pause run run-42 in Factory factory. Its current control revision is unknown. Choose the next tool call.",
    tool: "foundry_query",
    op: "run",
  },
];
const config = proxyConfig();
const rows = [];
for (const c of cases) {
  const response = await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      return yield* client.post(`${config.url}/responses`, {
        headers: { ...config.headers, "content-type": "application/json" },
        body: HttpBody.jsonUnsafe({
          model: "gpt-6.1-sol",
          reasoning: { effort: "medium" },
          input: c.prompt,
          tools: foundryMcpTools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
            strict: false,
          })),
          tool_choice: "required",
          parallel_tool_calls: false,
        }),
      });
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
  if (response.status < 200 || response.status >= 300)
    throw new Error(`Evaluation provider HTTP ${response.status}`);
  const body = decode(await Effect.runPromise(response.json));
  const call = body.output.find((item) => item.type === "function_call");
  const args = call?.arguments ?? "{}";
  rows.push({
    id: c.id,
    pass:
      call?.name === c.tool &&
      args.includes(`"${c.op}"`) &&
      (c.commandId === undefined || args.includes(`"${c.commandId}"`)),
    call: call?.name,
    arguments: args,
  });
}
await NodeFSP.mkdir(out, { recursive: true });
await NodeFSP.writeFile(`${out}/results.json`, JSON.stringify(rows, null, 2));
await Effect.runPromise(Console.log(JSON.stringify(rows.map(({ id, pass }) => ({ id, pass })))));
if (rows.some((row) => !row.pass)) process.exitCode = 1;
