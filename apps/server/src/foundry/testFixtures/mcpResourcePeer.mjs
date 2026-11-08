import * as NodeReadline from "node:readline";
import * as NodeHttp from "node:http";

function response(message) {
  if (message.id === undefined) return undefined;
  let result;
  switch (message.method) {
    case "initialize":
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "foundry-resource-fixture", version: "1" },
      };
      break;
    case "tools/list":
      result = {
        tools: ["allowed", "forbidden"].map((name) => ({
          name,
          description: name,
          inputSchema: { type: "object", properties: {} },
        })),
      };
      break;
    case "tools/call":
      result = { content: [{ type: "text", text: message.params.name }] };
      break;
    case "resources/list":
      result = { resources: [] };
      break;
    case "resources/templates/list":
      result = { resourceTemplates: [] };
      break;
    default:
      return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unknown method" } };
  }
  return { jsonrpc: "2.0", id: message.id, result };
}
if (process.argv[2] === "http") {
  const modelInputs = [];
  const server = NodeHttp.createServer(async (request, reply) => {
    if (request.url === "/capture") {
      reply.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(modelInputs));
      return;
    }
    if (request.method !== "POST") {
      reply.writeHead(405).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === "/responses") {
      const modelInput = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      modelInputs.push(modelInput);
      const completedCalls = modelInput.input.filter(
        (item) => item.type === "function_call_output",
      );
      const tools = modelInput.tools.flatMap((tool) =>
        tool.type === "namespace" && tool.name.startsWith("mcp__foundry_")
          ? tool.tools
              .filter((entry) => entry.name === "allowed")
              .map((entry) => ({ ...entry, namespace: tool.name }))
          : [],
      );
      const output = completedCalls.length
        ? [
            {
              id: "fixture-message",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "true", annotations: [] }],
            },
          ]
        : tools.map((tool, index) => ({
            id: `fixture-tool-${index}`,
            type: "function_call",
            status: "completed",
            call_id: `fixture-call-${index}`,
            name: tool.name,
            namespace: tool.namespace,
            arguments: "{}",
          }));
      reply.writeHead(200, { "content-type": "text/event-stream" });
      const event = (type, data) =>
        reply.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event("response.created", {
        response: {
          id: `fixture-response-${modelInputs.length}`,
          object: "response",
          status: "in_progress",
          output: [],
        },
      });
      output.forEach((item, output_index) => {
        event("response.output_item.added", { output_index, item });
        event("response.output_item.done", { output_index, item });
      });
      event("response.completed", {
        response: {
          id: `fixture-response-${modelInputs.length}`,
          object: "response",
          status: "completed",
          output,
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
      reply.end();
      return;
    }
    const result = response(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (result === undefined) reply.writeHead(202).end();
    else reply.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
  });
  server.listen(0, "127.0.0.1", () =>
    process.stdout.write(`http://127.0.0.1:${server.address().port}/mcp\n`),
  );
} else {
  NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
    const result = response(JSON.parse(line));
    if (result !== undefined) process.stdout.write(`${JSON.stringify(result)}\n`);
  });
}
