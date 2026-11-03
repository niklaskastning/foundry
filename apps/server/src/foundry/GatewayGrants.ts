import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  AuthOrchestrationReadScope,
  AuthAccessWriteScope,
  AuthSessionId,
  EnvironmentId,
  FoundryInstanceId,
  FoundryDeviceId,
  FoundryDeviceApproval,
  type FoundryDeviceCatalog,
  type FoundryEnrollment,
  type FoundryDeviceGrant,
  FoundryGatewayError,
  FoundryGatewayGrantId,
  FoundryGatewayGrantRequest,
  FoundryGatewayGrantLookup,
  type FoundryGatewayGrant,
  type FoundryGatewaySocketTicket,
  type ProjectSnapshot,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Socket from "effect/socket/Socket";
import * as Redacted from "effect/Redacted";
import { base64UrlEncode } from "../auth/utils.ts";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as SessionStore from "../auth/SessionStore.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as DeviceGrants from "./DeviceGrants.ts";
import * as DeviceRegistry from "./DeviceRegistry.ts";
import * as DeviceChannel from "./DeviceChannel.ts";
import * as DeviceConfig from "./DeviceConfig.ts";
import * as FoundrySessions from "./FoundrySessions.ts";
import * as ClientIdentity from "./ClientIdentity.ts";

const decodeRequest = Schema.decodeUnknownEffect(FoundryGatewayGrantRequest, {
  onExcessProperty: "error",
});
const decodeLookup = Schema.decodeUnknownEffect(FoundryGatewayGrantLookup, {
  onExcessProperty: "error",
});
const decodeDeviceId = Schema.decodeUnknownEffect(Schema.Struct({ deviceId: FoundryDeviceId }), {
  onExcessProperty: "error",
});
const decodeEmpty = Schema.decodeUnknownEffect(Schema.Struct({}), { onExcessProperty: "error" });
const decodeApproval = Schema.decodeUnknownEffect(FoundryDeviceApproval, {
  onExcessProperty: "error",
});
const decodeId = Schema.decodeUnknownEffect(FoundryGatewayGrantId);
const denied = () => new FoundryGatewayError({ code: "forbidden" });
const invalid = () => new FoundryGatewayError({ code: "invalid_request" });
type Request = HttpServerRequest.HttpServerRequest;

export const AutomationGatewayIdentity = Schema.Struct({
  instanceId: FoundryInstanceId,
  operatorId: Schema.String,
  deviceId: FoundryDeviceId,
  environmentId: EnvironmentId,
  deviceGeneration: Schema.Int,
  accessGeneration: Schema.Int,
  automationGeneration: Schema.Int,
  clientSessionId: AuthSessionId,
  foundrySessionHash: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
});
export type AutomationGatewayIdentity = typeof AutomationGatewayIdentity.Type;

export class GatewayGrants extends Context.Service<
  GatewayGrants,
  {
    readonly identityForRead: (
      request: Request,
    ) => Effect.Effect<
      Pick<AutomationGatewayIdentity, "instanceId" | "operatorId">,
      FoundryGatewayError
    >;
    readonly catalog: (
      request: Request,
      input: unknown,
    ) => Effect.Effect<FoundryDeviceCatalog, FoundryGatewayError>;
    readonly approveDevice: (
      request: Request,
      input: unknown,
    ) => Effect.Effect<FoundryEnrollment, FoundryGatewayError>;
    readonly revokeDevice: (
      request: Request,
      input: unknown,
    ) => Effect.Effect<void, FoundryGatewayError>;
    readonly readAccess: (
      request: Request,
      input: unknown,
    ) => Effect.Effect<ReadonlyArray<FoundryDeviceGrant>, FoundryGatewayError>;
    readonly updateAccess: (
      request: Request,
      input: unknown,
    ) => Effect.Effect<FoundryDeviceGrant, FoundryGatewayError>;
    readonly ticket: (
      request: Request,
      input: unknown,
    ) => Effect.Effect<FoundryGatewaySocketTicket, FoundryGatewayError>;
    readonly stream: (
      request: Request,
      upgrade: Effect.Effect<Socket.Socket, FoundryGatewayError>,
    ) => Effect.Effect<void, FoundryGatewayError>;
    readonly authorizeAutomation: (
      request: Request,
      target: Pick<AutomationGatewayIdentity, "deviceId" | "environmentId">,
    ) => Effect.Effect<AutomationGatewayIdentity, FoundryGatewayError>;
    readonly openAutomation: (
      identity: AutomationGatewayIdentity,
      socket: Socket.Socket,
    ) => Effect.Effect<void, FoundryGatewayError>;
    readonly projects: (
      request: Request,
      input: unknown,
    ) => Effect.Effect<ProjectSnapshot, FoundryGatewayError>;
    readonly create: (
      request: Request,
      input: unknown,
    ) => Effect.Effect<FoundryGatewayGrant, FoundryGatewayError>;
    readonly inspect: (
      request: Request,
      input: unknown,
    ) => Effect.Effect<FoundryGatewayGrant, FoundryGatewayError>;
    readonly remove: (request: Request, input: unknown) => Effect.Effect<void, FoundryGatewayError>;
  }
>()("t3/foundry/GatewayGrants") {}

const make = Effect.gen(function* () {
  const sessions = yield* FoundrySessions.FoundrySessions;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const clientSessions = yield* SessionStore.SessionStore;
  const channels = yield* DeviceChannel.DeviceChannel;
  const access = yield* DeviceGrants.DeviceGrants;
  const registry = yield* DeviceRegistry.DeviceRegistry;
  const { origin } = yield* DeviceConfig.DeviceOrigin;
  const crypto = yield* Crypto.Crypto;
  const streamsEnabled = yield* DeviceConfig.StreamGatewayEnabled;
  const tickets = new Map<
    string,
    {
      grant: FoundryGatewayGrant;
      validate: Effect.Effect<void, FoundryGatewayError>;
      expiresAt: number;
    }
  >();
  // Handles are not credentials: every use reauthenticates both sessions and the device lease.
  const grants = new Map<string, { grant: FoundryGatewayGrant; binding: string }>();
  const clientIdentityContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof ClientIdentity.authenticate>>>();
  const authenticate = Effect.fn("GatewayGrants.authenticate")(
    (request: Request) =>
      ClientIdentity.authenticate(request).pipe(Effect.provide(clientIdentityContext)),
    Effect.mapError((error) =>
      EnvironmentAuth.isServerAuthInternalError(error) ||
      (error._tag === "FoundryAuthError" && error.code === "unavailable")
        ? new FoundryGatewayError({ code: "unavailable" })
        : denied(),
    ),
  );
  const create = Effect.fn("GatewayGrants.create")(function* (request: Request, input: unknown) {
    const identity = yield* authenticate(request);
    const target = yield* decodeRequest(input).pipe(Effect.mapError(invalid));
    if (
      !target.scopes.includes(AuthOrchestrationReadScope) ||
      new Set(target.scopes).size !== target.scopes.length ||
      !target.scopes.every((scope) => identity.client.scopes.includes(scope)) ||
      (!streamsEnabled && target.scopes.some((scope) => scope !== AuthOrchestrationReadScope))
    )
      return yield* denied();
    const accessGeneration = yield* access.check(target.deviceId, identity.foundry.operatorId);
    const lease = yield* channels.current(target.deviceId).pipe(Effect.mapError(denied));
    if (
      lease.device.revoked ||
      lease.device.instanceId !== identity.foundry.instanceId ||
      lease.device.environmentId !== target.environmentId
    )
      return yield* denied();
    const now = yield* Clock.currentTimeMillis;
    const expiresAt = Math.min(
      now + 60_000,
      identity.foundry.expiresAt,
      identity.client.expiresAt ? DateTime.toEpochMillis(identity.client.expiresAt) : Infinity,
    );
    if (expiresAt <= now) return yield* denied();
    const grantId = FoundryGatewayGrantId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
    const grant: FoundryGatewayGrant = {
      ...target,
      grantId,
      protocolVersion: "2",
      grantKind: "clientAccess",
      accessGeneration,
      instanceId: identity.foundry.instanceId,
      origin,
      operatorId: identity.foundry.operatorId,
      clientSessionId: identity.client.sessionId,
      subject: identity.client.subject,
      generation: lease.device.generation,
      channelGeneration: lease.channelGeneration,
      expiresAt,
    };
    for (const [id, entry] of grants) if (entry.grant.expiresAt <= now) grants.delete(id);
    if (grants.size >= 128) return yield* new FoundryGatewayError({ code: "capacity" });
    grants.set(grantId, { grant, binding: identity.foundry.csrfToken });
    return grant;
  });
  const identityForRead = Effect.fn("GatewayGrants.identityForRead")(function* (request: Request) {
    const identity = yield* authenticate(request);
    if (!identity.client.scopes.includes(AuthOrchestrationReadScope)) return yield* denied();
    return { instanceId: identity.foundry.instanceId, operatorId: identity.foundry.operatorId };
  });
  const owned = Effect.fn("GatewayGrants.owned")(function* (request: Request, grantId: unknown) {
    const identity = yield* authenticate(request);
    const id = yield* decodeId(grantId).pipe(Effect.mapError(invalid));
    const entry = grants.get(id);
    if (
      !entry ||
      entry.binding !== identity.foundry.csrfToken ||
      entry.grant.operatorId !== identity.foundry.operatorId ||
      entry.grant.instanceId !== identity.foundry.instanceId ||
      entry.grant.clientSessionId !== identity.client.sessionId ||
      entry.grant.subject !== identity.client.subject
    )
      return yield* denied();
    return { ...entry, client: identity.client };
  });
  const inspectWithClient = Effect.fn("GatewayGrants.inspect")(function* (
    request: Request,
    input: unknown,
  ) {
    const target = yield* decodeLookup(input).pipe(Effect.mapError(invalid));
    const { grant, client } = yield* owned(request, target.grantId);
    if (grant.expiresAt <= (yield* Clock.currentTimeMillis)) {
      grants.delete(grant.grantId);
      return yield* denied();
    }
    if (
      !grant.scopes.every((scope) => client.scopes.includes(scope)) ||
      grant.deviceId !== target.deviceId ||
      grant.environmentId !== target.environmentId
    )
      return yield* denied();
    yield* access.check(grant.deviceId, grant.operatorId, grant.accessGeneration);
    const lease = yield* channels.current(grant.deviceId).pipe(Effect.mapError(denied));
    if (
      lease.device.revoked ||
      lease.device.instanceId !== grant.instanceId ||
      lease.device.environmentId !== grant.environmentId ||
      lease.device.generation !== grant.generation ||
      lease.channelGeneration !== grant.channelGeneration
    )
      return yield* denied();
    return { grant, client };
  });
  const inspect = (request: Request, input: unknown) =>
    inspectWithClient(request, input).pipe(Effect.map((result) => result.grant));
  const remove = Effect.fn("GatewayGrants.remove")(function* (request: Request, input: unknown) {
    const target = yield* decodeLookup(input).pipe(Effect.mapError(invalid));
    const { grant } = yield* owned(request, target.grantId);
    if (grant.deviceId !== target.deviceId || grant.environmentId !== target.environmentId)
      return yield* denied();
    grants.delete(grant.grantId);
  });
  const validation = Effect.fn("GatewayGrants.validate")(function* (
    request: Request,
    grant: FoundryGatewayGrant,
  ) {
    const foundry = yield* sessions
      .inspect(request.cookies[FoundrySessions.FOUNDRY_SESSION_COOKIE])
      .pipe(Effect.mapError(denied));
    const entry = grants.get(grant.grantId);
    yield* access.check(grant.deviceId, grant.operatorId, grant.accessGeneration);
    const clients = yield* clientSessions
      .listActive()
      .pipe(Effect.mapError(() => new FoundryGatewayError({ code: "unavailable" })));
    if (
      !entry ||
      entry.grant !== grant ||
      entry.binding !== foundry.csrfToken ||
      foundry.instanceId !== grant.instanceId ||
      foundry.operatorId !== grant.operatorId ||
      grant.expiresAt <= (yield* Clock.currentTimeMillis) ||
      !clients.some(
        (client) =>
          client.sessionId === grant.clientSessionId &&
          grant.scopes.every((scope) => client.scopes.includes(scope)),
      )
    )
      return yield* denied();
  });
  const projects = Effect.fn("GatewayGrants.projects")(function* (
    request: Request,
    input: unknown,
  ) {
    const grant = yield* inspect(request, input);
    return yield* channels.projects(grant, validation(request, grant));
  });
  const automationAccess = Effect.fn("GatewayGrants.automationAccess")(function* (
    deviceId: FoundryDeviceId,
    operatorId: string,
    generation?: number,
  ) {
    const rows = yield* access.read(deviceId, operatorId);
    const grant = rows.find((row) => row.kind === "automationExecution");
    if (!grant?.enabled || (generation !== undefined && grant.generation !== generation))
      return yield* denied();
    return grant.generation;
  });
  const authorizeAutomation = Effect.fn("GatewayGrants.authorizeAutomation")(function* (
    request: Request,
    target: Pick<AutomationGatewayIdentity, "deviceId" | "environmentId">,
  ) {
    const grant = yield* create(request, {
      deviceId: target.deviceId,
      environmentId: target.environmentId,
      scopes: ["orchestration:read", "orchestration:operate"],
    });
    return yield* Effect.gen(function* () {
      const automationGeneration = yield* automationAccess(grant.deviceId, grant.operatorId);
      const foundrySessionHash = yield* sessions
        .reference(request.cookies[FoundrySessions.FOUNDRY_SESSION_COOKIE])
        .pipe(Effect.mapError(denied));
      return {
        instanceId: grant.instanceId,
        operatorId: grant.operatorId,
        deviceId: grant.deviceId,
        environmentId: grant.environmentId,
        deviceGeneration: grant.generation,
        accessGeneration: grant.accessGeneration,
        automationGeneration,
        clientSessionId: grant.clientSessionId,
        foundrySessionHash,
      } satisfies AutomationGatewayIdentity;
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          grants.delete(grant.grantId);
        }),
      ),
    );
  });
  const validateAutomation = Effect.fn("GatewayGrants.validateAutomation")(function* (
    identity: AutomationGatewayIdentity,
  ) {
    if (!streamsEnabled) return yield* denied();
    const foundry = yield* sessions
      .inspectReference(identity.foundrySessionHash)
      .pipe(Effect.mapError(denied));
    if (foundry.instanceId !== identity.instanceId || foundry.operatorId !== identity.operatorId)
      return yield* denied();
    const clients = yield* clientSessions
      .listActive()
      .pipe(Effect.mapError(() => new FoundryGatewayError({ code: "unavailable" })));
    const client = clients.find((entry) => entry.sessionId === identity.clientSessionId);
    if (
      !client ||
      !client.scopes.includes("orchestration:read") ||
      !client.scopes.includes("orchestration:operate")
    )
      return yield* denied();
    yield* access.check(identity.deviceId, identity.operatorId, identity.accessGeneration);
    yield* automationAccess(identity.deviceId, identity.operatorId, identity.automationGeneration);
    const lease = yield* channels.current(identity.deviceId).pipe(Effect.mapError(denied));
    if (
      lease.device.revoked ||
      lease.device.instanceId !== identity.instanceId ||
      lease.device.environmentId !== identity.environmentId ||
      lease.device.generation !== identity.deviceGeneration ||
      !lease.rpcStream
    )
      return yield* denied();
    return { foundry, client, lease };
  });
  const openAutomation = Effect.fn("GatewayGrants.openAutomation")(function* (
    identity: AutomationGatewayIdentity,
    socket: Socket.Socket,
  ) {
    const { foundry, client, lease } = yield* validateAutomation(identity);
    const expiresAt = Math.min(
      (yield* Clock.currentTimeMillis) + 60_000,
      foundry.expiresAt,
      DateTime.toEpochMillis(client.expiresAt),
    );
    const grant: FoundryGatewayGrant = {
      deviceId: identity.deviceId,
      environmentId: identity.environmentId,
      scopes: ["orchestration:read", "orchestration:operate"],
      grantId: FoundryGatewayGrantId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
      protocolVersion: "2",
      grantKind: "clientAccess",
      accessGeneration: identity.accessGeneration,
      instanceId: identity.instanceId,
      origin,
      operatorId: identity.operatorId,
      clientSessionId: identity.clientSessionId,
      subject: client.subject,
      generation: identity.deviceGeneration,
      channelGeneration: lease.channelGeneration,
      expiresAt,
    };
    // clientAccess authorizes the existing transport; Automation additionally checks its own grant.
    const check = Effect.gen(function* () {
      const current = yield* validateAutomation(identity);
      if (
        current.lease.channelGeneration !== grant.channelGeneration ||
        grant.expiresAt <= (yield* Clock.currentTimeMillis)
      )
        return yield* denied();
    });
    yield* check;
    yield* channels.stream(grant, check, socket);
  });
  const ticket = Effect.fn("GatewayGrants.ticket")(function* (request: Request, input: unknown) {
    if (!streamsEnabled) return yield* denied();
    const { grant, client } = yield* inspectWithClient(request, input);
    const now = yield* Clock.currentTimeMillis;
    for (const [key, entry] of tickets) if (entry.expiresAt <= now) tickets.delete(key);
    const key = base64UrlEncode(yield* crypto.randomBytes(32).pipe(Effect.orDie));
    const issued = yield* auth
      .issueWebSocketTicket(client, { use: "rpc" })
      .pipe(Effect.mapError(denied));
    const expiresAt = Math.min(now + 10000, grant.expiresAt);
    if (tickets.size >= 128) return yield* new FoundryGatewayError({ code: "capacity" });
    tickets.set(key, { grant, expiresAt, validate: validation(request, grant) });
    return { ticket: key, wsTicket: Redacted.value(issued.ticket), expiresAt };
  });
  const stream = Effect.fn("GatewayGrants.stream")(function* (
    request: Request,
    upgrade: Effect.Effect<Socket.Socket, FoundryGatewayError>,
  ) {
    const url = HttpServerRequest.toURL(request);
    if (
      !streamsEnabled ||
      Option.isNone(url) ||
      url.value.searchParams.get(ORCHESTRATION_PROTOCOL_QUERY_PARAM) !==
        String(ORCHESTRATION_PROTOCOL_VERSION) ||
      url.value.origin !== origin ||
      request.headers.origin !== origin
    )
      return yield* denied();
    const key = url.value.searchParams.get("ticket") ?? "";
    const entry = tickets.get(key);
    tickets.delete(key);
    if (!entry || entry.expiresAt <= (yield* Clock.currentTimeMillis)) return yield* denied();
    const client = yield* auth
      .authenticateWebSocketUpgrade(request, "rpc")
      .pipe(Effect.mapError(denied));
    if (client.sessionId !== entry.grant.clientSessionId) return yield* denied();
    yield* entry.validate;
    const socket = yield* upgrade.pipe(
      Effect.mapError(() => new FoundryGatewayError({ code: "unavailable" })),
    );
    yield* channels.stream(entry.grant, entry.validate, socket);
  });
  const readAccess = Effect.fn("GatewayGrants.readAccess")(function* (
    request: Request,
    input: unknown,
  ) {
    const identity = yield* authenticate(request);
    if (!identity.client.scopes.includes(AuthAccessWriteScope)) return yield* denied();
    const { deviceId } = yield* decodeDeviceId(input).pipe(Effect.mapError(invalid));
    return yield* access.read(deviceId, identity.foundry.operatorId);
  });
  const updateAccess = Effect.fn("GatewayGrants.updateAccess")(function* (
    request: Request,
    input: unknown,
  ) {
    const identity = yield* authenticate(request);
    if (!identity.client.scopes.includes(AuthAccessWriteScope)) return yield* denied();
    return yield* access.update(input, identity.foundry.operatorId);
  });
  const catalog = Effect.fn("GatewayGrants.catalog")(function* (request: Request, input: unknown) {
    if (!streamsEnabled) return yield* denied();
    yield* decodeEmpty(input).pipe(Effect.mapError(invalid));
    const identity = yield* authenticate(request);
    if (!identity.client.scopes.includes(AuthOrchestrationReadScope)) return yield* denied();
    const devices = yield* registry
      .list(identity.foundry.operatorId)
      .pipe(Effect.mapError(() => new FoundryGatewayError({ code: "unavailable" })));
    return {
      instanceId: identity.foundry.instanceId,
      canManage: identity.client.scopes.includes(AuthAccessWriteScope),
      scopes: identity.client.scopes,
      devices: yield* Effect.forEach(devices, (device) =>
        channels.current(device.deviceId).pipe(
          Effect.map((lease) => ({ ...device, online: true, rpcReady: lease.rpcStream })),
          Effect.catchTags({
            FoundryDeviceError: () => Effect.succeed({ ...device, online: false, rpcReady: false }),
          }),
        ),
      ),
    };
  });
  const approveDevice = Effect.fn("GatewayGrants.approveDevice")(function* (
    request: Request,
    input: unknown,
  ) {
    if (!streamsEnabled) return yield* denied();
    const identity = yield* authenticate(request);
    if (!identity.client.scopes.includes(AuthAccessWriteScope)) return yield* denied();
    const value = yield* decodeApproval(input).pipe(Effect.mapError(invalid));
    return yield* registry
      .approve(value)
      .pipe(Effect.mapError(() => new FoundryGatewayError({ code: "unavailable" })));
  });
  const revokeDevice = Effect.fn("GatewayGrants.revokeDevice")(function* (
    request: Request,
    input: unknown,
  ) {
    if (!streamsEnabled) return yield* denied();
    const identity = yield* authenticate(request);
    if (!identity.client.scopes.includes(AuthAccessWriteScope)) return yield* denied();
    const { deviceId } = yield* decodeDeviceId(input).pipe(Effect.mapError(invalid));
    const ownedDevices = yield* registry
      .list(identity.foundry.operatorId)
      .pipe(Effect.mapError(denied));
    if (!ownedDevices.some((device) => device.deviceId === deviceId)) return yield* denied();
    yield* registry
      .revoke(deviceId)
      .pipe(Effect.mapError(() => new FoundryGatewayError({ code: "unavailable" })));
  });
  return GatewayGrants.of({
    identityForRead,
    catalog,
    approveDevice,
    revokeDevice,
    create,
    inspect,
    remove,
    projects,
    ticket,
    stream,
    authorizeAutomation,
    openAutomation,
    readAccess,
    updateAccess,
  });
});
export const layer = Layer.effect(GatewayGrants, make);
