import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { sendAuthenticated } from "./GitHubHttp.ts";

it.effect("uses only supplied authorization and bounds bytes while reporting invalid UTF-8", () =>
  Effect.gen(function* () {
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    const client = HttpClient.make((request) => {
      requests.push(request);
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(new Uint8Array([0xff, 97, 98, 99]))),
      );
    });
    const result = yield* sendAuthenticated(client, {
      request: HttpClientRequest.get("https://api.github.com/repos/owner/test"),
      authorization: Redacted.make("Bearer bounded-installation"),
      headers: { authorization: "Bearer unwanted-default" },
      maxResponseBytes: 2,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.authorization).toBe("Bearer bounded-installation");
    expect(result.body).toBe("\ufffda");
    expect(result.truncated).toBe(true);
    expect(result.invalidUtf8).toBe(true);
  }),
);
