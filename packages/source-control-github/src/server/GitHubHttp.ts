import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientRequest } from "effect/http";

export const sendAuthenticated = Effect.fn("GitHubHttp.sendAuthenticated")(function* (
  client: HttpClient.HttpClient,
  input: {
    readonly request: HttpClientRequest.HttpClientRequest;
    readonly authorization: Redacted.Redacted<string>;
    readonly headers?: Readonly<Record<string, string>>;
    readonly maxResponseBytes: number;
  },
) {
  const response = yield* client
    .execute(
      input.request.pipe(
        HttpClientRequest.setHeaders({
          ...input.headers,
          authorization: Redacted.value(input.authorization),
        }),
      ),
    )
    .pipe(
      // Client spans expose repository paths, SHAs and branches through url.full/url.query.
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
    );
  const collected = yield* collectUint8StreamText({
    stream: response.stream,
    maxBytes: input.maxResponseBytes,
  }).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "EmptyBodyError",
      () => Effect.succeed({ text: "", truncated: false, invalidUtf8: false }),
    ),
  );
  return {
    status: response.status,
    headers: response.headers,
    body: collected.text,
    truncated: collected.truncated,
    invalidUtf8: collected.invalidUtf8,
  };
});
