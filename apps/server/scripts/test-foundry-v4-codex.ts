// @effect-diagnostics nodeBuiltinImport:off -- This native gate uses isolated local Codex/MCP peers and a loopback model fixture, without provider credentials.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  SecretProviderId,
  type FoundryWorkerDefinitionV4,
  type FactoryV4Mcp,
} from "@t3tools/contracts";
import {
  codexResourceConfig,
  codexSandboxProbe,
  isolateCodexMcpConfig,
  verifyMcpInventory,
  prepareResources,
  prepareWorkspaceResources,
} from "../src/foundry/WorkerResources.ts";
import * as CodexSchema from "effect-codex-app-server/schema";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const Response = Schema.Struct({
  id: Schema.Number,
  result: Schema.optional(Schema.Json),
  error: Schema.optional(Schema.Json),
});
const decodeResponse = Schema.decodeUnknownOption(Response);
const decodeNotification = Schema.decodeUnknownOption(
  Schema.Struct({ method: Schema.String, params: Schema.Json }),
);
const decodeThread = Schema.decodeUnknownSync(CodexSchema.V2ThreadStartResponse);
const decodeInventory = Schema.decodeUnknownSync(CodexSchema.V2ListMcpServerStatusResponse);
const decodeCommand = Schema.decodeUnknownSync(CodexSchema.V2CommandExecResponse);
const decodeSkills = Schema.decodeUnknownSync(CodexSchema.V2SkillsListResponse);
const decodeModelRequests = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        tools: Schema.Array(
          Schema.Struct({
            name: Schema.optional(Schema.String),
            tools: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
          }),
        ),
        input: Schema.Array(
          Schema.Struct({ type: Schema.String, output: Schema.optional(Schema.Json) }),
        ),
      }),
    ),
  ),
);
const codexBinary = process.env.FOUNDRY_TEST_CODEX_BINARY ?? "codex";
const marker = "FOUNDRY_DETERMINISTIC_SECRET_SENTINEL_482031";
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "foundry-v4-codex-"));
const fixture = NodeURL.fileURLToPath(
  new URL("../src/foundry/testFixtures/mcpResourcePeer.mjs", import.meta.url),
);
const children: NodeChildProcess.ChildProcess[] = [];
const spawn = (command: string, args: string[]) => {
  const child = NodeChildProcess.spawn(command, args, {
    env: { ...process.env, CODEX_HOME: root },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  child.stderr?.resume();
  return child;
};
try {
  const marketplace = NodePath.join(root, "fixture-marketplace");
  const plugin = NodePath.join(marketplace, "plugins", "inherited");
  await NodeFSP.mkdir(NodePath.join(marketplace, ".agents", "plugins"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(plugin, ".codex-plugin"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(marketplace, ".agents", "plugins", "marketplace.json"),
    encodeJson({
      name: "foundry-fixture",
      plugins: [{ name: "inherited", source: { source: "local", path: "./plugins/inherited" } }],
    }),
  );
  await NodeFSP.writeFile(
    NodePath.join(plugin, ".codex-plugin", "plugin.json"),
    encodeJson({
      name: "inherited",
      version: "1.0.0",
      description: "Local isolation regression",
      mcpServers: "./.mcp.json",
    }),
  );
  await NodeFSP.writeFile(
    NodePath.join(plugin, ".mcp.json"),
    encodeJson({
      mcpServers: {
        "inherited-plugin": {
          command: process.execPath,
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(NodePath.join(root, "plugin-mcp-started"))}, 'started'); import(${JSON.stringify(NodeURL.pathToFileURL(fixture).href)})`,
          ],
        },
      },
    }),
  );
  const execute = NodeUtil.promisify(NodeChildProcess.execFile);
  const installOptions = {
    env: { ...process.env, CODEX_HOME: root },
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  };
  await execute(
    codexBinary,
    ["plugin", "marketplace", "add", marketplace, "--json"],
    installOptions,
  );
  await execute(
    codexBinary,
    ["plugin", "add", "inherited@foundry-fixture", "--json"],
    installOptions,
  );
  const http = spawn(process.execPath, [fixture, "http"]);
  const lines = NodeReadline.createInterface({ input: http.stdout! });
  const url = await new Promise<string>((resolve, reject) => {
    lines.once("line", resolve);
    http.once("error", reject);
  });
  lines.close();
  const codex = spawn(codexBinary, [
    "-c",
    'model_provider="fixture"',
    "-c",
    `model_providers.fixture={name="Fixture",base_url="${new URL(url).origin}",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`,
    "-c",
    `mcp_servers.unpinned={command="node",args=["-e",${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(NodePath.join(root, "host-mcp-started"))}, 'started')`)}]}`,
    "app-server",
  ]);
  const pending = new Map<
    number,
    { resolve: (value: Schema.Json) => void; reject: (error: unknown) => void }
  >();
  let nextId = 0;
  let completeTurn: (() => void) | undefined;
  const output = NodeReadline.createInterface({ input: codex.stdout! });
  output.on("line", (line) => {
    const parsed = decodeJson(line);
    const notification = decodeNotification(parsed);
    if (notification._tag === "Some" && notification.value.method === "turn/completed") {
      completeTurn?.();
    }
    const response = decodeResponse(parsed);
    if (response._tag === "None") return;
    const call = pending.get(response.value.id);
    if (!call) return;
    pending.delete(response.value.id);
    if (response.value.error) call.reject(response.value.error);
    else call.resolve(response.value.result ?? null);
  });
  codex.once("exit", () => {
    for (const call of pending.values()) call.reject(new Error("Codex exited"));
    pending.clear();
  });
  const request = (method: string, params: Schema.Json) =>
    new Promise<Schema.Json>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      codex.stdin!.write(`${encodeJson({ id, method, params })}\n`);
    });
  // @effect-diagnostics-next-line globalTimers:off -- Bound the native subprocess gate even if its JSON-RPC peer hangs.
  const deadline = setTimeout(() => codex.kill(), 30_000);
  try {
    await request("initialize", {
      clientInfo: { name: "foundry_v4_gate", version: "1" },
      capabilities: { experimentalApi: true },
    });
    codex.stdin!.write(`${encodeJson({ method: "initialized" })}\n`);
    const resources: FactoryV4Mcp[] = [
      {
        id: "stdio",
        name: "Stdio",
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        secretEnv: { FIXTURE_SECRET: "fixture-token" },
        allowedTools: ["allowed"],
      },
      {
        id: "http",
        name: "HTTP",
        transport: "streamable-http",
        url,
        auth: { connection: "fixture-token" },
        allowedTools: ["allowed"],
      },
      {
        id: "empty",
        name: "Disabled",
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        allowedTools: [],
      },
    ];
    const skillText =
      "---\nname: pinned\ndescription: Pinned fixture\n---\nFOUNDRY_SKILL_INJECTION_PROOF_71932\nRead references/proof.txt.\n";
    const skillFile = (path: string, content: string, mode: "100644" | "100755" = "100644") => ({
      path: `skills/pinned/${path}`,
      content,
      encoding: "utf8" as const,
      mode,
      sha256: NodeCrypto.createHash("sha256").update(content).digest("hex"),
    });
    const pinned: FoundryWorkerDefinitionV4 = {
      factoryId: "fixture",
      workspaceAccess: "read",
      resources: {
        agent: { id: "fixture", name: "Fixture" },
        instructions: "Fixture",
        skills: [
          {
            id: "pinned",
            name: "pinned",
            directory: "skills/pinned",
            description: "Pinned fixture",
            files: [
              skillFile("SKILL.md", skillText),
              skillFile("references/proof.txt", "PINNED_REFERENCE_BYTES"),
              skillFile(
                "scripts/not-on-import.sh",
                "#!/bin/sh\ntouch imported-script-ran\n",
                "100755",
              ),
            ],
          },
        ],
        mcp: resources,
        execution: { provider: "codex" },
        provenance: { instructions: [], skills: [], mcp: [], execution: { provider: "factory" } },
      },
      mcpBindings: resources.map((definition) => ({
        factoryId: "fixture",
        resourceId: definition.id,
        generation: 1,
        enabled: true,
        definition,
        allowedTools: definition.allowedTools,
        secrets: {
          "fixture-token": {
            provider: SecretProviderId.make("fixture"),
            reference: "fixture-reference",
          },
        },
      })),
    };
    const workspace = NodePath.join(root, "workspace");
    await NodeFSP.mkdir(workspace);
    await NodeUtil.promisify(NodeChildProcess.execFile)("git", ["init", "-q"], { cwd: workspace });
    await Effect.runPromise(prepareResources(root, "fixture-thread", pinned));
    const nativeDirectory = await Effect.runPromise(
      prepareWorkspaceResources(root, "fixture-thread", workspace),
    );
    const skillPath = NodePath.join(nativeDirectory, "skills", "pinned", "SKILL.md");
    const inherited = decodeJson(
      encodeJson(await request("config/read", { cwd: workspace, includeLayers: false })),
    );
    const hostConfig =
      inherited && typeof inherited === "object" && !Array.isArray(inherited)
        ? Reflect.get(inherited, "config")
        : undefined;
    const hostMcp =
      hostConfig && typeof hostConfig === "object"
        ? Reflect.get(hostConfig, "mcp_servers")
        : undefined;
    const thread = decodeThread(
      await request("thread/start", {
        cwd: workspace,
        model: "gpt-5.4",
        config: {
          ...isolateCodexMcpConfig(
            codexResourceConfig(pinned, { "fixture-token": marker }),
            hostMcp,
          ),
          model_provider: "fixture",
          "model_providers.fixture": {
            name: "Fixture",
            base_url: new URL(url).origin,
            wire_api: "responses",
            requires_openai_auth: false,
            supports_websockets: false,
            request_max_retries: 0,
            stream_max_retries: 0,
          },
        },
      }),
    );
    await NodeAssert.rejects(NodeFSP.stat(NodePath.join(root, "host-mcp-started")), {
      code: "ENOENT",
    });
    const catalog = decodeSkills(
      await request("skills/list", { cwds: [workspace], forceReload: true }),
    );
    NodeAssert.ok(
      catalog.data.some((entry) =>
        entry.skills.some(
          (skill) => skill.path === skillPath && skill.name === "pinned" && skill.enabled,
        ),
      ),
      "Native skill catalog omitted pinned resource",
    );
    if (process.env.FOUNDRY_TEST_MCP_ONLY !== "1") {
      const sandbox = decodeCommand(
        await request("command/exec", codexSandboxProbe("write", workspace)),
      );
      NodeAssert.equal(sandbox.exitCode, 0, `Native sandbox failed: ${sandbox.stderr}`);
      NodeAssert.equal(sandbox.stdout, "foundry-sandbox-ready");
      const written = decodeCommand(
        await request("command/exec", {
          ...codexSandboxProbe("write", workspace),
          command: ["/bin/sh", "-c", "printf sandbox-file > sandbox-proof.txt"],
        }),
      );
      NodeAssert.equal(written.exitCode, 0, written.stderr);
      NodeAssert.equal(
        await NodeFSP.readFile(NodePath.join(workspace, "sandbox-proof.txt"), "utf8"),
        "sandbox-file",
      );
      const read = decodeCommand(
        await request("command/exec", {
          ...codexSandboxProbe("read", workspace),
          command: ["/bin/sh", "-c", "cat sandbox-proof.txt"],
        }),
      );
      NodeAssert.equal(read.exitCode, 0, read.stderr);
      NodeAssert.equal(read.stdout, "sandbox-file");
      const denied = decodeCommand(
        await request("command/exec", {
          ...codexSandboxProbe("read", workspace),
          command: ["/bin/sh", "-c", "printf forbidden > sandbox-denied.txt"],
        }),
      );
      NodeAssert.notEqual(denied.exitCode, 0);
      await NodeAssert.rejects(NodeFSP.stat(NodePath.join(workspace, "sandbox-denied.txt")), {
        code: "ENOENT",
      });
      await NodeFSP.unlink(NodePath.join(workspace, "sandbox-proof.txt"));
    }

    const inventory = decodeInventory(
      await request("mcpServerStatus/list", {
        threadId: thread.thread.id,
        detail: "full",
        limit: 100,
      }),
    );
    await NodeAssert.rejects(NodeFSP.stat(NodePath.join(root, "plugin-mcp-started")), {
      code: "ENOENT",
    });
    verifyMcpInventory(pinned, inventory.data, inventory.nextCursor);
    for (const resource of resources) {
      const server = `foundry-${resource.id}`;
      if (resource.allowedTools.length) {
        const result = await request("mcpServer/tool/call", {
          threadId: thread.thread.id,
          server,
          tool: "allowed",
          arguments: {},
        });
        NodeAssert.deepEqual(result, { content: [{ type: "text", text: "allowed" }] });
      }
      await NodeAssert.rejects(
        request("mcpServer/tool/call", {
          threadId: thread.thread.id,
          server,
          tool: "forbidden",
          arguments: {},
        }),
      );
    }
    const completed = new Promise<void>((resolve, reject) => {
      completeTurn = resolve;
      codex.once("exit", () => reject(new Error("Codex exited before fixture turn completed")));
    });
    void completed.catch(() => {});
    await request("turn/start", {
      threadId: thread.thread.id,
      cwd: workspace,
      input: [
        { type: "text", text: "Fixture" },
        { type: "skill", name: "pinned", path: skillPath },
      ],
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly" },
      outputSchema: { type: "boolean" },
    });
    await completed;
    // @effect-diagnostics-next-line globalFetch:off -- Read only the loopback fixture's captured request after the native completion event.
    const captured = await (await fetch(new URL("/capture", url))).text();
    const modelRequests = decodeModelRequests(captured);
    NodeAssert.equal(
      modelRequests.length,
      2,
      "The native turn must execute MCP calls before requesting its final response",
    );
    const toolOutputs = modelRequests[1]!.input.filter(
      (item) => item.type === "function_call_output",
    );
    NodeAssert.equal(toolOutputs.length, 2);
    for (const item of toolOutputs) {
      const result = JSON.stringify(item.output);
      NodeAssert.ok(
        result.includes('"text":"allowed"'),
        `Authorized model-requested MCP tool was not executed: ${result}`,
      );
      NodeAssert.ok(!result.includes("requires approval"));
    }
    for (const input of modelRequests) {
      const mcpTools = input.tools.flatMap((tool) =>
        tool.name?.startsWith("mcp__")
          ? (tool.tools ?? []).map((entry) => `${tool.name}.${entry.name}`)
          : [],
      );
      NodeAssert.deepEqual(mcpTools.sort(), [
        "mcp__foundry_http.allowed",
        "mcp__foundry_stdio.allowed",
      ]);
    }
    NodeAssert.ok(
      captured.includes("FOUNDRY_SKILL_INJECTION_PROOF_71932"),
      "Explicit private skill path was not loaded into the native model request",
    );
    NodeAssert.equal(
      await NodeFSP.readFile(
        NodePath.join(nativeDirectory, "skills/pinned/references/proof.txt"),
        "utf8",
      ),
      "PINNED_REFERENCE_BYTES",
    );
    await NodeAssert.rejects(NodeFSP.access(NodePath.join(workspace, "imported-script-ran")));
    await NodeAssert.rejects(NodeFSP.stat(NodePath.join(root, "plugin-mcp-started")), {
      code: "ENOENT",
    });
    await NodeAssert.rejects(NodeFSP.stat(NodePath.join(root, "host-mcp-started")), {
      code: "ENOENT",
    });
    const staged = await NodeUtil.promisify(NodeChildProcess.execFile)(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      { cwd: workspace },
    );
    NodeAssert.equal(staged.stdout, "");
    async function scan(directory: string): Promise<string[]> {
      const leaks: string[] = [];
      for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
        const full = NodePath.join(directory, entry.name);
        if (entry.isDirectory()) leaks.push(...(await scan(full)));
        else if (entry.isFile() && (await NodeFSP.readFile(full)).includes(marker))
          leaks.push(NodePath.relative(root, full));
      }
      return leaks;
    }
    NodeAssert.deepEqual(await scan(root), [], "Native Codex persisted secret config values");
    process.stdout.write(
      "PASS native Codex: model-requested stdio + Streamable HTTP calls with no per-tool prompts, exact allowed tools, forbidden calls rejected, empty allowlist disabled, private native skill injection, no inherited host/plugin MCP startup, no persisted secret marker; loopback model only." +
        (process.env.FOUNDRY_TEST_MCP_ONLY === "1"
          ? " Command sandbox probes excluded by FOUNDRY_TEST_MCP_ONLY.\n"
          : "\n"),
    );
  } finally {
    clearTimeout(deadline);
    output.close();
  }
} finally {
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("exit", () => resolve());
          child.kill();
        }),
    ),
  );
  await NodeFSP.rm(root, { recursive: true, force: true });
}
