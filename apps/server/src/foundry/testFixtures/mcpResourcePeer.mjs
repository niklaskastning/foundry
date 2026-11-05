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
  let modelInput;
  const server = NodeHttp.createServer(async (request, reply) => {
    if (request.url === "/capture") {
      reply
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(modelInput ?? null));
      return;
    }
    if (request.method !== "POST") {
      reply.writeHead(405).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === "/responses") {
      modelInput = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      reply.writeHead(400, { "content-type": "application/json" }).end(
        JSON.stringify({
          error: { message: "Expected fixture failure", type: "invalid_request_error" },
        }),
      );
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
