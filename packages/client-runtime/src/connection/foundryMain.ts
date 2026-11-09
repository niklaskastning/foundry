import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, FetchHttpClient } from "effect/http";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { normalizeOrigin, type InstanceBinding } from "./foundry.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
  type PreparedHttpAuthorization,
} from "./model.ts";

export class FoundryInstanceSession extends Context.Reference<{
  readonly current: (binding: InstanceBinding) => Effect.Effect<
    {
      readonly binding: InstanceBinding;
      readonly csrfToken: string;
      readonly authorization: PreparedHttpAuthorization | null;
    },
    ConnectionAttemptError
  >;
}>("clientRuntime/FoundryInstanceSession", {
  defaultValue: () => ({
    current: () =>
      Effect.fail(
        new ConnectionBlockedError({
          reason: "authentication",
          detail: "Verify and sign in to this Foundry instance before connecting to a device.",
        }),
      ),
  }),
}) {}

const blocked = () =>
  new ConnectionBlockedError({
    reason: "authentication",
    detail:
      "Foundry gateway access was rejected. Verify Foundry sign-in and the T3 session permissions on Main.",
  });
const unavailable = () =>
  new ConnectionTransientError({
    reason: "transport",
    detail:
      "The Foundry gateway could not be reached. Retry after checking the instance connection.",
  });

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
export const make = Effect.fn("FoundryMain.make")(function* (
  options: { allowLoopback: boolean; maxResponseBytes?: number } = { allowLoopback: false },
) {
  const http = yield* HttpClient.HttpClient;
  const access = yield* FoundryInstanceSession;
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const prepare = Effect.fn("FoundryMain.prepare")(function* (binding: InstanceBinding) {
    const origin = yield* Effect.try({
      try: () => normalizeOrigin(binding.origin, options.allowLoopback),
      catch: blocked,
    });
    const session = yield* access.current(binding);
    if (
      session.binding.origin !== origin ||
      session.binding.instanceId !== binding.instanceId ||
      session.binding.issuer !== binding.issuer ||
      session.binding.mainEnvironmentId !== binding.mainEnvironmentId
    )
      return yield* blocked();
    const proof = (url: string, token: string, method: "GET" | "POST") =>
      Option.isSome(signer)
        ? signer.value
            .createProof({ method, url, accessToken: token })
            .pipe(Effect.mapError(blocked))
        : Effect.fail(blocked());
    const response = Effect.fn("FoundryGateway.request")(
      function* (path: string, body?: unknown, acceptErrors = false) {
        const definitionTransfer =
          path.startsWith("/api/foundry/automation/") &&
          typeof body === "object" &&
          body !== null &&
          "op" in body &&
          [
            "factory",
            "definitionRevision",
            "definitionRevisionFile",
            "runtimeNode",
            "activateDefinition",
            "activateDefinitionRevision",
          ].includes(String(body.op));
        const responseLimit = definitionTransfer ? 64 * 1024 * 1024 : 3 * 1024 * 1024;
        const url = `${origin}${path}`;
        let req = HttpClientRequest.make(body === undefined ? "GET" : "POST")(url).pipe(
          HttpClientRequest.setHeaders({
            "content-type": "application/json",
            ...(body === undefined ? {} : { "x-foundry-csrf": session.csrfToken }),
          }),
        );
        if (body !== undefined)
          req = yield* HttpClientRequest.bodyJson(req, body).pipe(Effect.mapError(blocked));
        if (body !== undefined && session.authorization?._tag === "Bearer")
          req = req.pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${session.authorization.token}`),
          );
        if (body !== undefined && session.authorization?._tag === "Dpop")
          req = req.pipe(
            HttpClientRequest.setHeaders({
              authorization: `DPoP ${session.authorization.accessToken}`,
              dpop: yield* proof(
                url,
                session.authorization.accessToken,
                body === undefined ? "GET" : "POST",
              ),
            }),
          );
        const response = yield* http.execute(req).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "manual",
            credentials: "include",
            cache: "no-store",
          }),
          Effect.mapError(unavailable),
        );
        if (
          (response.status >= 300 && response.status < 400) ||
          response.headers["content-type"]?.includes("text/html")
        )
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            detail:
              "Foundry returned an Access login page or redirect. Complete sign-in at the confirmed instance origin, then retry.",
          });
        if (response.status === 401 || response.status === 403) return yield* blocked();
        if (
          (!acceptErrors && response.status !== 200) ||
          !response.headers["content-type"]?.includes("application/json")
        )
          return yield* unavailable();
        const chunks = yield* response.stream.pipe(
          Stream.runFoldEffect(
            () => ({ parts: [] as Uint8Array[], size: 0 }),
            (state, bytes) => {
              if (
                state.size + bytes.byteLength >
                Math.min(options.maxResponseBytes ?? 512 * 1024, responseLimit)
              )
                return Effect.fail(unavailable());
              state.parts.push(bytes);
              state.size += bytes.byteLength;
              return Effect.succeed(state);
            },
          ),
          Effect.mapError(unavailable),
        );
        const bytes = new Uint8Array(chunks.size);
        let offset = 0;
        for (const part of chunks.parts) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
        const value = yield* decodeJson(new TextDecoder().decode(bytes)).pipe(
          Effect.mapError(unavailable),
        );
        return { status: response.status, value };
      },
      Effect.timeout("15 seconds"),
      Effect.catchTags({ TimeoutError: unavailable }),
    );
    // The response operation owns the existing HTTP span; this only unwraps its JSON value.
    const request = Effect.fnUntraced(function* (path: string, body?: unknown) {
      return (yield* response(path, body)).value;
    });
    return { request, response, origin, session, proof };
  });
  return { prepare };
});

export const nativeHttpPolicy = { allowLoopback: true };
