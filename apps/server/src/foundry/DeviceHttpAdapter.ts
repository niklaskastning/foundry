// @effect-diagnostics nodeBuiltinImport:off -- The local HTTP adapter signs fresh P-256 DPoP proofs; verification stays in EnvironmentAuth.
import * as NodeCrypto from "node:crypto";
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  FoundryGatewayGrant,
  FoundryGatewayError,
  ProjectSnapshot,
  ExecutionEnvironmentDescriptor,
  type FoundryDevice,
  type EnvironmentId,
  type FoundryDeviceError,
} from "@t3tools/contracts";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@t3tools/shared/dpop";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpClient, FetchHttpClient } from "effect/http";
import * as Schema from "effect/Schema";
import * as StreamSocket from "./StreamSocket.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

const encodeSubject = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ kind: Schema.Literal("foundry-gateway-v1"), ...FoundryGatewayGrant.fields }),
  ),
);
const decodeGrant = Schema.decodeUnknownEffect(FoundryGatewayGrant);
const decodeDescriptor = Schema.decodeEffect(Schema.fromJsonString(ExecutionEnvironmentDescriptor));
const decodeProjects = Schema.decodeEffect(Schema.fromJsonString(ProjectSnapshot));
const unavailable = () => new FoundryGatewayError({ code: "unavailable" });
const forbidden = () => new FoundryGatewayError({ code: "forbidden" });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

const readJson = Effect.fn("DeviceHttpAdapter.readJson")(function* (
  client: HttpClient.HttpClient,
  url: string,
  headers: Record<string, string> = {},
) {
  const response = yield* client
    .get(url, { headers })
    .pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.mapError(unavailable),
    );
  if (
    response.status !== 200 ||
    response.headers.location ||
    response.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json"
  )
    return yield* unavailable();
  const bytes = yield* response.stream.pipe(
    Stream.runFoldEffect(
      () => new Uint8Array(0),
      (bytes, chunk) => {
        if (bytes.length + chunk.length > 65536) return Effect.fail(unavailable());
        const next = new Uint8Array(bytes.length + chunk.length);
        next.set(bytes);
        next.set(chunk, bytes.length);
        return Effect.succeed(next);
      },
    ),
    Effect.mapError(unavailable),
  );
  return new TextDecoder().decode(bytes);
});

export const make = Effect.fn("DeviceHttpAdapter.make")(function* (options: {
  readonly device: FoundryDevice;
  readonly origin: string;
  readonly localOrigin: string;
  readonly localEnvironmentId: Effect.Effect<EnvironmentId, FoundryDeviceError>;
}) {
  if (!URL.canParse(options.localOrigin)) return yield* forbidden();
  const local = new URL(options.localOrigin);
  if (
    local.origin !== options.localOrigin ||
    local.protocol !== "http:" ||
    local.hostname !== "127.0.0.1"
  )
    return yield* forbidden();
  const sessions = yield* SessionStore.SessionStore;
  const client = yield* HttpClient.HttpClient;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
  const proofKeyThumbprint = computeDpopJwkThumbprint(jwk);
  const authorize = Effect.fn("DeviceHttpAdapter.authorize")(function* (
    input: unknown,
    channelGeneration: number,
    stream: boolean,
  ) {
    const grant = yield* decodeGrant(input).pipe(Effect.mapError(forbidden));
    const now = yield* Clock.currentTimeMillis;
    if (
      !grant.scopes.includes("orchestration:read") ||
      new Set(grant.scopes).size !== grant.scopes.length ||
      grant.instanceId !== options.device.instanceId ||
      grant.origin !== options.origin ||
      grant.deviceId !== options.device.deviceId ||
      grant.environmentId !== options.device.environmentId ||
      grant.generation !== options.device.generation ||
      grant.channelGeneration !== channelGeneration ||
      options.device.revoked ||
      grant.expiresAt <= now ||
      grant.expiresAt > now + 60_000 ||
      (yield* options.localEnvironmentId.pipe(Effect.mapError(forbidden))) !==
        grant.environmentId ||
      (yield* environment.getEnvironmentId.pipe(Effect.mapError(forbidden))) !== grant.environmentId
    )
      return yield* forbidden();
    const descriptor = yield* readJson(client, `${local.origin}/.well-known/t3/environment`).pipe(
      Effect.flatMap(decodeDescriptor),
      Effect.mapError(unavailable),
    );
    if (
      descriptor.environmentId !== grant.environmentId ||
      (stream && descriptor.orchestrationProtocolVersion !== ORCHESTRATION_PROTOCOL_VERSION)
    )
      return yield* forbidden();
    const remaining = grant.expiresAt - (yield* Clock.currentTimeMillis);
    if (remaining <= 0) return yield* forbidden();
    const session = yield* Effect.acquireRelease(
      sessions
        .issue({
          scopes: stream ? grant.scopes : ["orchestration:read"],
          subject: encodeSubject({ kind: "foundry-gateway-v1", ...grant }),
          method: "dpop-access-token",
          proofKeyThumbprint,
          ttl: Duration.millis(Math.min(stream ? 60000 : 5000, remaining)),
          client: { deviceType: "unknown", label: `Foundry ${grant.grantId}` },
        })
        .pipe(Effect.mapError(unavailable)),
      (session) => sessions.revoke(session.sessionId).pipe(Effect.orDie),
    );
    const proof = (url: string, token: string, now: number) => {
      const header = encode({ typ: "dpop+jwt", alg: "ES256", jwk });
      const payload = encode({
        htm: "GET",
        htu: url,
        jti: NodeCrypto.randomUUID(),
        iat: Math.floor(now / 1000),
        ath: computeDpopAccessTokenHash(token),
      });
      const unsigned = `${header}.${payload}`;
      return `${unsigned}.${NodeCrypto.sign("sha256", Buffer.from(unsigned), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
    };
    return { grant, session, proof };
  });
  const projects = Effect.fn("DeviceHttpAdapter.projects")(
    function* (input: unknown, channelGeneration: number) {
      const { session, proof } = yield* authorize(input, channelGeneration, false);
      const url = `${local.origin}/api/projects`;
      return yield* readJson(client, url, {
        authorization: `DPoP ${session.token}`,
        dpop: proof(url, session.token, yield* Clock.currentTimeMillis),
      }).pipe(Effect.flatMap(decodeProjects), Effect.mapError(unavailable));
    },
    Effect.scoped,
    Effect.timeout("5 seconds"),
    Effect.mapError(unavailable),
  );
  const openStream = Effect.fn("DeviceHttpAdapter.openStream")(
    function* (input: unknown, channelGeneration: number) {
      const { session, proof } = yield* authorize(input, channelGeneration, true);
      const issued = yield* sessions
        .issueWebSocketToken(session.sessionId, {
          audience: "rpc",
          proofKeyThumbprint,
          ttl: Duration.seconds(10),
        })
        .pipe(Effect.mapError(unavailable));
      const url = new URL(`${local.origin}/ws`);
      url.searchParams.set(
        ORCHESTRATION_PROTOCOL_QUERY_PARAM,
        String(ORCHESTRATION_PROTOCOL_VERSION),
      );
      url.searchParams.set("wsTicket", issued.token);
      url.searchParams.set(
        "dpop",
        proof(`${local.origin}/ws`, issued.token, yield* Clock.currentTimeMillis),
      );
      url.protocol = "ws:";
      return yield* StreamSocket.connect(url.href, { origin: local.origin }).pipe(
        Effect.mapError(unavailable),
      );
    },
    Effect.timeout("10 seconds"),
    Effect.mapError(unavailable),
  );
  return { projects, openStream };
});
