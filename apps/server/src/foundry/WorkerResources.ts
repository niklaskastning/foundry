// @effect-diagnostics nodeBuiltinImport:off -- Exclusive files and no-follow reads preserve pinned resource bytes.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import {
  FoundryWorkerDefinitionV4,
  type FactoryV4ResultSchema,
  type FactoryV4File,
  type SecretReference,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { SecretResolver } from "@t3tools/secret-provider-core/server/SecretResolver";
import { mcpBindingMatches, canonicalResourceJson } from "../automation/McpBindings.ts";

export class WorkerResourceError extends Schema.TaggedError<WorkerResourceError>()(
  "WorkerResourceError",
  {
    reason: Schema.Literals([
      "invalid_resource",
      "permission_denied",
      "secret_unavailable",
      "unavailable",
    ]),
  },
) {}
const isWorkerResourceError = Schema.is(WorkerResourceError);
const denied = () => new WorkerResourceError({ reason: "permission_denied" });
const invalid = () => new WorkerResourceError({ reason: "invalid_resource" });
const digest = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const decode = Schema.decodeUnknownSync(FoundryWorkerDefinitionV4, { onExcessProperty: "error" });
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(FoundryWorkerDefinitionV4));
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(FoundryWorkerDefinitionV4));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
const WorkspaceResources = Schema.Struct({ cwd: Schema.String, directory: Schema.String });
const decodeWorkspace = Schema.decodeUnknownSync(Schema.fromJsonString(WorkspaceResources));
const encodeWorkspace = Schema.encodeSync(Schema.fromJsonString(WorkspaceResources));
const resourceDirectory = (stateDir: string, threadId: string) =>
  NodePath.join(stateDir, "foundry-resources", digest(threadId));
const maxBytes = 16 * 1024 * 1024;
const bytesFor = (file: FactoryV4File) => {
  const bytes = Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");
  if (
    bytes.length > 1024 * 1024 ||
    digest(bytes) !== file.sha256 ||
    (file.encoding === "base64" && bytes.toString("base64") !== file.content)
  )
    throw invalid();
  return bytes;
};
const fileEntries = (request: FoundryWorkerDefinitionV4) => {
  const entries: { file: FactoryV4File; bytes: Buffer }[] = [];
  const paths = new Set<string>();
  let total = 0;
  for (const skill of request.resources.skills) {
    if (skill.directory !== `skills/${skill.id}` || skill.name !== skill.id) throw invalid();
    if (!skill.files.some((file) => file.path === `${skill.directory}/SKILL.md`)) throw invalid();
    for (const file of skill.files) {
      if (
        !file.path.startsWith(`${skill.directory}/`) ||
        paths.has(file.path) ||
        file.path.split("/").some((part) => part === "." || part === ".." || !part) ||
        file.path.includes("\\")
      )
        throw invalid();
      paths.add(file.path);
      const bytes = bytesFor(file);
      total += bytes.length;
      if (total > maxBytes || paths.size > 2048) throw invalid();
      entries.push({ file, bytes });
    }
  }
  return entries;
};
async function readFile(path: string) {
  const handle = await NodeFSP.open(path, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes * 2) throw invalid();
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
async function verify(directory: string, request: FoundryWorkerDefinitionV4, metadata = false) {
  const entries = fileEntries(request);
  if (!(await NodeFSP.lstat(directory)).isDirectory()) throw invalid();
  const permitted = new Set(metadata ? ["request.json", "workspace.json"] : []);
  for (const { file } of entries) {
    const parts = file.path.split("/");
    for (let length = 1; length <= parts.length; length++)
      permitted.add(parts.slice(0, length).join("/"));
  }
  async function checkTree(parent: string, relative: string) {
    for (const entry of await NodeFSP.readdir(parent, { withFileTypes: true })) {
      const local = relative ? `${relative}/${entry.name}` : entry.name;
      if (
        !permitted.has(local) ||
        entry.isSymbolicLink() ||
        (!entry.isDirectory() && !entry.isFile())
      )
        throw invalid();
      if (entry.isDirectory()) await checkTree(NodePath.join(parent, entry.name), local);
    }
  }
  await checkTree(directory, "");
  for (const { file, bytes } of entries) {
    const parts = file.path.split("/");
    let parent = directory;
    for (const part of parts.slice(0, -1)) {
      parent = NodePath.join(parent, part);
      if (!(await NodeFSP.lstat(parent)).isDirectory()) throw invalid();
    }
    const path = NodePath.join(directory, file.path);
    const actual = await readFile(path);
    if (
      !actual.equals(bytes) ||
      (await NodeFSP.lstat(path)).mode % 512 !== (file.mode === "100755" ? 0o500 : 0o400)
    )
      throw invalid();
  }
}
export const prepareResources = Effect.fn("WorkerResources.prepare")(
  (stateDir: string, threadId: string, raw: FoundryWorkerDefinitionV4) =>
    Effect.tryPromise({
      try: async () => {
        const request = decode(raw);
        const entries = fileEntries(request);
        codexResourceConfig(request, {}, false);
        const directory = resourceDirectory(stateDir, threadId);
        const root = NodePath.dirname(directory);
        await NodeFSP.mkdir(root, { recursive: true, mode: 0o700 });
        if (!(await NodeFSP.lstat(root)).isDirectory()) throw invalid();
        const temporary = await NodeFSP.mkdtemp(NodePath.join(root, ".prepare-"));
        try {
          for (const { file, bytes } of entries) {
            const path = NodePath.join(temporary, file.path);
            await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
            await NodeFSP.writeFile(path, bytes, {
              flag: "wx",
              mode: file.mode === "100755" ? 0o500 : 0o400,
            });
          }
          await NodeFSP.writeFile(
            NodePath.join(temporary, "request.json"),
            encodeRequest(request),
            {
              flag: "wx",
              mode: 0o400,
            },
          );
          try {
            await NodeFSP.rename(temporary, directory);
          } catch (error) {
            if (
              (error as NodeJS.ErrnoException).code !== "ENOTEMPTY" &&
              (error as NodeJS.ErrnoException).code !== "EEXIST"
            )
              throw error;
            const existing = decodeRequest(
              (await readFile(NodePath.join(directory, "request.json"))).toString("utf8"),
            );
            if (encodeRequest(existing) !== encodeRequest(request)) throw invalid();
          }
          await verify(directory, request, true);
          return { directory, request };
        } finally {
          await NodeFSP.rm(temporary, { recursive: true, force: true });
        }
      },
      catch: (error) => (isWorkerResourceError(error) ? error : invalid()),
    }),
);
export const readResources = Effect.fn("WorkerResources.read")(
  (stateDir: string, threadId: string, requireWorkspace = false) =>
    Effect.tryPromise({
      try: async () => {
        const directory = resourceDirectory(stateDir, threadId);
        let text: Buffer;
        try {
          text = await readFile(NodePath.join(directory, "request.json"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            try {
              await NodeFSP.lstat(directory);
            } catch (missing) {
              if (
                (missing as NodeJS.ErrnoException).code === "ENOENT" &&
                !threadId.startsWith("foundry-launch:v4:")
              )
                return null;
              throw missing;
            }
          }
          throw error;
        }
        if (!(await NodeFSP.lstat(directory)).isDirectory()) throw invalid();
        const request = decodeRequest(text.toString("utf8"));
        await verify(directory, request, true);
        let nativeDirectory: string | undefined;
        let workspaceText: Buffer | undefined;
        try {
          workspaceText = await readFile(NodePath.join(directory, "workspace.json"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (workspaceText) {
          const workspace = decodeWorkspace(workspaceText.toString("utf8"));
          const expected = NodePath.join(
            workspace.cwd,
            ".agents",
            "skills",
            `foundry-${digest(threadId)}`,
          );
          if (workspace.directory !== expected) throw invalid();
          for (const parent of [
            NodePath.join(workspace.cwd, ".agents"),
            NodePath.join(workspace.cwd, ".agents", "skills"),
          ]) {
            if (!(await NodeFSP.lstat(parent)).isDirectory()) throw invalid();
          }
          await verify(workspace.directory, request);
          nativeDirectory = workspace.directory;
        }
        if (requireWorkspace && !nativeDirectory) throw invalid();
        return { directory, request, ...(nativeDirectory ? { nativeDirectory } : {}) };
      },
      catch: () => invalid(),
    }),
);

export const prepareWorkspaceResources = Effect.fn("WorkerResources.prepareWorkspace")(function* (
  stateDir: string,
  threadId: string,
  cwd: string,
) {
  const resources = yield* readResources(stateDir, threadId);
  if (!resources) return yield* invalid();
  return yield* Effect.tryPromise({
    try: async () => {
      const directory = NodePath.join(cwd, ".agents", "skills", `foundry-${digest(threadId)}`);
      const ownershipPath = NodePath.join(resources.directory, "workspace.json");
      const ownership = encodeWorkspace({ cwd, directory });
      let owned = false;
      try {
        owned = (await readFile(ownershipPath)).toString("utf8") === ownership;
        if (!owned) throw invalid();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      for (const parent of [
        NodePath.join(cwd, ".agents"),
        NodePath.join(cwd, ".agents", "skills"),
      ]) {
        try {
          await NodeFSP.mkdir(parent, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        if (!(await NodeFSP.lstat(parent)).isDirectory()) throw invalid();
      }
      if (owned) {
        await verify(directory, resources.request);
        return directory;
      }
      try {
        await NodeFSP.lstat(directory);
        throw invalid();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const git = await execute(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        { cwd, maxBuffer: 4096, timeout: 30000 },
      );
      const info = NodePath.join(git.stdout.trim(), "info");
      await NodeFSP.mkdir(info, { recursive: true });
      if (!(await NodeFSP.lstat(info)).isDirectory()) throw invalid();
      const exclude = await NodeFSP.open(
        NodePath.join(info, "exclude"),
        NodeFS.constants.O_WRONLY |
          NodeFS.constants.O_APPEND |
          NodeFS.constants.O_CREAT |
          NodeFS.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await exclude.write(`\n/.agents/skills/foundry-${digest(threadId)}/\n`);
        await exclude.sync();
      } finally {
        await exclude.close();
      }
      await NodeFSP.writeFile(ownershipPath, ownership, { flag: "wx", mode: 0o400 });
      try {
        await NodeFSP.mkdir(directory, { mode: 0o700 });
        for (const { file, bytes } of fileEntries(resources.request)) {
          const path = NodePath.join(directory, file.path);
          await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
          await NodeFSP.writeFile(path, bytes, {
            flag: "wx",
            mode: file.mode === "100755" ? 0o500 : 0o400,
          });
        }
        await verify(directory, resources.request);
        return directory;
      } catch (error) {
        await NodeFSP.rm(ownershipPath, { force: true });
        throw error;
      }
    },
    catch: () => invalid(),
  });
});

export function isolateCodexMcpConfig(config: Record<string, Schema.Json>, inherited: unknown) {
  if (inherited === undefined || inherited === null) return config;
  if (typeof inherited !== "object" || Array.isArray(inherited)) throw denied();
  const isolated = { ...config };
  for (const name of Object.keys(inherited)) {
    if (
      !/^[A-Za-z0-9_-]+$/.test(name) ||
      (name !== "t3-code" && Object.hasOwn(config, `mcp_servers.${name}`))
    )
      throw denied();
    isolated[`mcp_servers.${name}.enabled`] = false;
  }
  return isolated;
}

export function codexResourceConfig(
  request: FoundryWorkerDefinitionV4,
  secrets: Readonly<Record<string, string>>,
  requireSecrets = true,
): Record<string, Schema.Json> {
  const config: Record<string, Schema.Json> = {
    "features.multi_agent": false,
    "features.apps": false,
    "features.plugins": false,
    "features.remote_plugin": false,
    "features.plugin_discovery_prefetch": false,
    "features.recommended_plugins": false,
    "skills.bundled.enabled": false,
    "skills.include_instructions": false,
    "mcp_servers.t3-code": { enabled: false, url: "http://127.0.0.1:1" },
  };
  for (const resource of request.resources.mcp) {
    const binding = request.mcpBindings.find((binding) =>
      mcpBindingMatches(binding, request.factoryId, resource),
    );
    if (!binding) throw denied();
    const secret = (id: string) => {
      const value = secrets[id];
      if (!binding.secrets[id] || (requireSecrets && value === undefined)) throw denied();
      return value ?? "";
    };
    const common = {
      enabled: resource.allowedTools.length > 0,
      required: resource.allowedTools.length > 0,
      enabled_tools: [...resource.allowedTools],
      startup_timeout_sec: 20,
    };
    config[`mcp_servers.foundry-${resource.id}`] =
      resource.transport === "stdio"
        ? {
            ...common,
            command: resource.command,
            args: [...resource.args],
            env_vars: [],
            env: {
              ...resource.env,
              ...Object.fromEntries(
                Object.entries(resource.secretEnv ?? {}).map(([name, id]) => [name, secret(id)]),
              ),
            },
          }
        : {
            ...common,
            url: resource.url,
            ...(resource.auth
              ? { http_headers: { Authorization: `Bearer ${secret(resource.auth.connection)}` } }
              : {}),
          };
  }
  return config;
}
export function verifyMcpInventory(
  request: FoundryWorkerDefinitionV4,
  servers: readonly {
    readonly name: string;
    readonly runtimeStatus?: string | null;
    readonly tools: Readonly<Record<string, { readonly name: string }>>;
    readonly toolsError?: string | null;
  }[],
  nextCursor?: string | null,
) {
  if (nextCursor) throw denied();
  for (const server of servers) {
    const resource = request.resources.mcp.find(
      (resource) => server.name === `foundry-${resource.id}`,
    );
    const tools = Object.values(server.tools).map((tool) => tool.name);
    if (!resource && server.runtimeStatus !== "disabled") throw denied();
    if (
      tools.length > 0 &&
      (!resource || tools.some((tool) => !resource.allowedTools.includes(tool)))
    )
      throw denied();
  }
  for (const resource of request.resources.mcp) {
    if (resource.allowedTools.length === 0) continue;
    const server = servers.find((server) => server.name === `foundry-${resource.id}`);
    if (
      !server ||
      server.toolsError ||
      server.runtimeStatus !== "connected" ||
      resource.allowedTools.some(
        (tool) => !Object.values(server.tools).some((entry) => entry.name === tool),
      )
    )
      throw denied();
  }
}
export const resolveResourceSecrets = Effect.fn("WorkerResources.resolveSecrets")(function* (
  request: FoundryWorkerDefinitionV4,
) {
  const wanted = new Map<string, SecretReference>();
  for (const resource of request.resources.mcp) {
    const binding = request.mcpBindings.find((binding) =>
      mcpBindingMatches(binding, request.factoryId, resource),
    );
    if (!binding) return yield* denied();
    const ids =
      resource.transport === "stdio"
        ? Object.values(resource.secretEnv ?? {})
        : resource.auth
          ? [resource.auth.connection]
          : [];
    for (const id of ids) {
      const reference = binding.secrets[id];
      if (!reference) return yield* denied();
      const previous = wanted.get(id);
      if (
        previous &&
        (previous.provider !== reference.provider || previous.reference !== reference.reference)
      )
        return yield* denied();
      wanted.set(id, reference);
    }
  }
  if (wanted.size === 0) return {};
  const resolver = yield* Effect.serviceOption(SecretResolver);
  if (resolver._tag === "None")
    return yield* new WorkerResourceError({ reason: "secret_unavailable" });
  const refs = [...wanted.values()];
  yield* resolver.value.invalidate(refs);
  const values = yield* resolver.value.read(refs);
  const result: Record<string, string> = {};
  let index = 0;
  for (const id of wanted.keys()) {
    const value = values[index++];
    if (value === undefined)
      return yield* new WorkerResourceError({ reason: "secret_unavailable" });
    result[id] = value;
  }
  return result;
});

function matches(schema: FactoryV4ResultSchema, value: Schema.Json, depth = 0): boolean {
  if (depth > 8) return false;
  if (
    schema.enum &&
    !schema.enum.some((item) => canonicalResourceJson(item) === canonicalResourceJson(value))
  )
    return false;
  switch (schema.type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "string":
      return typeof value === "string" && [...value].length <= (schema.maxLength ?? 65536);
    case "array":
      return (
        Array.isArray(value) &&
        value.length <= (schema.maxItems ?? 1000) &&
        schema.items !== undefined &&
        value.every((item) => matches(schema.items!, item, depth + 1))
      );
    case "object":
      return (
        Predicate.isObject(value) &&
        !Array.isArray(value) &&
        schema.additionalProperties === false &&
        Object.keys(value).length <= 100 &&
        (schema.required ?? []).every((key) => Object.hasOwn(value, key)) &&
        Object.entries(value).every(
          ([key, item]) =>
            Object.hasOwn(schema.properties ?? {}, key) &&
            matches(schema.properties![key]!, item as Schema.Json, depth + 1),
        )
      );
  }
}
export function parseStructuredResult(
  schema: FactoryV4ResultSchema,
  text: string | undefined,
):
  | { structuredResult: Schema.Json }
  | { structuredResultError: "missing" | "invalid" | "oversized" } {
  if (text === undefined || text.trim() === "") return { structuredResultError: "missing" };
  if (Buffer.byteLength(text, "utf8") > 65536) return { structuredResultError: "oversized" };
  try {
    const value: Schema.Json = decodeJson(text);
    return matches(schema, value)
      ? { structuredResult: value }
      : { structuredResultError: "invalid" };
  } catch {
    return { structuredResultError: "invalid" };
  }
}
const execute = NodeUtil.promisify(NodeChildProcess.execFile);
export const checkpointCommit = Effect.fn("WorkerResources.checkpointCommit")(
  (cwd: string, ref: string) =>
    Effect.tryPromise({
      try: async () => {
        if (!ref.startsWith("refs/")) throw invalid();
        const result = await execute(
          "git",
          ["-c", "core.hooksPath=/dev/null", "rev-parse", "--verify", `${ref}^{commit}`],
          {
            cwd,
            timeout: 30000,
            maxBuffer: 4096,
            env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
          },
        );
        const sha = result.stdout.trim();
        if (!/^[a-f0-9]{40}$/.test(sha)) throw invalid();
        return sha;
      },
      catch: () => invalid(),
    }),
);
