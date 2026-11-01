// @effect-diagnostics nodeBuiltinImport:off globalProcess:off globalFetch:off globalTimers:off globalFetchInEffect:off preferSchemaOverJson:off -- This isolated verifier owns its worker child, network requests and startup deadline.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  CommandId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  FoundryGatewayGrant,
  FoundryGatewaySocketTicket,
  FoundryDeviceCatalog,
  FoundryDeviceGrant,
  ORCHESTRATION_PROTOCOL_VERSION,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import * as ServerConfig from "../src/config.ts";
import * as ServerEnvironment from "../src/environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../src/persistence/Sqlite.ts";
import * as ServerSecretStore from "../src/auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "../src/auth/EnvironmentAuth.ts";
import * as SessionStore from "../src/auth/SessionStore.ts";
import * as AccessConfig from "../src/foundry/AccessConfig.ts";
import * as AccessVerifier from "../src/foundry/AccessVerifier.ts";
import * as FoundrySessions from "../src/foundry/FoundrySessions.ts";
import * as InstanceDatabase from "../src/foundry/InstanceDatabase.ts";
import * as InstancePostgres from "../src/foundry/InstancePostgres.ts";
import * as DeviceRegistry from "../src/foundry/DeviceRegistry.ts";
import * as DeviceConfig from "../src/foundry/DeviceConfig.ts";
import * as DeviceGrants from "../src/foundry/DeviceGrants.ts";
import * as DeviceChannel from "../src/foundry/DeviceChannel.ts";
import * as DeviceConnector from "../src/foundry/DeviceConnector.ts";
import * as DeviceHttpAdapter from "../src/foundry/DeviceHttpAdapter.ts";
import * as GatewayGrants from "../src/foundry/GatewayGrants.ts";
import * as GatewayHttp from "../src/foundry/gatewayHttp.ts";
import * as DeviceChannelHttp from "../src/foundry/deviceChannelHttp.ts";
import * as StreamSocket from "../src/foundry/StreamSocket.ts";
import * as StreamBridge from "../src/foundry/StreamBridge.ts";
import { generateDeviceKey, signEnrollment } from "../src/foundry/DeviceProof.ts";

const decodeToken = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

export async function verifyGateway(options: {
  root: string;
  mainHome: string;
  databaseSocket: string;
}) {
  const root = await NodeFSP.mkdtemp(NodePath.join(options.root, "gateway-"));
  const workerHome = NodePath.join(root, "worker");
  const project = NodePath.join(root, "project");
  await NodeFSP.mkdir(project);
  NodeChildProcess.execFileSync("git", ["init", "-q", project]);
  NodeChildProcess.execFileSync("git", [
    "-C",
    project,
    "-c",
    "user.name=Verifier",
    "-c",
    "user.email=verifier@localhost",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  ]);
  await NodeFSP.mkdir(NodePath.join(workerHome, "userdata"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(workerHome, "userdata", "settings.json"),
    JSON.stringify({
      providerInstances: {
        devReplay: {
          displayName: "Replay acceptance fixture",
          driver: "acpRegistry",
          enabled: true,
          config: {
            source: "local",
            commandPath: process.execPath,
            commandArgs: [NodePath.join(import.meta.dirname, "dev-replay-agent.ts")],
          },
        },
      },
    }),
    { mode: 0o600 },
  );
  const reservation = NodeHttp.createServer();
  reservation.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => reservation.once("listening", resolve));
  const address = reservation.address();
  NodeAssert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const localOrigin = `http://127.0.0.1:${port}`;
  const bootstrap = NodeCrypto.randomUUID();
  const worker = NodeChildProcess.spawn(
    process.execPath,
    ["apps/server/src/bin.ts", "start", "--bootstrap-fd", "3", "--log-level", "debug"],
    {
      cwd: NodePath.resolve(import.meta.dirname, "../../.."),
      env: { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8", NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    },
  );
  const pipe = worker.stdio[3];
  NodeAssert.ok(pipe && "write" in pipe);
  pipe.end(
    JSON.stringify({
      mode: "desktop",
      noBrowser: true,
      port,
      host: "127.0.0.1",
      t3Home: workerHome,
      desktopBootstrapToken: bootstrap,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    }),
  );
  const ready = Promise.withResolvers<void>();
  let log = "";
  for (const output of [worker.stdout, worker.stderr])
    output?.on("data", (chunk: Buffer) => {
      log = (log + chunk.toString().replaceAll(bootstrap, "[redacted]")).slice(-16000);
      if (log.includes("startup phase: complete")) ready.resolve();
    });
  worker.once("error", ready.reject);
  worker.once("exit", (code) => ready.reject(new Error(`Isolated worker exited ${code}`)));
  const deadline = setTimeout(
    () => ready.reject(new Error("Isolated worker startup deadline")),
    60000,
  );
  try {
    await ready.promise;
    clearTimeout(deadline);
    const exchange = await fetch(`${localOrigin}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: bootstrap,
        subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      }),
    });
    NodeAssert.equal(exchange.status, 200);
    const directToken = decodeToken(await exchange.json()).access_token;
    const directHeaders = {
      authorization: `Bearer ${directToken}`,
      "content-type": "application/json",
    };
    const projectId = NodeCrypto.randomUUID();
    const created = await fetch(`${localOrigin}/api/projects/mutate`, {
      method: "POST",
      headers: directHeaders,
      body: JSON.stringify({
        type: "project.create",
        commandId: NodeCrypto.randomUUID(),
        projectId,
        title: "Isolated gateway acceptance",
        workspaceRoot: project,
      }),
    });
    NodeAssert.equal(created.status, 200, "worker project creation");
    const accessConfig = {
      issuer: "https://fixture.cloudflareaccess.com",
      audience: "fixture-app",
      origin: "https://foundry.example.test",
    };
    const keys = await generateKeyPair("RS256");
    const jwk = await exportJWK(keys.publicKey);
    const assertion = await new SignJWT({ type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: "integration" })
      .setIssuer(accessConfig.issuer)
      .setAudience(accessConfig.audience)
      .setSubject("operator-subject")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(keys.privateKey);
    const database = InstanceDatabase.layer({
      path: options.databaseSocket,
      username: "foundry_runtime",
      database: "fork_connect",
    });
    const shared = Layer.mergeAll(
      Layer.succeed(AccessConfig.AccessConfig, accessConfig),
      Layer.succeed(
        AccessVerifier.AccessSigningKeys,
        createLocalJWKSet({ keys: [{ ...jwk, kid: "integration", alg: "RS256" }] }),
      ),
      Layer.succeed(DeviceConfig.DeviceOrigin, { origin: accessConfig.origin }),
      Layer.succeed(DeviceConfig.HttpGatewayEnabled, true),
      Layer.succeed(DeviceConfig.StreamGatewayEnabled, true),
      ServerEnvironment.layerIdentity,
    );
    const mainLayer = GatewayGrants.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          DeviceChannel.layer,
          DeviceGrants.layer,
          FoundrySessions.layer,
          EnvironmentAuth.layer,
        ),
      ),
      Layer.provideMerge(
        Layer.mergeAll(
          DeviceRegistry.layer,
          AccessVerifier.layer,
          SqlitePersistence.layerMemory,
          ServerSecretStore.layer,
        ),
      ),
      Layer.provideMerge(InstancePostgres.layer),
      Layer.provideMerge(database),
      Layer.provideMerge(shared),
      Layer.provideMerge(ServerConfig.layerTest(root, options.mainHome)),
      Layer.provideMerge(NodeServices.layer),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const main = yield* Layer.build(mainLayer);
        const server = yield* Layer.build(
          HttpRouter.serve(Layer.merge(GatewayHttp.layer, DeviceChannelHttp.layer), {
            disableListenLog: true,
          }).pipe(
            Layer.provide(Layer.succeedContext(main)),
            Layer.provideMerge(NodeHttpServer.layerTest),
          ),
        );
        const mainOrigin = HttpServer.formatAddress(
          Context.get(server, HttpServer.HttpServer).address,
        ).replace("0.0.0.0", "127.0.0.1");
        const socketOrigin = mainOrigin.replace(/^http/, "ws");
        const workerServices = yield* Layer.build(
          SessionStore.layer.pipe(
            Layer.provideMerge(SqlitePersistence.layerConfig),
            Layer.provideMerge(ServerSecretStore.layer),
            Layer.provideMerge(ServerEnvironment.layerIdentity),
            Layer.provideMerge(FetchHttpClient.layer),
            Layer.provideMerge(ServerConfig.layerTest(root, workerHome)),
            Layer.provideMerge(NodeServices.layer),
          ),
        );
        const environmentId = yield* Context.get(
          workerServices,
          ServerEnvironment.ServerEnvironmentIdentity,
        ).getEnvironmentId;
        const key = generateDeviceKey();
        const registry = Context.get(main, DeviceRegistry.DeviceRegistry);
        const invitation = yield* registry.approve({ environmentId, publicKey: key.publicKey });
        const device = yield* registry.enroll(signEnrollment(invitation, key.privateKey));
        const adapter = yield* DeviceHttpAdapter.make({
          device,
          origin: accessConfig.origin,
          localOrigin,
          localEnvironmentId: Effect.succeed(environmentId),
        }).pipe(Effect.provide(workerServices));
        const connected = yield* Deferred.make<void>();
        const connector = yield* DeviceConnector.runOnce(
          yield* StreamSocket.connect(`${socketOrigin}/api/foundry/devices/channel`),
          {
            device,
            origin: accessConfig.origin,
            privateKey: Redacted.make(key.privateKey),
            localEnvironmentId: Effect.succeed(environmentId),
            connected: Deferred.succeed(connected, undefined).pipe(Effect.asVoid),
            projects: adapter.projects,
            stream: Effect.fn("verification.workerStream")(
              function* (grant, generation, ticket) {
                const local = yield* adapter.openStream(grant, generation);
                const remote = yield* StreamSocket.connect(
                  `${socketOrigin}/api/foundry/devices/stream`,
                  { "x-foundry-stream-ticket": ticket },
                );
                return yield* StreamBridge.bridge(local, remote, Effect.void);
              },
              Effect.scoped,
              Effect.orDie,
            ),
          },
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(connected);
        const clients: Array<Record<string, string>> = [];
        for (const subject of ["client-a", "client-b"]) {
          const foundry = yield* Context.get(main, FoundrySessions.FoundrySessions).login(
            assertion,
          );
          const t3 = yield* Context.get(main, SessionStore.SessionStore).issue({
            subject,
            method: "bearer-access-token",
            scopes: [
              "orchestration:read",
              "orchestration:operate",
              "access:write",
              "filesystem:read",
              "terminal:read",
              "terminal:operate",
            ],
          });
          clients.push({
            origin: accessConfig.origin,
            host: "foundry.example.test",
            "x-forwarded-proto": "https",
            "content-type": "application/json",
            cookie: `${FoundrySessions.FOUNDRY_SESSION_COOKIE}=${foundry.token}`,
            authorization: `Bearer ${t3.token}`,
            "x-foundry-csrf": foundry.session.csrfToken,
          });
        }
        const post = Effect.fn("verification.post")(function* (
          index: number,
          operation: string,
          input: unknown,
        ) {
          const response = yield* Effect.promise(
            () =>
              new Promise<{ status: number; body: string }>((resolve, reject) => {
                const request = NodeHttp.request(
                  `${mainOrigin}/api/foundry/gateway/${operation}`,
                  { method: "POST", headers: clients[index]! },
                  (response) => {
                    const chunks: Buffer[] = [];
                    response.on("data", (chunk: Buffer) => chunks.push(chunk));
                    response.once("end", () =>
                      resolve({
                        status: response.statusCode ?? 0,
                        body: Buffer.concat(chunks).toString(),
                      }),
                    );
                    response.once("error", reject);
                  },
                );
                request.once("error", reject);
                request.setTimeout(15000, () =>
                  request.destroy(new Error("Gateway HTTP request deadline")),
                );
                request.end(JSON.stringify(input));
              }),
          );
          NodeAssert.equal(response.status, 200, operation);
          return yield* decodeJson(response.body);
        });
        const target = { deviceId: device.deviceId, environmentId };
        const scopes = [
          "orchestration:read",
          "orchestration:operate",
          "filesystem:read",
          "terminal:read",
          "terminal:operate",
        ];
        const sockets = [];
        for (const index of [0, 1]) {
          const catalog = yield* post(index, "grants/catalog", {}).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(FoundryDeviceCatalog)),
          );
          NodeAssert.ok(catalog.devices.some((entry) => entry.deviceId === device.deviceId));
          const grant = yield* post(index, "grants/create", { ...target, scopes }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(FoundryGatewayGrant)),
          );
          const lookup = { ...target, grantId: grant.grantId };
          const projects = yield* post(index, "projects", lookup);
          NodeAssert.ok(
            JSON.stringify(projects).includes(projectId),
            "HTTP read reaches worker project",
          );
          const ticket = yield* post(index, "grants/ticket", lookup).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(FoundryGatewaySocketTicket)),
          );
          const socket = yield* StreamSocket.connect(
            `${socketOrigin}/api/foundry/gateway/stream?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&ticket=${ticket.ticket}&wsTicket=${ticket.wsTicket}`,
            clients[index],
          );
          const protocol = RpcClient.layerProtocolSocket().pipe(
            Layer.provide(Layer.succeed(Socket.Socket, socket)),
            Layer.provide(RpcSerialization.layerJson),
          );
          const protocolContext = yield* Layer.build(protocol);
          const rpc = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(protocolContext));
          const config = yield* rpc["server.getConfig"]({}).pipe(Effect.timeout("15 seconds"));
          NodeAssert.equal(
            config.environment.environmentId,
            environmentId,
            "RPC reaches the registered worker",
          );
          sockets.push({ rpc, lookup });
        }
        const bytes = Buffer.alloc(32768 + 29, 0x41);
        const digest = (data: Uint8Array) =>
          NodeCrypto.createHash("sha256").update(data).digest("hex");
        const first = sockets[0]!.rpc;
        const second = sockets[1]!.rpc;
        const threadId = ThreadId.make(NodeCrypto.randomUUID());
        const launch = {
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          threadId,
          projectId: ProjectId.make(projectId),
          title: "Gateway replay acceptance",
          modelSelection: { instanceId: ProviderInstanceId.make("devReplay"), model: "multi-turn" },
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          workspaceStrategy: { type: "root" as const },
          initialMessage: { text: "go", attachments: [] },
        };
        yield* first["orchestration.launchThread"](launch);
        yield* first["orchestration.launchThread"](launch);
        const completed = yield* second["orchestration.subscribeThread"]({ threadId }).pipe(
          Stream.mapEffect((item) =>
            item.kind === "snapshot"
              ? Effect.succeed(item.projection)
              : second["orchestration.getThreadProjection"]({ threadId }),
          ),
          Stream.filter((projection) =>
            projection.runs.some((run) =>
              ["completed", "failed", "cancelled", "interrupted"].includes(run.status),
            ),
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("30 seconds"),
        );
        NodeAssert.equal(completed.length, 1);
        NodeAssert.equal(completed[0]!.runs.length, 1, "retry does not duplicate the run");
        NodeAssert.equal(
          completed[0]!.runs[0]!.status,
          "completed",
          "Replay completes through Main",
        );
        NodeAssert.ok(
          completed[0]!.messages.some(
            (message) => message.role === "assistant" && message.text.length > 0,
          ),
        );
        const sameThread = yield* first["orchestration.getThreadProjection"]({ threadId });
        NodeAssert.equal(sameThread.runs[0]!.id, completed[0]!.runs[0]!.id);
        const upload = yield* first["attachments.createUploadUrl"]({
          type: "file",
          name: "gateway.bin",
          mimeType: "application/octet-stream",
          sizeBytes: bytes.length,
        });
        const write = (offset: number) => {
          const chunk = bytes.subarray(offset, offset + 32768);
          return {
            url: upload.relativeUrl,
            offset,
            data: chunk.toString("base64"),
            sha256: digest(chunk),
            fileSha256: digest(bytes),
          };
        };
        yield* first["attachments.writeChunk"](write(0));
        const confirmed = yield* second["attachments.chunkStatus"]({ url: upload.relativeUrl });
        NodeAssert.equal(confirmed.offset, 32768);
        NodeAssert.equal(confirmed.complete, false);
        NodeAssert.equal(
          (yield* second["attachments.writeChunk"](write(0))).offset,
          32768,
          "lost-reply retry does not append duplicate bytes",
        );
        NodeAssert.equal(
          (yield* second["attachments.writeChunk"](write(confirmed.offset))).complete,
          true,
        );
        const asset = yield* first["assets.createUrl"]({
          resource: { _tag: "attachment", attachmentId: upload.attachmentId },
        });
        const head = yield* first["assets.readChunk"]({ url: asset.relativeUrl, offset: 0 });
        const tail = yield* second["assets.readChunk"]({
          url: asset.relativeUrl,
          offset: head.total > 32768 ? 32768 : head.total,
          revision: head.revision,
        });
        NodeAssert.equal(
          digest(
            Buffer.concat([Buffer.from(head.data, "base64"), Buffer.from(tail.data, "base64")]),
          ),
          digest(bytes),
        );
        const stored = yield* Effect.promise(() =>
          NodeFSP.readFile(
            NodePath.join(workerHome, "userdata", "attachments", `${upload.attachmentId}.bin`),
          ),
        );
        NodeAssert.equal(digest(stored), digest(bytes), "bytes persisted by real worker");
        const terminal = { threadId, terminalId: "acceptance-terminal" };
        yield* first["terminal.open"]({ ...terminal, cwd: project });
        yield* first["terminal.write"]({
          ...terminal,
          data: "printf x >> acceptance-count; printf '\\107\\101\\124\\105\\127\\101\\131\\137\\117\\113\\n'\n",
        });
        const output = yield* second["terminal.observe"](terminal).pipe(
          Stream.scan(
            () => "",
            (text, event) =>
              text +
              (event.type === "output"
                ? event.data
                : event.type === "snapshot"
                  ? event.snapshot.history
                  : ""),
          ),
          Stream.filter((text) => text.includes("GATEWAY_OK")),
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("10 seconds"),
        );
        NodeAssert.equal(output.length, 1);
        const watching = yield* Deferred.make<void>();
        const terminalStream = yield* second["terminal.observe"](terminal).pipe(
          Stream.tap(() => Deferred.succeed(watching, undefined)),
          Stream.runDrain,
          Effect.result,
          Effect.forkScoped,
        );
        yield* Deferred.await(watching);
        const grants = yield* post(0, "grants/readAccess", { deviceId: device.deviceId }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(FoundryDeviceGrant))),
        );
        const access = grants.find((grant) => grant.kind === "clientAccess")!;
        yield* post(0, "grants/updateAccess", {
          deviceId: device.deviceId,
          kind: "clientAccess",
          enabled: false,
          generation: access.generation,
        });
        for (const client of sockets)
          NodeAssert.equal(
            (yield* client.rpc["server.getConfig"]({}).pipe(
              Effect.result,
              Effect.timeout("10 seconds"),
            ))._tag,
            "Failure",
            "revocation fences both clients",
          );
        NodeAssert.equal(
          (yield* Fiber.join(terminalStream).pipe(Effect.timeout("10 seconds")))._tag,
          "Failure",
          "active terminal subscription closes after revoke",
        );
        NodeAssert.equal(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(project, "acceptance-count"), "utf8"),
          ),
          "x",
          "terminal input executed once",
        );
        const direct = yield* Effect.promise(() =>
          fetch(`${localOrigin}/api/projects`, { headers: directHeaders }),
        );
        NodeAssert.equal(direct.status, 200, "independent direct T3 credential survives");
        yield* Fiber.interrupt(connector);
      }).pipe(Effect.scoped),
    );
  } finally {
    clearTimeout(deadline);
    if (worker.exitCode === null && worker.signalCode === null) {
      const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
      worker.kill("SIGTERM");
      const force = setTimeout(() => worker.kill("SIGKILL"), 5000);
      try {
        await exited;
      } finally {
        clearTimeout(force);
      }
    }
    await NodeFSP.writeFile(NodePath.join(root, "worker.log"), log, { mode: 0o600 });
  }
}
